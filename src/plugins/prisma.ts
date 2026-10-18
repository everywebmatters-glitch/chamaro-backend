import fp from "fastify-plugin";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import { getDatabaseSslOptions } from "../config/database-ssl.js";

export default fp(async (app) => {
  const databaseUrl = new URL(env.DATABASE_URL);
  // Cloud Run's native Cloud SQL integration connects over a Unix socket at /cloudsql/<connection
  // name> rather than host:port. DATABASE_URL signals this with a "socket" query param, per
  // Prisma/Cloud SQL convention: mysql://user:pass@localhost/db?socket=/cloudsql/<connection-name>.
  const socketPath = databaseUrl.searchParams.get("socket") ?? undefined;
  const adapter = new PrismaMariaDb({
    ...(socketPath ? { socketPath } : { host: databaseUrl.hostname, port: Number(databaseUrl.port || 3306) }),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: databaseUrl.pathname.slice(1),
    connectionLimit: 10,
    ssl: getDatabaseSslOptions(databaseUrl.hostname),
    // Matches the verified TLS connectivity probe.
    connectTimeout: 10_000,
    acquireTimeout: 10_000,
  });
  const prisma = new PrismaClient({ adapter });
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => prisma.$disconnect());
});
