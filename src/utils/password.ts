import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
// Sentinel stored for Google-only accounts (no local password). It contains no ":" separator,
// so verifyPassword() below always returns false for it -- Google-only accounts can never
// authenticate via password login, without needing a special-case check anywhere else.
export const GOOGLE_OAUTH_NO_PASSWORD = "GOOGLE_OAUTH_NO_PASSWORD";

// A real scrypt hash of a random password that was discarded when it was generated, so nothing
// can match it. Used so a login for an unknown email (or an account without a local password)
// costs the same scrypt work as a wrong password for a real account; otherwise the response
// time reveals which emails exist.
const DUMMY_PASSWORD_HASH = "fa644552bed4616ff8954dddb9b20f85:11e6cac46601b75b33b684131afa03b67398110a773324e18a1e2935a5f8413682974a2bbdbcee6498c9d8eb53a27d0f758f1901ac73cc19c26e6f2a659275e9";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${Buffer.from(await scrypt(password, salt, 64) as Buffer).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64) as Buffer);
  const target = Buffer.from(expected, "hex");
  return target.length === actual.length && timingSafeEqual(target, actual);
}

// Always performs exactly one scrypt comparison. Returns true only when `stored` is a real
// password hash and the password matches it.
export async function verifyPasswordConstantWork(password: string, stored: string | undefined): Promise<boolean> {
  const usable = typeof stored === "string" && stored.includes(":");
  const matches = await verifyPassword(password, usable ? stored : DUMMY_PASSWORD_HASH);
  return usable && matches;
}
