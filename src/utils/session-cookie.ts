import { env } from "../config/env.js";

// The persistent-session cookie. HttpOnly (script can't read it), Secure in production, SameSite=Lax (sent on requests
// from the same site, never on cross-site subrequests), and scoped to the auth routes so no other request carries it.
// It is set by api.chamaro.com and sent by the storefront on chamaro.com, which is the same site.

export const SESSION_COOKIE = "chamaro_rt";
const PATH = "/api/v1/auth";

function cookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=${PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${env.isProduction ? "; Secure" : ""}`;
}

export const sessionCookie = (token: string, expiresAt: Date) => cookie(token, Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));
export const clearedSessionCookie = () => cookie("", 0);

export function readSessionCookie(header: string | undefined): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || undefined;
  }
  return undefined;
}

// The refresh and logout routes act on a cookie, so they only answer requests from our own sites (a browser always sends
// Origin on a cross-origin POST). A request from anywhere else is refused before the cookie is looked at.
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  return env.CORS_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean).includes(origin);
}
