// Initial stock on product creation. Runs only against a throwaway local database (tests/helpers/throwaway-db.ts).
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();

test("POST /admin/products persists the initial stock quantity", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const unique = randomBytes(6).toString("hex");
  const created: { productIds: string[]; categoryId?: string; userId?: string } = { productIds: [] };

  try {
    const admin = await app.prisma.user.create({ data: { name: "Stock Test Admin", email: `stock-${unique}@example.test`, passwordHash: "unused", role: "ADMIN" } });
    created.userId = admin.id;
    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin.id, role: "ADMIN" })}` };

    const category = await app.prisma.category.create({ data: { name: `Stock ${unique}`, slug: `stock-${unique}` } });
    created.categoryId = category.id;

    const create = async (label: string, extra: Record<string, unknown>) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/products",
        headers,
        payload: { name: `Stock ${label} ${unique}`, slug: `stock-${label}-${unique}`, price: 100, categoryId: category.id, status: "ACTIVE", ...extra },
      });
      if (response.statusCode === 201) created.productIds.push(response.json().data.id);
      return response;
    };

    // Quantity 5: the inventory record is created with 5 on hand and nothing reserved.
    const five = await create("five", { quantity: 5 });
    assert.equal(five.statusCode, 201);
    assert.equal(five.json().data.inventory.quantity, 5);
    assert.equal(five.json().data.inventory.reservedQuantity, 0);
    const fiveId = five.json().data.id as string;
    const adminRead = await app.inject({ method: "GET", url: `/api/v1/admin/products/${fiveId}`, headers });
    assert.equal(adminRead.json().data.inventory.quantity, 5);
    const publicRead = await app.inject({ method: "GET", url: `/api/v1/products/stock-five-${unique}` });
    assert.equal(publicRead.statusCode, 200);
    assert.equal(publicRead.json().data.inventory.quantity, 5);
    assert.equal(await app.prisma.inventory.count({ where: { productId: fiveId } }), 1);

    // Quantity omitted: unchanged behaviour, stock is simply not tracked (no inventory row).
    const omitted = await create("omitted", {});
    assert.equal(omitted.statusCode, 201);
    assert.equal(omitted.json().data.inventory, null);
    assert.equal(await app.prisma.inventory.count({ where: { productId: omitted.json().data.id } }), 0);

    // Quantity 0 is an explicit "tracked, none on hand", which is different from omitted.
    const zero = await create("zero", { quantity: 0 });
    assert.equal(zero.statusCode, 201);
    assert.equal(zero.json().data.inventory.quantity, 0);
    assert.equal(zero.json().data.inventory.reservedQuantity, 0);
    assert.equal(await app.prisma.inventory.count({ where: { productId: zero.json().data.id } }), 1);

    // Invalid quantities are rejected by validation and create nothing. (A numeric string such as "5"
    // is deliberately not tested: Fastify's AJV coerces it to the integer 5.)
    for (const quantity of [-1, 1.5]) {
      const bad = await create(`bad-${String(quantity).replace(".", "-")}`, { quantity });
      assert.equal(bad.statusCode, 400, `quantity ${JSON.stringify(quantity)} should be rejected`);
    }
    assert.equal(await app.prisma.product.count({ where: { categoryId: category.id } }), 3);

    // Updating the quantity afterwards still works (existing PUT behaviour).
    const update = await app.inject({ method: "PUT", url: `/api/v1/admin/products/${fiveId}`, headers, payload: { quantity: 9 } });
    assert.equal(update.statusCode, 200);
    assert.equal(update.json().data.inventory.quantity, 9);
  } finally {
    if (created.productIds.length) await app.prisma.product.deleteMany({ where: { id: { in: created.productIds } } }).catch(() => undefined);
    if (created.categoryId) await app.prisma.category.delete({ where: { id: created.categoryId } }).catch(() => undefined);
    if (created.userId) await app.prisma.user.delete({ where: { id: created.userId } }).catch(() => undefined);
    await app.close();
  }
});
