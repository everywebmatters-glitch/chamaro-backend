import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";

// Stateless Google OAuth browser-flow tokens, so any backend instance can validate them:
//
// - state: signed JWT carrying a hash of a random nonce and the frontend's PKCE code_challenge.
//   The nonce itself goes in an HttpOnly cookie scoped to the Google auth routes; the callback
//   only accepts a state whose nonce matches that cookie (login-CSRF protection).
// - exchange code: 60-second signed JWT for the user, bound to the same code_challenge. The
//   frontend redeems it once with its code_verifier; a code copied from the URL is useless
//   without the verifier, which never leaves the browser that started the flow.
//
// Both are signed with keys derived from JWT_SECRET per purpose, so they never verify as access
// tokens (and access tokens never verify as these). Without shared storage the exchange code
// cannot be strictly single-use; its short lifetime plus the verifier binding bound the risk.

export const OAUTH_STATE_COOKIE = "chamaro_google_oauth";
const COOKIE_PATH = "/api/v1/auth/google";
const STATE_TTL_SECONDS = 10 * 60;

type StatePayload = { purpose: "google_oauth_state"; nonce: string; cc: string };
type ExchangePayload = { purpose: "google_exchange_code"; cc: string; sub: string };

function derivedKey(purpose: string): Buffer {
  return createHmac("sha256", env.JWT_SECRET).update(`chamaro:${purpose}`).digest();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function oauthError(message: string, code: string): Error {
  return Object.assign(new Error(message), { statusCode: 401, code });
}

export function createOAuthState(app: FastifyInstance, codeChallenge: string): { state: string; nonce: string } {
  const nonce = randomBytes(32).toString("base64url");
  const payload: StatePayload = { purpose: "google_oauth_state", nonce: sha256(nonce), cc: codeChallenge };
  const state = app.jwt.sign(payload, { key: derivedKey("google-oauth-state"), algorithm: "HS256", expiresIn: `${STATE_TTL_SECONDS}s` });
  return { state, nonce };
}

// Returns the PKCE code_challenge the flow was started with.
export function verifyOAuthState(app: FastifyInstance, state: string | undefined, cookieNonce: string | undefined): string {
  const invalid = () => oauthError("Invalid or expired OAuth state", "OAUTH_STATE_INVALID");
  if (!state || !cookieNonce) throw invalid();
  let payload: StatePayload;
  try { payload = app.jwt.verify<StatePayload>(state, { key: derivedKey("google-oauth-state"), algorithms: ["HS256"] }); } catch { throw invalid(); }
  if (payload.purpose !== "google_oauth_state" || !safeEqual(payload.nonce, sha256(cookieNonce))) throw invalid();
  return payload.cc;
}

export function createExchangeCode(app: FastifyInstance, userId: string, codeChallenge: string): string {
  return app.jwt.sign({ purpose: "google_exchange_code", cc: codeChallenge }, { key: derivedKey("google-exchange-code"), algorithm: "HS256", sub: userId, expiresIn: "60s" });
}

// Returns the user ID the code was issued for.
export function verifyExchangeCode(app: FastifyInstance, code: string, codeVerifier: string): string {
  const invalid = () => oauthError("Invalid or expired sign-in code", "OAUTH_CODE_INVALID");
  let payload: ExchangePayload;
  try { payload = app.jwt.verify<ExchangePayload>(code, { key: derivedKey("google-exchange-code"), algorithms: ["HS256"] }); } catch { throw invalid(); }
  if (payload.purpose !== "google_exchange_code" || !payload.sub || !safeEqual(payload.cc, sha256(codeVerifier))) throw invalid();
  return payload.sub;
}

function cookie(value: string, maxAgeSeconds: number): string {
  // Secure whenever the callback itself is served over HTTPS (production); plain http on localhost.
  const secure = env.GOOGLE_REDIRECT_URI.startsWith("https://") ? "; Secure" : "";
  // SameSite=Lax: sent on Google's top-level redirect back to the callback, not on cross-site subrequests.
  return `${OAUTH_STATE_COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

export function stateCookie(nonce: string): string {
  return cookie(nonce, STATE_TTL_SECONDS);
}

export function clearedStateCookie(): string {
  return cookie("", 0);
}

export function readStateCookie(header: string | undefined): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name === OAUTH_STATE_COOKIE) return value.join("=") || undefined;
  }
  return undefined;
}
