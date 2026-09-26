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
  if (!env.DATABASE_CA_CERT_PATH) {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: true, ca: readFileSync(env.DATABASE_CA_CERT_PATH) };
}
