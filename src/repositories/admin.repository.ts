import type { PrismaClient } from "../../../generated/prisma/client.js";

const safeAdminSelect = { id: true, name: true, email: true, role: true, isActive: true, createdAt: true } as const;

export function createAdminRepository(prisma: PrismaClient) {
  return {
    // `select` (rather than fetching the row and filtering afterwards) means passwordHash
    // is never read out of the database for this response in the first place.
    createAdmin: (data: { name: string; email: string; passwordHash: string }) =>
      prisma.user.create({ data: { ...data, role: "ADMIN", adminProfile: { create: {} } }, select: safeAdminSelect }),
  };
}

export type AdminRepository = ReturnType<typeof createAdminRepository>;
