// TEMPORARY database connectivity diagnostic (Hostinger P2028 investigation). Remove this file and
// its one call in server.ts once resolved. Logs host, port, database name and TLS settings only:
// never the URL, username or password, which are also scrubbed from every logged error message.
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect, checkServerIdentity as tlsCheckServerIdentity, type TLSSocket } from "node:tls";
import { X509Certificate } from "node:crypto";
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

type PeerCertificateResult = Record<string, unknown>;

// Describes the CA exactly as getDatabaseSslOptions() produced it. Node's TLS silently ignores a
// CA it cannot parse as PEM, so when parsing fails the layout is reported (never the contents).
function describeConfiguredCa(ca: Buffer | undefined): Record<string, unknown> | null {
  if (!ca) return null;
  const text = ca.toString("utf8");
  const layout = {
    bytes: ca.length,
    lines: text.split("\n").length,
    certificates: (text.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length,
    startsWithBeginLine: text.startsWith("-----BEGIN CERTIFICATE-----"),
    beginLineEndsWithNewline: /-----BEGIN CERTIFICATE-----\r?\n/.test(text),
    containsCarriageReturns: text.includes("\r"),
    containsQuotes: /["']/.test(text),
  };
  try {
    const cert = new X509Certificate(ca);
    return { parsed: true, subject: cert.subject, fingerprint256: cert.fingerprint256, valid_from: cert.validFrom, valid_to: cert.validTo, ...layout };
  } catch (error) {
    return { parsed: false, parseError: error instanceof Error ? error.message : String(error), ...layout };
  }
}

// Reads the certificate the server presents in the MySQL TLS upgrade: waits for the plaintext
// greeting, sends an SSLRequest packet (no username, password or query), completes the TLS
// handshake, records the certificate and closes. Verification is not aborted here only so the
// failing certificate can be read; the handshake is still checked against the configured CA and
// reported as authorized/authorizationError. The application's connection is unaffected.
function peerCertificateProbe(host: string, port: number, ca: Buffer | undefined): Promise<PeerCertificateResult> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    let settled = false;
    let secure: TLSSocket | undefined;
    // Once TLS wraps the socket, only the TLS socket may be destroyed (destroying the raw socket
    // underneath it crashes Node).
    const finish = (result: PeerCertificateResult) => { if (!settled) { settled = true; (secure ?? socket).destroy(); resolve(result); } };
    socket.setTimeout(TCP_TIMEOUT_MS * 2, () => finish({ ok: false, error: { code: "PROBE_TIMEOUT", message: "No TLS handshake result in time" } }));
    socket.once("error", (error) => finish({ ok: false, stage: "tcp", error: describeError(error, (text) => text) }));
    let greeting = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      greeting = Buffer.concat([greeting, chunk]);
      if (greeting.length < 4) return;
      const length = greeting.readUIntLE(0, 3);
      if (greeting.length < 4 + length) return;
      socket.off("data", onData);
      const payload = greeting.subarray(4, 4 + length);
      if (payload[0] === 0xff) {
        finish({ ok: false, stage: "greeting", error: { code: "SERVER_ERROR_PACKET", errno: payload.readUInt16LE(1), message: payload.subarray(3).toString("utf8") } });
        return;
      }
      // Protocol v10: version string, then connection id (4), auth data (8), filler (1), capability flags (2).
      const capabilitiesOffset = payload.indexOf(0, 1) + 1 + 4 + 8 + 1;
      const CLIENT_SSL = 0x0800;
      if ((payload.readUInt16LE(capabilitiesOffset) & CLIENT_SSL) === 0) {
        finish({ ok: false, stage: "greeting", error: { code: "SERVER_NO_TLS", message: "Server does not offer TLS" } });
        return;
      }
      const sslRequest = Buffer.alloc(4 + 32);
      sslRequest.writeUIntLE(32, 0, 3);
      sslRequest[3] = 1; // sequence id
      sslRequest.writeUInt32LE(0x0800 | 0x0200 | 0x8000 | 0x0001, 4); // SSL, PROTOCOL_41, SECURE_CONNECTION, LONG_PASSWORD
      sslRequest.writeUInt32LE(16 * 1024 * 1024, 8);
      sslRequest[12] = 45; // utf8mb4_general_ci
      socket.write(sslRequest);
      const tlsSocket = tlsConnect({ socket, ca, rejectUnauthorized: false });
      secure = tlsSocket;
      tlsSocket.on("error", (error) => finish({ ok: false, stage: "tls", error: describeError(error, (text) => text) }));
      tlsSocket.once("secureConnect", () => {
        const cert = tlsSocket.getPeerCertificate();
        const identityError = cert && Object.keys(cert).length > 0 ? tlsCheckServerIdentity(host, cert) : undefined;
        finish({
          ok: true,
          authorized: tlsSocket.authorized,
          authorizationError: tlsSocket.authorizationError ?? null,
          subject: cert?.subject ?? null,
          issuer: cert?.issuer ?? null,
          valid_from: cert?.valid_from ?? null,
          valid_to: cert?.valid_to ?? null,
          fingerprint256: cert?.fingerprint256 ?? null,
          // Hostname/IP check the MariaDB driver runs after the CA check passes.
          identityCheck: identityError ? identityError.message : "passes",
        });
      });
    };
    socket.on("data", onData);
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
  log("config", { ok: true, host, port, database, tlsEnabled: ssl !== undefined, tlsCustomCa: Boolean(ssl?.ca), tlsCaSource: !ssl ? null : env.DATABASE_CA_CERT?.trim() ? "DATABASE_CA_CERT" : env.DATABASE_CA_CERT_PATH ? "DATABASE_CA_CERT_PATH" : "none",tlsRejectUnauthorized: ssl?.rejectUnauthorized ?? null });

  const tcp = await tcpProbe(host, port);
  if (!tcp.ok) {
    log("tcp", { ok: false, ms: tcp.ms, error: describeError(tcp.error, scrub) });
    return;
  }
  log("tcp", { ok: true, ms: tcp.ms });

  if (ssl) {
    try {
      log("tlsPeerCertificate", { configuredCa: describeConfiguredCa(ssl.ca), ...(await peerCertificateProbe(host, port, ssl.ca)) });
    } catch (error) {
      log("tlsPeerCertificate", { ok: false, error: describeError(error, scrub) });
    }
  }

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
