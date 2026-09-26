import type { PrismaClient } from "../../generated/prisma/client.js";
import { hashPassword } from "../utils/password.js";
import { createAdminRepository } from "../repositories/admin.repository.js";
import type { CreateAdminInput, SafeAdminUser } from "../types/admin.types.js";

export function createAdminService(prisma: PrismaClient) {
  const repository = createAdminRepository(prisma);

  return {
    async createAdmin(input: CreateAdminInput): Promise<SafeAdminUser> {
      const email = input.email.trim().toLowerCase();
      const passwordHash = await hashPassword(input.password);
      // role is always "ADMIN" -- never taken from input. The request schema
      // (additionalProperties: false) already rejects a client-supplied "role" field
      // before this runs; this hardcode is the second, independent guarantee.
      // Duplicate emails are left to the User.email unique constraint: Prisma raises P2002,
      // which error.middleware.ts maps to 409 DUPLICATE_RECORD, matching every other module.
      const admin = await repository.createAdmin({ name: input.name.trim(), email, passwordHash });
      return { ...admin, role: "ADMIN" };
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
