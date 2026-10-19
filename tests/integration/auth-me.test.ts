import "dotenv/config";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";
import { registerWithCode } from "../helpers/signup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

const skipReason = await isolatedDatabaseSkipReason();

// HS256 JWT signed with an arbitrary secret, for "valid-looking but untrusted" tokens.
function foreignToken(payload: object, secret: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

test("GET /api/v1/auth/me returns only an active, authenticated customer", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const suffix = randomBytes(6).toString("hex");
  const email = `me-${suffix}@example.test`;
  const password = "customer-password-123";
  const createdUserIds: string[] = [];
  const me = (authorization?: string) =>
    app.inject({ method: "GET", url: "/api/v1/auth/me", headers: authorization ? { authorization } : {} });

  try {
    const registered = await registerWithCode(app, { name: "Me Customer", email, password });
    await app.prisma.emailOtp.deleteMany({ where: { email } });
    assert.equal(registered.statusCode, 201);
    createdUserIds.push(registered.json().data.id);
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
    assert.equal(login.statusCode, 200);
    const token = login.json().data.token as string;

    // Success: safe customer shape, same as registration
    const success = await me(`Bearer ${token}`);
    assert.equal(success.statusCode, 200);
    const body = success.json();
    assert.equal(body.success, true);
    assert.deepEqual(Object.keys(body.data).sort(), ["createdAt", "email", "id", "isActive", "name", "role"]);
    assert.equal(body.data.id, registered.json().data.id);
    assert.equal(body.data.email, email);
    assert.equal(body.data.role, "CUSTOMER");
    assert.equal(body.data.isActive, true);
    assert.equal("passwordHash" in body.data, false);

    // Unauthenticated
    const missing = await me();
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().error.code, "UNAUTHENTICATED");
    assert.equal((await me(token)).statusCode, 401, "missing Bearer scheme");

    // Invalid JWTs
    for (const invalid of [
      "Bearer not-a-jwt",
      `Bearer ${token.slice(0, -2)}xx`, // tampered signature
      `Bearer ${foreignToken({ sub: body.data.id, role: "CUSTOMER" }, "some-other-secret-that-is-long-enough")}`,
      `Bearer ${foreignToken({ sub: body.data.id, role: "CUSTOMER", exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET as string)}`, // expired
    ]) {
      const response = await me(invalid);
      assert.equal(response.statusCode, 401, invalid);
      assert.equal(response.json().error.code, "UNAUTHENTICATED");
    }

    // Token without a CUSTOMER role claim
    assert.equal((await me(`Bearer ${app.jwt.sign({ sub: body.data.id })}`)).statusCode, 403);

    // ADMIN tokens cannot use the customer endpoint
    const admin = await app.prisma.user.create({ data: { name: "Admin", email: `me-admin-${suffix}@example.test`, passwordHash: "x", role: "ADMIN" } });
    createdUserIds.push(admin.id);
    const adminResponse = await me(`Bearer ${app.jwt.sign({ sub: admin.id, role: "ADMIN" })}`);
    assert.equal(adminResponse.statusCode, 403);
    assert.equal(adminResponse.json().error.code, "FORBIDDEN");
    // ...even when forged with a CUSTOMER claim: the database role is checked too
    assert.equal((await me(`Bearer ${app.jwt.sign({ sub: admin.id, role: "CUSTOMER" })}`)).json().error.code, "FORBIDDEN");

    // Inactive customer with a still-valid token
    await app.prisma.user.update({ where: { id: body.data.id }, data: { isActive: false } });
    const inactive = await me(`Bearer ${token}`);
    assert.equal(inactive.statusCode, 403);
    assert.equal(inactive.json().error.code, "ACCOUNT_INACTIVE");

    // Deleted customer
    const ghost = await me(`Bearer ${app.jwt.sign({ sub: `missing-${suffix}`, role: "CUSTOMER" })}`);
    assert.equal(ghost.statusCode, 403);
    assert.equal(ghost.json().error.code, "ACCOUNT_INACTIVE");
  } finally {
    for (const id of createdUserIds) await app.prisma.user.delete({ where: { id } }).catch(() => undefined);
    await app.close();
  }
});
