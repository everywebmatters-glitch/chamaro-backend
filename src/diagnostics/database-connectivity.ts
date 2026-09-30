// TEMPORARY database connectivity diagnostic (Hostinger P2028 investigation). Remove this file and
// its one call in server.ts once resolved. Logs host, port, database name and TLS settings only:
// never the URL, username or password, which are also scrubbed from every logged error message.
import { connect as tcpConnect } from "node:net";
import mariadb from "mariadb";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import { getDatabaseSslOptions } from "../config/database-ssl.js";

const TCP_TIMEOUT_MS = 5_000;

function log(step: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ dbDiagnostic: step, ...details }));
}

function describeError(error: unknown, scrub: (text?: string) => string | undefined, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: scrub(String(error)) };
  const extra = error as { code?: unknown; errno?: unknown; sqlState?: unknown; cause?: unknown };
  return {
    name: error.name,
    code: extra.code,
    errno: extra.errno,
    sqlState: extra.sqlState,
    message: scrub(error.message),
    cause: extra.cause !== undefined && depth < 3 ? describeError(extra.cause, scrub, depth + 1) : undefined,
  };
}

function tcpProbe(host: string, port: number): Promise<{ ok: true; ms: number } | { ok: false; ms: number; error: unknown }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once("connect", () => { socket.destroy(); resolve({ ok: true, ms: Date.now() - started }); });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - started, error: Object.assign(new Error(`No TCP response within ${TCP_TIMEOUT_MS} ms`), { code: "TCP_TIMEOUT" }) });
    });
    socket.once("error", (error) => { socket.destroy(); resolve({ ok: false, ms: Date.now() - started, error }); });
  });
}

export async function runDatabaseDiagnostic(): Promise<void> {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
  } catch (error) {
    log("config", { ok: false, error: describeError(error, () => "DATABASE_URL is missing or not a valid URL") });
    return;
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const secrets = [env.DATABASE_URL, url.password, password, url.username, user].filter((value) => value.length > 0);
  const scrub = (text?: string) => secrets.reduce((result, secret) => result?.split(secret).join("[redacted]"), text);

  // Same values plugins/prisma.ts passes to PrismaMariaDb.
  const host = url.hostname;
  const port = Number(url.port || 3306);
  const database = url.pathname.slice(1);
  let ssl: ReturnType<typeof getDatabaseSslOptions>;
  try {
    ssl = getDatabaseSslOptions(host);
  } catch (error) {
    log("config", { ok: false, host, port, database, step: "TLS options", error: describeError(error, scrub) });
    return;
  }
  log("config", { ok: true, host, port, database, tlsEnabled: ssl !== undefined, tlsCustomCa: Boolean(ssl?.ca), tlsRejectUnauthorized: ssl?.rejectUnauthorized ?? null });

  const tcp = await tcpProbe(host, port);
  if (!tcp.ok) {
    log("tcp", { ok: false, ms: tcp.ms, error: describeError(tcp.error, scrub) });
    return;
  }
  log("tcp", { ok: true, ms: tcp.ms });

  // MariaDB driver directly: authentication, TLS and unknown-database errors keep their own codes here.
  const driverStarted = Date.now();
  try {
    const connection = await mariadb.createConnection({ host, port, user, password, database, ssl, connectTimeout: 10_000 });
    try {
      await connection.query("SELECT 1");
      log("mariadb", { ok: true, ms: Date.now() - driverStarted });
    } finally {
      await connection.end();
    }
  } catch (error) {
    log("mariadb", { ok: false, ms: Date.now() - driverStarted, error: describeError(error, scrub) });
    return;
  }

  // Prisma through the adapter, outside a transaction, so its 2s transaction wait doesn't hide the result.
  const prismaStarted = Date.now();
  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb({ host, port, user, password, database, connectionLimit: 1, ssl, connectTimeout: 10_000, acquireTimeout: 10_000 }),
  });
  try {
    await prisma.$queryRaw`SELECT 1`;
    log("prisma", { ok: true, ms: Date.now() - prismaStarted });
  } catch (error) {
    log("prisma", { ok: false, ms: Date.now() - prismaStarted, error: describeError(error, scrub) });
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
