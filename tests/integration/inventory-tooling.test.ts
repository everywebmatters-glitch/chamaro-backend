// Inventory tooling safety (pre-commit review fixes C1-C5): durable rollback archive and partial-failure recovery,
// backfill idempotency for products already on the ledger, dry runs under a database-enforced read-only session,
// lock order against a concurrent cancellation, and rollback of products without a migration snapshot.
// Runs only against the isolated local test database; every run is scoped to this file's own products.
import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();
const fx = await import("../helpers/inventory-fixtures.js");
const inv = await import("../../src/services/inventory.service.js");
const mig = await import("../../src/services/inventory-migration.js");
const { openArchive, verifyArchive } = await import("../../src/scripts/inventory-archive.js");

const db = skipReason ? (undefined as never) : fx.testPrisma();
const readOnly = skipReason ? (undefined as never) : fx.testPrisma(4, 10_000, { readOnly: true });
after(async () => { if (!skipReason) { await db.$disconnect(); await readOnly.$disconnect(); } });
after(() => fx.cleanupArchives()); // runs even when a test fails

const legacyReserve = (productId: string, quantity: number) => db.$transaction((tx) => inv.reserveProductStock(tx, [{ productId, quantity, productName: "x", tracked: true }]));

// A legacy product with an open order (2 units), a dispatched order (1) and a cancelled one (1, released).
async function legacyProduct(quantity = 10) {
  const cat = await fx.category(db);
  const buyer = await fx.customer(db);
  const p = await fx.product(db, { categoryId: cat.id, quantity, legacy: true });
  const open = await fx.order(db, { customerId: buyer.id, items: [{ productId: p.id, quantity: 2 }] });
  const shipped = await fx.order(db, { customerId: buyer.id, items: [{ productId: p.id, quantity: 1 }], status: "SHIPPED", trackingNumber: "AWB" });
  const cancelled = await fx.order(db, { customerId: buyer.id, items: [{ productId: p.id, quantity: 1 }], status: "CANCELLED" });
  await legacyReserve(p.id, 3);
  return { p, buyer, open, shipped, cancelled };
}

const comparable = (report: Awaited<ReturnType<typeof mig.runBackfill>>) => ({
  products: report.products.map(({ productId, mode, before, after, actions, problems, committedUnits, openUnits }) => ({ productId, mode, before, after, actions, problems, committedUnits, openUnits })),
  ordersSettled: report.ordersSettled.map(({ orderId, to }) => ({ orderId, to })),
  ordersMarkedNone: report.ordersMarkedNone,
});

test("C3: the read-only session really refuses writes and locking reads", { skip: skipReason }, async () => {
  await assert.rejects(readOnly.$executeRaw`UPDATE Inventory SET quantity = quantity WHERE productId = 'none'`, /1792|READ ONLY/);
  await assert.rejects(readOnly.$queryRaw`SELECT id FROM Product LIMIT 1 FOR UPDATE`, /1792|READ ONLY/);
});

test("C3: backfill, rollback and reconcile dry runs work in a read-only session, and the dry run predicts the apply exactly", { skip: skipReason }, async () => {
  const a = await legacyProduct(10);
  const b = await legacyProduct(7);
  const only = [a.p.id, b.p.id];
  const dry = await mig.runBackfill(readOnly, { apply: false, only });
  assert.equal(dry.summary.migrated, 2);
  const applied = await mig.runBackfill(db, { apply: true, only });
  assert.deepEqual(comparable(applied), comparable(dry), "dry-run report == apply report");
  // After migration: the old code dispatches the open order of A; the dry runs see it without writing.
  await db.retailOrder.update({ where: { id: a.open.id }, data: { status: "SHIPPED", trackingNumber: "AWB-2" } });
  const dryConverge = await mig.runBackfill(readOnly, { apply: false, only });
  assert.deepEqual(dryConverge.ordersSettled.map((s) => [s.orderId, s.to]), [[a.open.id, "COMMITTED"]]);
  const reconciled = await mig.reconcile(readOnly, { only });
  assert.equal(reconciled.summary.pending, 1);
  const rollbackPlan = await mig.rollbackMigration(readOnly, { apply: false, only });
  assert.equal(rollbackPlan.status, "planned");
  assert.deepEqual(rollbackPlan.products.map((p) => p.productId).sort(), [...only].sort());
  // The apply does what the dry runs said.
  const converged = await mig.runBackfill(db, { apply: true, only });
  assert.deepEqual(comparable(converged), comparable(dryConverge));
  const archive = openArchive(fx.archivePath("c3"));
  const rolledBack = await mig.rollbackMigration(db, { apply: true, only, archive });
  archive.close();
  assert.equal(rolledBack.status, "complete");
  // The plan was made before the convergence committed A's open order, so compare what the plan could know: B.
  const planB = rollbackPlan.products.find((p) => p.productId === b.p.id)!;
  const doneB = rolledBack.products.find((p) => p.productId === b.p.id)!;
  assert.deepEqual([doneB.before, doneB.after], [planB.before, planB.after]);
});

test("C2: a product already on the ledger without a snapshot is skipped, never given a second opening balance", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const buyer = await fx.customer(db);
  const p = await fx.product(db, { categoryId: cat.id, quantity: 5 }); // opening balance on the ledger, no snapshot
  const order = await fx.order(db, { customerId: buyer.id, items: [{ productId: p.id, quantity: 1 }] });
  await db.$transaction((tx) => inv.reserveForOrder(tx, order.id, [{ productId: p.id, variantId: null, quantity: 1 }]));
  const movements = await db.stockMovement.count({ where: { productId: p.id } });
  for (const apply of [false, true, true]) {
    const report = await mig.runBackfill(apply ? db : readOnly, { apply, only: [p.id] });
    assert.equal(report.products[0].mode, "skip");
    assert.match(report.products[0].problems[0], /already on the ledger .* without a migration snapshot/);
  }
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 5, reservedQuantity: 1 });
  assert.equal(await db.stockMovement.count({ where: { productId: p.id } }), movements, "no second opening balance");
  assert.equal(await db.inventoryMigration.count({ where: { productId: p.id } }), 0);
  assert.deepEqual(await fx.ledgerInvariants(db, `P:${p.id}`), []);
  assert.deepEqual((await mig.reconcile(db, { only: [p.id] })).products[0].violations, []);
});

test("C1: a rollback that fails on product B after A committed keeps every row archived and reports partial progress", { skip: skipReason }, async () => {
  const a = await legacyProduct(10);
  const b = await legacyProduct(10);
  const only = [a.p.id, b.p.id].sort();
  await mig.runBackfill(db, { apply: true, only });
  const [first, second] = only; // products are rolled back in id order
  const ledgerOf = async (productId: string) => (await db.stockMovement.findMany({ where: { productId }, select: { id: true } })).map((m) => m.id).sort();
  const firstIds = await ledgerOf(first);
  const secondIds = await ledgerOf(second);
  const secondRow = await fx.stockRow(db, second);
  // Make the second product's ledger delete fail INSIDE its transaction, after its archive record is written.
  const trigger = `inventory_test_fail_${fx.rid()}`;
  await fx.execDdl(`CREATE TRIGGER ${trigger} BEFORE DELETE ON StockMovement FOR EACH ROW BEGIN IF OLD.productId = '${second}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected rollback failure'; END IF; END`);
  const path = fx.archivePath("c1");
  const archive = openArchive(path);
  let result;
  try {
    result = await mig.rollbackMigration(db, { apply: true, only, archive });
  } finally {
    await fx.execDdl(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  const summary = archive.close();
  // Partial progress reported accurately.
  assert.equal(result.status, "partial");
  assert.deepEqual(result.products.map((p) => [p.productId, p.status]), [[first, "committed"]]);
  assert.equal(result.failed?.scope, `product:${second}`);
  assert.match(result.failed?.error ?? "", /injected rollback failure/);
  assert.equal(result.cleared.status, "not run", "the clear step never runs after a failure");
  // Database: the first product is rolled back, the second is untouched.
  assert.deepEqual(await ledgerOf(first), []);
  assert.deepEqual(await ledgerOf(second), secondIds, "nothing deleted for the failed product");
  assert.equal(await db.inventoryMigration.count({ where: { productId: second } }), 1);
  assert.deepEqual(await fx.stockRow(db, second), secondRow);
  // Archive: on disk, checksum verified, the first product's deleted rows are all there, the failed attempt too.
  assert.ok(existsSync(path), "the archive survives the failure");
  const verification = verifyArchive(path, { sha256: summary.sha256, committed: mig.committedScopes(result) });
  assert.deepEqual(verification.problems, []);
  const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const firstPrepared = records.find((r) => r.scope === `product:${first}` && r.phase === "prepared");
  assert.deepEqual(firstPrepared.movements.map((m: { id: string }) => m.id).sort(), firstIds, "archived ids == deleted ids");
  assert.ok(firstPrepared.snapshot, "the snapshot is archived");
  assert.deepEqual(records.filter((r) => r.scope === `product:${second}`).map((r) => r.phase), ["prepared", "failed"]);
  // An existing archive is never overwritten.
  assert.throws(() => openArchive(path), /EEXIST/);
  // Recovery: run again with a new archive; it finishes the second product and the clear step.
  const archive2 = openArchive(fx.archivePath("c1-retry"));
  const retry = await mig.rollbackMigration(db, { apply: true, only, archive: archive2 });
  archive2.close();
  assert.equal(retry.status, "complete");
  assert.deepEqual(retry.products.map((p) => p.productId), [second]);
  assert.deepEqual(await ledgerOf(second), []);
  assert.equal((await mig.reconcile(db, { only })).summary.violations, 0, "both products are consistent legacy numbers again");
  assert.equal(readFileSync(path, "utf8").length, summary.bytes, "the first archive was not touched by the retry");
});

test("C1: the rollback command refuses --apply without --report", { skip: skipReason }, () => {
  const run = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/inventory-rollback.ts", "--apply"], { env: process.env, encoding: "utf8" });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /--apply needs --report/);
});

test("C4: the backfill locks orders before stock, so it can't deadlock with a cancellation holding an order", { skip: skipReason }, async () => {
  const a = await legacyProduct(10);
  const other = fx.testPrisma(2);
  try {
    let locked!: () => void;
    const orderLocked = new Promise<void>((resolve) => { locked = resolve; });
    // The legacy cancellation path, step by step: lock the order, (backfill starts meanwhile), release the stock,
    // cancel the order. With the old backfill lock order (stock row first) this deadlocked.
    let observed!: () => void;
    const lockStateObserved = new Promise<void>((resolve) => { observed = resolve; });
    const cancellation = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM RetailOrder WHERE id = ${a.open.id} FOR UPDATE`;
      locked();
      await lockStateObserved; // the backfill is now waiting for this order; its locks were inspected
      await inv.releaseProductStock(tx, [{ productId: a.p.id, quantity: 2 }]);
      await tx.retailOrder.update({ where: { id: a.open.id }, data: { status: "CANCELLED" } });
    }, { timeout: 20_000 });
    await orderLocked;
    const backfill = mig.runBackfill(db, { apply: true, only: [a.p.id] });
    // Inspect InnoDB's live locks while the backfill is blocked: it must be waiting for the cancellation's order row
    // and must NOT already hold this product's stock row (the old lock order held it, which is what deadlocked).
    let waitingOnOrder = 0;
    for (let attempt = 0; attempt < 50 && waitingOnOrder === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const waits = await db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks r ON r.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID WHERE r.OBJECT_SCHEMA = DATABASE() AND r.OBJECT_NAME = 'RetailOrder' AND r.LOCK_DATA LIKE CONCAT('%', ${a.open.id}, '%')`;
      waitingOnOrder = Number(waits[0].n);
    }
    const stockLocks = await db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = DATABASE() AND OBJECT_NAME = 'Inventory' AND LOCK_TYPE = 'RECORD' AND LOCK_DATA LIKE CONCAT('%', ${a.p.id}, '%')`;
    observed();
    // Let both transactions finish before asserting anything, so a failure never leaves them running.
    const [cancelResult, backfillResult] = await Promise.allSettled([cancellation, backfill]);
    assert.equal(waitingOnOrder, 1, "the backfill waits for the order row first");
    assert.equal(Number(stockLocks[0].n), 0, "while waiting, the backfill holds no lock on the stock row");
    assert.equal(cancelResult.status, "fulfilled", `the cancellation was not chosen as a deadlock victim: ${String((cancelResult as PromiseRejectedResult).reason?.message ?? "")}`);
    assert.equal(backfillResult.status, "fulfilled");
    const report = (backfillResult as PromiseFulfilledResult<Awaited<ReturnType<typeof mig.runBackfill>>>).value;
    assert.equal(report.products[0].mode, "migrate", "the backfill waited for the cancellation and then saw it");
    assert.deepEqual(await fx.stockRow(db, a.p.id), { quantity: 9, reservedQuantity: 0 });
    assert.equal((await db.retailOrder.findUniqueOrThrow({ where: { id: a.open.id } })).stockState, "RELEASED");
    assert.deepEqual((await mig.reconcile(db, { only: [a.p.id] })).products[0].violations, []);
  } finally {
    await other.$disconnect();
  }
});

test("C4: backfill racing 15 customer cancellations stays consistent (no surfaced errors, no drift)", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const p = await fx.product(db, { categoryId: cat.id, quantity: 40, legacy: true });
  const buyers = await Promise.all(Array.from({ length: 15 }, () => fx.customer(db)));
  const orders = [];
  for (const buyer of buyers) { orders.push(await fx.order(db, { customerId: buyer.id, items: [{ productId: p.id, quantity: 1 }] })); await legacyReserve(p.id, 1); }
  const others = [fx.testPrisma(5), fx.testPrisma(5)];
  try {
    const cancel = (client: typeof db, orderId: string) => client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM RetailOrder WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.retailOrder.findUniqueOrThrow({ where: { id: orderId } });
      if (order.status === "CANCELLED") return;
      await inv.releaseProductStock(tx, [{ productId: p.id, quantity: 1 }]);
      await tx.retailOrder.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
    });
    const results = await Promise.allSettled([mig.runBackfill(db, { apply: true, only: [p.id] }), ...orders.map((order, i) => cancel(others[i % 2], order.id))]);
    const rejected = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.message ?? r));
    assert.deepEqual(rejected, [], "no deadlock or other error surfaced");
    // One more pass converges anything the race left (orders cancelled after the conversion).
    await mig.runBackfill(db, { apply: true, only: [p.id] });
    const report = await mig.reconcile(db, { only: [p.id] });
    assert.deepEqual(report.products[0].violations, []);
    assert.deepEqual(report.products[0].pending, []);
    assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 40, reservedQuantity: 0 }, "all 15 cancelled; nothing held");
  } finally {
    for (const client of others) await client.$disconnect();
  }
});

test("C5: rollback restores a product with dispatch movements but no snapshot exactly (0 units before migration)", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const buyer = await fx.customer(db);
  const p = await fx.product(db, { categoryId: cat.id, quantity: 5 }); // on the ledger, never migrated
  const shippedOrder = await fx.order(db, { customerId: buyer.id, items: [{ productId: p.id, quantity: 1 }] });
  const openOrder = await fx.order(db, { customerId: buyer.id, items: [{ productId: p.id, quantity: 1 }] });
  for (const order of [shippedOrder, openOrder]) await db.$transaction((tx) => inv.reserveForOrder(tx, order.id, [{ productId: p.id, variantId: null, quantity: 1 }]));
  await db.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM RetailOrder WHERE id = ${shippedOrder.id} FOR UPDATE`; await inv.commitForOrder(tx, shippedOrder.id); });
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 4, reservedQuantity: 1 });
  const plan = await mig.rollbackMigration(readOnly, { apply: false, only: [p.id] });
  assert.deepEqual(plan.products.map((x) => [x.committedBefore, x.committedSince, x.snapshot, x.after]), [[0, 1, false, { quantity: 5, reserved: 2 }]]);
  const archive = openArchive(fx.archivePath("c5"));
  const result = await mig.rollbackMigration(db, { apply: true, only: [p.id], archive });
  const summary = archive.close();
  assert.equal(result.status, "complete");
  // Legacy model of the same history: quantity never decremented (5), reserved = both uncancelled orders (2).
  assert.deepEqual(await fx.stockRow(db, p.id), { quantity: 5, reservedQuantity: 2 });
  assert.equal(await db.stockMovement.count({ where: { productId: p.id } }), 0);
  assert.deepEqual(verifyArchive(summary.path, { sha256: summary.sha256, committed: mig.committedScopes(result) }).problems, []);
});
