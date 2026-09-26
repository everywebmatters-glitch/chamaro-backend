import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client.js";
import { getDatabaseSslOptions } from "../config/database-ssl.js";

export function createScriptPrisma(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const adapter = new PrismaMariaDb({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connectionLimit: 2,
    ssl: getDatabaseSslOptions(url.hostname),
    connectTimeout: 10_000,
    acquireTimeout: 10_000,
  });
  return new PrismaClient({ adapter });
}