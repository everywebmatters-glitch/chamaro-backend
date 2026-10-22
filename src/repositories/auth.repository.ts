import type { PrismaClient } from "../../generated/prisma/client.js";
import { GOOGLE_OAUTH_NO_PASSWORD } from "../utils/password.js";

const safeUserSelect = { id: true, name: true, email: true, role: true, isActive: true, createdAt: true } as const;

export function createAuthRepository(prisma: PrismaClient) {
  return {
    // Full row (includes passwordHash) -- only for internal credential verification.
    findByEmail: (email: string) => prisma.user.findUnique({ where: { email } }),
    findByGoogleId: (googleId: string) => prisma.user.findUnique({ where: { googleId } }),

    findSafeById: (id: string) => prisma.user.findUnique({ where: { id }, select: safeUserSelect }),

    // Self-registration always creates a RETAIL customer profile alongside the identity.
    createCustomer: (data: { name: string; email: string; passwordHash: string }) =>
      prisma.user.create({ data: { ...data, role: "CUSTOMER", customer: { create: { customerType: "RETAIL" } } }, select: safeUserSelect }),

    // Google only signs in accounts whose address it has verified (see google.provider), so the address starts verified.
    createGoogleCustomer: (data: { name: string; email: string; googleId: string }) =>
      prisma.user.create({ data: { ...data, passwordHash: GOOGLE_OAUTH_NO_PASSWORD, emailVerifiedAt: new Date(), role: "CUSTOMER", customer: { create: { customerType: "RETAIL" } } } }),

    // Attaches a Google identity to an existing, active CUSTOMER account whose own address is already verified. It sets
    // googleId and nothing else: the password, role, status and every other field are left exactly as they are. The
    // claim is atomic (only while the account has no Google identity), so two requests can't link two identities.
    // Returns null when the account was linked, changed, deactivated or is not a verified customer in the meantime.
    linkGoogleToCustomer: async (accountId: string, googleId: string) => {
      const claimed = await prisma.user.updateMany({ where: { id: accountId, role: "CUSTOMER", isActive: true, googleId: null, emailVerifiedAt: { not: null } }, data: { googleId } });
      return claimed.count === 1 ? prisma.user.findUniqueOrThrow({ where: { id: accountId } }) : null;
    },

    // Records that the holder of `email` proved they read mail there. Only while the account still has that address
    // and was not verified already, so a later address can never inherit an earlier proof.
    markEmailVerified: (userId: string, email: string) =>
      prisma.user.updateMany({ where: { id: userId, email, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } }),

    // Upsert so admins created before their profile existed self-heal on next login.
    recordAdminLogin: (userId: string) =>
      prisma.adminUser.upsert({ where: { userId }, update: { lastLoginAt: new Date() }, create: { userId, lastLoginAt: new Date() } }),
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
