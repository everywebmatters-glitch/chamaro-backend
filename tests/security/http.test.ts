// Security regression tests through Fastify's in-process inject (no server, no database writes).
// Requests that fail validation or auth never reach Prisma; one test reads a user by id (read-only).
import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createSigner } from "fast-jwt";
import { buildApp } from "../../src/app.js";
import { redactUrl } from "../../src/config/logger.js";

const app = await buildApp();
after(() => app.close());

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
// Each test uses its own forwarded client IP (inject connects from loopback, a trusted proxy).
const from = (ip: string) => ({ "x-forwarded-for": ip });

test("M1: registration is limited to 5 requests per hour per IP", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    // Invalid bodies: nothing is ever created, but each attempt still counts.
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: from("203.0.113.10"), payload: { email: "not-an-email" } });
    statuses.push(res.statusCode);
  }
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429]);
  const other = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: from("203.0.113.11"), payload: { email: "not-an-email" } });
  assert.equal(other.statusCode, 400, "a different visitor has their own limit");
});

test("L2: only HS256 access tokens are accepted", async () => {
  const secret = process.env.JWT_SECRET!;
  const claims = { sub: "no-such-user", role: "ADMIN" };
  const hs256 = createSigner({ key: secret, algorithm: "HS256" })(claims);
  const hs512 = createSigner({ key: secret, algorithm: "HS512" })(claims);
  const none = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
  const call = (token: string) => app.inject({ method: "GET", url: "/api/v1/admin/me", headers: { authorization: `Bearer ${token}` } });
  // HS256 passes signature checks and is then refused by the database re-check (no such user).
  assert.equal((await call(hs256)).statusCode, 403);
  assert.equal((await call(hs512)).statusCode, 401, "HS512 with the right secret is rejected");
  assert.equal((await call(none)).statusCode, 401, "alg=none is rejected");
});

test("M4: Swagger is available outside production", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/docs/json" })).statusCode, 200);
});

test("L1: security headers on API responses; HSTS only over HTTPS", async () => {
  const plain = await app.inject({ method: "GET", url: "/health" });
  assert.equal(plain.headers["x-content-type-options"], "nosniff");
  assert.equal(plain.headers["x-frame-options"], "DENY");
  assert.equal(plain.headers["referrer-policy"], "no-referrer");
  assert.equal(plain.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
  assert.equal(plain.headers["strict-transport-security"], undefined, "no HSTS over plain HTTP");
  const https = await app.inject({ method: "GET", url: "/health", headers: { "x-forwarded-proto": "https" } });
  assert.equal(https.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
});

test("L6: media metadata bodies reject unexpected fields", async () => {
  const valid = { url: "https://cdn.example.com/a.jpg", filename: "a.jpg", mimeType: "image/jpeg" };
  // Validation runs before the handler's admin check, so no token is needed to see the 400.
  const withExtra = await app.inject({ method: "POST", url: "/api/v1/admin/media", payload: { ...valid, size: 10 } });
  assert.equal(withExtra.statusCode, 400);
  assert.equal(withExtra.json().error.code, "VALIDATION_ERROR");
  const update = await app.inject({ method: "PUT", url: "/api/v1/admin/media/some-id", payload: { urlHash: "x" } });
  assert.equal(update.statusCode, 400);
  const clean = await app.inject({ method: "POST", url: "/api/v1/admin/media", payload: valid });
  assert.equal(clean.statusCode, 401, "a valid body passes validation and reaches the admin check");
});

test("L7: banner URLs must be http(s)", async () => {
  const banner = (imageUrl: string, extra: object = {}) =>
    app.inject({ method: "POST", url: "/api/v1/admin/cms/banners", payload: { title: "t", imageUrl, ...extra } });
  for (const unsafe of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "file:///etc/passwd", "vbscript:msgbox", "ftp://x.example/a.jpg"]) {
    const res = await banner(unsafe);
    assert.equal(res.statusCode, 400, unsafe);
  }
  assert.equal((await banner("https://cdn.example.com/b.jpg", { linkUrl: "javascript:alert(1)" })).statusCode, 400, "linkUrl too");
  assert.equal((await banner("https://cdn.example.com/b.jpg", { linkUrl: "https://chamaro.com/sale" })).statusCode, 401, "safe URLs pass validation");
});

test("L9: auth URLs are logged without their query string", () => {
  assert.equal(redactUrl("/api/v1/auth/google/callback?code=4/abc&state=xyz"), "/api/v1/auth/google/callback?[redacted]");
  assert.equal(redactUrl("/api/v1/auth/google?code_challenge=abc"), "/api/v1/auth/google?[redacted]");
  assert.equal(redactUrl("/api/v1/products?search=chair"), "/api/v1/products?search=chair");
});
