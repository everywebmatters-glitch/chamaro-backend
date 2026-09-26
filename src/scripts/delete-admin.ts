import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { createScriptPrisma } from "./prisma.js";
import { normalizeEmail } from "./create-admin.js";

export async function deleteAdmin(email: string, confirmation: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  if (confirmation !== "DELETE") throw new Error("Deletion cancelled. Type DELETE to confirm.");

  const prisma = createScriptPrisma();
  try {
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true, role: true } });
    if (!user) throw new Error("User not found.");
    if (user.role !== "ADMIN") throw new Error("Only ADMIN users can be deleted with this script.");

    // There is no SUPER_ADMIN tier and no other bootstrap path once this script deletes the
    // last admin -- refuse rather than lock the whole application out of admin access.
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) throw new Error("Cannot delete the last remaining ADMIN account.");

    await prisma.user.delete({ where: { id: user.id } });
  } finally {
    await prisma.$disconnect();
  }
}

function emailArgument(): string {
  const argument = process.argv.find((value) => value.startsWith("--email="));
  if (!argument) throw new Error("Usage: npm.cmd run admin:delete -- --email=user@example.com");
  return argument.slice("--email=".length);
}

export async function main(): Promise<void> {
  const prompts = readline.createInterface({ input, output });
  try {
    const email = emailArgument();
    const confirmation = await prompts.question(`Type DELETE to permanently delete admin ${normalizeEmail(email)}: `);
    await deleteAdmin(email, confirmation.trim());
    console.log("Administrator deleted.");
  } finally {
    prompts.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Unable to delete administrator."); process.exitCode = 1; });
}
