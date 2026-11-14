// Sign-up by emailed code: an account is only created with a valid, unused code for that exact email, and the
// send-code step answers the same way whether or not the email is registered. Emails go to a fake Resend client.
// Runs only against the isolated local test database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";
import { captureEmails, codeFrom, type SentEmail } from "../helpers/signup.js";

// Read by env.ts at import: lift the per-IP send limit so one test can make several requests.
process.env.OTP_RATE_LIMIT_MAX = "1000";
process.env.APP_BASE_URL = "https://chamaro.com";

const skipReason = await isolatedDatabaseSkipReason();
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
const PASSWORD = "signup-password-1";
const GENERIC = "Check your email for a verification code to finish creating your account.";

async function withApp(run: (ctx: Ctx) => Promise<void>) {
  const { buildApp } = await import("../../src/app.js");
  const emails = captureEmails();
  const app = await buildApp();
  const ctx = new Ctx(app, emails.sent);
  try {
    await run(ctx);
  } finally {
    await app.prisma.user.deleteMany({ where: { email: { contains: ctx.unique } } }).catch(() => undefined);
    await app.prisma.emailOtp.deleteMany({ where: { email: { contains: ctx.unique } } }).catch(() => undefined);
    await app.close();
    emails.stop();
  }
}

class Ctx {
  unique = randomBytes(5).toString("hex");
  private counter = 0;
  // Sign-up allows 5 attempts per hour per client; each call here comes from its own forwarded address.
  private ip = 0;
  constructor(readonly app: App, readonly sent: SentEmail[]) {}

  email(label: string) {
    return `signup-${label}-${this.unique}-${++this.counter}@example.test`;
  }
  private headers() {
    return { "x-forwarded-for": `198.51.100.${++this.ip}` };
  }
  sendCode(email: string) {
    return this.app.inject({ method: "POST", url: "/api/v1/auth/register/send-otp", headers: this.headers(), payload: { email } });
  }
  register(email: string, otp?: string) {
    return this.app.inject({ method: "POST", url: "/api/v1/auth/register", headers: this.headers(), payload: { name: "Signup Tester", email, password: PASSWORD, ...(otp === undefined ? {} : { otp }) } });
  }
  lastEmailTo(email: string) {
    return this.sent.filter((message) => message.to === email).at(-1);
  }
  userCount(email: string) {
    return this.app.prisma.user.count({ where: { email } });
  }
}

test("an account is created only with the emailed code, and the code works once", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const email = ctx.email("new");
    const sent = await ctx.sendCode(email);
    assert.equal(sent.statusCode, 200);
    assert.deepEqual(sent.json(), { success: true, data: { message: GENERIC } });
    const message = ctx.lastEmailTo(email);
    assert.equal(message?.subject, "Verify your Chamaro email");
    const code = codeFrom(message);
    assert.ok(code);

    const missing = await ctx.register(email);
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.code, "VALIDATION_ERROR");

    const wrong = await ctx.register(email, code === "000000" ? "111111" : "000000");
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error.code, "OTP_INVALID");
    assert.equal(await ctx.userCount(email), 0, "a wrong code creates nothing");

    const created = await ctx.register(email, code);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().data.role, "CUSTOMER");
    assert.equal(await ctx.userCount(email), 1);

    const reused = await ctx.register(email, code);
    assert.equal(reused.statusCode, 400);
    assert.equal(reused.json().error.code, "OTP_INVALID");
  }));

test("a code is bound to the email it was sent to", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const owner = ctx.email("owner");
    const other = ctx.email("other");
    await ctx.sendCode(owner);
    const code = codeFrom(ctx.lastEmailTo(owner));
    assert.ok(code);

    const res = await ctx.register(other, code);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "OTP_INVALID");
    assert.equal(await ctx.userCount(other), 0);
  }));

test("a registered email gets sign-in help instead of a code; the answer is identical and sign-up fails at the code check", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const { hashPassword } = await import("../../src/utils/password.js");
    const customerEmail = ctx.email("customer");
    const adminEmail = ctx.email("admin");
    const inactiveEmail = ctx.email("inactive");
    const customer = await ctx.app.prisma.user.create({ data: { name: "Existing", email: customerEmail, passwordHash: await hashPassword(PASSWORD), role: "CUSTOMER" } });
    await ctx.app.prisma.user.create({ data: { name: "Admin", email: adminEmail, passwordHash: await hashPassword(PASSWORD), role: "ADMIN" } });
    await ctx.app.prisma.user.create({ data: { name: "Inactive", email: inactiveEmail, passwordHash: await hashPassword(PASSWORD), role: "CUSTOMER", isActive: false } });

    const bodies = [];
    for (const email of [ctx.email("fresh"), customerEmail, adminEmail, inactiveEmail]) {
      const res = await ctx.sendCode(email);
      assert.equal(res.statusCode, 200, email);
      bodies.push(res.json());
    }
    for (const body of bodies) assert.deepEqual(body, { success: true, data: { message: GENERIC } });

    const help = ctx.lastEmailTo(customerEmail);
    assert.equal(help?.subject, "You already have a Chamaro account");
    assert.equal(codeFrom(help), null, "no code goes to a registered email");
    assert.ok(help?.html.includes('href="https://chamaro.com/account/login"'));
    assert.ok(help?.html.includes('href="https://chamaro.com/account/login?reset=1"'));
    assert.equal(ctx.lastEmailTo(adminEmail), undefined, "admins get nothing");
    assert.equal(ctx.lastEmailTo(inactiveEmail), undefined, "inactive accounts get nothing");

    const duplicate = await ctx.register(customerEmail, "123456");
    assert.equal(duplicate.statusCode, 400);
    assert.equal(duplicate.json().error.code, "OTP_INVALID", "not DUPLICATE_RECORD, which would reveal the account");
    const unchanged = await ctx.app.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(unchanged.name, "Existing");
  }));

test("the resend cooldown applies the same way to new and registered emails", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const { hashPassword } = await import("../../src/utils/password.js");
    const registered = ctx.email("registered");
    await ctx.app.prisma.user.create({ data: { name: "Existing", email: registered, passwordHash: await hashPassword(PASSWORD), role: "CUSTOMER" } });

    for (const email of [ctx.email("fresh"), registered]) {
      assert.equal((await ctx.sendCode(email)).statusCode, 200);
      const again = await ctx.sendCode(email);
      assert.equal(again.statusCode, 429, email);
      assert.equal(again.json().error.code, "OTP_RESEND_COOLDOWN");
    }
  }));

test("every send-code answer takes at least 1.5 seconds", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    for (const email of [ctx.email("timing"), "nobody-at-all@example.test"]) {
      const started = Date.now();
      await ctx.sendCode(email);
      assert.ok(Date.now() - started >= 1450, `${email} answered too fast`);
    }
    await ctx.app.prisma.emailOtp.deleteMany({ where: { email: "nobody-at-all@example.test" } });
  }));

test("an expired code is refused", { skip: skipReason }, () =>
  withApp(async (ctx) => {
    const email = ctx.email("expired");
    await ctx.sendCode(email);
    const code = codeFrom(ctx.lastEmailTo(email));
    assert.ok(code);
    await ctx.app.prisma.emailOtp.updateMany({ where: { email, purpose: "EMAIL_VERIFICATION" }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await ctx.register(email, code);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "OTP_EXPIRED");
    assert.equal(await ctx.userCount(email), 0);
  }));
