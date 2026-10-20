// Password reset by emailed link: generic responses, single use, expiry, supersession, concurrency, and
// email failures. Emails go to a fake Resend client. Runs only against the isolated local test database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

// Read by env.ts at import: lift the per-IP OTP limit so one test can make several requests.
process.env.OTP_RATE_LIMIT_MAX = "1000";
process.env.APP_BASE_URL = "https://chamaro.com";

const skipReason = await isolatedDatabaseSkipReason();
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
type Sent = { to: string; subject: string; html: string; text: string };

const GENERIC = "If an account exists for this email, a password reset link has been sent.";
const PASSWORD = "original-password-1";

async function withApp(run: (ctx: Ctx) => Promise<void>, sendResult: () => Promise<{ error: unknown }> = async () => ({ error: null })) {
  const { buildApp } = await import("../../src/app.js");
  const { setEmailClientForTests } = await import("../../src/services/email.service.js");
  const sent: Sent[] = [];
  setEmailClientForTests({ emails: { send: async (message) => { sent.push(message); return sendResult(); } } });
  const app = await buildApp();
  const ctx = new Ctx(app, sent);
  try {
    await run(ctx);
  } finally {
    await ctx.cleanup();
    await app.close();
    setEmailClientForTests(undefined);
  }
}

class Ctx {
  unique = randomBytes(5).toString("hex");
  userIds: string[] = [];
  private counter = 0;
  constructor(readonly app: App, readonly sent: Sent[]) {}

  async user(options: { role?: "CUSTOMER" | "ADMIN"; isActive?: boolean } = {}) {
    const { hashPassword } = await import("../../src/utils/password.js");
    const user = await this.app.prisma.user.create({
      data: { name: "Reset Tester", email: `reset-${this.unique}-${++this.counter}@example.test`, passwordHash: await hashPassword(PASSWORD), role: options.role ?? "CUSTOMER", isActive: options.isActive ?? true },
    });
    this.userIds.push(user.id);
    return user;
  }

  requestLink(email: string) {
    return this.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password/request-link", payload: { email } });
  }

  reset(token: string, newPassword = "brand-new-password-2") {
    return this.app.inject({ method: "POST", url: "/api/v1/auth/reset-password", payload: { token, newPassword } });
  }

  login(email: string, password: string) {
    return this.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  }

  // The token from the most recent reset email.
  lastToken(): string {
    const html = this.sent.at(-1)?.html ?? "";
    const match = html.match(/href="https:\/\/chamaro\.com\/reset-password#token=([A-Za-z0-9_-]{43})"/);
    assert.ok(match, "the email links to the storefront's /reset-password page");
    return match[1];
  }

  async cleanup() {
    await this.app.prisma.user.deleteMany({ where: { id: { in: this.userIds } } }).catch(() => undefined);
  }
}

test("request-link answers the same for unknown, inactive, admin and real customer accounts; only the customer gets an email", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const customer = await ctx.user();
    const inactive = await ctx.user({ isActive: false });
    const admin = await ctx.user({ role: "ADMIN" });
    const bodies = [];
    for (const email of [`nobody-${ctx.unique}@example.test`, inactive.email, admin.email, customer.email.toUpperCase()]) {
      const res = await ctx.requestLink(email);
      assert.equal(res.statusCode, 200);
      bodies.push(res.json());
    }
    for (const body of bodies) assert.deepEqual(body, { success: true, data: { message: GENERIC } });
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].to, customer.email);
    assert.ok(!ctx.sent[0].html.includes("admin."), "the link never points at the admin domain");
  }));

test("only a hash of the token is stored; the link resets the password once and then stops working", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const customer = await ctx.user();
    await ctx.requestLink(customer.email);
    const token = ctx.lastToken();

    const rows = await ctx.app.prisma.passwordResetToken.findMany({ where: { userId: customer.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokenHash, createHash("sha256").update(token).digest("hex"));
    assert.notEqual(rows[0].tokenHash, token);

    const first = await ctx.reset(token);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal((await ctx.login(customer.email, "brand-new-password-2")).statusCode, 200);
    assert.equal((await ctx.login(customer.email, PASSWORD)).statusCode, 401);

    const reused = await ctx.reset(token, "another-password-3");
    assert.equal(reused.statusCode, 400);
    assert.equal(reused.json().error.code, "RESET_TOKEN_INVALID");
    assert.equal((await ctx.login(customer.email, "brand-new-password-2")).statusCode, 200, "the reused link changed nothing");
  }));

test("an expired, unknown or malformed token is refused and changes nothing", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const customer = await ctx.user();
    const token = randomBytes(32).toString("base64url");
    await ctx.app.prisma.passwordResetToken.create({ data: { userId: customer.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() - 1000) } });

    const expired = await ctx.reset(token);
    assert.equal(expired.statusCode, 400);
    assert.equal(expired.json().error.code, "RESET_TOKEN_INVALID");
    assert.equal((await ctx.reset(randomBytes(32).toString("base64url"))).json().error.code, "RESET_TOKEN_INVALID");
    assert.equal((await ctx.reset("short")).statusCode, 400);
    assert.equal((await ctx.login(customer.email, PASSWORD)).statusCode, 200);
  }));

test("a newer link supersedes the older one, and repeat requests inside the cooldown send nothing", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const customer = await ctx.user();
    await ctx.requestLink(customer.email);
    const older = ctx.lastToken();
    await ctx.requestLink(customer.email);
    assert.equal(ctx.sent.length, 1, "inside the resend cooldown no second email is sent");

    // Move the first link out of the cooldown window, then ask again.
    await ctx.app.prisma.passwordResetToken.updateMany({ where: { userId: customer.id }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    await ctx.requestLink(customer.email);
    assert.equal(ctx.sent.length, 2);
    const newer = ctx.lastToken();

    assert.equal((await ctx.reset(older)).json().error.code, "RESET_TOKEN_INVALID");
    assert.equal((await ctx.reset(newer)).statusCode, 200);
  }));

test("two simultaneous resets with the same token: exactly one succeeds", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const customer = await ctx.user();
    await ctx.requestLink(customer.email);
    const token = ctx.lastToken();
    const results = await Promise.all([ctx.reset(token, "parallel-password-a"), ctx.reset(token, "parallel-password-b"), ctx.reset(token, "parallel-password-c")]);
    assert.deepEqual(results.map((res) => res.statusCode).sort(), [200, 400, 400]);
  }));

test("a link issued to a customer who is later made an admin or deactivated cannot reset the password", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    for (const change of [{ role: "ADMIN" as const }, { isActive: false }]) {
      const customer = await ctx.user();
      await ctx.requestLink(customer.email);
      const token = ctx.lastToken();
      await ctx.app.prisma.user.update({ where: { id: customer.id }, data: change });
      const refused = await ctx.reset(token);
      assert.equal(refused.statusCode, 400, JSON.stringify(change));
      assert.equal(refused.json().error.code, "RESET_TOKEN_INVALID");
      const stored = await ctx.app.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
      assert.equal(stored.passwordHash, customer.passwordHash, `${JSON.stringify(change)}: password unchanged`);
    }
  }));

test("a reset by code (OTP) still works and revokes any outstanding reset link", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const customer = await ctx.user();
    await ctx.requestLink(customer.email);
    const token = ctx.lastToken();

    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password/send-otp", payload: { email: customer.email } })).statusCode, 200);
    const otp = ctx.sent.at(-1)!.html.match(/>(\d{6})<\/div>/)![1];
    const viaOtp = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password/reset", payload: { email: customer.email, otp, newPassword: "otp-password-4" } });
    assert.equal(viaOtp.statusCode, 200, viaOtp.body);
    assert.deepEqual(viaOtp.json(), { success: true, data: { message: "Password has been reset successfully." } });

    assert.equal((await ctx.reset(token)).json().error.code, "RESET_TOKEN_INVALID");
    assert.equal((await ctx.login(customer.email, "otp-password-4")).statusCode, 200);
  }));

test("a reset link also retires an outstanding reset code", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const customer = await ctx.user();
    await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password/send-otp", payload: { email: customer.email } });
    const otp = ctx.sent.at(-1)!.html.match(/>(\d{6})<\/div>/)![1];
    await ctx.requestLink(customer.email);
    assert.equal((await ctx.reset(ctx.lastToken())).statusCode, 200);

    const viaOtp = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password/reset", payload: { email: customer.email, otp, newPassword: "otp-password-5" } });
    assert.equal(viaOtp.statusCode, 400);
    assert.equal(viaOtp.json().error.code, "OTP_INVALID");
  }));

test("a failed email still gets the generic answer (no 502 that would reveal the account)", { skip: skipReason }, () =>
  withApp(
    async (ctx) => {
      const customer = await ctx.user();
      const res = await ctx.requestLink(customer.email);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { success: true, data: { message: GENERIC } });
      assert.equal(ctx.sent.length, 1, "the send was attempted");
    },
    async () => ({ error: { message: "provider down" } }),
  ));

// ---- password-changed email and email verification ----------------------------------------------------------------

const CHANGED = "Your Chamaro password was changed";

test("a reset by link verifies the address and sends one password-changed email, with no token in it", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const customer = await ctx.user();
    assert.equal(customer.emailVerifiedAt, null, "an account made before verification existed starts unverified");
    await ctx.requestLink(customer.email);
    const token = ctx.lastToken();
    assert.equal((await ctx.reset(token)).statusCode, 200);

    const changed = ctx.sent.filter((message) => message.subject === CHANGED);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].to, customer.email);
    assert.ok(changed[0].html.includes("https://chamaro.com/account/login?reset=1"), "links the reset form");
    assert.ok(!changed[0].html.includes(token) && !changed[0].text.includes(token), "the used token is not in the email");
    assert.ok((await ctx.app.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).emailVerifiedAt, "using the emailed link verified the address");

    const rows = await ctx.app.prisma.emailNotification.findMany({ where: { userId: customer.id } });
    assert.equal(rows.length, 1, "the reset link itself is never stored in the outbox");
    assert.deepEqual([rows[0].kind, rows[0].status, rows[0].toEmail], ["PASSWORD_CHANGED", "SENT", customer.email]);
    assert.match(rows[0].eventKey, new RegExp(`^user:${customer.id}:password-changed:link:`));
    assert.ok(!JSON.stringify(rows[0]).includes(token));

    assert.equal((await ctx.reset(token)).statusCode, 400);
    assert.equal(ctx.sent.filter((message) => message.subject === CHANGED).length, 1, "a refused reuse sends nothing");
  }));

test("a reset by code sends one password-changed email; admins get no storefront reset link; the code is not stored", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    for (const role of ["CUSTOMER", "ADMIN"] as const) {
      const user = await ctx.user({ role });
      await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password/send-otp", payload: { email: user.email } });
      const otp = ctx.sent.at(-1)!.html.match(/>(\d{6})<\/div>/)![1];
      const res = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password/reset", payload: { email: user.email, otp, newPassword: "otp-password-6" } });
      assert.equal(res.statusCode, 200, res.body);
      const changed = ctx.sent.at(-1)!;
      assert.deepEqual([changed.subject, changed.to], [CHANGED, user.email], role);
      assert.equal(changed.html.includes("reset=1"), role === "CUSTOMER", `${role}: reset link only for customers`);
      const rows = await ctx.app.prisma.emailNotification.findMany({ where: { userId: user.id } });
      assert.deepEqual(rows.map((row) => [row.kind, row.status]), [["PASSWORD_CHANGED", "SENT"]], role);
      assert.ok(!JSON.stringify(rows).includes(otp), `${role}: the code is not stored`);
      assert.ok((await ctx.app.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt, `${role}: verified`);
    }
  }));

test("a failed password-changed email never undoes the reset; it is kept for a retry", { skip: skipReason }, () => {
  let failing = false;
  return withApp(
    async (ctx) => {
      const customer = await ctx.user();
      await ctx.requestLink(customer.email);
      const token = ctx.lastToken();
      failing = true;
      assert.equal((await ctx.reset(token)).statusCode, 200);
      assert.equal((await ctx.login(customer.email, "brand-new-password-2")).statusCode, 200, "the new password works");
      const [row] = await ctx.app.prisma.emailNotification.findMany({ where: { userId: customer.id } });
      assert.deepEqual([row.kind, row.status, row.attempts, row.lastErrorName], ["PASSWORD_CHANGED", "PENDING", 1, "internal_server_error"]);
    },
    async () => (failing ? { error: { name: "internal_server_error", statusCode: 500, message: "down" } } : { error: null }),
  );
});

test("a refused reset (expired link, wrong code) records no email and verifies nothing", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const customer = await ctx.user();
    const token = randomBytes(32).toString("base64url");
    await ctx.app.prisma.passwordResetToken.create({ data: { userId: customer.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await ctx.reset(token)).statusCode, 400);
    await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password/send-otp", payload: { email: customer.email } });
    const wrong = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password/reset", payload: { email: customer.email, otp: "000000", newPassword: "otp-password-7" } });
    assert.equal(wrong.statusCode, 400);
    assert.equal(await ctx.app.prisma.emailNotification.count({ where: { userId: customer.id } }), 0);
    assert.equal((await ctx.app.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).emailVerifiedAt, null);
  }));

test("signing in with an emailed login code verifies the address; a password login does not", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const customer = await ctx.user();
    assert.equal((await ctx.login(customer.email, PASSWORD)).statusCode, 200);
    assert.equal((await ctx.app.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).emailVerifiedAt, null, "a password proves nothing about the inbox");
    await ctx.app.inject({ method: "POST", url: "/api/v1/auth/send-login-otp", payload: { email: customer.email } });
    const otp = ctx.sent.at(-1)!.html.match(/>(\d{6})<\/div>/)![1];
    const res = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify-login-otp", payload: { email: customer.email, otp } });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok((await ctx.app.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).emailVerifiedAt);
  }));
