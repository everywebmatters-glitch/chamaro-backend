import type { PrismaClient } from "../../generated/prisma/client.js";
import { verifyPassword, hashPassword } from "../utils/password.js";
import { createAuthRepository } from "../repositories/auth.repository.js";
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

export function createAuthService(prisma: PrismaClient) {
  const repository = createAuthRepository(prisma);

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
      // Single generic failure for every case (no account, wrong password, inactive account,
      // Google-only account, or an ADMIN account attempting the customer endpoint) so the
      // response never discloses which of those applies.
      if (!user || !user.isActive || user.role !== "CUSTOMER" || !(await verifyPassword(input.password, user.passwordHash))) {
        throw invalidCredentials();
      }
      return user;
    },

    async adminLogin(input: AdminLoginInput) {
      const email = input.email.trim().toLowerCase();
      const user = await repository.findByEmail(email);
      if (!user || !user.isActive || user.role !== "ADMIN" || !(await verifyPassword(input.password, user.passwordHash))) {
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
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
