import { createHash, randomBytes } from "node:crypto";
import { revokeAllSessions } from "./session.service.js";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient, Role } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import { hashPassword, verifyPasswordConstantWork } from "../utils/password.js";
import { createAuthRepository } from "../repositories/auth.repository.js";
import { createPasswordResetRepository } from "../repositories/password-reset.repository.js";
import { createOtpService } from "./otp.service.js";
import { passwordChangedEmail, sendPasswordResetLinkEmail } from "./email.service.js";
import { createEmailOutbox, enqueueNotification } from "./email-outbox.service.js";
import { googleProvider } from "../providers/google.provider.js";
import type { AdminLoginInput, GoogleIdentity, LoginInput, RegisterInput, SafeUser } from "../types/auth.types.js";

function invalidCredentials(): Error {
  return Object.assign(new Error("Invalid email or password"), { statusCode: 401, code: "INVALID_CREDENTIALS" });
}
function accountInactive(): Error {
  return Object.assign(new Error("Account is inactive"), { statusCode: 403, code: "ACCOUNT_INACTIVE" });
}
function googleAccountNotLinked(): Error {
  return Object.assign(new Error("An account already exists for this email; sign in with its existing method to link Google"), { statusCode: 409, code: "GOOGLE_ACCOUNT_NOT_LINKED" });
}

function resetTokenInvalid(): Error {
  return Object.assign(new Error("This reset link is invalid or has expired; request a new one"), { statusCode: 400, code: "RESET_TOKEN_INVALID" });
}

// Longer than a normal token write plus email send, so a request for a real account takes as long as one for an
// unknown email.
const RESET_LINK_MIN_RESPONSE_MS = 1500;

// Reset tokens are 256 random bits, so a fast unsalted SHA-256 is enough to make the stored value useless
// to anyone who reads the table; it also lets the token be looked up by its hash. An admin's token is hashed under
// an "admin:" scope, so the stored hash also records which role the link was issued for: a link sent while the
// account was a customer can't reset it after it becomes an admin, and the other way round.
export function hashResetToken(token: string, role: Role = "CUSTOMER"): string {
  return createHash("sha256").update(role === "ADMIN" ? `admin:${token}` : token).digest("hex");
}

// Customers reset on the storefront, admins on the admin app. The token goes in the fragment, so it is never sent
// to either site's server or leaked via Referer.
export function passwordResetUrl(token: string, role: Role = "CUSTOMER"): string {
  return role === "ADMIN" ? `${env.ADMIN_BASE_URL}/reset-password/#token=${token}` : `${env.APP_BASE_URL}/reset-password#token=${token}`;
}

// Records the "your password was changed" email inside the transaction that changed it. Every reset path first
// proves the holder reads mail at the account's address, so it goes to that (now verified) address. `eventKey`
// names the change (the reset link or code used), so it is recorded once. Each account gets a link to its own
// site's reset form.
async function enqueuePasswordChanged(tx: Prisma.TransactionClient, user: { id: string; name: string; email: string; role: Role; emailVerifiedAt: Date | null }, changedAt: Date, eventKey: string) {
  // Changing the password signs the account out everywhere: every persistent session ends with it.
  await revokeAllSessions(tx, user.id);
  const resetUrl = user.role === "ADMIN" ? `${env.ADMIN_BASE_URL}/forgot-password/` : `${env.APP_BASE_URL}/account/login?reset=1`;
  return enqueueNotification(tx, {
    eventKey,
    kind: "PASSWORD_CHANGED",
    recipient: { userId: user.id, email: user.email, verified: user.emailVerifiedAt !== null },
    message: passwordChangedEmail({ name: user.name, changedAt, resetUrl }),
  });
}

export function createAuthService(prisma: PrismaClient, options: { log?: FastifyBaseLogger } = {}) {
  const repository = createAuthRepository(prisma);
  const resetTokens = createPasswordResetRepository(prisma);
  const otpService = createOtpService(prisma);
  const outbox = createEmailOutbox(prisma, { log: options.log });

  async function issuePasswordResetLink(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const user = await repository.findByEmail(normalized);
    if (!user || !user.isActive) return;
    const latest = await resetTokens.findLatestForUser(user.id);
    if (latest && Date.now() - latest.createdAt.getTime() < env.OTP_RESEND_COOLDOWN_SECONDS * 1000) return;

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60_000);
    await resetTokens.issue({ userId: user.id, tokenHash: hashResetToken(token, user.role), expiresAt });
    try {
      await sendPasswordResetLinkEmail(user.email, passwordResetUrl(token, user.role), env.PASSWORD_RESET_TOKEN_TTL_MINUTES);
    } catch (error) {
      const { code, provider } = error as { code?: unknown; provider?: unknown };
      options.log?.error({ err: { code, provider }, userId: user.id }, "Password reset email failed");
    }
  }

  async function loginWithGoogle(identity: GoogleIdentity) {
    let user = await repository.findByGoogleId(identity.googleId);
    if (!user) {
      const existing = await repository.findByEmail(identity.email);
      if (existing) {
        // Google has verified this address (verifyGoogleCallback refuses anything else), so a shopper who registered with
        // a password and now uses Google is the same person: the customer account is linked and signed in. Never linked
        // automatically: an administrator account, or one already tied to a different Google identity.
        if (existing.role !== "CUSTOMER" || existing.googleId) throw googleAccountNotLinked();
        if (!existing.isActive) throw accountInactive();
        const linked = await repository.linkGoogleToCustomer(existing, identity.googleId);
        if (!linked) throw googleAccountNotLinked();
        options.log?.info({ userId: linked.id, hadVerifiedEmail: existing.emailVerifiedAt !== null }, "Google identity linked to an existing customer account");
        return linked;
      }
      user = await repository.createGoogleCustomer({ name: identity.name, email: identity.email, googleId: identity.googleId });
    }
    if (!user.isActive) throw accountInactive();
    // Google vouches only for the address it just returned; an account whose address differs stays as it is.
    if (!user.emailVerifiedAt && user.email === identity.email) await repository.markEmailVerified(user.id, user.email);
    return user;
  }

  return {
    async register(input: RegisterInput): Promise<SafeUser> {
      const email = input.email.trim().toLowerCase();
      const passwordHash = await hashPassword(input.password);
      // role is always CUSTOMER -- never taken from input, and the request schema
      // (additionalProperties: false) rejects a client-supplied "role" before we get here.
      return repository.createCustomer({ name: input.name.trim(), email, passwordHash });
    },

    async login(input: LoginInput) {
      const email = input.email.trim().toLowerCase();
      const user = await repository.findByEmail(email);
      // The password check always runs one scrypt (against a dummy hash when there's no account
      // or no local password), so response time doesn't reveal whether the email exists.
      const passwordMatches = await verifyPasswordConstantWork(input.password, user?.passwordHash);
      // Single generic failure for every case (no account, wrong password, inactive account,
      // Google-only account, or an ADMIN account attempting the customer endpoint) so the
      // response never discloses which of those applies.
      if (!user || !passwordMatches || !user.isActive || user.role !== "CUSTOMER") {
        throw invalidCredentials();
      }
      return user;
    },

    async adminLogin(input: AdminLoginInput) {
      const email = input.email.trim().toLowerCase();
      const user = await repository.findByEmail(email);
      // Same constant-work check as customer login (see above).
      const passwordMatches = await verifyPasswordConstantWork(input.password, user?.passwordHash);
      if (!user || !passwordMatches || !user.isActive || user.role !== "ADMIN") {
        throw invalidCredentials();
      }
      await repository.recordAdminLogin(user.id);
      return user;
    },

    async getSafeUser(userId: string) {
      return repository.findSafeById(userId);
    },

    googleAuthorizationUrl(state: string): string {
      return googleProvider.googleAuthorizationUrl(state);
    },

    // The OAuth state has already been verified by the controller before this runs.
    async completeGoogleLogin(code: string) {
      const identity = await googleProvider.verifyGoogleCallback(code);
      return loginWithGoogle(identity);
    },

    // Re-checked at code exchange: the account may have been deactivated or deleted since the callback.
    async getActiveUserForGoogleExchange(userId: string) {
      const user = await repository.findSafeById(userId);
      if (!user) throw Object.assign(new Error("Invalid or expired sign-in code"), { statusCode: 401, code: "OAUTH_CODE_INVALID" });
      if (!user.isActive) throw accountInactive();
      return user;
    },

    // Only ever sends when the account exists, is active, and is a CUSTOMER -- but always
    // returns the same outcome to the caller either way, so the response never discloses
    // whether an account exists for this email (same enumeration-avoidance stance as login()).
    async sendLoginOtp(email: string): Promise<void> {
      const normalized = email.trim().toLowerCase();
      const user = await repository.findByEmail(normalized);
      if (user && user.isActive && user.role === "CUSTOMER") {
        await otpService.sendOtp({ email: normalized, purpose: "LOGIN" });
      }
    },

    async verifyLoginOtp(email: string, otp: string) {
      const normalized = email.trim().toLowerCase();
      await otpService.verifyOtp({ email: normalized, purpose: "LOGIN", otp });
      const user = await repository.findByEmail(normalized);
      // The OTP matched, but the account could have been deactivated/role-changed since it was
      // sent; treat that the same as any other login failure.
      if (!user || !user.isActive || user.role !== "CUSTOMER") throw invalidCredentials();
      // The code was emailed to this address, so whoever entered it reads mail there.
      if (!user.emailVerifiedAt) await repository.markEmailVerified(user.id, normalized);
      return user;
    },

    // Same enumeration-avoidance stance as sendLoginOtp(): always the same outcome regardless
    // of whether the email has an account.
    async forgotPasswordSendOtp(email: string): Promise<void> {
      const normalized = email.trim().toLowerCase();
      const user = await repository.findByEmail(normalized);
      if (user && user.isActive) {
        await otpService.sendOtp({ email: normalized, purpose: "FORGOT_PASSWORD" });
      }
    },

    // Non-consuming check: lets the frontend show "code accepted" before collecting the new
    // password. reset() below re-validates and performs the actual consumption.
    async forgotPasswordVerifyOtp(email: string, otp: string): Promise<void> {
      const normalized = email.trim().toLowerCase();
      await otpService.verifyOtp({ email: normalized, purpose: "FORGOT_PASSWORD", otp, consume: false });
    },

    // The new password, the verified address, the invalidated reset links and the password-changed email are
    // recorded in one transaction; the email is sent once it has committed.
    async resetPasswordWithOtp(email: string, otp: string, newPassword: string): Promise<void> {
      const normalized = email.trim().toLowerCase();
      const otpId = await otpService.verifyOtp({ email: normalized, purpose: "FORGOT_PASSWORD", otp, consume: true });
      const user = await repository.findByEmail(normalized);
      if (!user || !user.isActive) throw accountInactive();
      const passwordHash = await hashPassword(newPassword);
      const notification = await prisma.$transaction(async (tx) => {
        const changedAt = new Date();
        const changed = await tx.user.update({ where: { id: user.id }, data: { passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? changedAt }, select: { id: true, name: true, email: true, role: true, emailVerifiedAt: true } });
        await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: changedAt } });
        return enqueuePasswordChanged(tx, changed, changedAt, `user:${user.id}:password-changed:code:${otpId}`);
      });
      await outbox.dispatch(notification);
    },

    // Emails a single-use reset link to an active account: customers' link opens the storefront, admins' the admin
    // app. Every other case, a send within the resend cooldown, and a failed email
    // all return the same way, so the caller can't tell whether the email has an account. Every answer also takes
    // at least RESET_LINK_MIN_RESPONSE_MS, so the time spent issuing and emailing a link doesn't give it away either.
    async requestPasswordResetLink(email: string): Promise<void> {
      const started = Date.now();
      try {
        await issuePasswordResetLink(email);
      } finally {
        const remaining = RESET_LINK_MIN_RESPONSE_MS - (Date.now() - started);
        if (remaining > 0) await sleep(remaining);
      }
    },

    async resetPasswordWithToken(token: string, newPassword: string): Promise<void> {
      const passwordHash = await hashPassword(newPassword);
      const candidates = (["CUSTOMER", "ADMIN"] as const).map((role) => ({ tokenHash: hashResetToken(token, role), role }));
      const notification = await resetTokens.redeem(candidates, passwordHash, (tx, user, changedAt, tokenId) =>
        enqueuePasswordChanged(tx, user, changedAt, `user:${user.id}:password-changed:link:${tokenId}`),
      );
      if (!notification) throw resetTokenInvalid();
      await outbox.dispatch(notification);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
