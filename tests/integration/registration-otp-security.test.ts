// Sign-up by emailed code on the live auth stack: verified accounts, atomic one-time codes (also for login and
// password-reset codes), duplicate and concurrent sign-ups, delivery failures, rate limits, order emails and Google
// linking. Every email goes to a fake Resend client; nothing is ever sent. Runs only against the isolated test database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";
import { codeFrom } from "../helpers/signup.js";

// Read by env.ts at import: lift the per-IP limits so one test can make many requests (limits have their own file).
process.env.OTP_RATE_LIMIT_MAX = "1000";
process.env.AUTH_RATE_LIMIT_MAX = "1000";
process.env.APP_BASE_URL = "https://chamaro.com";

const skipReason = await isolatedDatabaseSkipReason();
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
type Sent = { to: string; subject: string; html: string; text: string };

const PASSWORD = "signup-password-1";
const GENERIC = "Check your email for a verification code to finish creating your account.";

// One fake provider for the whole file: collects messages, or fails every send while `failEmails` is set.
const sent: Sent[] = [];
let failEmails = false;
const { setEmailClientForTests } = await import("../../src/services/email.service.js");
setEmailClientForTests({
  emails: {
    send: async (message) => {
      if (failEmails) return { error: { name: "application_error", statusCode: 500 } };
      sent.push(message);
      return { data: { id: `fake_${randomBytes(4).toString("hex")}` }, error: null };
    },
  },
});

class Ctx {
  unique = randomBytes(5).toString("hex");
  private counter = 0;
  private ip = 0;
  productIds: string[] = [];
  categoryId?: string;
  constructor(readonly app: App, readonly other: App) {}

  email(label: string) {
    return `otpsec-${label}-${this.unique}-${++this.counter}@example.test`;
  }
  // Each request gets its own client address (sign-up allows 5 per hour per client); `ip` pins one when needed.
  headers(ip?: string) {
    return { "x-forwarded-for": ip ?? `203.0.113.${(++this.ip % 250) + 1}` };
  }
  post(url: string, payload: object, options: { app?: App; ip?: string } = {}) {
    return (options.app ?? this.app).inject({ method: "POST", url, headers: this.headers(options.ip), payload });
  }
  sendCode(email: string, options: { app?: App; ip?: string } = {}) {
    return this.post("/api/v1/auth/register/send-otp", { email }, options);
  }
  register(email: string, otp: string | undefined, options: { app?: App; ip?: string; password?: string } = {}) {
    return this.post("/api/v1/auth/register", { name: "OTP Tester", email, password: options.password ?? PASSWORD, ...(otp === undefined ? {} : { otp }) }, options);
  }
  lastCodeFor(email: string) {
    return codeFrom(sent.filter((message) => message.to === email).at(-1));
  }
  async signupCode(email: string) {
    const res = await this.sendCode(email);
    assert.equal(res.statusCode, 200, res.body);
    const code = this.lastCodeFor(email);
    assert.ok(code, "a sign-up code was emailed");
    return code;
  }
  users(email: string) {
    return this.app.prisma.user.findMany({ where: { email } });
  }
  code(email: string, purpose: "EMAIL_VERIFICATION" | "LOGIN" | "FORGOT_PASSWORD" = "EMAIL_VERIFICATION") {
    return this.app.prisma.emailOtp.findFirstOrThrow({ where: { email, purpose }, orderBy: { createdAt: "desc" } });
  }
  // Steps past the 60 s resend cooldown for this email.
  async skipCooldown(email: string) {
    await this.app.prisma.emailOtp.updateMany({ where: { email }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
  }
  async existing(label: string, data: { role?: "CUSTOMER" | "ADMIN"; isActive?: boolean; verified?: boolean } = {}) {
    const { hashPassword } = await import("../../src/utils/password.js");
    return this.app.prisma.user.create({
      data: {
        name: `Existing ${label}`,
        email: this.email(label),
        passwordHash: await hashPassword(PASSWORD),
        role: data.role ?? "CUSTOMER",
        isActive: data.isActive ?? true,
        emailVerifiedAt: data.verified ? new Date() : null,
        ...((data.role ?? "CUSTOMER") === "CUSTOMER" ? { customer: { create: { customerType: "RETAIL" } } } : {}),
      },
    });
  }
}

async function withApps(run: (ctx: Ctx) => Promise<void>) {
  sent.length = 0;
  failEmails = false;
  const { buildApp } = await import("../../src/app.js");
  // Two app instances share the database, like two Cloud Run instances.
  const app = await buildApp();
  const other = await buildApp();
  const ctx = new Ctx(app, other);
  try {
    await run(ctx);
  } finally {
    failEmails = false;
    const { prisma } = app;
    const users = await prisma.user.findMany({ where: { email: { contains: ctx.unique } }, select: { id: true } }).catch(() => []);
    const customers = await prisma.customer.findMany({ where: { userId: { in: users.map((u) => u.id) } }, select: { id: true } }).catch(() => []);
    await prisma.retailOrder.deleteMany({ where: { customerId: { in: customers.map((c) => c.id) } } }).catch(() => undefined);
    await prisma.product.deleteMany({ where: { id: { in: ctx.productIds } } }).catch(() => undefined);
    if (ctx.categoryId) await prisma.category.delete({ where: { id: ctx.categoryId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { contains: ctx.unique } } }).catch(() => undefined);
    await prisma.emailOtp.deleteMany({ where: { email: { contains: ctx.unique } } }).catch(() => undefined);
    await app.close();
    await other.close();
  }
}

const statusCodes = (responses: { statusCode: number; json: () => { error?: { code?: string } } }[]) =>
  responses.map((res) => (res.statusCode === 201 || res.statusCode === 200 ? String(res.statusCode) : `${res.statusCode} ${res.json().error?.code}`));
const count = (values: string[], value: string) => values.filter((v) => v === value).length;

// 1, 10. Success: one verified customer; the code is used up and counted no guesses.
test("a successful sign-up creates one verified customer and uses the code up", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const email = ctx.email("ok");
    const code = await ctx.signupCode(email);
    const res = await ctx.register(email, code);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.success, true);
    assert.deepEqual(Object.keys(body.data).sort(), ["createdAt", "email", "id", "isActive", "name", "role"]);
    assert.equal(body.data.role, "CUSTOMER");

    const [user] = await ctx.users(email);
    assert.ok(user.emailVerifiedAt, "the account starts verified: the code proved the address");
    assert.ok(await ctx.app.prisma.customer.findUnique({ where: { userId: user.id } }), "a RETAIL customer profile exists");
    const otp = await ctx.code(email);
    assert.ok(otp.consumedAt, "the code is used up");
    assert.equal(otp.attempts, 0, "a correct code is not counted as a guess");
    assert.ok(!JSON.stringify(body).includes(otp.otpHash), "the code hash never appears in a response");

    const login = await ctx.post("/api/v1/auth/login", { email, password: PASSWORD });
    assert.equal(login.statusCode, 200, "the new customer signs in with the chosen password");
  }));

// 2, 3, 10. Nothing is created without a valid code for that exact email.
test("a missing, malformed, wrong or another email's code creates nothing", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const email = ctx.email("bad");
    const code = await ctx.signupCode(email);
    const wrong = code === "000000" ? "111111" : "000000";

    const missing = await ctx.register(email, undefined);
    assert.deepEqual([missing.statusCode, missing.json().error.code], [400, "VALIDATION_ERROR"]);
    for (const malformed of ["12345", "1234567", "abcdef", ""]) {
      const res = await ctx.register(email, malformed);
      assert.deepEqual([res.statusCode, res.json().error.code], [400, "VALIDATION_ERROR"], malformed);
    }
    const bad = await ctx.register(email, wrong);
    assert.deepEqual([bad.statusCode, bad.json().error.code], [400, "OTP_INVALID"]);
    const otherEmail = ctx.email("not-the-owner");
    const elsewhere = await ctx.register(otherEmail, code);
    assert.deepEqual([elsewhere.statusCode, elsewhere.json().error.code], [400, "OTP_INVALID"]);
    assert.equal((await ctx.users(email)).length + (await ctx.users(otherEmail)).length, 0, "no account without a valid code");
    assert.equal((await ctx.code(email)).attempts, 1, "only the wrong guess counted");

    const ok = await ctx.register(email, code);
    assert.equal(ok.statusCode, 201, "the right code still works after a wrong guess");
  }));

// 4. Expired codes are refused, and no account appears.
test("an expired code is refused and creates nothing", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const email = ctx.email("expired");
    const code = await ctx.signupCode(email);
    await ctx.app.prisma.emailOtp.updateMany({ where: { email }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await ctx.register(email, code);
    assert.deepEqual([res.statusCode, res.json().error.code], [400, "OTP_EXPIRED"]);
    assert.equal((await ctx.users(email)).length, 0);
  }));

// 5. A used code, and a code replaced by a newer one, are refused.
test("a used code and a superseded code are refused", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const email = ctx.email("reuse");
    const first = await ctx.signupCode(email);
    await ctx.skipCooldown(email);
    const second = await ctx.signupCode(email);
    if (first !== second) {
      const superseded = await ctx.register(email, first);
      assert.deepEqual([superseded.statusCode, superseded.json().error.code], [400, "OTP_INVALID"], "a resend replaces the earlier code");
    }
    assert.equal((await ctx.register(email, second)).statusCode, 201);
    const reused = await ctx.register(email, second, { password: "another-password-2" });
    assert.deepEqual([reused.statusCode, reused.json().error.code], [400, "OTP_INVALID"]);
    assert.equal((await ctx.users(email)).length, 1);
  }));

// 6, 7. Concurrency across two instances: one code, one account.
test("concurrent sign-ups with the same code (two instances) create exactly one account", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const email = ctx.email("race");
    const code = await ctx.signupCode(email);
    const passwords = Array.from({ length: 8 }, (_, i) => `race-password-${i}-x`);
    const results = await Promise.all(passwords.map((password, i) => ctx.register(email, code, { app: i % 2 ? ctx.other : ctx.app, password })));
    const outcomes = statusCodes(results);
    assert.equal(count(outcomes, "201"), 1, outcomes.join(", "));
    // Every other request is refused. Beyond OTP_MAX_ATTEMPTS requests in flight at once, the guess allowance is
    // momentarily all reserved, so the extra ones are told OTP_MAX_ATTEMPTS instead of OTP_INVALID.
    assert.equal(outcomes.filter((o) => o !== "201" && o !== "400 OTP_INVALID" && o !== "429 OTP_MAX_ATTEMPTS").length, 0, outcomes.join(", "));
    const used = await ctx.code(email);
    assert.ok(used.consumedAt);
    assert.equal(used.attempts, 0, "correct submissions never count as guesses");
    const users = await ctx.users(email);
    assert.equal(users.length, 1);
    assert.ok(users[0].emailVerifiedAt);

    const winner = passwords[results.findIndex((res) => res.statusCode === 201)];
    assert.equal((await ctx.post("/api/v1/auth/login", { email, password: winner })).statusCode, 200, "the winning request's password is the account's");
    const loser = passwords.find((password) => password !== winner)!;
    assert.equal((await ctx.post("/api/v1/auth/login", { email, password: loser })).statusCode, 401);
  }));

// 6. Parallel wrong guesses can't exceed the allowance, and the code is then dead.
test("parallel wrong guesses never compare more than OTP_MAX_ATTEMPTS guesses", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const { env } = await import("../../src/config/env.js");
    const email = ctx.email("guess");
    const code = await ctx.signupCode(email);
    const wrongs = Array.from({ length: 12 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0"));
    const outcomes = statusCodes(await Promise.all(wrongs.map((wrong, i) => ctx.register(email, wrong, { app: i % 2 ? ctx.other : ctx.app }))));
    assert.equal(count(outcomes, "400 OTP_INVALID"), env.OTP_MAX_ATTEMPTS, outcomes.join(", "));
    assert.equal(count(outcomes, "429 OTP_MAX_ATTEMPTS"), wrongs.length - env.OTP_MAX_ATTEMPTS, outcomes.join(", "));
    assert.equal((await ctx.code(email)).attempts, env.OTP_MAX_ATTEMPTS);

    const late = await ctx.register(email, code);
    assert.deepEqual([late.statusCode, late.json().error.code], [429, "OTP_MAX_ATTEMPTS"], "even the right code is refused once the guesses are spent");
    assert.equal((await ctx.users(email)).length, 0);
  }));

// 8. Duplicate emails.
test("duplicates: a registered email fails at the code; an account made meanwhile gives 409 and stays untouched", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const existing = await ctx.existing("dup", { verified: true });
    assert.equal((await ctx.sendCode(existing.email)).statusCode, 200);
    assert.equal(ctx.lastCodeFor(existing.email), null, "a registered email never receives a code");
    const guess = await ctx.register(existing.email, "123456");
    assert.deepEqual([guess.statusCode, guess.json().error.code], [400, "OTP_INVALID"]);

    // The address got an account between the code and the sign-up (e.g. Google sign-in in another tab).
    const email = ctx.email("meanwhile");
    const code = await ctx.signupCode(email);
    const other = await ctx.app.prisma.user.create({ data: { name: "Made Meanwhile", email, passwordHash: "unused", emailVerifiedAt: new Date(), role: "CUSTOMER" } });
    const late = await ctx.register(email, code);
    assert.deepEqual([late.statusCode, late.json().error.code], [409, "DUPLICATE_RECORD"]);
    const users = await ctx.users(email);
    assert.deepEqual(users.map((u) => [u.id, u.name]), [[other.id, "Made Meanwhile"]], "the existing account is unchanged");
    assert.ok((await ctx.code(email)).consumedAt, "the code is used up either way");
  }));

// 9. A customer made by sign-up gets order emails; an unverified one would not.
test("a signed-up (verified) customer's order email is queued; an unverified customer's is skipped", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const { prisma } = ctx.app;
    ctx.categoryId = (await prisma.category.create({ data: { name: `OTP ${ctx.unique}`, slug: `otp-${ctx.unique}` } })).id;
    const product = await prisma.product.create({ data: { name: `OTP Chair ${ctx.unique}`, slug: `otp-chair-${ctx.unique}`, price: "1000.00", status: "ACTIVE", categoryId: ctx.categoryId, inventory: { create: { quantity: 10 } } } });
    ctx.productIds.push(product.id);

    const placeOrder = async (headers: Record<string, string>) => {
      const address = await ctx.app.inject({ method: "POST", url: "/api/v1/addresses", headers, payload: { name: "Asha Rao", phone: "+91 98765 43210", addressLine1: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: "560001" } });
      assert.equal(address.statusCode, 201, address.body);
      assert.equal((await ctx.app.inject({ method: "PUT", url: "/api/v1/cart", headers, payload: { items: [{ productId: product.id, quantity: 1 }] } })).statusCode, 200);
      const placed = await ctx.app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...headers, "idempotency-key": `otp-${randomBytes(8).toString("hex")}` }, payload: { addressId: address.json().data.id, shippingMethod: "standard" } });
      assert.equal(placed.statusCode, 201, placed.body);
      return prisma.emailNotification.findFirstOrThrow({ where: { orderId: placed.json().data.id, kind: "ORDER_PLACED" } });
    };

    const email = ctx.email("buyer");
    assert.equal((await ctx.register(email, await ctx.signupCode(email))).statusCode, 201);
    const login = await ctx.post("/api/v1/auth/login", { email, password: PASSWORD });
    assert.equal(login.statusCode, 200);
    const verified = await placeOrder({ authorization: `Bearer ${login.json().data.token}` });
    assert.notEqual(verified.status, "SKIPPED", "the order email is queued for a signed-up customer");
    assert.equal(verified.toEmail, email);

    const unverified = await ctx.existing("legacy", { verified: false });
    const skipped = await placeOrder({ authorization: `Bearer ${ctx.app.jwt.sign({ sub: unverified.id, role: "CUSTOMER" })}` });
    assert.deepEqual([skipped.status, skipped.skipReason], ["SKIPPED", "UNVERIFIED_RECIPIENT"], "control: an unverified address gets nothing");
  }));

// 11. Registered and unregistered emails get the same answer.
test("send-code answers identically for new, customer, admin and inactive emails", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const customer = await ctx.existing("cust", { verified: true });
    const admin = await ctx.existing("admin", { role: "ADMIN" });
    const inactive = await ctx.existing("inactive", { isActive: false });
    const answers = [];
    for (const email of [ctx.email("fresh"), customer.email, admin.email, inactive.email]) {
      const res = await ctx.sendCode(email);
      answers.push([res.statusCode, res.body]);
    }
    for (const answer of answers) assert.deepEqual(answer, [200, JSON.stringify({ success: true, data: { message: GENERIC } })]);
    const help = sent.filter((message) => message.to === customer.email).at(-1);
    assert.equal(help?.subject, "You already have a Chamaro account");
    assert.ok(help?.text.includes("https://chamaro.com/account/login"), "the help email has a plain-text part");
    assert.equal(codeFrom(help), null);
  }));

// 12. Delivery failures.
test("a failed email is a 502 EMAIL_SEND_FAILED for new and registered emails alike, and creates nothing", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const customer = await ctx.existing("failcust", { verified: true });
    const fresh = ctx.email("failnew");
    failEmails = true;
    const answers = [];
    for (const email of [fresh, customer.email]) {
      const res = await ctx.sendCode(email);
      answers.push([res.statusCode, res.json().error.code, res.json().error.message]);
    }
    // The shared error handler reports every 5xx as 500 with a generic message and keeps the code (as for login and
    // reset codes); the storefront maps EMAIL_SEND_FAILED by code. Both cases answer identically.
    for (const answer of answers) assert.deepEqual(answer, [500, "EMAIL_SEND_FAILED", "An unexpected error occurred"]);
    assert.equal((await ctx.users(fresh)).length, 0);

    // The undelivered code still starts the cooldown (as for login codes); after it, a new code arrives and works.
    failEmails = false;
    const soon = await ctx.sendCode(fresh);
    assert.deepEqual([soon.statusCode, soon.json().error.code], [429, "OTP_RESEND_COOLDOWN"]);
    await ctx.skipCooldown(fresh);
    assert.equal((await ctx.register(fresh, await ctx.signupCode(fresh))).statusCode, 201);
  }));

// 13. Rate limit on sign-up itself (5 per hour per client) and the resend cooldown.
test("sign-up is limited to 5 requests per hour per client, and codes to one per minute per email", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const email = ctx.email("limit");
    await ctx.signupCode(email);
    const again = await ctx.sendCode(email);
    assert.deepEqual([again.statusCode, again.json().error.code], [429, "OTP_RESEND_COOLDOWN"]);

    // An email with no code, so every attempt is a plain OTP_INVALID and only the rate limit can answer 429.
    const noCode = ctx.email("limit-nocode");
    const ip = "198.51.100.77";
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push(statusCodes([await ctx.register(noCode, "000000", { ip })])[0]);
    assert.deepEqual(statuses.slice(0, 5), Array(5).fill("400 OTP_INVALID"), statuses.join(","));
    assert.match(statuses[5], /^429 /, statuses.join(","));
    assert.deepEqual(statusCodes([await ctx.register(noCode, "000000")]), ["400 OTP_INVALID"], "another client is not affected");
  }));

// 14. Login and password-reset codes keep their behaviour, and gain the atomic use.
test("login codes: same answers as before one at a time, and one winner in parallel", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const { env } = await import("../../src/config/env.js");
    const customer = await ctx.existing("login", { verified: false });
    const sendLogin = async () => {
      await ctx.skipCooldown(customer.email);
      assert.equal((await ctx.post("/api/v1/auth/send-login-otp", { email: customer.email })).statusCode, 200);
      const code = ctx.lastCodeFor(customer.email);
      assert.ok(code);
      return code;
    };
    const verify = (otp: string, app?: App) => ctx.post("/api/v1/auth/verify-login-otp", { email: customer.email, otp }, { app });

    const code = await sendLogin();
    const ok = await verify(code);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(ok.json().data.token);
    assert.ok((await ctx.app.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).emailVerifiedAt, "a login code still verifies the address");
    assert.deepEqual(statusCodes([await verify(code)]), ["400 OTP_INVALID"], "a used login code is refused");

    // One at a time: every wrong guess is OTP_INVALID until the allowance is spent, then even the right code is refused.
    const fresh = await sendLogin();
    const wrong = fresh === "000000" ? "111111" : "000000";
    const sequence = [];
    for (let i = 0; i < env.OTP_MAX_ATTEMPTS; i++) sequence.push(...statusCodes([await verify(wrong)]));
    sequence.push(...statusCodes([await verify(fresh)]));
    assert.deepEqual(sequence, [...Array(env.OTP_MAX_ATTEMPTS).fill("400 OTP_INVALID"), "429 OTP_MAX_ATTEMPTS"]);

    // In parallel across two instances: exactly one sign-in per code.
    const raced = await sendLogin();
    const outcomes = statusCodes(await Promise.all(Array.from({ length: 6 }, (_, i) => verify(raced, i % 2 ? ctx.other : ctx.app))));
    assert.equal(count(outcomes, "200"), 1, outcomes.join(", "));
    assert.equal(outcomes.filter((o) => o !== "200" && o !== "400 OTP_INVALID" && o !== "429 OTP_MAX_ATTEMPTS").length, 0, outcomes.join(", "));
    const usedLogin = await ctx.code(customer.email, "LOGIN");
    assert.ok(usedLogin.consumedAt);
    assert.equal(usedLogin.attempts, 0, "correct submissions never count as guesses");
    // Two at once (a double click) are both answered precisely: one sign-in, one OTP_INVALID.
    const doubled = await sendLogin();
    assert.deepEqual(statusCodes(await Promise.all([verify(doubled), verify(doubled, ctx.other)])).sort(), ["200", "400 OTP_INVALID"]);
  }));

test("password-reset codes: the non-consuming check doesn't use up guesses or the code; reset uses it once", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const customer = await ctx.existing("reset", { verified: true });
    assert.equal((await ctx.post("/api/v1/auth/forgot-password/send-otp", { email: customer.email })).statusCode, 200);
    const code = ctx.lastCodeFor(customer.email);
    assert.ok(code);
    for (let i = 0; i < 7; i++) {
      const check = await ctx.post("/api/v1/auth/forgot-password/verify-otp", { email: customer.email, otp: code });
      assert.equal(check.statusCode, 200, `check ${i + 1}: ${check.body}`);
    }
    assert.equal((await ctx.code(customer.email, "FORGOT_PASSWORD")).attempts, 0, "correct checks are not counted as guesses");
    const reset = await ctx.post("/api/v1/auth/forgot-password/reset", { email: customer.email, otp: code, newPassword: "new-password-after-otp-1" });
    assert.equal(reset.statusCode, 200, reset.body);
    const again = await ctx.post("/api/v1/auth/forgot-password/reset", { email: customer.email, otp: code, newPassword: "new-password-after-otp-2" });
    assert.deepEqual(statusCodes([again]), ["400 OTP_INVALID"]);
  }));

// 15. Google sign-in links to a signed-up account (it is verified), as for any verified customer.
test("Google sign-in links to an account made by sign-up; an unverified account still needs verification", { skip: skipReason }, () =>
  withApps(async (ctx) => {
    const { googleProvider } = await import("../../src/providers/google.provider.js");
    const { createAuthService } = await import("../../src/services/auth.service.js");
    const original = googleProvider.verifyGoogleCallback;
    try {
      const email = ctx.email("google");
      const created = await ctx.register(email, await ctx.signupCode(email));
      assert.equal(created.statusCode, 201);
      googleProvider.verifyGoogleCallback = async () => ({ googleId: `g-${ctx.unique}-1`, email, name: "Google Name" });
      const linked = await createAuthService(ctx.app.prisma).completeGoogleLogin("code");
      assert.equal(linked.id, created.json().data.id, "the same account, now linked");
      assert.equal(linked.googleId, `g-${ctx.unique}-1`);

      const legacy = await ctx.existing("google-legacy", { verified: false });
      googleProvider.verifyGoogleCallback = async () => ({ googleId: `g-${ctx.unique}-2`, email: legacy.email, name: "Legacy" });
      await assert.rejects(createAuthService(ctx.app.prisma).completeGoogleLogin("code"), (error: { code?: string }) => error.code === "GOOGLE_EMAIL_NEEDS_VERIFICATION");
    } finally {
      googleProvider.verifyGoogleCallback = original;
    }
  }));
