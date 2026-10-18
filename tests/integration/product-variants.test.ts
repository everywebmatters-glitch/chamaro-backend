// PUT /admin/products/:id with `variants`: IDs stay stable, referenced variants are archived, never lost.
// Runs only against a throwaway local database (see tests/helpers/throwaway-db.ts).
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();

type Variant = { id: string; sku: string; name: string; status: string; price: string | null };

test("product variant updates keep IDs and protect cart/order references", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const unique = randomBytes(6).toString("hex");
  const sku = (name: string) => `V-${name}-${unique}`;
  const made: { userIds: string[]; orderIds: string[]; productIds: string[]; categoryId?: string } = { userIds: [], orderIds: [], productIds: [] };

  try {
    const admin = await app.prisma.user.create({ data: { name: "Variant Test Admin", email: `variants-${unique}@example.test`, passwordHash: "unused", role: "ADMIN" } });
    made.userIds.push(admin.id);
    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin.id, role: "ADMIN" })}` };
    const category = await app.prisma.category.create({ data: { name: `Variants ${unique}`, slug: `variants-${unique}` } });
    made.categoryId = category.id;

    const createProduct = async (label: string, variants: object[]) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/admin/products", headers, payload: { name: `Variants ${label} ${unique}`, slug: `variants-${label}-${unique}`, price: 100, categoryId: category.id, status: "ACTIVE", variants } });
      assert.equal(response.statusCode, 201, response.body);
      made.productIds.push(response.json().data.id);
      return response.json().data as { id: string; slug: string; variants: Variant[] };
    };
    const put = (id: string, payload: object) => app.inject({ method: "PUT", url: `/api/v1/admin/products/${id}`, headers, payload });
    const adminVariants = async (id: string) => ((await app.inject({ method: "GET", url: `/api/v1/admin/products/${id}`, headers })).json().data.variants as Variant[]);
    const bySku = (variants: Variant[], key: string) => variants.find((variant) => variant.sku.toLowerCase() === key.toLowerCase());

    const product = await createProduct("main", [
      { name: "Alpha", sku: sku("A"), price: 10, options: { colour: "red" } },
      { name: "Bravo", sku: sku("B"), price: 20, options: { colour: "blue" } },
      { name: "Charlie", sku: sku("C"), options: { colour: "green" } },
    ]);
    const idOf = (key: string) => bySku(product.variants, sku(key))!.id;
    const [a, b, c] = [idOf("A"), idOf("B"), idOf("C")];

    // --- update: existing SKUs keep their IDs; changes are applied; a new SKU is created ------------------
    const updated = await put(product.id, { variants: [
      { name: "Alpha 2", sku: sku("A"), price: 11, options: { colour: "red" } },
      { name: "Bravo", sku: sku("B"), price: 20, options: { colour: "blue" } },
      { name: "Charlie", sku: sku("C"), options: { colour: "green" } },
      { name: "Delta", sku: sku("D"), price: 40, options: { colour: "black" } },
    ] });
    assert.equal(updated.statusCode, 200, updated.body);
    let variants = updated.json().data.variants as Variant[];
    assert.equal(variants.length, 4);
    assert.equal(bySku(variants, sku("A"))!.id, a, "A keeps its ID");
    assert.equal(bySku(variants, sku("A"))!.name, "Alpha 2");
    assert.equal(Number(bySku(variants, sku("A"))!.price), 11);
    assert.equal(bySku(variants, sku("B"))!.id, b);
    assert.equal(bySku(variants, sku("C"))!.id, c);
    const d = bySku(variants, sku("D"))!.id;
    assert.ok(![a, b, c].includes(d), "D is a new variant");

    // --- SKUs match case-insensitively, as the unique index does ------------------------------------------
    const recased = await put(product.id, { variants: [
      { name: "Alpha 2", sku: sku("A").toLowerCase(), price: 11, options: { colour: "red" } },
      { name: "Bravo", sku: sku("B"), price: 20, options: { colour: "blue" } },
      { name: "Charlie", sku: sku("C"), options: { colour: "green" } },
      { name: "Delta", sku: sku("D"), price: 40, options: { colour: "black" } },
    ] });
    assert.equal(recased.statusCode, 200, recased.body);
    assert.equal(bySku(recased.json().data.variants, sku("A"))!.id, a, "re-cased SKU is the same variant");

    // --- PUT without `variants` leaves them alone ---------------------------------------------------------
    assert.equal((await put(product.id, { price: 101 })).statusCode, 200);
    assert.deepEqual((await adminVariants(product.id)).map((variant) => variant.id).sort(), [a, b, c, d].sort());

    // --- references: a cart line on B and an order line on C --------------------------------------------
    const customerUser = await app.prisma.user.create({ data: { name: "Variant Test Customer", email: `variants-customer-${unique}@example.test`, passwordHash: "unused", role: "CUSTOMER" } });
    made.userIds.push(customerUser.id);
    const customer = await app.prisma.customer.create({ data: { userId: customerUser.id } });
    const cart = await app.prisma.cart.create({ data: { customerId: customer.id, items: { create: { productId: product.id, variantId: b, quantity: 2 } } } });
    const order = await app.prisma.retailOrder.create({ data: { customerId: customer.id, subtotal: 40, total: 40, items: { create: { productId: product.id, variantId: c, quantity: 1, unitPrice: 40 } } }, include: { items: true } });
    made.orderIds.push(order.id);

    // --- remove vs archive: omit B (cart), C (order) and D (unreferenced), keep A ---------------------------
    const pruned = await put(product.id, { variants: [{ name: "Alpha 2", sku: sku("A"), price: 11, options: { colour: "red" } }] });
    assert.equal(pruned.statusCode, 200, pruned.body);
    variants = pruned.json().data.variants as Variant[];
    assert.equal(bySku(variants, sku("A"))!.status, "ACTIVE");
    assert.equal(bySku(variants, sku("B"))!.id, b, "cart-referenced variant survives");
    assert.equal(bySku(variants, sku("B"))!.status, "ARCHIVED");
    assert.equal(bySku(variants, sku("C"))!.id, c, "order-referenced variant survives");
    assert.equal(bySku(variants, sku("C"))!.status, "ARCHIVED");
    assert.equal(bySku(variants, sku("D")), undefined, "unreferenced variant is deleted");
    assert.equal(await app.prisma.productVariant.count({ where: { id: d } }), 0);

    // the references themselves are intact
    assert.equal(await app.prisma.cartItem.count({ where: { cartId: cart.id, variantId: b } }), 1);
    assert.equal((await app.prisma.retailOrderItem.findUniqueOrThrow({ where: { id: order.items[0].id } })).variantId, c);

    // archived variants are off sale: the public product response leaves them out, the admin one keeps them
    const publicProduct = await app.inject({ method: "GET", url: `/api/v1/products/${product.slug}` });
    assert.deepEqual((publicProduct.json().data.variants as Variant[]).map((variant) => variant.id), [a]);

    // resending an archived SKU brings the same variant back on sale
    const restored = await put(product.id, { variants: [
      { name: "Alpha 2", sku: sku("A"), price: 11, options: { colour: "red" } },
      { name: "Bravo", sku: sku("B"), price: 20, options: { colour: "blue" } },
      { name: "Charlie", sku: sku("C"), options: { colour: "green" }, status: "ARCHIVED" },
    ] });
    variants = restored.json().data.variants as Variant[];
    assert.equal(bySku(variants, sku("B"))!.id, b);
    assert.equal(bySku(variants, sku("B"))!.status, "ACTIVE");
    assert.equal(bySku(variants, sku("C"))!.status, "ARCHIVED");

    // an empty list retires everything: referenced variants are archived, none are lost
    const emptied = await put(product.id, { variants: [] });
    assert.equal(emptied.statusCode, 200, emptied.body);
    variants = emptied.json().data.variants as Variant[];
    assert.deepEqual(variants.map((variant) => variant.id).sort(), [b, c].sort(), "only referenced variants remain");
    assert.ok(variants.every((variant) => variant.status === "ARCHIVED"));
    assert.equal(await app.prisma.cartItem.count({ where: { cartId: cart.id, variantId: b } }), 1);

    // --- failures roll back the whole update --------------------------------------------------------------
    const other = await createProduct("other", [{ name: "Other", sku: sku("OTHER"), options: {} }]);
    const before = await adminVariants(product.id);
    const clash = await put(product.id, { name: "Should not stick", variants: [
      { name: "Alpha 3", sku: sku("A"), options: {} },
      { name: "Steals other's SKU", sku: sku("OTHER"), options: {} },
    ] });
    assert.equal(clash.statusCode, 409, clash.body);
    assert.equal(clash.json().error.code, "DUPLICATE_RECORD");
    const unchanged = (await app.inject({ method: "GET", url: `/api/v1/admin/products/${product.id}`, headers })).json().data;
    assert.equal(unchanged.name, `Variants main ${unique}`, "product fields roll back with the variants");
    assert.deepEqual(unchanged.variants, before, "variants are exactly as before");
    assert.equal((await adminVariants(other.id)).length, 1);

    const duplicate = await put(product.id, { variants: [{ name: "x", sku: sku("DUP"), options: {} }, { name: "y", sku: sku("dup"), options: {} }] });
    assert.equal(duplicate.statusCode, 409);
    assert.deepEqual(await adminVariants(product.id), before);
  } finally {
    if (made.orderIds.length) await app.prisma.retailOrder.deleteMany({ where: { id: { in: made.orderIds } } }).catch(() => undefined);
    if (made.productIds.length) await app.prisma.product.deleteMany({ where: { id: { in: made.productIds } } }).catch(() => undefined);
    if (made.categoryId) await app.prisma.category.delete({ where: { id: made.categoryId } }).catch(() => undefined);
    if (made.userIds.length) await app.prisma.user.deleteMany({ where: { id: { in: made.userIds } } }).catch(() => undefined);
    await app.close();
  }
});
