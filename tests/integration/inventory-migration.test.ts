// Inventory backfill, reconciliation and rollback on a legacy dataset (orders in every state, a drifted product, a
// product without a stock row, an order spanning two products). Proves: dry run writes nothing; available stock is
// unchanged; drift is reported, not repaired; re-runs are idempotent; orders the previous code placed, shipped or
// cancelled after the conversion converge; rollback restores the legacy numbers exactly.
// Runs only against the isolated local test database (each run is scoped to this file's own products).
import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();
const fx = await import("../helpers/inventory-fixtures.js");
const inv = await import("../../src/services/inventory.service.js");
const mig = await import("../../src/services/inventory-migration.js");
const { openArchive, verifyArchive } = await import("../../src/scripts/inventory-archive.js");

const db = skipReason ? (undefined as never) : fx.testPrisma();
after(async () => { if (!skipReason) await db.$disconnect(); });
after(() => fx.cleanupArchives()); // runs even when a test fails

// Legacy model: reservedQuantity counts every order that was not cancelled (open and dispatched); quantity is the
// total ever received. The previous code reserves and releases with these two functions.
const legacyReserve = (productId: string, quantity: number) => db.$transaction((tx) => inv.reserveProductStock(tx, [{ productId, quantity, productName: "x", tracked: true }]));
const legacyRelease = (productId: string, quantity: number) => db.$transaction((tx) => inv.releaseProductStock(tx, [{ productId, quantity }]));

test("backfill → converge → reconcile → rollback on legacy data", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const buyer = await fx.customer(db);
  const A = await fx.product(db, { categoryId: cat.id, name: "Legacy chair A", quantity: 20, legacy: true });
  const B = await fx.product(db, { categoryId: cat.id, name: "Drifted chair B", quantity: 10, reserved: 4, legacy: true });
  const C = await fx.product(db, { categoryId: cat.id, name: "Unstocked chair C", quantity: null, legacy: true });
  const only = [A.id, B.id, C.id];
  const place = async (spec: Parameters<typeof fx.order>[1], reserveA: number) => { const o = await fx.order(db, spec); if (reserveA) await legacyReserve(A.id, reserveA); return o; };
  const line = (productId: string, quantity: number) => ({ productId, quantity });
  // A's orders, in every state, reserved the legacy way.
  const O1 = await place({ customerId: buyer.id, items: [line(A.id, 2)] }, 2); //                          PENDING
  const O2 = await place({ customerId: buyer.id, items: [line(A.id, 1)], status: "CONFIRMED", paymentStatus: "PAID" }, 1);
  const O3 = await place({ customerId: buyer.id, items: [line(A.id, 3)], status: "SHIPPED", paymentStatus: "PAID" }, 3);
  const O4 = await place({ customerId: buyer.id, items: [line(A.id, 1)], status: "COMPLETED", paymentStatus: "PAID" }, 1);
  const O5 = await place({ customerId: buyer.id, items: [line(A.id, 2)] }, 2);
  await db.retailOrder.update({ where: { id: O5.id }, data: { status: "CANCELLED" } }); await legacyRelease(A.id, 2);
  const O6 = await place({ customerId: buyer.id, items: [line(A.id, 1)], status: "PROCESSING", paymentStatus: "PAID", trackingNumber: "AWB-1" }, 1);
  const O7 = await place({ customerId: buyer.id, items: [line(A.id, 1), line(C.id, 1)] }, 1); //        A + untracked C
  const OC = await fx.order(db, { customerId: buyer.id, items: [line(C.id, 2)] }); //                   only untracked C
  await fx.order(db, { customerId: buyer.id, items: [line(B.id, 2)] }); // B: reserved says 4, orders hold 2 → drift
  assert.deepEqual(await fx.stockRow(db, A.id), { quantity: 20, reservedQuantity: 9 }, "legacy A: 2+1+3+1+1+1 uncancelled units");

  // 1. Pre-migration reconciliation (read-only).
  const pre = await mig.reconcile(db, { only });
  const preA = pre.products.find((p) => p.productId === A.id)!;
  assert.equal(preA.model, "legacy");
  assert.deepEqual(preA.violations, []);
  assert.equal(pre.products.find((p) => p.productId === B.id)!.violations.length, 1, "B's drift is reported");
  assert.deepEqual(pre.productsWithoutInventory.map((p) => p.productId), [C.id]);

  // 2. Dry run: full report, nothing written.
  const dry = await mig.runBackfill(db, { apply: false, only });
  const dryA = dry.products.find((p) => p.productId === A.id)!;
  assert.equal(dryA.mode, "migrate");
  assert.deepEqual(dryA.after, { quantity: 15, reserved: 4, available: 11 });
  assert.equal(dryA.before.available, dryA.after!.available, "available unchanged");
  assert.equal(dry.products.find((p) => p.productId === B.id)!.mode, "skip");
  assert.equal(dry.summary.availableChanged, 0);
  assert.deepEqual(await fx.stockRow(db, A.id), { quantity: 20, reservedQuantity: 9 }, "dry run wrote nothing");
  assert.equal(await db.stockMovement.count({ where: { productId: { in: only } } }), 0);
  assert.equal(await db.inventoryMigration.count({ where: { productId: { in: only } } }), 0);
  assert.equal(await db.retailOrder.count({ where: { id: O1.id, stockState: { not: null } } }), 0);

  // 3. Apply.
  const applied = await mig.runBackfill(db, { apply: true, only });
  assert.equal(applied.summary.migrated, 1);
  assert.equal(applied.summary.skipped, 1, "B skipped, not repaired");
  assert.equal(applied.summary.availableChanged, 0);
  assert.deepEqual(await fx.stockRow(db, A.id), { quantity: 15, reservedQuantity: 4 }, "5 dispatched units off both numbers");
  assert.deepEqual(await fx.stockRow(db, B.id), { quantity: 10, reservedQuantity: 4 }, "drifted product untouched");
  const states = Object.fromEntries((await db.retailOrder.findMany({ where: { id: { in: [O1.id, O2.id, O3.id, O4.id, O5.id, O6.id, O7.id, OC.id] } }, select: { id: true, stockState: true } })).map((o) => [o.id, o.stockState]));
  assert.deepEqual([O1, O2, O7].map((o) => states[o.id]), ["RESERVED", "RESERVED", "RESERVED"]);
  assert.deepEqual([O3, O4, O6].map((o) => states[o.id]), ["COMMITTED", "COMMITTED", "COMMITTED"]);
  assert.equal(states[O5.id], "RELEASED");
  assert.equal(states[OC.id], "NONE", "an order of only untracked products holds no stock");
  assert.deepEqual(await fx.ledgerInvariants(db, `P:${A.id}`), []);

  // 4. Post-migration reconciliation and an idempotent re-run.
  const post = await mig.reconcile(db, { only });
  const postA = post.products.find((p) => p.productId === A.id)!;
  assert.equal(postA.model, "migrated");
  assert.deepEqual(postA.violations, []);
  assert.deepEqual(postA.pending, []);
  const movementsBefore = await db.stockMovement.count({ where: { productId: A.id } });
  const rerun = await mig.runBackfill(db, { apply: true, only });
  assert.equal(rerun.summary.migrated, 0);
  assert.deepEqual(await fx.stockRow(db, A.id), { quantity: 15, reservedQuantity: 4 }, "re-run changes nothing");
  assert.equal(await db.stockMovement.count({ where: { productId: A.id } }), movementsBefore);

  // 5. The previous code keeps running during the cutover window: places O8, ships O1, cancels O2, places and ships O9.
  const O8 = await place({ customerId: buyer.id, items: [line(A.id, 2)] }, 2);
  await db.retailOrder.update({ where: { id: O1.id }, data: { status: "SHIPPED", trackingNumber: "AWB-2" } });
  await db.retailOrder.update({ where: { id: O2.id }, data: { status: "CANCELLED", paymentStatus: "REFUNDED" } }); await legacyRelease(A.id, 1);
  const O9 = await place({ customerId: buyer.id, items: [line(A.id, 1)] }, 1);
  await db.retailOrder.update({ where: { id: O9.id }, data: { status: "SHIPPED", trackingNumber: "AWB-3" } });
  assert.deepEqual(await fx.stockRow(db, A.id), { quantity: 15, reservedQuantity: 6 });
  const mid = await mig.reconcile(db, { only });
  assert.ok(mid.products.find((p) => p.productId === A.id)!.pending.length >= 3, "pending convergence is reported");

  // 6. Converge (the backfill re-run after the traffic move).
  const converged = await mig.runBackfill(db, { apply: true, only });
  assert.deepEqual(converged.ordersSettled.map((s) => [s.orderId, s.to]).sort(), [[O1.id, "COMMITTED"], [O2.id, "RELEASED"], [O9.id, "COMMITTED"]].sort());
  assert.deepEqual(await fx.stockRow(db, A.id), { quantity: 12, reservedQuantity: 3 }, "O1 (2) and O9 (1) left the warehouse; O7 (1) + O8 (2) still held");
  const final = await mig.reconcile(db, { only });
  const finalA = final.products.find((p) => p.productId === A.id)!;
  assert.deepEqual(finalA.violations, []);
  assert.deepEqual(finalA.pending, []);
  assert.deepEqual(await fx.ledgerInvariants(db, `P:${A.id}`), []);

  // 7. Rollback: the legacy model of the same history is quantity 20 (never decremented) and reserved 11 (O1, O3, O4,
  //    O6, O7, O8, O9 uncancelled = 2+3+1+1+1+2+1).
  const rollbackDry = await mig.rollbackMigration(db, { apply: false, only });
  assert.equal(rollbackDry.refused, null);
  assert.deepEqual(rollbackDry.products.map((p) => p.after), [{ quantity: 20, reserved: 11 }]);
  assert.deepEqual(await fx.stockRow(db, A.id), { quantity: 12, reservedQuantity: 3 }, "rollback dry run wrote nothing");
  const archive = openArchive(fx.archivePath("migration"));
  const rolledBack = await mig.rollbackMigration(db, { apply: true, only, archive });
  const summary = archive.close();
  assert.equal(rolledBack.status, "complete");
  assert.deepEqual(await fx.stockRow(db, A.id), { quantity: 20, reservedQuantity: 11 });
  const verification = verifyArchive(summary.path, { sha256: summary.sha256, committed: mig.committedScopes(rolledBack) });
  assert.deepEqual(verification.problems, [], "every deleted ledger row is in the archive");
  assert.ok(rolledBack.products[0].movementIds.length > 0);
  assert.equal(await db.stockMovement.count({ where: { productId: { in: only } } }), 0);
  assert.equal(await db.inventoryMigration.count({ where: { productId: { in: only } } }), 0);
  assert.equal(await db.retailOrder.count({ where: { items: { some: { productId: { in: only } } }, stockState: { not: null } } }), 0);
  const legacyAgain = await mig.reconcile(db, { only });
  assert.deepEqual(legacyAgain.products.find((p) => p.productId === A.id)!.violations, [], "rolled-back numbers are consistent legacy numbers");
  // The previous code keeps working on the rolled-back numbers.
  await legacyReserve(A.id, 9);
  await assert.rejects(legacyReserve(A.id, 1), (error: { code?: string }) => error.code === "INSUFFICIENT_STOCK");
});

test("rollback is refused while variant-level stock exists", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const V = await fx.product(db, { categoryId: cat.id, quantity: null, stockLevel: "VARIANT", variants: [{ name: "Beige", onHand: 2 }] });
  const archive = openArchive(fx.archivePath("refused"));
  const result = await mig.rollbackMigration(db, { apply: true, only: [V.id], archive });
  assert.equal(archive.close().entries, 0, "nothing archived, nothing deleted");
  assert.equal(result.status, "refused");
  assert.match(result.refused ?? "", /variant-level stock exists/);
  assert.deepEqual(await fx.variantRow(db, V.variants[0].id), { onHand: 2, reserved: 0 }, "nothing changed");
});

test("backfill skips variant-level products (D4 pending) and reports them", { skip: skipReason }, async () => {
  const cat = await fx.category(db);
  const V = await fx.product(db, { categoryId: cat.id, quantity: 4, stockLevel: "VARIANT", legacy: true, variants: [{ name: "Grey", onHand: null }] });
  const report = await mig.runBackfill(db, { apply: true, only: [V.id] });
  assert.equal(report.products[0].mode, "skip");
  assert.match(report.products[0].problems[0], /D4 pending/);
  assert.deepEqual(await fx.stockRow(db, V.id), { quantity: 4, reservedQuantity: 0 });
});
