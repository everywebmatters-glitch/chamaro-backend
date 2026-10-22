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

    // Attaches a Google identity to an existing CUSTOMER account whose address Google has just verified. Claimed
    // atomically (only while the account has no Google identity). If the account's own address was never verified, someone
    // else may have registered it with a password they know, so that password is disabled and every session and reset
    // link of the account ends with the link; the real owner signs in with Google, or sets a new password by email.
    // Returns null when the account was linked, changed or is not a customer in the meantime.
    linkGoogleToCustomer: (existing: { id: string; emailVerifiedAt: Date | null }, googleId: string) =>
      prisma.$transaction(async (tx) => {
        const now = new Date();
        const unverified = existing.emailVerifiedAt === null;
        const claimed = await tx.user.updateMany({
          where: { id: existing.id, role: "CUSTOMER", googleId: null },
          data: { googleId, emailVerifiedAt: existing.emailVerifiedAt ?? now, ...(unverified ? { passwordHash: GOOGLE_OAUTH_NO_PASSWORD } : {}) },
        });
        if (claimed.count !== 1) return null;
        if (unverified) {
          await tx.authSession.updateMany({ where: { userId: existing.id, revokedAt: null }, data: { revokedAt: now } });
          await tx.passwordResetToken.updateMany({ where: { userId: existing.id, usedAt: null }, data: { usedAt: now } });
        }
        return tx.user.findUniqueOrThrow({ where: { id: existing.id } });
      }),

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
