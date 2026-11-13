import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import {
  adoptLegacyReservation,
  applyLedgerClear,
  applyLegacyRestore,
  commitForOrder,
  migrateProductStock,
  planLedgerClear,
  planLegacyRestore,
  productStockKey,
  recordLegacyRelease,
  setOrderStockState,
} from "./inventory.service.js";
import { retryOnConflict } from "./order.service.js";

// Inventory backfill, reconciliation and rollback (expand stage tooling; see the approved plan, section 5).
// Rules (binding safeguards):
//  - available stock (quantity - reservedQuantity) is identical before and after the conversion of every product;
//  - a product whose numbers don't reconcile is SKIPPED and reported, never repaired;
//  - every write goes through inventory.service.ts; this module only gathers facts, decides, and reports;
//  - dry runs are pure reads: no transaction, no locking read, no INSERT/UPDATE/DELETE (they work in a database
//    session that is read-only), and they report exactly the actions an apply would take on the same data;
//  - apply locks in one order everywhere: the product's order rows (by id), then the product row (FOR SHARE), then the
//    stock row (FOR UPDATE), the same order as cancellation, expiry, refunds and dispatch (order → product → stock).

export type OrderClass = "RESERVED" | "COMMITTED" | "RELEASED";
type OrderFacts = { status: string; trackingNumber: string | null; pickedUpAt: Date | null };

// Where a legacy order's units are: dispatched orders have left the warehouse; cancelled ones (including expired and
// refunded before dispatch) gave their units back; everything else still holds them.
export function classifyOrder(order: OrderFacts): OrderClass {
  if (order.status === "SHIPPED" || order.status === "COMPLETED" || order.trackingNumber !== null || order.pickedUpAt !== null) return "COMMITTED";
  if (order.status === "CANCELLED") return "RELEASED";
  return "RESERVED";
}

// Optional scope: limit a run to some products (rehearsing one product; tests sharing a database). Default: all.
export type Scope = { only?: string[] };
const byProduct = (scope: Scope) => (scope.only ? { productId: { in: scope.only } } : {});
const productById = (scope: Scope) => (scope.only ? { id: { in: scope.only } } : {});
const ordersOf = (scope: Scope) => (scope.only ? { items: { some: { productId: { in: scope.only } } } } : {});

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Reader = Db | Tx;
type Line = { orderId: string; quantity: number; cls: OrderClass; stockState: string | null };
const sum = (lines: Line[]) => lines.reduce((total, line) => total + line.quantity, 0);

async function orderLinesFor(db: Reader, productId: string): Promise<Line[]> {
  const items = await db.retailOrderItem.findMany({
    where: { productId },
    select: { quantity: true, order: { select: { id: true, status: true, trackingNumber: true, stockState: true, shipment: { select: { pickedUpAt: true } } } } },
  });
  const byOrder = new Map<string, Line>();
  for (const item of items) {
    const order = item.order;
    const existing = byOrder.get(order.id);
    if (existing) { existing.quantity += item.quantity; continue; }
    byOrder.set(order.id, { orderId: order.id, quantity: item.quantity, cls: classifyOrder({ status: order.status, trackingNumber: order.trackingNumber, pickedUpAt: order.shipment?.pickedUpAt ?? null }), stockState: order.stockState });
  }
  return [...byOrder.values()].sort((a, b) => a.orderId.localeCompare(b.orderId));
}

// ---- backfill ------------------------------------------------------------------------------------------------------

export type ProductResult = {
  productId: string;
  name: string;
  mode: "migrate" | "converge" | "skip";
  before: { quantity: number; reserved: number; available: number };
  after: { quantity: number; reserved: number; available: number } | null;
  committedUnits: number;
  openUnits: number;
  ordersByClass: Record<OrderClass, number>;
  actions: string[];
  problems: string[];
};

export type BackfillReport = {
  kind: "backfill";
  apply: boolean;
  generatedAt: string;
  products: ProductResult[];
  ordersSettled: { orderId: string; to: OrderClass; drift: string[] }[];
  productsWithoutInventory: { productId: string; name: string; status: string; inventoryPolicy: string }[];
  ordersMarkedNone: number;
  summary: { products: number; migrated: number; converged: number; skipped: number; unchanged: number; problems: number; availableChanged: number };
};

type ProductFacts = {
  productId: string;
  name: string;
  quantity: number;
  reserved: number;
  lines: Line[];
  snapshot: { committedUnits: number } | null;
  ledgerRows: number;
  ledgeredOrderIds: Set<string>;
};

// Everything the decision needs, by plain reads (never locking). In an apply these run after the locks are held.
async function readFacts(db: Reader, productId: string, name: string, row: { quantity: number; reservedQuantity: number }): Promise<ProductFacts> {
  const lines = await orderLinesFor(db, productId);
  const snapshot = await db.inventoryMigration.findUnique({ where: { productId }, select: { committedUnits: true } });
  const key = productStockKey(productId);
  const ledgerRows = await db.stockMovement.count({ where: { stockKey: key } });
  const ledgered = await db.stockMovement.findMany({ where: { stockKey: key, orderId: { not: null }, kind: { in: ["MIGRATION", "RESERVE"] } }, select: { orderId: true } });
  return { productId, name, quantity: Number(row.quantity), reserved: Number(row.reservedQuantity), lines, snapshot, ledgerRows, ledgeredOrderIds: new Set(ledgered.map((movement) => movement.orderId!)) };
}

type Op =
  | { type: "migrate"; committed: Line[]; open: Line[] }
  | { type: "state"; orderIds: string[]; state: OrderClass }
  | { type: "adopt"; orderId: string; quantity: number; setReserved: boolean };

// The pure decision, identical for a dry run and an apply. `lockedOrderIds` (apply only): orders that appeared after
// the locks were planned are not locked, so the product is left for a re-run instead of being touched.
function decide(facts: ProductFacts, lockedOrderIds?: Set<string>): ProductResult & { ops: Op[] } {
  const { productId, name, quantity, reserved, lines } = facts;
  const before = { quantity, reserved, available: quantity - reserved };
  const ordersByClass = { RESERVED: 0, COMMITTED: 0, RELEASED: 0 } as Record<OrderClass, number>;
  for (const line of lines) ordersByClass[line.cls]++;
  const committed = lines.filter((line) => line.cls === "COMMITTED");
  const open = lines.filter((line) => line.cls === "RESERVED");
  const base = { productId, name, before, committedUnits: facts.snapshot?.committedUnits ?? sum(committed), openUnits: sum(open), ordersByClass };
  const unlocked = lockedOrderIds ? lines.filter((line) => !lockedOrderIds.has(line.orderId)) : [];
  if (unlocked.length) return { ...base, mode: "skip", after: null, actions: [], problems: [`${unlocked.length} order(s) were placed while the backfill ran; run it again`], ops: [] };

  if (!facts.snapshot) {
    // C2: a product already on the ledger without a snapshot (created or restocked by the new code) must never get a
    // second opening balance.
    if (facts.ledgerRows > 0) return { ...base, committedUnits: 0, mode: "skip", after: null, actions: [], problems: [`already on the ledger (${facts.ledgerRows} movement(s)) without a migration snapshot; not converted again`], ops: [] };
    const problems: string[] = [];
    const committedUnits = sum(committed);
    const openUnits = sum(open);
    const newOnHand = quantity - committedUnits;
    const newReserved = reserved - committedUnits;
    if (quantity < 0 || reserved < 0) problems.push(`negative legacy values (quantity ${quantity}, reserved ${reserved})`);
    if (newReserved !== openUnits) problems.push(`reserved after conversion would be ${newReserved}, but open (undispatched, uncancelled) orders hold ${openUnits}: legacy reservedQuantity ${reserved} differs from the ${committedUnits + openUnits} units of dispatched and open orders by ${reserved - committedUnits - openUnits}`);
    if (newReserved < 0) problems.push(`reserved would become negative (${newReserved})`);
    if (newOnHand < newReserved) problems.push(`on hand (${newOnHand}) would be below reserved (${newReserved})`);
    if (problems.length) return { ...base, mode: "skip", after: null, actions: [], problems, ops: [] };
    const ops: Op[] = [{ type: "migrate", committed, open }];
    const actions = [`convert: quantity ${quantity}→${newOnHand}, reserved ${reserved}→${newReserved} (${committedUnits} dispatched unit(s) taken off both)`];
    for (const cls of ["RESERVED", "COMMITTED", "RELEASED"] as OrderClass[]) {
      const ids = lines.filter((line) => line.cls === cls && line.stockState === null).map((line) => line.orderId);
      if (ids.length) { ops.push({ type: "state", orderIds: ids, state: cls }); actions.push(`${ids.length} order(s) marked ${cls}`); }
    }
    return { ...base, mode: "migrate", after: { quantity: newOnHand, reserved: newReserved, available: newOnHand - newReserved }, actions, problems: [], ops };
  }

  // Already migrated, phase 1 of convergence (per product): an order the previous code placed after the conversion
  // reserved units without a ledger entry; adopt that reservation (no stock change). Settling orders (commit/release)
  // is phase 2, per order, after every product has been adopted (convergeOrders).
  const ops: Op[] = [];
  const actions: string[] = [];
  for (const line of lines) {
    if (facts.ledgeredOrderIds.has(line.orderId)) continue;
    if (line.stockState !== null && line.stockState !== "RESERVED") continue;
    if (line.cls === "RELEASED") {
      // Placed and cancelled by the previous code after migration: reserved and given back, so nothing is held.
      if (line.stockState === null) { ops.push({ type: "state", orderIds: [line.orderId], state: "RELEASED" }); actions.push(`order ${line.orderId}: placed and cancelled by previous code after migration → RELEASED`); }
      continue;
    }
    ops.push({ type: "adopt", orderId: line.orderId, quantity: line.quantity, setReserved: line.stockState === null });
    actions.push(`order ${line.orderId}: reservation of ${line.quantity} unit(s) by previous code adopted${line.cls === "COMMITTED" ? " (dispatched since; committed in phase 2)" : ""}`);
  }
  return { ...base, mode: ops.length ? "converge" : "skip", after: { ...before }, actions: actions.length ? actions : ["already migrated; nothing to converge"], problems: [], ops };
}

async function execute(tx: Tx, facts: ProductFacts, ops: Op[]): Promise<string | null> {
  for (const op of ops) {
    if (op.type === "migrate") {
      const done = await migrateProductStock(tx, {
        productId: facts.productId,
        oldQuantity: facts.quantity,
        oldReserved: facts.reserved,
        committedLines: op.committed.map(({ orderId, quantity }) => ({ orderId, quantity })),
        reservedLines: op.open.map(({ orderId, quantity }) => ({ orderId, quantity })),
      });
      if (!done) return "stock changed while the backfill ran; run it again";
    } else if (op.type === "state") {
      const changed = await setOrderStockState(tx, op.orderIds, op.state);
      if (changed !== op.orderIds.length) throw new Error(`Expected to mark ${op.orderIds.length} order(s) ${op.state}, marked ${changed}`);
    } else {
      await adoptLegacyReservation(tx, { productId: facts.productId, orderId: op.orderId, quantity: op.quantity });
      if (op.setReserved) {
        const changed = await setOrderStockState(tx, [op.orderId], "RESERVED");
        if (changed !== 1) throw new Error(`Order ${op.orderId} changed while the backfill ran`);
      }
    }
  }
  return null;
}

const strip = ({ ops: _ops, ...result }: ProductResult & { ops: Op[] }): ProductResult => result;

async function backfillProduct(db: Db, productId: string, name: string, apply: boolean): Promise<ProductResult> {
  if (!apply) {
    const row = await db.inventory.findUnique({ where: { productId }, select: { quantity: true, reservedQuantity: true } });
    if (!row) throw new Error(`No stock row for product ${productId}`);
    return strip(decide(await readFacts(db, productId, name, row)));
  }
  // The orders to lock are read first (outside the transaction); orders placed after that are detected and the
  // product is left for a re-run.
  const orderIds = [...new Set((await db.retailOrderItem.findMany({ where: { productId }, select: { orderId: true } })).map((item) => item.orderId))].sort();
  return retryOnConflict(() => db.$transaction(async (tx) => {
    // Lock order: order rows (id order) → product (shared) → stock row. The first statements are locking reads, so
    // the plain reads below see the data as it is once every lock is held.
    if (orderIds.length) await tx.$queryRaw`SELECT id FROM RetailOrder WHERE id IN (${Prisma.join(orderIds)}) ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM Product WHERE id = ${productId} FOR SHARE`;
    const rows = await tx.$queryRaw<{ quantity: number; reservedQuantity: number }[]>`SELECT quantity, reservedQuantity FROM Inventory WHERE productId = ${productId} FOR UPDATE`;
    if (rows.length === 0) throw new Error(`No stock row for product ${productId}`);
    const facts = await readFacts(tx, productId, name, rows[0]);
    const decision = decide(facts, new Set(orderIds));
    const failure = await execute(tx, facts, decision.ops);
    if (failure) return { ...strip(decision), mode: "skip" as const, after: null, actions: [], problems: [failure] };
    return strip(decision);
  }, { maxWait: 10_000, timeout: 60_000 }));
}

// Phase 2 of convergence (per order): an order whose stock is still RESERVED but which the previous code dispatched
// or cancelled after migration is settled now, exactly once (the inventory service's compare-and-set under the order
// lock). A dry run only lists them.
async function convergeOrders(db: Db, apply: boolean, scope: Scope): Promise<{ orderId: string; to: OrderClass; drift: string[] }[]> {
  const orders = await db.retailOrder.findMany({ where: { stockState: "RESERVED", ...ordersOf(scope) }, select: { id: true, status: true, trackingNumber: true, shipment: { select: { pickedUpAt: true } } }, orderBy: { id: "asc" } });
  const settled: { orderId: string; to: OrderClass; drift: string[] }[] = [];
  for (const order of orders) {
    const cls = classifyOrder({ status: order.status, trackingNumber: order.trackingNumber, pickedUpAt: order.shipment?.pickedUpAt ?? null });
    if (cls === "RESERVED") continue;
    const drift: string[] = [];
    if (apply) {
      await retryOnConflict(() => db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM RetailOrder WHERE id = ${order.id} FOR UPDATE`;
        if (cls === "COMMITTED") {
          const result = await commitForOrder(tx, order.id, "dispatched by previous code after migration");
          for (const item of result.drift) drift.push(`${item.key} could not absorb ${item.quantity} unit(s)`);
        } else await recordLegacyRelease(tx, order.id);
      }));
    }
    settled.push({ orderId: order.id, to: cls, drift });
  }
  return settled;
}

export async function runBackfill(db: Db, options: { apply: boolean } & Scope): Promise<BackfillReport> {
  const rows = await db.inventory.findMany({ where: byProduct(options), select: { productId: true, product: { select: { name: true, stockLevel: true } } }, orderBy: { productId: "asc" } });
  const products: ProductResult[] = [];
  for (const row of rows) {
    if (row.product.stockLevel === "VARIANT") {
      products.push({ productId: row.productId, name: row.product.name, mode: "skip", before: { quantity: 0, reserved: 0, available: 0 }, after: null, committedUnits: 0, openUnits: 0, ordersByClass: { RESERVED: 0, COMMITTED: 0, RELEASED: 0 }, actions: [], problems: ["variant-level stock is outside the expand-stage backfill (D4 pending)"] });
      continue;
    }
    products.push(await backfillProduct(db, row.productId, row.product.name, options.apply));
  }
  const ordersSettled = await convergeOrders(db, options.apply, options);
  const productsWithoutInventory = (await db.product.findMany({ where: { inventory: null, ...productById(options) }, select: { id: true, name: true, status: true, inventoryPolicy: true }, orderBy: { name: "asc" } }))
    .map((product) => ({ productId: product.id, name: product.name, status: product.status, inventoryPolicy: product.inventoryPolicy }));
  // Orders whose every line is on a product without a stock row hold no tracked stock.
  const unclassified = await db.retailOrder.findMany({ where: { stockState: null, ...ordersOf(options) }, select: { id: true, items: { select: { product: { select: { inventory: { select: { id: true } } } } } } } });
  const noneIds = unclassified.filter((order) => order.items.every((item) => item.product.inventory === null)).map((order) => order.id).sort();
  const ordersMarkedNone = options.apply && noneIds.length ? await db.$transaction((tx) => setOrderStockState(tx, noneIds, "NONE")) : noneIds.length;
  const migrated = products.filter((p) => p.mode === "migrate").length;
  const converged = products.filter((p) => p.mode === "converge").length;
  const skipped = products.filter((p) => p.mode === "skip" && p.problems.length).length;
  return {
    kind: "backfill",
    apply: options.apply,
    generatedAt: new Date().toISOString(),
    products,
    ordersSettled,
    productsWithoutInventory,
    ordersMarkedNone,
    summary: {
      products: products.length,
      migrated,
      converged,
      skipped,
      unchanged: products.length - migrated - converged - skipped,
      problems: products.reduce((n, p) => n + p.problems.length, 0),
      availableChanged: products.filter((p) => p.mode === "migrate" && p.after && p.after.available !== p.before.available).length,
    },
  };
}

// ---- reconciliation (read-only) -------------------------------------------------------------------------------------

export type ReconcileProduct = {
  productId: string;
  name: string;
  model: "legacy" | "migrated";
  quantity: number;
  reserved: number;
  available: number;
  expectedReserved: number;
  ledger: { onHand: number; reserved: number } | null;
  violations: string[];
  pending: string[];
};

export type ReconcileReport = {
  kind: "reconcile";
  generatedAt: string;
  products: ReconcileProduct[];
  variantRows: { variantId: string; productId: string; onHand: number; reserved: number; violations: string[] }[];
  productsWithoutInventory: { productId: string; name: string; status: string; inventoryPolicy: string }[];
  summary: { products: number; legacy: number; migrated: number; violations: number; pending: number };
};

export async function reconcile(db: Reader, scope: Scope = {}): Promise<ReconcileReport> {
  const rows = await db.inventory.findMany({ where: byProduct(scope), select: { productId: true, quantity: true, reservedQuantity: true, product: { select: { name: true } } }, orderBy: { productId: "asc" } });
  const migratedIds = new Set((await db.inventoryMigration.findMany({ where: byProduct(scope), select: { productId: true } })).map((row) => row.productId));
  const products: ReconcileProduct[] = [];
  for (const row of rows) {
    const lines = await orderLinesFor(db, row.productId);
    const violations: string[] = [];
    const pending: string[] = [];
    const base = { productId: row.productId, name: row.product.name, quantity: row.quantity, reserved: row.reservedQuantity, available: row.quantity - row.reservedQuantity };
    if (row.quantity < 0 || row.reservedQuantity < 0) violations.push("negative stock value");
    const key = productStockKey(row.productId);
    const ledgerRows = await db.stockMovement.count({ where: { stockKey: key } });
    if (!migratedIds.has(row.productId) && ledgerRows === 0) {
      // Legacy model: reservedQuantity holds every order that was not cancelled (open and dispatched).
      const expectedReserved = sum(lines.filter((line) => line.cls !== "RELEASED"));
      if (row.reservedQuantity !== expectedReserved) violations.push(`reservedQuantity ${row.reservedQuantity} ≠ ${expectedReserved} units of uncancelled orders (difference ${row.reservedQuantity - expectedReserved})`);
      if (row.reservedQuantity > row.quantity) violations.push(`reservedQuantity ${row.reservedQuantity} > quantity ${row.quantity}`);
      products.push({ ...base, model: "legacy", expectedReserved, ledger: null, violations, pending });
      continue;
    }
    const ledgerSums = await db.stockMovement.aggregate({ where: { stockKey: key }, _sum: { onHandDelta: true, reservedDelta: true } });
    const ledger = { onHand: ledgerSums._sum.onHandDelta ?? 0, reserved: ledgerSums._sum.reservedDelta ?? 0 };
    const held = await db.stockMovement.groupBy({ by: ["orderId"], where: { stockKey: key, orderId: { not: null }, kind: { in: ["RESERVE", "MIGRATION", "RELEASE", "COMMIT"] } }, _sum: { reservedDelta: true } });
    const expectedReserved = held.reduce((total, item) => total + Math.max(0, item._sum.reservedDelta ?? 0), 0);
    if (ledger.onHand !== row.quantity) violations.push(`on hand ${row.quantity} ≠ ledger ${ledger.onHand}`);
    if (ledger.reserved !== row.reservedQuantity) violations.push(`reserved ${row.reservedQuantity} ≠ ledger ${ledger.reserved}`);
    if (row.reservedQuantity !== expectedReserved) violations.push(`reserved ${row.reservedQuantity} ≠ ${expectedReserved} units held by open orders`);
    if (row.reservedQuantity > row.quantity) violations.push(`reserved ${row.reservedQuantity} > on hand ${row.quantity}`);
    for (const line of lines) {
      if (line.stockState === null) pending.push(`order ${line.orderId} has no stock state (placed by previous code after migration)`);
      else if (line.stockState === "RESERVED" && line.cls !== "RESERVED") pending.push(`order ${line.orderId} is ${line.cls.toLowerCase()} but its stock is still RESERVED`);
    }
    products.push({ ...base, model: "migrated", expectedReserved, ledger, violations, pending });
  }
  const variantRows = [];
  for (const row of await db.variantInventory.findMany({ where: byProduct(scope), orderBy: { variantId: "asc" } })) {
    const ledgerSums = await db.stockMovement.aggregate({ where: { stockKey: `V:${row.variantId}` }, _sum: { onHandDelta: true, reservedDelta: true } });
    const violations: string[] = [];
    if (row.onHand < 0 || row.reserved < 0) violations.push("negative stock value");
    if (row.reserved > row.onHand) violations.push(`reserved ${row.reserved} > on hand ${row.onHand}`);
    if ((ledgerSums._sum.onHandDelta ?? 0) !== row.onHand || (ledgerSums._sum.reservedDelta ?? 0) !== row.reserved) violations.push("stock row ≠ ledger");
    variantRows.push({ variantId: row.variantId, productId: row.productId, onHand: row.onHand, reserved: row.reserved, violations });
  }
  const productsWithoutInventory = (await db.product.findMany({ where: { inventory: null, ...productById(scope) }, select: { id: true, name: true, status: true, inventoryPolicy: true }, orderBy: { name: "asc" } }))
    .map((product) => ({ productId: product.id, name: product.name, status: product.status, inventoryPolicy: product.inventoryPolicy }));
  return {
    kind: "reconcile",
    generatedAt: new Date().toISOString(),
    products,
    variantRows,
    productsWithoutInventory,
    summary: {
      products: products.length,
      legacy: products.filter((p) => p.model === "legacy").length,
      migrated: products.filter((p) => p.model === "migrated").length,
      violations: products.reduce((n, p) => n + p.violations.length, 0) + variantRows.reduce((n, r) => n + r.violations.length, 0),
      pending: products.reduce((n, p) => n + p.pending.length, 0),
    },
  };
}

// ---- rollback ------------------------------------------------------------------------------------------------------

// Where rolled-back rows go before they are deleted. record() must make the entry durable (written and flushed)
// before it returns; src/scripts/inventory-archive.ts provides the file implementation.
export interface RollbackArchive { record(entry: object): void }

export type RollbackProduct = { productId: string; status: "planned" | "committed"; before: { quantity: number; reserved: number }; after: { quantity: number; reserved: number }; committedBefore: number; committedSince: number; snapshot: boolean; movementIds: string[] };

export type RollbackReport = {
  kind: "rollback";
  apply: boolean;
  generatedAt: string;
  status: "refused" | "planned" | "complete" | "partial";
  refused: string | null;
  products: RollbackProduct[];
  failed: { scope: string; error: string } | null;
  notStarted: string[];
  cleared: { status: "planned" | "committed" | "not run"; movements: number; orders: number; movementIds: string[] };
};

// The actual cause for a report: a database error's own message (Prisma's wrapper text is only call-site boilerplate),
// otherwise the last non-empty line of the error message.
function errorText(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown; meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown; originalCode?: unknown } } } };
  const cause = e?.meta?.driverAdapterError?.cause;
  if (cause?.originalMessage) return `${e.code ?? "database"} ${cause.originalCode ?? ""}: ${String(cause.originalMessage)}`.slice(0, 300);
  const lines = String(e?.message ?? error).split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? "unknown error").slice(0, 300);
}

// Returns products to the legacy numbers exactly, then clears the ledger and order stock states. Every product with a
// migration snapshot or with COMMIT movements is restored (C5: no snapshot means 0 units dispatched before migration).
// With apply, each product's ledger rows and snapshot are archived durably BEFORE its transaction deletes them, the
// transaction deletes exactly those rows, and a commit marker follows; a failure stops the run (status "partial", the
// failed product and the ones not started are reported) without deleting anything the archive doesn't hold, and the
// clear step only runs after every product succeeded. The dry run is a pure read. Refused while variant-level stock
// exists (it has no legacy equivalent).
export async function rollbackMigration(db: Db, options: { apply: boolean; archive?: RollbackArchive } & Scope): Promise<RollbackReport> {
  const generatedAt = new Date().toISOString();
  const report = (fields: Partial<RollbackReport>): RollbackReport => ({ kind: "rollback", apply: options.apply, generatedAt, status: "planned", refused: null, products: [], failed: null, notStarted: [], cleared: { status: "not run", movements: 0, orders: 0, movementIds: [] }, ...fields });
  if (options.apply && !options.archive) throw new Error("A rollback with apply needs a durable archive");
  const variantRows = await db.variantInventory.count({ where: byProduct(options) });
  const variantProducts = await db.product.count({ where: { stockLevel: "VARIANT", ...productById(options) } });
  if (variantRows > 0 || variantProducts > 0) return report({ status: "refused", refused: `variant-level stock exists (${variantRows} row(s), ${variantProducts} product(s)); switch those products back to product level first` });

  const snapshotIds = (await db.inventoryMigration.findMany({ where: byProduct(options), select: { productId: true } })).map((row) => row.productId);
  const committedIds = (await db.stockMovement.findMany({ where: { kind: "COMMIT", stockKey: { startsWith: "P:" }, ...byProduct(options) }, select: { productId: true }, distinct: ["productId"] })).map((row) => row.productId);
  const productIds = [...new Set([...snapshotIds, ...committedIds])].sort();
  const view = (plan: Awaited<ReturnType<typeof planLegacyRestore>>, status: RollbackProduct["status"]): RollbackProduct => ({ productId: plan.productId, status, before: plan.before, after: plan.after, committedBefore: plan.committedBefore, committedSince: plan.committedSince, snapshot: plan.snapshot !== null, movementIds: plan.movements.map((movement) => movement.id) });

  if (!options.apply) {
    const products = [];
    for (const productId of productIds) products.push(view(await planLegacyRestore(db, productId, { lock: false }), "planned"));
    const clear = await planLedgerClear(db, options.only);
    const restoredIds = new Set(products.flatMap((product) => product.movementIds));
    const remaining = clear.movements.filter((movement) => !restoredIds.has(movement.id));
    return report({ status: "planned", products, cleared: { status: "planned", movements: remaining.length, orders: clear.orderIds.length, movementIds: remaining.map((movement) => movement.id) } });
  }

  const archive = options.archive!;
  const products: RollbackProduct[] = [];
  for (const [index, productId] of productIds.entries()) {
    const scope = `product:${productId}`;
    let committed: RollbackProduct | null = null;
    try {
      committed = await retryOnConflict(() => db.$transaction(async (tx) => {
        const plan = await planLegacyRestore(tx, productId, { lock: true });
        archive.record({ type: "product", phase: "prepared", scope, productId, before: plan.before, after: plan.after, committedBefore: plan.committedBefore, committedSince: plan.committedSince, snapshot: plan.snapshot, movements: plan.movements, at: new Date().toISOString() });
        await applyLegacyRestore(tx, plan);
        return view(plan, "committed");
      }, { maxWait: 10_000, timeout: 60_000 }));
    } catch (error) {
      archive.record({ type: "product", phase: "failed", scope, productId, error: errorText(error), at: new Date().toISOString() });
      return report({ status: "partial", products, failed: { scope, error: errorText(error) }, notStarted: productIds.slice(index + 1) });
    }
    archive.record({ type: "product", phase: "committed", scope, productId, movements: committed.movementIds.length, at: new Date().toISOString() });
    products.push(committed);
  }

  const scope = "clear";
  try {
    const cleared = await retryOnConflict(() => db.$transaction(async (tx) => {
      const plan = await planLedgerClear(tx, options.only);
      archive.record({ type: "clear", phase: "prepared", scope, movements: plan.movements, orderIds: plan.orderIds, at: new Date().toISOString() });
      const result = await applyLedgerClear(tx, plan);
      return { ...result, movementIds: plan.movements.map((movement) => movement.id) };
    }, { maxWait: 10_000, timeout: 60_000 }));
    archive.record({ type: "clear", phase: "committed", scope, movements: cleared.movements, orders: cleared.orders, at: new Date().toISOString() });
    return report({ status: "complete", products, cleared: { status: "committed", ...cleared } });
  } catch (error) {
    archive.record({ type: "clear", phase: "failed", scope, error: errorText(error), at: new Date().toISOString() });
    return report({ status: "partial", products, failed: { scope, error: errorText(error) } });
  }
}

// What an archive must hold for a rollback report: every committed scope and the ledger ids it deleted.
export function committedScopes(result: RollbackReport): { scope: string; movementIds: string[] }[] {
  const scopes = result.products.filter((product) => product.status === "committed").map((product) => ({ scope: `product:${product.productId}`, movementIds: product.movementIds }));
  if (result.cleared.status === "committed") scopes.push({ scope: "clear", movementIds: result.cleared.movementIds });
  return scopes;
}

// ---- reports -------------------------------------------------------------------------------------------------------

export function renderMarkdown(report: BackfillReport | ReconcileReport | (RollbackReport & { archive?: unknown; verification?: unknown })): string {
  const out: string[] = [`# Inventory ${report.kind} report`, "", `Generated ${report.generatedAt}${"apply" in report ? ` · ${report.apply ? "APPLIED" : "DRY RUN (nothing written)"}` : ""}`, ""];
  if (report.kind === "backfill") {
    out.push("| Summary | |", "|---|---|", ...Object.entries(report.summary).map(([k, v]) => `| ${k} | ${v} |`), "");
    out.push("| Product | Mode | Before q/r/avail | After q/r/avail | Dispatched units | Open units | Problems |", "|---|---|---|---|---|---|---|");
    for (const p of report.products) out.push(`| ${p.name} \`${p.productId}\` | ${p.mode} | ${p.before.quantity}/${p.before.reserved}/${p.before.available} | ${p.after ? `${p.after.quantity}/${p.after.reserved}/${p.after.available}` : "—"} | ${p.committedUnits} | ${p.openUnits} | ${p.problems.join("; ") || "—"} |`);
    out.push("", `Orders settled: ${report.ordersSettled.length} · orders marked NONE: ${report.ordersMarkedNone}`);
    out.push("", `Products without a stock row (not purchasable after the switch-over unless given stock or an authorised UNLIMITED policy): ${report.productsWithoutInventory.length}`);
    for (const p of report.productsWithoutInventory) out.push(`- ${p.name} \`${p.productId}\` (${p.status}, ${p.inventoryPolicy})`);
  } else if (report.kind === "reconcile") {
    out.push("| Summary | |", "|---|---|", ...Object.entries(report.summary).map(([k, v]) => `| ${k} | ${v} |`), "");
    out.push("| Product | Model | On hand | Reserved | Available | Expected reserved | Ledger | Violations | Pending |", "|---|---|---|---|---|---|---|---|---|");
    for (const p of report.products) out.push(`| ${p.name} \`${p.productId}\` | ${p.model} | ${p.quantity} | ${p.reserved} | ${p.available} | ${p.expectedReserved} | ${p.ledger ? `${p.ledger.onHand}/${p.ledger.reserved}` : "—"} | ${p.violations.join("; ") || "—"} | ${p.pending.join("; ") || "—"} |`);
    out.push("", `Products without a stock row: ${report.productsWithoutInventory.length}`);
    for (const p of report.productsWithoutInventory) out.push(`- ${p.name} \`${p.productId}\` (${p.status}, ${p.inventoryPolicy})`);
  } else {
    out.push(`**Status: ${report.status}**${report.refused ? ` · refused: ${report.refused}` : ""}${report.failed ? ` · failed at ${report.failed.scope}: ${report.failed.error}` : ""}`, "");
    out.push("| Product | Status | Before q/r | After q/r | Dispatched before migration | Committed since | Snapshot | Ledger rows |", "|---|---|---|---|---|---|---|---|");
    for (const p of report.products) out.push(`| \`${p.productId}\` | ${p.status} | ${p.before.quantity}/${p.before.reserved} | ${p.after.quantity}/${p.after.reserved} | ${p.committedBefore} | ${p.committedSince} | ${p.snapshot ? "yes" : "no"} | ${p.movementIds.length} |`);
    if (report.notStarted.length) out.push("", `Not started (left as they are): ${report.notStarted.map((id) => `\`${id}\``).join(", ")}`);
    out.push("", `Clear step: ${report.cleared.status} · ${report.cleared.movements} ledger row(s) · ${report.cleared.orders} order state(s)`);
    if ("archive" in report && report.archive) out.push("", `Archive: \`${JSON.stringify(report.archive)}\``, `Verification: \`${JSON.stringify(report.verification ?? null)}\``);
  }
  return out.join("\n") + "\n";
}
