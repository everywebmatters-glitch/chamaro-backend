import "dotenv/config";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";
import { captureEmails, codeFrom, registerWithCode } from "../helpers/signup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const skipReason = await isolatedDatabaseSkipReason();
const scrypt = promisify(scryptCallback);

async function passwordHashFor(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${Buffer.from((await scrypt(password, salt, 64)) as Buffer).toString("hex")}`;
}

test("customer registration and login", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const suffix = randomBytes(6).toString("hex");
  const email = `register-${suffix}@example.test`;
  const password = "customer-password-123";
  let userId: string | undefined;
  try {
    // 13. register (with the emailed sign-up code) -> 201, 14. registered user has CUSTOMER role
    const register = await registerWithCode(app, { name: "New Customer", email, password });
    assert.equal(register.statusCode, 201);
    const registered = register.json().data;
    assert.equal(registered.role, "CUSTOMER");
    assert.equal(registered.email, email);
    assert.equal("passwordHash" in registered, false);
    assert.equal("password" in registered, false);
    userId = registered.id;

    // 15. role field in body -> 400
    const withRole = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { name: "Other", email: `role-${suffix}@example.test`, password, otp: "123456", role: "ADMIN" } });
    assert.equal(withRole.statusCode, 400);
    assert.equal(withRole.json().error.code, "VALIDATION_ERROR");

    const withSuperAdmin = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { name: "Other", email: `role2-${suffix}@example.test`, password, otp: "123456", role: "SUPER_ADMIN" } });
    assert.equal(withSuperAdmin.statusCode, 400);
    assert.equal(withSuperAdmin.json().error.code, "VALIDATION_ERROR");

    // 16. duplicate registration: the registered email is sent sign-in help instead of a code, so the
    // sign-up attempt fails at the code check (400 OTP_INVALID) without revealing that the account exists.
    // Step past the resend cooldown left by this email's sign-up code a moment ago.
    await app.prisma.emailOtp.updateMany({ where: { email }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    const emails = captureEmails();
    try {
      const sendForExisting = await app.inject({ method: "POST", url: "/api/v1/auth/register/send-otp", payload: { email } });
      assert.equal(sendForExisting.statusCode, 200);
      assert.equal(codeFrom(emails.sent.at(-1)), null, "no sign-up code goes to a registered email");
    } finally {
      emails.stop();
    }
    const duplicate = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { name: "Duplicate", email, password, otp: "000000" } });
    assert.equal(duplicate.statusCode, 400);
    assert.equal(duplicate.json().error.code, "OTP_INVALID");

    // 17. customer login -> 200
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().data.user.role, "CUSTOMER");
    assert.equal("passwordHash" in login.json().data.user, false);
    const tokenPayload = JSON.parse(Buffer.from(login.json().data.token.split(".")[1], "base64url").toString("utf8"));
    assert.equal(tokenPayload.role, "CUSTOMER");

    // 18. wrong password -> 401
    const wrongPassword = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "wrong-password-123" } });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(wrongPassword.json().error.code, "INVALID_CREDENTIALS");

    // 19. nonexistent email -> 401 (same code/shape as wrong password -- no information leak)
    const nonexistent = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: `missing-${suffix}@example.test`, password } });
    assert.equal(nonexistent.statusCode, 401);
    assert.equal(nonexistent.json().error.code, "INVALID_CREDENTIALS");

    // Inactive account -> 401 (same generic response)
    const inactiveEmail = `inactive-${suffix}@example.test`;
    const inactiveUser = await app.prisma.user.create({ data: { name: "Inactive", email: inactiveEmail, passwordHash: await passwordHashFor(password), role: "CUSTOMER", isActive: false } });
    const inactiveLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: inactiveEmail, password } });
    assert.equal(inactiveLogin.statusCode, 401);
    assert.equal(inactiveLogin.json().error.code, "INVALID_CREDENTIALS");
    await app.prisma.user.delete({ where: { id: inactiveUser.id } }).catch(() => undefined);

    // Google-only account (no local password) -> 401, not a crash or a distinguishing error
    const googleOnlyEmail = `google-only-${suffix}@example.test`;
    const googleOnlyUser = await app.prisma.user.create({ data: { name: "Google Only", email: googleOnlyEmail, googleId: `gid-${suffix}`, passwordHash: "GOOGLE_OAUTH_NO_PASSWORD", role: "CUSTOMER", isActive: true } });
    const googleOnlyLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: googleOnlyEmail, password } });
    assert.equal(googleOnlyLogin.statusCode, 401);
    assert.equal(googleOnlyLogin.json().error.code, "INVALID_CREDENTIALS");
    await app.prisma.user.delete({ where: { id: googleOnlyUser.id } }).catch(() => undefined);

    // An ADMIN account cannot use the customer login endpoint
    const adminEmail = `admin-login-${suffix}@example.test`;
    const adminUser = await app.prisma.user.create({ data: { name: "Admin", email: adminEmail, passwordHash: await passwordHashFor(password), role: "ADMIN", isActive: true } });
    const adminViaCustomerLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: adminEmail, password } });
    assert.equal(adminViaCustomerLogin.statusCode, 401);
    await app.prisma.user.delete({ where: { id: adminUser.id } }).catch(() => undefined);
  } finally {
    if (userId) await app.prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await app.prisma.user.deleteMany({ where: { email: { contains: suffix } } }).catch(() => undefined);
    await app.prisma.emailOtp.deleteMany({ where: { email: { contains: suffix } } }).catch(() => undefined);
    await app.close();
  }
});
