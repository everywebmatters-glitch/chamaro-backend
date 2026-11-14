// Admin release of orphaned reservations (reserved units no order holds). HTTP route, service rules, concurrency,
// rollback on failure, product edits, and how ORPHAN_RELEASE rows pass through the backfill, reconcile and rollback.
// Runs only against the isolated local test database.
import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();
const fx = await import("../helpers/inventory-fixtures.js");
const inv = await import("../../src/services/inventory.service.js");
const mig = await import("../../src/services/inventory-migration.js");
const { openArchive } = await import("../../src/scripts/inventory-archive.js");
type Client = ReturnType<typeof fx.testPrisma>;
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;

// Three clients like three API instances, with small pools: the whole integration suite runs its files in parallel
// against one MySQL (default max_connections 151), and the concurrent requests below queue for connections anyway.
const clients: Client[] = skipReason ? [] : [fx.testPrisma(4), fx.testPrisma(4), fx.testPrisma(4)];
const db = clients[0];
let app: App | null = null;
after(async () => {
  fx.cleanupArchives();
  await app?.close();
  for (const client of clients) await client.$disconnect();
});

const REASON = "Orphaned reservation: isolated backup investigation confirmed no matching order lines and no physical units held.";
const ref = () => `test-${randomUUID()}`;

async function api(): Promise<App> {
  if (!app) app = await (await import("../../src/app.js")).buildApp();
  return app;
}

async function adminHeaders(options: { active?: boolean } = {}) {
  const id = fx.rid();
  const user = await db.user.create({ data: { name: `Inventory Admin ${id}`, email: `inv-admin-${id}@example.test`, passwordHash: "unused", role: "ADMIN", isActive: options.active ?? true } });
  return { user, headers: { authorization: `Bearer ${(await api()).jwt.sign({ sub: user.id, role: "ADMIN" })}` } };
}

// The Bistro Cafe Chair situation: 20 on hand, 4 reserved, no order lines at all, legacy numbers (no ledger rows).
async function orphanedProduct(quantity = 20, reserved = 4) {
  const category = await fx.category(db);
  return fx.product(db, { categoryId: category.id, quantity, reserved, legacy: true });
}

const movementsOf = (productId: string) => db.stockMovement.findMany({ where: { productId, kind: "ORPHAN_RELEASE" } });

async function post(headers: Record<string, string>, productId: string, payload: Record<string, unknown>) {
  return (await api()).inject({ method: "POST", url: `/api/v1/admin/inventory/products/${productId}/orphan-releases`, headers, payload });
}

// Calls the service the way the route does (its own transaction); returns "201" or the API answer for the error.
async function release(client: Client, input: Omit<Parameters<typeof inv.releaseOrphanedReservation>[1], "actorUserId"> & { actorUserId?: string }, actorUserId: string): Promise<string> {
  try {
    await client.$transaction((tx) => inv.releaseOrphanedReservation(tx, { ...input, actorUserId: input.actorUserId ?? actorUserId }), { maxWait: 10_000, timeout: 20_000 });
    return "201";
  } catch (error) {
    return fx.outcomeOf(error);
  }
}

test("valid release of 4 units: on hand stays 20, reserved 4→0, available 16→20, one audited ledger movement", { skip: skipReason }, async () => {
  const p = await orphanedProduct();
  const { user, headers } = await adminHeaders();
  const server = await api();

  const view = await server.inject({ method: "GET", url: `/api/v1/admin/inventory/products/${p.id}/orphan-release`, headers });
  assert.equal(view.statusCode, 200);
  const before = view.json().data;
  assert.deepEqual(before.stock && { onHand: before.stock.onHand, reserved: before.stock.reserved, available: before.stock.available }, { onHand: 20, reserved: 4, available: 16 });
  assert.equal(before.heldByOrders, 0);
  assert.equal(before.releasable, 4);
  assert.deepEqual(before.history, []);

  const reference = ref();
  const response = await post(headers, p.id, { quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference });
  assert.equal(response.statusCode, 201, response.body);
  const result = response.json().data;
  assert.deepEqual(result.stock, { onHand: 20, reserved: 0, available: 20 });
  assert.equal(result.movement.kind, "ORPHAN_RELEASE");
  assert.equal(result.movement.reservedBefore, 4);
  assert.equal(result.movement.reservedAfter, 0);
  assert.equal(result.movement.actorUserId, user.id);

  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 0 });
  const rows = await movementsOf(p.id);
  assert.equal(rows.length, 1, "ledger entry is created exactly once");
  const [row] = rows;
  assert.equal(row.stockKey, `P:${p.id}`);
  assert.equal(row.quantity, 4);
  assert.equal(row.reservedDelta, -4);
  assert.equal(row.onHandDelta, 0, "on hand is never changed by a release");
  assert.equal(row.reservedBefore, 4);
  assert.equal(row.reservedAfter, 0);
  assert.equal(row.actorUserId, user.id);
  assert.equal(row.reason, REASON);
  assert.equal(row.reference, reference);
  assert.ok(row.createdAt instanceof Date);
  assert.equal(row.orderId, null);

  // The audit trail stays readable after the operation.
  const afterView = (await server.inject({ method: "GET", url: `/api/v1/admin/inventory/products/${p.id}/orphan-release`, headers })).json().data;
  assert.deepEqual({ onHand: afterView.stock.onHand, reserved: afterView.stock.reserved, available: afterView.stock.available }, { onHand: 20, reserved: 0, available: 20 });
  assert.equal(afterView.releasable, 0);
  assert.equal(afterView.history.length, 1);
  assert.equal(afterView.history[0].reference, reference);
  assert.equal(afterView.history[0].actorName, user.name);
  assert.equal(afterView.history[0].reason, REASON);
});

test("invalid requests are rejected and change nothing: missing/blank/short reason, zero, negative, fractional, over-reserved, bad reference", { skip: skipReason }, async () => {
  const p = await orphanedProduct();
  const { headers } = await adminHeaders();
  const good = { quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON };
  const cases: [string, Record<string, unknown>, number, string][] = [
    ["missing reason", { quantity: 4, expectedOnHand: 20, expectedReserved: 4, reference: ref() }, 400, "VALIDATION_ERROR"],
    ["blank reason", { ...good, reason: "      ", reference: ref() }, 400, "REASON_REQUIRED"],
    ["too-short reason", { ...good, reason: "orphan", reference: ref() }, 400, "REASON_REQUIRED"],
    ["zero quantity", { ...good, quantity: 0, reference: ref() }, 400, "VALIDATION_ERROR"],
    ["negative quantity", { ...good, quantity: -4, reference: ref() }, 400, "VALIDATION_ERROR"],
    ["fractional quantity", { ...good, quantity: 1.5, reference: ref() }, 400, "VALIDATION_ERROR"],
    ["more than reserved", { ...good, quantity: 5, reference: ref() }, 409, "EXCEEDS_RESERVED"],
    ["missing reference", { ...good }, 400, "VALIDATION_ERROR"],
    ["malformed reference", { ...good, reference: "bad ref with spaces" }, 400, "VALIDATION_ERROR"],
    ["missing expected numbers", { quantity: 4, reason: REASON, reference: ref() }, 400, "VALIDATION_ERROR"],
    ["extra field", { ...good, reference: ref(), onHand: 0 }, 400, "VALIDATION_ERROR"],
  ];
  for (const [label, payload, status, code] of cases) {
    const response = await post(headers, p.id, payload);
    assert.equal(response.statusCode, status, `${label}: ${response.body}`);
    assert.equal(response.json().error.code, code, label);
  }
  // The service enforces the same rules when called directly (not only the HTTP schema).
  const { user } = await adminHeaders();
  for (const [label, input] of [["zero", { quantity: 0 }], ["negative", { quantity: -1 }], ["no reason", { reason: "" }]] as const) {
    assert.equal(await release(db, { productId: p.id, quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference: ref(), ...input }, user.id), label === "no reason" ? "400 REASON_REQUIRED" : "400 VALIDATION_ERROR", label);
  }
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 4 });
  assert.equal((await movementsOf(p.id)).length, 0);
});

test("only an authenticated, active admin may view or release: no token 401, customer 403, inactive admin 403, forged role 403", { skip: skipReason }, async () => {
  const p = await orphanedProduct();
  const server = await api();
  const buyer = await fx.customer(db);
  const customerToken = server.jwt.sign({ sub: buyer.userId, role: "CUSTOMER" });
  const forgedToken = server.jwt.sign({ sub: buyer.userId, role: "ADMIN" }); // role claim says ADMIN, the account is a customer
  const inactive = await adminHeaders({ active: false });
  const payload = () => ({ quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference: ref() });
  const cases: [string, Record<string, string>, number][] = [
    ["no token", {}, 401],
    ["garbage token", { authorization: "Bearer not-a-jwt" }, 401],
    ["customer", { authorization: `Bearer ${customerToken}` }, 403],
    ["forged admin role", { authorization: `Bearer ${forgedToken}` }, 403],
    ["inactive admin", inactive.headers, 403],
  ];
  for (const [label, headers, status] of cases) {
    assert.equal((await post(headers, p.id, payload())).statusCode, status, `POST ${label}`);
    assert.equal((await server.inject({ method: "GET", url: `/api/v1/admin/inventory/products/${p.id}/orphan-release`, headers })).statusCode, status, `GET ${label}`);
  }
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 4 });
  assert.equal((await movementsOf(p.id)).length, 0);
});

test("a reference key is used once: a repeat is refused (409 DUPLICATE_REFERENCE) and releases nothing more", { skip: skipReason }, async () => {
  const p = await orphanedProduct();
  const { headers } = await adminHeaders();
  const reference = ref();
  assert.equal((await post(headers, p.id, { quantity: 1, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference })).statusCode, 201);
  // Same key, with numbers that would otherwise be valid: refused before anything else is checked.
  const again = await post(headers, p.id, { quantity: 1, expectedOnHand: 20, expectedReserved: 3, reason: REASON, reference });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, "DUPLICATE_REFERENCE");
  // The key is global: reusing it on another product is refused too.
  const other = await orphanedProduct(5, 2);
  assert.equal((await post(headers, other.id, { quantity: 1, expectedOnHand: 5, expectedReserved: 2, reason: REASON, reference })).json().error.code, "DUPLICATE_REFERENCE");
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 3 });
  assert.deepEqual(await fx.stockRow(db, other.id), { quantity: 5, reservedQuantity: 2 });
  assert.equal((await movementsOf(p.id)).length, 1);
  assert.equal((await movementsOf(other.id)).length, 0);
});

test("stale view: if on hand or reserved changed since the admin looked, 409 STALE_STOCK and nothing changes", { skip: skipReason }, async () => {
  const p = await orphanedProduct();
  const { headers } = await adminHeaders();
  for (const expected of [{ expectedOnHand: 20, expectedReserved: 5 }, { expectedOnHand: 19, expectedReserved: 4 }]) {
    const response = await post(headers, p.id, { quantity: 4, ...expected, reason: REASON, reference: ref() });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "STALE_STOCK");
  }
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 4 });
  assert.equal((await movementsOf(p.id)).length, 0);
});

test("units held by orders can never be released: open and legacy-dispatched orders count, cancelled orders don't", { skip: skipReason }, async () => {
  const category = await fx.category(db);
  // Legacy numbers: 3 units on an open order, 2 on a dispatched order (legacy keeps them reserved), 5 on a cancelled
  // order (given back), plus 4 orphaned → reserved 3 + 2 + 4 = 9.
  const p = await fx.product(db, { categoryId: category.id, quantity: 20, reserved: 9, legacy: true });
  const buyer = await fx.customer(db);
  await fx.order(db, { customerId: buyer.id, items: [{ productId: p.id, quantity: 3 }], status: "CONFIRMED" });
  await fx.order(db, { customerId: buyer.id, items: [{ productId: p.id, quantity: 2 }], status: "SHIPPED", trackingNumber: "TRK-TEST" });
  await fx.order(db, { customerId: buyer.id, items: [{ productId: p.id, quantity: 5 }], status: "CANCELLED" });
  const { user, headers } = await adminHeaders();
  const view = (await (await api()).inject({ method: "GET", url: `/api/v1/admin/inventory/products/${p.id}/orphan-release`, headers })).json().data;
  assert.equal(view.heldByOrders, 5);
  assert.equal(view.releasable, 4);
  const tooMany = await post(headers, p.id, { quantity: 5, expectedOnHand: 20, expectedReserved: 9, reason: REASON, reference: ref() });
  assert.equal(tooMany.statusCode, 409);
  assert.equal(tooMany.json().error.code, "HELD_BY_ORDERS");
  assert.equal((await post(headers, p.id, { quantity: 4, expectedOnHand: 20, expectedReserved: 9, reason: REASON, reference: ref() })).statusCode, 201);
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 5 });
  // Nothing left to release: the 5 belong to orders.
  assert.equal(await release(db, { productId: p.id, quantity: 1, expectedOnHand: 20, expectedReserved: 5, reason: REASON, reference: ref() }, user.id), "409 HELD_BY_ORDERS");
});

test("variant-level products and products without a stock row are refused", { skip: skipReason }, async () => {
  const category = await fx.category(db);
  const variantProduct = await fx.product(db, { categoryId: category.id, quantity: 10, reserved: 2, stockLevel: "VARIANT", legacy: true });
  const untracked = await fx.product(db, { categoryId: category.id, quantity: null });
  const { user } = await adminHeaders();
  assert.equal(await release(db, { productId: variantProduct.id, quantity: 1, expectedOnHand: 10, expectedReserved: 2, reason: REASON, reference: ref() }, user.id), "409 VARIANT_LEVEL_STOCK");
  assert.equal(await release(db, { productId: untracked.id, quantity: 1, expectedOnHand: 0, expectedReserved: 0, reason: REASON, reference: ref() }, user.id), "404 STOCK_NOT_FOUND");
  assert.equal(await release(db, { productId: `missing-${fx.rid()}`, quantity: 1, expectedOnHand: 0, expectedReserved: 0, reason: REASON, reference: ref() }, user.id), "404 NOT_FOUND");
});

test("concurrent release attempts cannot release the same reservation twice (10 admins, 3 API instances)", { skip: skipReason }, async () => {
  const { user } = await adminHeaders();
  // Different reference keys, same view of the stock: exactly one wins, the rest see the stock changed.
  const p = await orphanedProduct();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => release(clients[i % clients.length], { productId: p.id, quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference: ref() }, user.id)));
  const tally = results.reduce<Record<string, number>>((t, r) => ({ ...t, [r]: (t[r] ?? 0) + 1 }), {});
  assert.deepEqual(tally, { "201": 1, "409 STALE_STOCK": 9 }, JSON.stringify(tally));
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 0 });
  assert.equal((await movementsOf(p.id)).length, 1);

  // The same reference key submitted 10 times at once (double-click, retries): exactly one wins.
  const q = await orphanedProduct();
  const reference = ref();
  const same = await Promise.all(Array.from({ length: 10 }, (_, i) => release(clients[i % clients.length], { productId: q.id, quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference }, user.id)));
  assert.equal(same.filter((r) => r === "201").length, 1, JSON.stringify(same));
  assert.ok(same.every((r) => r === "201" || r === "409 DUPLICATE_REFERENCE"), JSON.stringify(same));
  assert.deepEqual(await fx.stockRow(db, q.id), { quantity: 20, reservedQuantity: 0 });
  assert.equal((await movementsOf(q.id)).length, 1);

  // Releases racing new checkouts on the legacy path: reserved never goes negative or below what orders hold.
  const r = await orphanedProduct(20, 4);
  const buyers = await Promise.all(Array.from({ length: 6 }, () => fx.customer(db)));
  const checkout = (client: Client, customerId: string) => client.$transaction(async (tx) => {
    await fx.order(tx, { customerId, items: [{ productId: r.id, quantity: 1 }] });
    await inv.reserveProductStock(tx, [{ productId: r.id, quantity: 1, productName: "Test chair", tracked: true }]);
  }).then(() => "201", (error) => fx.outcomeOf(error));
  const mixed = await Promise.all([
    ...buyers.map((buyer, i) => checkout(clients[i % clients.length], buyer.id)),
    release(clients[1], { productId: r.id, quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference: ref() }, user.id),
  ]);
  const placed = mixed.slice(0, 6).filter((x) => x === "201").length;
  const released = mixed[6] === "201";
  const row = await fx.stockRow(db, r.id);
  assert.equal(row!.quantity, 20);
  assert.equal(row!.reservedQuantity, (released ? 0 : 4) + placed, `release ${mixed[6]}, ${placed} checkout(s)`);
  assert.ok(row!.reservedQuantity >= await inv.unitsHeldByOrders(db, r.id));
  assert.ok(released || mixed[6] === "409 STALE_STOCK", mixed[6]);
});

test("a failure after the stock update rolls back: inventory and ledger unchanged", { skip: skipReason }, async () => {
  const p = await orphanedProduct();
  const { user } = await adminHeaders();
  const trigger = `fail_orphan_${fx.rid()}`;
  // Fails the ledger insert for this product only (other test files share the database).
  await fx.execDdl(`CREATE TRIGGER ${trigger} BEFORE INSERT ON StockMovement FOR EACH ROW BEGIN IF NEW.productId = '${p.id}' AND NEW.kind = 'ORPHAN_RELEASE' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected ledger failure'; END IF; END`);
  try {
    const outcome = await release(db, { productId: p.id, quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference: ref() }, user.id);
    assert.match(outcome, /^500 /, outcome); // a server error (the injected database failure), never a success
  } finally {
    await fx.execDdl(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 4 }, "the reserved update was rolled back with the failed ledger insert");
  assert.equal((await movementsOf(p.id)).length, 0);
  // With the fault gone the same request works.
  assert.equal(await release(db, { productId: p.id, quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference: ref() }, user.id), "201");
});

test("a normal product edit cannot change reserved stock", { skip: skipReason }, async () => {
  const p = await orphanedProduct();
  const { headers } = await adminHeaders();
  const server = await api();
  const put = (payload: Record<string, unknown>) => server.inject({ method: "PUT", url: `/api/v1/admin/products/${p.id}`, headers, payload });
  for (const payload of [{ reservedQuantity: 0 }, { inventory: { reservedQuantity: 0 } }, { inventory: { update: { reservedQuantity: 0 } } }, { quantity: 20, reservedQuantity: 0 }]) {
    const response = await put(payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
  }
  // Editing the stock field changes on hand only; reserved stays.
  const edited = await put({ quantity: 25 });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 25, reservedQuantity: 4 });
  const renamed = await put({ name: `Renamed ${fx.rid()}` });
  assert.equal(renamed.statusCode, 200);
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 25, reservedQuantity: 4 });
  assert.equal((await movementsOf(p.id)).length, 0);
});

test("backfill, reconcile and rollback: a release on the legacy numbers lets the product migrate, and the audit row survives a rollback", { skip: skipReason }, async () => {
  const p = await orphanedProduct();
  const only = [p.id];
  const { user } = await adminHeaders();

  // Before: the backfill skips the product (reserved 4, no order holds anything); reconcile reports the difference.
  const skipped = await mig.runBackfill(db, { apply: false, only });
  assert.equal(skipped.products[0].mode, "skip");
  assert.match(skipped.products[0].problems.join(" "), /reserved after conversion would be 4, but open .* hold 0/);
  assert.equal((await mig.reconcile(db, { only })).products[0].violations.length, 1);

  assert.equal(await release(db, { productId: p.id, quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference: ref() }, user.id), "201");

  // After the release: still the legacy model, and clean.
  const legacy = (await mig.reconcile(db, { only })).products[0];
  assert.equal(legacy.model, "legacy");
  assert.deepEqual(legacy.violations, []);

  // The backfill now migrates it (the ORPHAN_RELEASE row doesn't count as "already on the ledger"), and the opening
  // balance carries the released units so the ledger sums to the stock row.
  const dry = await mig.runBackfill(db, { apply: false, only });
  assert.equal(dry.products[0].mode, "migrate", JSON.stringify(dry.products[0]));
  assert.ok(dry.products[0].actions.some((action) => action.includes("4 unit(s) released earlier by admin")));
  const applied = await mig.runBackfill(db, { apply: true, only });
  assert.equal(applied.products[0].mode, "migrate");
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 0 });
  assert.deepEqual(await fx.ledgerInvariants(db, `P:${p.id}`), []);
  const migrated = (await mig.reconcile(db, { only })).products[0];
  assert.equal(migrated.model, "migrated");
  assert.deepEqual(migrated.violations, []);
  assert.equal((await mig.runBackfill(db, { apply: true, only })).products[0].mode, "skip", "a re-run changes nothing");

  // Rollback: back to the legacy numbers; the ORPHAN_RELEASE row stays (audit), every other ledger row is removed.
  const archive = openArchive(fx.archivePath("orphan-release"));
  const rolledBack = await mig.rollbackMigration(db, { apply: true, only, archive });
  archive.close();
  assert.equal(rolledBack.status, "complete", JSON.stringify(rolledBack.failed));
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 0 });
  const left = await db.stockMovement.findMany({ where: { productId: p.id } });
  assert.deepEqual(left.map((row) => row.kind), ["ORPHAN_RELEASE"]);
  assert.deepEqual((await mig.reconcile(db, { only })).products[0].violations, []);

  // And it migrates again, consistently.
  assert.equal((await mig.runBackfill(db, { apply: true, only })).products[0].mode, "migrate");
  assert.deepEqual(await fx.ledgerInvariants(db, `P:${p.id}`), []);
});

test("on a migrated product the release is an ordinary ledger movement and the ledger still sums to the row", { skip: skipReason }, async () => {
  // A ledger product (opening balance 20 on hand, 4 reserved by no order: drift).
  const category = await fx.category(db);
  const p = await fx.product(db, { categoryId: category.id, quantity: 20, reserved: 4 });
  const { user } = await adminHeaders();
  assert.equal(await release(db, { productId: p.id, quantity: 4, expectedOnHand: 20, expectedReserved: 4, reason: REASON, reference: ref() }, user.id), "201");
  assert.deepEqual(await fx.ledgerInvariants(db, `P:${p.id}`), []);
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 20, reservedQuantity: 0 });
});
