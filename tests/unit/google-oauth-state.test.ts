// OAuth state is bound to a cookie nonce (host-scoped by the browser). A flow started on one API host and
// completed on another has no cookie, so it must be rejected.
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import jwt from "@fastify/jwt";

process.env.JWT_SECRET = "x".repeat(40);
process.env.GOOGLE_REDIRECT_URI = "https://api.chamaro.com/api/v1/auth/google/callback";
const { createOAuthState, verifyOAuthState, stateCookie, readStateCookie } = await import("../../src/utils/google-oauth.tokens.js");

const app = Fastify();
await app.register(jwt, { secret: process.env.JWT_SECRET });
await app.ready();

test("valid state with its cookie nonce is accepted and returns the PKCE challenge", () => {
  const { state, nonce } = createOAuthState(app, "challenge-1");
  const cookieNonce = readStateCookie(stateCookie(nonce).split(";")[0]);
  assert.equal(verifyOAuthState(app, state, cookieNonce), "challenge-1");
});

test("missing cookie (flow started on a different API host) is rejected", () => {
  const { state } = createOAuthState(app, "c");
  assert.throws(() => verifyOAuthState(app, state, undefined), (e: any) => e.code === "OAUTH_STATE_INVALID");
});

test("missing, tampered, or foreign-nonce state is rejected", () => {
  const a = createOAuthState(app, "c"), b = createOAuthState(app, "c");
  for (const [state, nonce] of [[undefined, a.nonce], ["garbage", a.nonce], [a.state, b.nonce]] as const)
    assert.throws(() => verifyOAuthState(app, state, nonce), (e: any) => e.code === "OAUTH_STATE_INVALID");
});

test("state cookie is HttpOnly, Lax, Secure, scoped to the Google auth routes", () => {
  const c = stateCookie("n");
  for (const part of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/api/v1/auth/google"]) assert.ok(c.includes(part), part);
});
