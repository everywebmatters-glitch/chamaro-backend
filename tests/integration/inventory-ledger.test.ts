// Inventory ledger primitives (expand stage: not yet wired into checkout). Concurrency for 1, 2, 10 and 50 buyers on
// product- and variant-level stock, exactly-once release/commit, fail-closed policy, admin adjustments and drift.
// Runs only against the isolated local test database.
import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();
const fx = await import("../helpers/inventory-fixtures.js");
const inv = await import("../../src/services/inventory.service.js");
type Client = ReturnType<typeof fx.testPrisma>;

// Three clients of 10 connections each, like three API instances (Cloud Run maxScale 3).
const clients: Client[] = skipReason ? [] : [fx.testPrisma(), fx.testPrisma(), fx.testPrisma()];
const db = clients[0];
after(async () => { for (const client of clients) await client.$disconnect(); });

// One buyer's checkout as the switch-over stage will run it: create the order, lock it, reserve. Any failure rolls
// the whole transaction back (no order, no stock change). Returns the API answer.
async function buy(client: Client, customerId: string, line: { productId: string; variantId?: string | null; quantity: number }): Promise<string> {
  try {
    await client.$transaction(async (tx) => {
      const order = await fx.order(tx, { customerId, items: [line] });
      await tx.$queryRaw`SELECT id FROM RetailOrder WHERE id = ${order.id} FOR UPDATE`;
      await inv.reserveForOrder(tx, order.id, [{ productId: line.productId, variantId: line.variantId ?? null, quantity: line.quantity }]);
    }, { maxWait: 5_000, timeout: 20_000 });
    return "201";
  } catch (error) {
    return fx.outcomeOf(error);
  }
}

async function crowd(n: number, line: { productId: string; variantId?: string | null; quantity: number }) {
  const buyers = await Promise.all(Array.from({ length: n }, () => fx.customer(db)));
  const results = await Promise.all(buyers.map((buyer, index) => buy(clients[index % clients.length], buyer.id, line)));
  const tally: Record<string, number> = {};
  for (const result of results) tally[result] = (tally[result] ?? 0) + 1;
  return tally;
}

for (const n of [1, 2, 10, 50]) {
  test(`${n} buyer(s) for the last product-level unit: exactly one succeeds, nobody else gets a 5xx other than 503`, { skip: skipReason }, async () => {
    const cat = await fx.category(db);
    const chair = await fx.product(db, { categoryId: cat.id, quantity: 1 });
    const tally = await crowd(n, { productId: chair.id, quantity: 1 });
    assert.equal(tally["201"], 1, JSON.stringify(tally));
    const others = Object.entries(tally).filter(([outcome]) => outcome !== "201");
    for (const [outcome] of others) assert.ok(outcome === "409 INSUFFICIENT_STOCK" || outcome === "503 TRY_AGAIN", `unexpected outcome ${outcome} ${JSON.stringify(tally)}`);
    assert.deepEqual(await fx.stockRow(db, chair.id), { quantity: 1, reservedQuantity: 1 });
    assert.equal(await db.retailOrder.count({ where: { items: { some: { productId: chair.id } } } }), 1, "failed buyers left no order");
    assert.equal(await db.stockMovement.count({ where: { stockKey: `P:${chair.id}`, kind: "RESERVE" } }), 1);
    // Ledger opening balance for this fresh key (no backfill): the reservation is the only movement.
    assert.equal((await db.stockMovement.aggregate({ where: { stockKey: `P:${chair.id}` }, _sum: { reservedDelta: true } }))._sum.reservedDelta, 1);
  });

  test(`${n} buyer(s) for the last unit of one VARIANT: exactly one succeeds; the sibling variant is untouched`, { skip: skipReason }, async () => {
    const cat = await fx.category(db);
    const chair = await fx.product(db, { categoryId: cat.id, quantity: null, stockLevel: "VARIANT", variants: [{ name: "Beige", onHand: 1 }, { name: "Grey", onHand: 5 }] });
    const [beige, grey] = chair.variants;
    const tally = await crowd(n, { productId: chair.id, variantId: beige.id, quantity: 1 });
    assert.equal(tally["201"], 1, JSON.stringify(tally));
    for (const outcome of Object.keys(tally).filter((o) => o !== "201")) assert.ok(outcome === "409 INSUFFICIENT_STOCK" || outcome === "503 TRY_AGAIN", `unexpected ${outcome}`);
    assert.deepEqual(await fx.variantRow(db, beige.id), { onHand: 1, reserved: 1 });
    assert.deepEqual(await fx.variantRow(db, grey.id), { onHand: 5, reserved: 0 }, "sibling untouched");
    assert.equal(await fx.stockRow(db, chair.id), null, "no product-level row was created or used");
  });
}

test("50 buyers for 5 units: exactly five succeed", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const chair = await fx.product(db, { categoryId: cat.id, quantity: 5 });
  const tally = await crowd(50, { productId: chair.id, quantity: 1 });
  assert.equal(tally["201"], 5, JSON.stringify(tally));
  assert.equal(tally["500 INTERNAL_ERROR"], undefined, "no 500");
  assert.deepEqual(await fx.stockRow(db, chair.id), { quantity: 5, reservedQuantity: 5 });
});

test("fail closed (D2): no stock row → ITEM_NOT_STOCKED; variant product without a variant → VARIANT_REQUIRED; UNLIMITED is never checked", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const buyer = await fx.customer(db);
  const unstocked = await fx.product(db, { categoryId: cat.id, quantity: null });
  assert.equal(await buy(db, buyer.id, { productId: unstocked.id, quantity: 1 }), "409 ITEM_NOT_STOCKED");
  const variantProduct = await fx.product(db, { categoryId: cat.id, quantity: null, stockLevel: "VARIANT", variants: [{ name: "Beige", onHand: 3 }, { name: "Uncounted", onHand: null }] });
  assert.equal(await buy(db, buyer.id, { productId: variantProduct.id, quantity: 1 }), "409 VARIANT_REQUIRED");
  assert.equal(await buy(db, buyer.id, { productId: variantProduct.id, variantId: variantProduct.variants[1].id, quantity: 1 }), "409 ITEM_NOT_STOCKED", "a variant without its own count is not sold");
  const madeToOrder = await fx.product(db, { categoryId: cat.id, quantity: null, policy: "UNLIMITED" });
  assert.equal(await buy(db, buyer.id, { productId: madeToOrder.id, quantity: 500 }), "201");
  const order = await db.retailOrder.findFirstOrThrow({ where: { items: { some: { productId: madeToOrder.id } } } });
  assert.equal(order.stockState, "NONE");
  assert.equal(await db.stockMovement.count({ where: { orderId: order.id, kind: "UNTRACKED_SALE" } }), 1, "recorded for audit");
  assert.equal(await db.retailOrder.count({ where: { items: { some: { productId: { in: [unstocked.id, variantProduct.id] } } } } }), 0, "refused orders left nothing");
});

// An order that holds stock, locked as callers will (RetailOrder row first).
async function reservedOrder(productId: string, quantity: number) {
  const buyer = await fx.customer(db);
  return db.$transaction(async (tx) => {
    const order = await fx.order(tx, { customerId: buyer.id, items: [{ productId, quantity }] });
    await inv.reserveForOrder(tx, order.id, [{ productId, variantId: null, quantity }]);
    return order;
  });
}
const settle = (client: Client, orderId: string, how: "commit" | "release") => client.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM RetailOrder WHERE id = ${orderId} FOR UPDATE`;
  return how === "commit" ? inv.commitForOrder(tx, orderId) : inv.releaseForOrder(tx, orderId);
});

test("dispatch (D1) commits exactly once: 10 concurrent commits decrement on-hand and reserved once", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const chair = await fx.product(db, { categoryId: cat.id, quantity: 10 });
  const order = await reservedOrder(chair.id, 3);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => settle(clients[i % 3], order.id, "commit")));
  assert.equal(results.filter((r) => r.changed).length, 1);
  assert.deepEqual(await fx.stockRow(db, chair.id), { quantity: 7, reservedQuantity: 0 }, "3 units left the warehouse once");
  assert.equal(await db.stockMovement.count({ where: { orderId: order.id, kind: "COMMIT" } }), 1);
  assert.equal((await db.retailOrder.findUniqueOrThrow({ where: { id: order.id } })).stockState, "COMMITTED");
  // Duplicate deduction attempt bypassing the state check: the ledger's unique key refuses it.
  await assert.rejects(db.stockMovement.create({ data: { kind: "COMMIT", stockKey: `P:${chair.id}`, productId: chair.id, orderId: order.id, quantity: 3, onHandDelta: -3, reservedDelta: -3 } }), /Unique constraint|P2002/);
  assert.deepEqual(await fx.ledgerInvariants(db, `P:${chair.id}`), []);
});

test("cancel/expiry races dispatch: exactly one terminal transition; no double release", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const chair = await fx.product(db, { categoryId: cat.id, quantity: 4 });
  const order = await reservedOrder(chair.id, 2);
  const results = await Promise.all([...Array.from({ length: 5 }, (_, i) => settle(clients[i % 3], order.id, "commit")), ...Array.from({ length: 5 }, (_, i) => settle(clients[(i + 1) % 3], order.id, "release"))]);
  assert.equal(results.filter((r) => r.changed).length, 1, "one winner");
  const state = (await db.retailOrder.findUniqueOrThrow({ where: { id: order.id } })).stockState;
  const row = await fx.stockRow(db, chair.id);
  if (state === "COMMITTED") assert.deepEqual(row, { quantity: 2, reservedQuantity: 0 });
  else { assert.equal(state, "RELEASED"); assert.deepEqual(row, { quantity: 4, reservedQuantity: 0 }); }
  assert.equal(await db.stockMovement.count({ where: { orderId: order.id, kind: { in: ["COMMIT", "RELEASE"] } } }), 1);
  assert.deepEqual(await fx.ledgerInvariants(db, `P:${chair.id}`), []);
  // Releasing again later (e.g. a late expiry pass) changes nothing.
  assert.equal((await settle(db, order.id, "release")).changed, false);
  assert.deepEqual(await fx.stockRow(db, chair.id), row);
});

test("admin adjustments respect reservations: below reserved → 409 BELOW_RESERVED; stale count → 409 STALE_COUNT", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const chair = await fx.product(db, { categoryId: cat.id, quantity: 5 });
  await reservedOrder(chair.id, 3);
  const key = inv.productStockKey(chair.id);
  const adjust = (delta: number) => db.$transaction((tx) => inv.adjustStock(tx, { key, delta, reason: "test", actorUserId: "admin-test" }));
  const count = (onHand: number, expectedOnHand: number) => db.$transaction((tx) => inv.countStock(tx, { key, onHand, expectedOnHand, reason: "test", actorUserId: "admin-test" }));
  await assert.rejects(adjust(-3), (error: { code?: string }) => error.code === "BELOW_RESERVED");
  assert.deepEqual(await adjust(-2), { onHand: 3, reserved: 3 });
  await assert.rejects(count(2, 3), (error: { code?: string }) => error.code === "BELOW_RESERVED");
  await assert.rejects(count(9, 5), (error: { code?: string }) => error.code === "STALE_COUNT");
  assert.deepEqual(await count(10, 3), { onHand: 10, reserved: 3 });
  assert.deepEqual((await db.stockMovement.findMany({ where: { stockKey: key, kind: { in: ["ADJUST", "COUNT"] } }, orderBy: { createdAt: "asc" } })).map((m) => [m.kind, m.onHandDelta]), [["ADJUST", -2], ["COUNT", 7]]);
});

test("admin adjustments during a 50-buyer burst never make available stock negative", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const chair = await fx.product(db, { categoryId: cat.id, quantity: 10 });
  const key = inv.productStockKey(chair.id);
  const adjustments = Array.from({ length: 10 }, (_, i) => db.$transaction((tx) => inv.adjustStock(tx, { key, delta: i % 2 ? 1 : -1, reason: "burst", actorUserId: "admin-test" })).then(() => "ok", (e) => fx.outcomeOf(e)));
  const [tally] = await Promise.all([crowd(50, { productId: chair.id, quantity: 1 }), Promise.all(adjustments)]);
  const row = (await fx.stockRow(db, chair.id))!;
  assert.ok(row.reservedQuantity <= row.quantity, JSON.stringify(row));
  assert.equal(row.reservedQuantity, tally["201"], "every success is reserved, nothing more");
  assert.equal(tally["500 INTERNAL_ERROR"], undefined);
});

test("drift is reported, never driven negative: a release the row cannot absorb is recorded as DRIFT", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const chair = await fx.product(db, { categoryId: cat.id, quantity: 5 });
  const order = await reservedOrder(chair.id, 2);
  await db.$executeRaw`UPDATE Inventory SET reservedQuantity = 1 WHERE productId = ${chair.id}`; // simulated outside edit
  const result = await settle(db, order.id, "release");
  assert.equal(result.changed, true);
  assert.deepEqual(result.drift, [{ key: `P:${chair.id}`, quantity: 2 }]);
  assert.deepEqual(await fx.stockRow(db, chair.id), { quantity: 5, reservedQuantity: 1 }, "nothing repaired, nothing negative");
  const movement = await db.stockMovement.findFirstOrThrow({ where: { orderId: order.id, kind: "RELEASE" } });
  assert.match(movement.reason ?? "", /^DRIFT/);
  assert.equal(movement.reservedDelta, 0);
});

test("the legacy checkout path still behaves as before (expand stage keeps production behaviour)", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const tracked = await fx.product(db, { categoryId: cat.id, quantity: 2, legacy: true });
  const untracked = await fx.product(db, { categoryId: cat.id, quantity: null, legacy: true });
  await db.$transaction((tx) => inv.reserveProductStock(tx, [{ productId: tracked.id, quantity: 2, productName: "A", tracked: true }, { productId: untracked.id, quantity: 9, productName: "B", tracked: false }]));
  assert.deepEqual(await fx.stockRow(db, tracked.id), { quantity: 2, reservedQuantity: 2 });
  await assert.rejects(db.$transaction((tx) => inv.reserveProductStock(tx, [{ productId: tracked.id, quantity: 1, productName: "A", tracked: true }])), (error: { code?: string; message?: string }) => error.code === "INSUFFICIENT_STOCK" && error.message === "Not enough stock for A");
  await db.$transaction((tx) => inv.releaseProductStock(tx, [{ productId: tracked.id, quantity: 5 }]));
  assert.deepEqual(await fx.stockRow(db, tracked.id), { quantity: 2, reservedQuantity: 0 }, "legacy release clamps at 0 (GREATEST), unchanged");
  assert.equal(await db.stockMovement.count({ where: { productId: { in: [tracked.id, untracked.id] } } }), 0, "the legacy path writes no ledger rows");
});
