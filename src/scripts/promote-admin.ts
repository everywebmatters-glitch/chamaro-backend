import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { createScriptPrisma } from "./prisma.js";
import { normalizeEmail } from "./create-admin.js";

export async function promoteAdmin(email: string, confirmation: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  if (confirmation !== "PROMOTE") throw new Error("Promotion cancelled. Type PROMOTE to confirm.");
  const prisma = createScriptPrisma();
  try {
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true, role: true } });
    if (!user) throw new Error("User not found.");
    if (user.role !== "CUSTOMER") throw new Error("Only CUSTOMER users can be promoted.");
    // The Customer profile is kept: any order/enquiry history it owns must survive the promotion.
    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN", adminProfile: { connectOrCreate: { where: { userId: user.id }, create: {} } } }, select: { id: true } });
  } finally { await prisma.$disconnect(); }
}

function emailArgument(): string {
  const argument = process.argv.find((value) => value.startsWith("--email="));
  if (!argument) throw new Error("Usage: npm.cmd run admin:promote -- --email=user@example.com");
  return argument.slice("--email=".length);
}

export async function main(): Promise<void> {
  const prompts = readline.createInterface({ input, output });
  try {
    const email = emailArgument();
    const confirmation = await prompts.question(`Type PROMOTE to promote ${normalizeEmail(email)} to ADMIN: `);
    await promoteAdmin(email, confirmation.trim());
    console.log("User promoted to ADMIN.");
  } finally { prompts.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Unable to promote user."); process.exitCode = 1; });
}