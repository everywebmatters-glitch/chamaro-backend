import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../generated/prisma/client.js";
import { hashPassword } from "../src/utils/password.js";

const url = new URL(process.env.DATABASE_URL ?? "");
const email = process.env.ADMIN_EMAIL?.toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 12) throw new Error("Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters before seeding");
const adapter = new PrismaMariaDb({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), connectionLimit: 2 });
const prisma = new PrismaClient({ adapter });
try {
  const admin = await prisma.user.upsert({ where: { email }, update: { name: "Initial Administrator", role: "ADMIN", isActive: true }, create: { name: "Initial Administrator", email, passwordHash: await hashPassword(password), role: "ADMIN" } });
  await prisma.adminUser.upsert({ where: { userId: admin.id }, update: {}, create: { userId: admin.id } });
  console.log(`Administrator ${email} is ready.`);
} finally { await prisma.$disconnect(); }
