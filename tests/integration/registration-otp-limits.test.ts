// The sign-up code request uses the OTP rate limit at its configured default (OTP_RATE_LIMIT_MAX, 5 per 10 minutes per
// client), unlike registration-otp*.test.ts, which lift it. Its own file, because the limit is read once at import.
// Every email goes to a fake Resend client. Runs only against the isolated test database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

delete process.env.OTP_RATE_LIMIT_MAX;
delete process.env.OTP_RATE_LIMIT_WINDOW;
const skipReason = await isolatedDatabaseSkipReason();

test("send-code is limited per client to OTP_RATE_LIMIT_MAX requests; other clients are unaffected", { skip: skipReason }, async () => {
  const { setEmailClientForTests } = await import("../../src/services/email.service.js");
  setEmailClientForTests({ emails: { send: async () => ({ data: { id: "fake" }, error: null }) } });
  const { env } = await import("../../src/config/env.js");
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const unique = randomBytes(5).toString("hex");
  try {
    assert.equal(env.OTP_RATE_LIMIT_MAX, 5, "the default applies");
    const send = (n: number, ip: string) =>
      app.inject({ method: "POST", url: "/api/v1/auth/register/send-otp", headers: { "x-forwarded-for": ip }, payload: { email: `otplimit-${unique}-${n}@example.test` } });
    const statuses = [];
    for (let i = 0; i <= env.OTP_RATE_LIMIT_MAX; i++) statuses.push((await send(i, "198.51.100.91")).statusCode);
    assert.deepEqual(statuses, [...Array(env.OTP_RATE_LIMIT_MAX).fill(200), 429]);
    assert.equal((await send(99, "198.51.100.92")).statusCode, 200, "another client is not affected");
  } finally {
    await app.prisma.emailOtp.deleteMany({ where: { email: { contains: unique } } }).catch(() => undefined);
    await app.close();
    setEmailClientForTests(undefined);
  }
});
