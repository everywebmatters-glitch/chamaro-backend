import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
// Sentinel stored for Google-only accounts (no local password). It contains no ":" separator,
// so verifyPassword() below always returns false for it -- Google-only accounts can never
// authenticate via password login, without needing a special-case check anywhere else.
export const GOOGLE_OAUTH_NO_PASSWORD = "GOOGLE_OAUTH_NO_PASSWORD";

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