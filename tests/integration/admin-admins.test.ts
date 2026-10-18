import "dotenv/config";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const skipReason = await isolatedDatabaseSkipReason();
const scrypt = promisify(scryptCallback);

test("admin-created admins and admin-to-admin authorization", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const suffix = randomBytes(6).toString("hex");
  const actingAdminEmail = `acting-admin-${suffix}@example.test`;
  const password = "acting-admin-password-123";
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `${salt}:${Buffer.from((await scrypt(password, salt, 64)) as Buffer).toString("hex")}`;
  let actingAdminId: string | undefined;
  let createdAdminId: string | undefined;
  let customerId: string | undefined;
  try {
    const actingAdmin = await app.prisma.user.create({ data: { name: "Acting Admin", email: actingAdminEmail, passwordHash, role: "ADMIN", isActive: true } });
    actingAdminId = actingAdmin.id;
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/admin/login", payload: { email: actingAdminEmail, password } });
    assert.equal(login.statusCode, 200);
    const adminToken = login.json().data.token;
    const adminHeaders = { authorization: `Bearer ${adminToken}` };

    // Regression: existing admin login + JWT role + /admin/me still work
    const tokenPayload = JSON.parse(Buffer.from(adminToken.split(".")[1], "base64url").toString("utf8"));
    assert.equal(tokenPayload.role, "ADMIN");
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/me", headers: adminHeaders })).statusCode, 200);

    const newAdminEmail = `created-admin-${suffix}@example.test`;

    // 6. unauthenticated -> 401
    const unauthenticated = await app.inject({ method: "POST", url: "/api/v1/admin/admins", payload: { name: "New Admin", email: newAdminEmail, password: "new-admin-password-123" } });
    assert.equal(unauthenticated.statusCode, 401);

    // 7. customer token -> 403
    const customer = await app.prisma.user.create({ data: { name: "Customer", email: `customer-${suffix}@example.test`, passwordHash, role: "CUSTOMER", isActive: true } });
    customerId = customer.id;
    const customerToken = app.jwt.sign({ sub: customer.id, role: "CUSTOMER" });
    const asCustomer = await app.inject({ method: "POST", url: "/api/v1/admin/admins", headers: { authorization: `Bearer ${customerToken}` }, payload: { name: "New Admin", email: newAdminEmail, password: "new-admin-password-123" } });
    assert.equal(asCustomer.statusCode, 403);

    // 8. admin creates another admin -> 201
    const created = await app.inject({ method: "POST", url: "/api/v1/admin/admins", headers: adminHeaders, payload: { name: "New Admin", email: newAdminEmail, password: "new-admin-password-123" } });
    assert.equal(created.statusCode, 201);
    const createdAdmin = created.json().data;
    assert.equal(createdAdmin.role, "ADMIN");
    assert.equal(createdAdmin.email, newAdminEmail);
    // 12. passwordHash never appears in response
    assert.equal("passwordHash" in createdAdmin, false);
    assert.equal("password" in createdAdmin, false);
    createdAdminId = createdAdmin.id;

    // The newly created admin can actually log in
    const newAdminLogin = await app.inject({ method: "POST", url: "/api/v1/auth/admin/login", payload: { email: newAdminEmail, password: "new-admin-password-123" } });
    assert.equal(newAdminLogin.statusCode, 200);

    // 9. role field in body -> 400
    const withRole = await app.inject({ method: "POST", url: "/api/v1/admin/admins", headers: adminHeaders, payload: { name: "X", email: `role-${suffix}@example.test`, password: "some-password-123", role: "ADMIN" } });
    assert.equal(withRole.statusCode, 400);
    assert.equal(withRole.json().error.code, "VALIDATION_ERROR");

    // 10. SUPER_ADMIN field -> 400
    const withSuperAdmin = await app.inject({ method: "POST", url: "/api/v1/admin/admins", headers: adminHeaders, payload: { name: "X", email: `role2-${suffix}@example.test`, password: "some-password-123", role: "SUPER_ADMIN" } });
    assert.equal(withSuperAdmin.statusCode, 400);
    assert.equal(withSuperAdmin.json().error.code, "VALIDATION_ERROR");

    // 11. duplicate email -> 409
    const duplicate = await app.inject({ method: "POST", url: "/api/v1/admin/admins", headers: adminHeaders, payload: { name: "Dup", email: newAdminEmail, password: "some-password-123" } });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, "DUPLICATE_RECORD");
  } finally {
    if (createdAdminId) await app.prisma.user.delete({ where: { id: createdAdminId } }).catch(() => undefined);
    if (customerId) await app.prisma.user.delete({ where: { id: customerId } }).catch(() => undefined);
    if (actingAdminId) await app.prisma.user.delete({ where: { id: actingAdminId } }).catch(() => undefined);
    await app.close();
  }
});
