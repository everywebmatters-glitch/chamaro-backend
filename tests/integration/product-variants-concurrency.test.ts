// Variant updates racing with customers and with other admins. Runs only against the isolated test database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A cart line or order line created by a customer while an admin save is in flight must never be lost.
// "cart-repoint" moves an existing cart line onto the contested variant: that touches only the variant row, so it is
// not held back by the product-row lock and relies on the conditional delete.
for (const kind of ["cart", "order", "cart-repoint"] as const) {
  test(`a ${kind} reference committed while the product is being saved is protected`, { skip: skipReason }, async () => {
    const { buildApp } = await import("../../src/app.js");
    const app = await buildApp();
    const unique = randomBytes(6).toString("hex");
    const made: { userIds: string[]; orderIds: string[]; productId?: string; categoryId?: string } = { userIds: [], orderIds: [] };

    try {
      const admin = await app.prisma.user.create({ data: { name: "Race Admin", email: `race-admin-${kind}-${unique}@example.test`, passwordHash: "unused", role: "ADMIN" } });
      const customerUser = await app.prisma.user.create({ data: { name: "Race Customer", email: `race-customer-${kind}-${unique}@example.test`, passwordHash: "unused", role: "CUSTOMER" } });
      made.userIds.push(admin.id, customerUser.id);
      const headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin.id, role: "ADMIN" })}` };
      const category = await app.prisma.category.create({ data: { name: `Race ${kind} ${unique}`, slug: `race-${kind}-${unique}` } });
      made.categoryId = category.id;
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/admin/products",
        headers,
        payload: { name: `Race ${kind} ${unique}`, slug: `race-${kind}-${unique}`, price: 50, categoryId: category.id, status: "ACTIVE", variants: [
          { name: "Keep", sku: `RACE-KEEP-${unique}`, options: {} },
          { name: "Contested", sku: `RACE-CONTESTED-${unique}`, options: {} },
        ] },
      });
      assert.equal(created.statusCode, 201, created.body);
      const product = created.json().data as { id: string; variants: { id: string; sku: string }[] };
      made.productId = product.id;
      const contested = product.variants.find((variant) => variant.sku.startsWith("RACE-CONTESTED"))!.id;
      const customer = await app.prisma.customer.create({ data: { userId: customerUser.id } });
      const cart = await app.prisma.cart.create({ data: { customerId: customer.id } });
      const keep = product.variants.find((variant) => variant.sku.startsWith("RACE-KEEP"))!.id;
      const existingLine = kind === "cart-repoint" ? await app.prisma.cartItem.create({ data: { cartId: cart.id, productId: product.id, variantId: keep, quantity: 1 } }) : undefined;

      // The customer's transaction inserts the reference, then stays open (uncommitted) while the admin saves.
      let inserted!: () => void;
      const insertedSignal = new Promise<void>((resolve) => { inserted = resolve; });
      const customerTx = app.prisma.$transaction(async (tx) => {
        if (kind === "cart-repoint") {
          await tx.cartItem.update({ where: { id: existingLine!.id }, data: { variantId: contested } });
        } else if (kind === "cart") {
          await tx.cartItem.create({ data: { cartId: cart.id, productId: product.id, variantId: contested, quantity: 1 } });
        } else {
          const order = await tx.retailOrder.create({ data: { customerId: customer.id, subtotal: 50, total: 50, items: { create: { productId: product.id, variantId: contested, quantity: 1, unitPrice: 50 } } } });
          made.orderIds.push(order.id);
        }
        inserted();
        await sleep(1500);
      }, { timeout: 20_000 });
      await insertedSignal;

      const save = app.inject({ method: "PUT", url: `/api/v1/admin/products/${product.id}`, headers, payload: { variants: [{ name: "Keep", sku: `RACE-KEEP-${unique}`, options: {} }] } });
      await customerTx;
      const response = await save;

      assert.equal(response.statusCode, 200, response.body);
      const variant = await app.prisma.productVariant.findUnique({ where: { id: contested } });
      assert.ok(variant, "the contested variant must not be deleted");
      assert.equal(variant.status, "ARCHIVED");
      if (kind !== "order") {
        assert.equal(await app.prisma.cartItem.count({ where: { cartId: cart.id, variantId: contested } }), 1, "the customer's cart line must survive");
      } else {
        assert.equal(await app.prisma.retailOrderItem.count({ where: { orderId: made.orderIds[0], variantId: contested } }), 1, "the order line must still point at the variant");
      }
    } finally {
      if (made.orderIds.length) await app.prisma.retailOrder.deleteMany({ where: { id: { in: made.orderIds } } }).catch(() => undefined);
      if (made.productId) await app.prisma.product.deleteMany({ where: { id: made.productId } }).catch(() => undefined);
      if (made.categoryId) await app.prisma.category.delete({ where: { id: made.categoryId } }).catch(() => undefined);
      if (made.userIds.length) await app.prisma.user.deleteMany({ where: { id: { in: made.userIds } } }).catch(() => undefined);
      await app.close();
    }
  });
}

// Two admins saving the same product at once must end in one of the two requested states, never a mixture or an error.
test("concurrent saves of one product's variants end in one of the requested states", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const unique = randomBytes(6).toString("hex");
  const made: { userId?: string; productId?: string; categoryId?: string } = {};
  try {
    const admin = await app.prisma.user.create({ data: { name: "Concurrent Admin", email: `concurrent-${unique}@example.test`, passwordHash: "unused", role: "ADMIN" } });
    made.userId = admin.id;
    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin.id, role: "ADMIN" })}` };
    const category = await app.prisma.category.create({ data: { name: `Concurrent ${unique}`, slug: `concurrent-${unique}` } });
    made.categoryId = category.id;
    const created = await app.inject({ method: "POST", url: "/api/v1/admin/products", headers, payload: { name: `Concurrent ${unique}`, slug: `concurrent-${unique}`, price: 5, categoryId: category.id, status: "ACTIVE", variants: [{ name: "Base", sku: `CON-BASE-${unique}`, options: {} }] } });
    made.productId = created.json().data.id;

    const listA = [{ name: "Base A", sku: `CON-BASE-${unique}`, options: {} }, { name: "Only A", sku: `CON-A-${unique}`, options: {} }];
    const listB = [{ name: "Base B", sku: `CON-BASE-${unique}`, options: {} }, { name: "Only B", sku: `CON-B-${unique}`, options: {} }];
    const [a, b] = await Promise.all(
      [listA, listB].map((variants) => app.inject({ method: "PUT", url: `/api/v1/admin/products/${made.productId}`, headers, payload: { variants } })),
    );
    assert.deepEqual([a.statusCode, b.statusCode], [200, 200], `${a.body} ${b.body}`);

    const final = (await app.prisma.productVariant.findMany({ where: { productId: made.productId } })).map((variant) => variant.sku).sort();
    const expectA = [`CON-A-${unique}`, `CON-BASE-${unique}`].sort();
    const expectB = [`CON-B-${unique}`, `CON-BASE-${unique}`].sort();
    assert.ok(JSON.stringify(final) === JSON.stringify(expectA) || JSON.stringify(final) === JSON.stringify(expectB), `unexpected final state ${final.join(", ")}`);
  } finally {
    if (made.productId) await app.prisma.product.deleteMany({ where: { id: made.productId } }).catch(() => undefined);
    if (made.categoryId) await app.prisma.category.delete({ where: { id: made.categoryId } }).catch(() => undefined);
    if (made.userId) await app.prisma.user.delete({ where: { id: made.userId } }).catch(() => undefined);
    await app.close();
  }
});
