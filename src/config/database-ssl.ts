import { readFileSync } from "node:fs";
import { env } from "./env.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * A loopback host means traffic is going through the Cloud SQL Auth Proxy,
 * which already terminates TLS to Cloud SQL itself; the local hop never
 * leaves the machine, so no additional client-side TLS is layered on it.
 */
export function getDatabaseSslOptions(
  hostname: string,
): { rejectUnauthorized: true; ca?: Buffer } | undefined {
  if (LOOPBACK_HOSTS.has(hostname)) {
    return undefined;
  }
  const ca = getDatabaseCa();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

/**
 * The CA that signs the database server certificate (Cloud SQL uses its own, which Node does not
 * trust by default). DATABASE_CA_CERT (PEM contents) wins over DATABASE_CA_CERT_PATH (a file).
 * Hosting panels that store single-line values often keep newlines as literal "\n"; those are
 * restored. Errors name the variable, never its contents.
 */
function getDatabaseCa(): Buffer | undefined {
  const pem = env.DATABASE_CA_CERT?.trim();
  if (pem) {
    const restored = pem.replace(/\\n/g, "\n");
    if (!restored.includes("-----BEGIN CERTIFICATE-----")) {
      throw new Error("DATABASE_CA_CERT must contain a PEM certificate (-----BEGIN CERTIFICATE-----)");
    }
    return Buffer.from(restored);
  }
  return env.DATABASE_CA_CERT_PATH ? readFileSync(env.DATABASE_CA_CERT_PATH) : undefined;
}
