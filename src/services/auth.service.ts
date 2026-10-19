import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import { hashPassword, verifyPasswordConstantWork } from "../utils/password.js";
import { createAuthRepository } from "../repositories/auth.repository.js";
import { createPasswordResetRepository } from "../repositories/password-reset.repository.js";
import { createOtpService } from "./otp.service.js";
import { sendPasswordResetLinkEmail } from "./email.service.js";
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
// to anyone who reads the table; it also lets the token be looked up by its hash.
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The token goes in the fragment, so it is never sent to the storefront's server or leaked via Referer.
export function passwordResetUrl(token: string): string {
  return `${env.APP_BASE_URL}/reset-password#token=${token}`;
}

export function createAuthService(prisma: PrismaClient, options: { log?: FastifyBaseLogger } = {}) {
  const repository = createAuthRepository(prisma);
  const resetTokens = createPasswordResetRepository(prisma);
  const otpService = createOtpService(prisma);

  async function issuePasswordResetLink(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const user = await repository.findByEmail(normalized);
    if (!user || !user.isActive || user.role !== "CUSTOMER") return;
    const latest = await resetTokens.findLatestForUser(user.id);
    if (latest && Date.now() - latest.createdAt.getTime() < env.OTP_RESEND_COOLDOWN_SECONDS * 1000) return;

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60_000);
    await resetTokens.issue({ userId: user.id, tokenHash: hashResetToken(token), expiresAt });
    try {
      await sendPasswordResetLinkEmail(user.email, passwordResetUrl(token), env.PASSWORD_RESET_TOKEN_TTL_MINUTES);
    } catch (error) {
      const { code, provider } = error as { code?: unknown; provider?: unknown };
      options.log?.error({ err: { code, provider }, userId: user.id }, "Password reset email failed");
    }
  }

  async function loginWithGoogle(identity: GoogleIdentity) {
    let user = await repository.findByGoogleId(identity.googleId);
    if (!user) {
      const existing = await repository.findByEmail(identity.email);
      // Do not silently attach a Google identity to an existing password account -- that
      // would let anyone who controls a Google account with a matching email take over an
      // unrelated local account. Linking requires an explicit, separately-designed flow.
      if (existing) throw googleAccountNotLinked();
      user = await repository.createGoogleCustomer({ name: identity.name, email: identity.email, googleId: identity.googleId });
    }
    if (!user.isActive) throw accountInactive();
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

    async resetPasswordWithOtp(email: string, otp: string, newPassword: string): Promise<void> {
      const normalized = email.trim().toLowerCase();
      await otpService.verifyOtp({ email: normalized, purpose: "FORGOT_PASSWORD", otp, consume: true });
      const user = await repository.findByEmail(normalized);
      if (!user || !user.isActive) throw accountInactive();
      const passwordHash = await hashPassword(newPassword);
      await repository.updatePassword(user.id, passwordHash);
      await resetTokens.invalidateForUser(user.id);
    },

    // Emails a single-use reset link to an active CUSTOMER account (admins keep the code flow, and their reset
    // must not point at the storefront). Every other case, a send within the resend cooldown, and a failed email
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
      if (!(await resetTokens.redeem(hashResetToken(token), passwordHash))) throw resetTokenInvalid();
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
