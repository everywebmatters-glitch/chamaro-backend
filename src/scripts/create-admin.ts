import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { createScriptPrisma } from "./prisma.js";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../utils/password.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }
export function isValidEmail(email: string): boolean { return emailPattern.test(email); }

export async function createAdmin(name: string, email: string, password: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  if (!name.trim()) throw new Error("Admin name is required.");
  if (!isValidEmail(normalizedEmail)) throw new Error("A valid admin email is required.");
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) throw new Error(`Admin password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`);

  const prisma = createScriptPrisma();
  try {
    if (await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } })) throw new Error("User already exists.");
    await prisma.user.create({ data: { name: name.trim(), email: normalizedEmail, passwordHash: await hashPassword(password), role: "ADMIN", isActive: true, adminProfile: { create: {} } } });
  } finally { await prisma.$disconnect(); }
}

export async function deleteAdmin(email: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email);

  if (!isValidEmail(normalizedEmail)) {
    throw new Error("A valid admin email is required.");
  }

  const prisma = createScriptPrisma();

  try {
    await prisma.$transaction(async (tx) => {
      const admin = await tx.user.findUnique({
        where: {
          email: normalizedEmail,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
        },
      });

      if (!admin) {
        throw new Error("Administrator not found.");
      }

      if (admin.role !== "ADMIN") {
        throw new Error(
          `User "${admin.email}" is not an administrator.`,
        );
      }

      if (!admin.isActive) {
        throw new Error(
          `Administrator "${admin.email}" is already inactive.`,
        );
      }

      const activeAdminCount = await tx.user.count({
        where: {
          role: "ADMIN",
          isActive: true,
        },
      });

      if (activeAdminCount <= 1) {
        throw new Error(
          "Cannot delete the last active administrator.",
        );
      }

      await tx.user.delete({
        where: {
          id: admin.id,
        },
      });

      console.log(
        `Administrator deleted: ${admin.name} <${admin.email}>`,
      );
    });
  } finally {
    await prisma.$disconnect();
  }
}
export async function main(): Promise<void> {
  const prompts = readline.createInterface({ input, output });
  try {
    const name = await prompts.question("Admin name: ");
    const email = await prompts.question("Admin email: ");
    const password = await prompts.question("Admin password: ");
    await createAdmin(name, email, password);
    console.log("Administrator created.");
  } finally { prompts.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Unable to create administrator."); process.exitCode = 1; });
}