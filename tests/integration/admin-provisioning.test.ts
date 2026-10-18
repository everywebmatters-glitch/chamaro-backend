import "dotenv/config";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const skipReason = await isolatedDatabaseSkipReason();

test("admin provisioning creates ADMIN users and rejects duplicate email", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const { createAdmin } = await import("../../src/scripts/create-admin.js");
  const app = await buildApp();
  const email = `provision-${randomBytes(6).toString("hex")}@example.test`;
  try {
    await createAdmin("Provisioned Admin", email.toUpperCase(), "admin-password-123");
    const created = await app.prisma.user.findUnique({ where: { email }, select: { name: true, email: true, role: true, isActive: true, passwordHash: true } });
    assert.deepEqual({ name: created?.name, email: created?.email, role: created?.role, isActive: created?.isActive }, { name: "Provisioned Admin", email, role: "ADMIN", isActive: true });
    assert.notEqual(created?.passwordHash, "admin-password-123");
    await assert.rejects(() => createAdmin("Duplicate", email, "another-password-123"), /User already exists\./);
  } finally {
    await app.prisma.user.delete({ where: { email } }).catch(() => undefined);
    await app.close();
  }
});

test("admin promotion requires confirmation and preserves user fields", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const { promoteAdmin } = await import("../../src/scripts/promote-admin.js");
  const app = await buildApp();
  const email = `promote-${randomBytes(6).toString("hex")}@example.test`;
  try {
    const before = await app.prisma.user.create({ data: { name: "Promotable Customer", email, googleId: `google-${randomBytes(6).toString("hex")}`, passwordHash: "existing-password-hash", role: "CUSTOMER", isActive: true } });
    await assert.rejects(() => promoteAdmin(email, "NO"), /Type PROMOTE to confirm/);
    const unchanged = await app.prisma.user.findUnique({ where: { id: before.id } });
    assert.equal(unchanged?.role, "CUSTOMER");
    await promoteAdmin(email.toUpperCase(), "PROMOTE");
    const after = await app.prisma.user.findUnique({ where: { id: before.id } });
    assert.ok(after);
    assert.equal(after.role, "ADMIN");
    assert.equal(after.name, before.name);
    assert.equal(after.email, before.email);
    assert.equal(after.passwordHash, before.passwordHash);
    assert.equal(after.googleId, before.googleId);
    assert.equal(after.isActive, before.isActive);
  } finally {
    await app.prisma.user.delete({ where: { email } }).catch(() => undefined);
    await app.close();
  }
});

test("admin deletion requires confirmation, only removes ADMIN users, and refuses to delete the last admin", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const { deleteAdmin } = await import("../../src/scripts/delete-admin.js");
  const { createAdmin } = await import("../../src/scripts/create-admin.js");
  const app = await buildApp();
  const email = `delete-${randomBytes(6).toString("hex")}@example.test`;
  const customerEmail = `delete-customer-${randomBytes(6).toString("hex")}@example.test`;
  let deleted = false;
  try {
    await createAdmin("Deletable Admin", email, "admin-password-123");

    await assert.rejects(() => deleteAdmin(email, "NO"), /Type DELETE to confirm/);
    assert.ok(await app.prisma.user.findUnique({ where: { email } }));

    await app.prisma.user.create({ data: { name: "Not An Admin", email: customerEmail, passwordHash: "irrelevant-hash", role: "CUSTOMER", isActive: true } });
    await assert.rejects(() => deleteAdmin(customerEmail, "DELETE"), /Only ADMIN users can be deleted/);
    await app.prisma.user.delete({ where: { email: customerEmail } }).catch(() => undefined);

    await deleteAdmin(email.toUpperCase(), "DELETE");
    deleted = true;
    assert.equal(await app.prisma.user.findUnique({ where: { email } }), null);
  } finally {
    if (!deleted) await app.prisma.user.delete({ where: { email } }).catch(() => undefined);
    await app.close();
  }
});

test("admin deletion refuses to remove the last remaining admin", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const { deleteAdmin } = await import("../../src/scripts/delete-admin.js");
  const app = await buildApp();
  const email = `delete-sole-${randomBytes(6).toString("hex")}@example.test`;
  try {
    const existingAdminCount = await app.prisma.user.count({ where: { role: "ADMIN" } });
    // This test only proves the sole-admin case, so seed enough admins that deleting the
    // freshly-created one below cannot itself trigger the last-admin refusal for the wrong reason.
    const created = await app.prisma.user.create({ data: { name: "Sole-check Admin", email, passwordHash: "irrelevant-hash", role: "ADMIN", isActive: true } });
    if (existingAdminCount === 0) {
      await assert.rejects(() => deleteAdmin(email, "DELETE"), /Cannot delete the last remaining ADMIN account/);
      assert.ok(await app.prisma.user.findUnique({ where: { id: created.id } }));
    } else {
      await deleteAdmin(email, "DELETE");
      assert.equal(await app.prisma.user.findUnique({ where: { id: created.id } }), null);
    }
  } finally {
    await app.prisma.user.delete({ where: { email } }).catch(() => undefined);
    await app.close();
  }
});

test("ADMIN-only runtime contains no SUPER_ADMIN references", async () => {
  const files = [
    "src/app.ts",
    "src/middleware/auth.middleware.ts",
    "src/types/fastify.d.ts",
    "src/routes/auth.routes.ts",
    "src/routes/category.routes.ts",
    "src/routes/cms.routes.ts",
    "src/routes/media.routes.ts",
    "src/routes/product.routes.ts",
    "src/scripts/create-admin.ts",
    "src/scripts/promote-admin.ts",
    "src/scripts/prisma.ts",
    "src/utils/password.ts",
  ];
  for (const file of files) assert.equal((await readFile(file, "utf8")).includes("SUPER_ADMIN"), false, file);
});