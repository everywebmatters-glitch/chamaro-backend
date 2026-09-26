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

    createGoogleCustomer: (data: { name: string; email: string; googleId: string }) =>
      prisma.user.create({ data: { ...data, passwordHash: GOOGLE_OAUTH_NO_PASSWORD, role: "CUSTOMER", customer: { create: { customerType: "RETAIL" } } } }),

    // Upsert so admins created before their profile existed self-heal on next login.
    recordAdminLogin: (userId: string) =>
      prisma.adminUser.upsert({ where: { userId }, update: { lastLoginAt: new Date() }, create: { userId, lastLoginAt: new Date() } }),
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
