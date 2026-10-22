// Persistent customer sessions ("stay signed in"): an HttpOnly cookie renews a short access token; every renewal rotates
// the cookie; a replayed cookie ends the whole session; logout, deactivation, a password change and a foreign Origin all
// stop it; and one customer's cookie can never produce another customer's token. Runs only against the isolated test
// database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
const ORIGIN = "http://localhost:3000";
const PASSWORD = "Correct-horse-battery-9";

class Fixture {
  unique = randomBytes(5).toString("hex");
  userIds: string[] = [];
  private n = 0;
  constructor(readonly app: App) {}

  async user(role: "CUSTOMER" | "ADMIN" = "CUSTOMER") {
    const { hashPassword } = await import("../../src/utils/password.js");
    const email = `s-${this.unique}-${++this.n}@example.test`;
    const user = await this.app.prisma.user.create({
      data: { name: `User ${this.n}`, email, passwordHash: await hashPassword(PASSWORD), role, emailVerifiedAt: new Date(), ...(role === "CUSTOMER" ? { customer: { create: { customerType: "RETAIL" } } } : {}) },
    });
    this.userIds.push(user.id);
    return { id: user.id, email };
  }

  login(email: string, admin = false) {
    return this.app.inject({ method: "POST", url: admin ? "/api/v1/auth/admin/login" : "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  }

  refresh(cookie?: string, origin: string | null = ORIGIN) {
    return this.app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });
  }

  logout(cookie?: string, origin: string | null = ORIGIN) {
    return this.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });
  }

  async cleanup() {
    await this.app.prisma.user.deleteMany({ where: { id: { in: this.userIds } } }).catch(() => undefined);
  }
}

// "chamaro_rt=<token>; Path=...; HttpOnly" -> "chamaro_rt=<token>"
const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers["set-cookie"] ?? "").split(";")[0];
const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { sub: string; exp: number; iat: number; role: string };

async function withFixture(run: (f: Fixture) => Promise<void>) {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const fixture = new Fixture(app);
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
    await app.close();
  }
}

test("customer sign-in sets an HttpOnly session cookie and a 30-minute access token; the page never gets the cookie value", { skip: skipReason }, () =>
  withFixture(async (f) => {
    const customer = await f.user();
    const login = await f.login(customer.email);
    assert.equal(login.statusCode, 200, login.body);
    const raw = String(login.headers["set-cookie"]);
    assert.match(raw, /^chamaro_rt=[A-Za-z0-9_-]{43};/);
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Lax/);
    assert.match(raw, /Path=\/api\/v1\/auth/);
    assert.ok(!login.body.includes(cookieOf(login).split("=")[1]), "the cookie value is not in the response body");
    const { exp, iat, sub } = claims(login.json().data.token);
    assert.equal(exp - iat, 30 * 60);
    assert.equal(sub, customer.id);
    // The row stores a hash, not the token.
    const rows = await f.app.prisma.authSession.findMany({ where: { userId: customer.id } });
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].tokenHash, cookieOf(login).split("=")[1]);
  }));

test("administrators get a 2-hour token and no persistent session", { skip: skipReason }, () =>
  withFixture(async (f) => {
    const admin = await f.user("ADMIN");
    const login = await f.login(admin.email, true);
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.headers["set-cookie"], undefined);
    const { exp, iat } = claims(login.json().data.token);
    assert.equal(exp - iat, 2 * 60 * 60);
    assert.equal(await f.app.prisma.authSession.count({ where: { userId: admin.id } }), 0);
  }));

test("refresh renews the access token, rotates the cookie, and the new token works", { skip: skipReason }, () =>
  withFixture(async (f) => {
    const customer = await f.user();
    const cookie1 = cookieOf(await f.login(customer.email));
    const refreshed = await f.refresh(cookie1);
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const cookie2 = cookieOf(refreshed);
    assert.ok(cookie2.startsWith("chamaro_rt=") && cookie2 !== cookie1, "the cookie was rotated");
    assert.equal(refreshed.headers["cache-control"], "no-store");
    const me = await f.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${refreshed.json().data.token}` } });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().data.id, customer.id);
    // The newest cookie keeps working, and keeps rotating.
    assert.equal((await f.refresh(cookie2)).statusCode, 200);
  }));

test("a copied (already used) cookie replayed after the grace period ends the whole session", { skip: skipReason }, () =>
  withFixture(async (f) => {
    const customer = await f.user();
    const stolen = cookieOf(await f.login(customer.email));
    const legit = cookieOf(await f.refresh(stolen));
    // Inside the grace window the old cookie is still served (two tabs refreshing together) ...
    const second = await f.refresh(stolen);
    assert.equal(second.statusCode, 200);
    // ... but not after it.
    await f.app.prisma.authSession.updateMany({ where: { userId: customer.id, usedAt: { not: null } }, data: { usedAt: new Date(Date.now() - 5 * 60_000) } });
    const replay = await f.refresh(stolen);
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error.code, "SESSION_INVALID");
    assert.match(String(replay.headers["set-cookie"]), /Max-Age=0/, "the cookie is cleared");
    // The replay revoked the family: the legitimate newest cookie is dead too, so the thief gains nothing lasting.
    assert.equal((await f.refresh(legit)).statusCode, 401);
    assert.equal((await f.refresh(cookieOf(second))).statusCode, 401);
  }));

test("refresh and logout refuse a foreign or missing Origin, and no cookie, an unknown cookie or a malformed one is 401", { skip: skipReason }, () =>
  withFixture(async (f) => {
    const customer = await f.user();
    const cookie = cookieOf(await f.login(customer.email));
    for (const origin of ["https://evil.example", null]) {
      const refused = await f.refresh(cookie, origin);
      assert.equal(refused.statusCode, 403, String(origin));
      assert.equal(refused.json().error.code, "ORIGIN_NOT_ALLOWED");
      assert.equal((await f.logout(cookie, origin)).statusCode, 403);
    }
    assert.equal((await f.refresh()).statusCode, 401, "no cookie");
    assert.equal((await f.refresh(`chamaro_rt=${"A".repeat(43)}`)).statusCode, 401, "unknown token");
    assert.equal((await f.refresh("chamaro_rt=short")).statusCode, 401, "malformed token");
    assert.equal((await f.refresh(cookie)).statusCode, 200, "the refused attempts did not use up the real cookie");
  }));

test("logout ends the session: the cookie is cleared and can't be used again", { skip: skipReason }, () =>
  withFixture(async (f) => {
    const customer = await f.user();
    const cookie = cookieOf(await f.login(customer.email));
    const renewed = cookieOf(await f.refresh(cookie));
    const out = await f.logout(renewed);
    assert.equal(out.statusCode, 200, out.body);
    assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await f.refresh(renewed)).statusCode, 401);
    assert.equal((await f.refresh(cookie)).statusCode, 401, "the whole family is gone, not just one cookie");
  }));

test("a deactivated account, or one no longer a customer, can't renew", { skip: skipReason }, () =>
  withFixture(async (f) => {
    const a = await f.user();
    const cookieA = cookieOf(await f.login(a.email));
    await f.app.prisma.user.update({ where: { id: a.id }, data: { isActive: false } });
    assert.equal((await f.refresh(cookieA)).statusCode, 401);

    const b = await f.user();
    const cookieB = cookieOf(await f.login(b.email));
    await f.app.prisma.user.update({ where: { id: b.id }, data: { role: "ADMIN" } });
    assert.equal((await f.refresh(cookieB)).statusCode, 401);
  }));

test("changing the password revokes every session of the account, and only that account's", { skip: skipReason }, () =>
  withFixture(async (f) => {
    const mine = await f.user();
    const other = await f.user();
    const phone = cookieOf(await f.login(mine.email));
    const laptop = cookieOf(await f.login(mine.email));
    const otherCookie = cookieOf(await f.login(other.email));
    const { revokeAllSessions } = await import("../../src/services/session.service.js");
    await f.app.prisma.$transaction((tx) => revokeAllSessions(tx, mine.id));
    assert.equal((await f.refresh(phone)).statusCode, 401);
    assert.equal((await f.refresh(laptop)).statusCode, 401);
    assert.equal((await f.refresh(otherCookie)).statusCode, 200, "another account is untouched");
  }));

test("one customer's cookie only ever yields that customer's token", { skip: skipReason }, () =>
  withFixture(async (f) => {
    const a = await f.user();
    const b = await f.user();
    const cookieA = cookieOf(await f.login(a.email));
    const cookieB = cookieOf(await f.login(b.email));
    const tokenA = (await f.refresh(cookieA)).json().data;
    const tokenB = (await f.refresh(cookieB)).json().data;
    assert.equal(claims(tokenA.token).sub, a.id);
    assert.equal(claims(tokenB.token).sub, b.id);
    assert.equal(tokenA.user.email, a.email);
    assert.equal(tokenB.user.email, b.email);
    assert.notEqual(tokenA.token, tokenB.token);
  }));

test("a user is limited to 20 live sessions; the oldest are revoked", { skip: skipReason }, () =>
  withFixture(async (f) => {
    const customer = await f.user();
    // Sessions are started directly: signing in 21 times would hit the login rate limit, which is its own protection.
    const { createSessionService } = await import("../../src/services/session.service.js");
    const sessions = createSessionService(f.app.prisma);
    const first = await sessions.start(customer.id, null);
    for (let i = 0; i < 20; i++) await sessions.start(customer.id, null);
    assert.equal((await f.refresh(`chamaro_rt=${first.token}`)).statusCode, 401, "the oldest session was pushed out");
    assert.equal(await f.app.prisma.authSession.count({ where: { userId: customer.id, revokedAt: null, usedAt: null } }), 20);
  }));
