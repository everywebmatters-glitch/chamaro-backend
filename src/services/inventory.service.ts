import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { httpError } from "../shared/http.js";
import { unitsPerProduct } from "../shared/order-pricing.js";

// The single authoritative path for every stock write. No other module may UPDATE or upsert Inventory or
// VariantInventory rows, or write StockMovement rows.
//
// Expand stage. Two groups of functions:
//  1. The CURRENT production behaviour, moved here unchanged (same SQL, same lock order, same errors):
//     reserveProductStock, releaseProductStock, setProductQuantity. Checkout, cancellation, expiry, refunds and the
//     admin product form use these.
//  2. The ledger operations of the approved plan (reserveForOrder, releaseForOrder, commitForOrder, adjustStock,
//     countStock). They are complete and tested but not called by any route or worker until the switch-over stage.
//     Exception: releaseOrphanedReservation (admin route) is live in the expand stage; it works on the legacy numbers
//     too and its ORPHAN_RELEASE rows are carried through the backfill and kept by the rollback.
//
// Rules shared by every stock write, old and new:
//  - one conditional UPDATE per stock row, so the check and the change are a single atomic statement; a stock row
//    is never read, computed on and written back;
//  - products are locked FOR SHARE in id order before any stock row (the same order as the admin product save), and
//    stock rows are written in stock-key order, so concurrent writers cannot deadlock each other;
//  - callers own the transaction (and, for order operations, have already locked the RetailOrder row);
//  - nothing here calls an external service.

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

// ---- 1. current production behaviour ---------------------------------------------------------------------------

// Reserve units for an order being placed: reservedQuantity += n only while quantity - reservedQuantity >= n.
// Products without an Inventory row are not checked (current behaviour; the switch-over stage makes this fail closed).
export async function reserveProductStock(tx: Tx, lines: { productId: string; quantity: number; productName: string; tracked: boolean }[]): Promise<void> {
  const wanted = unitsPerProduct(lines);
  const productIds = [...wanted.keys()].sort();
  if (productIds.length === 0) return;
  // Products are locked (shared) in id order before any stock row, matching the admin product save
  // (product first, then variants/inventory), so the two cannot deadlock.
  await tx.$queryRaw`SELECT id FROM Product WHERE id IN (${Prisma.join(productIds)}) ORDER BY id FOR SHARE`;
  for (const productId of productIds) {
    const line = lines.find((candidate) => candidate.productId === productId)!;
    if (!line.tracked) continue; // stock isn't tracked for this product
    const quantity = wanted.get(productId)!;
    const reserved = await tx.$executeRaw`UPDATE Inventory SET reservedQuantity = reservedQuantity + ${quantity}, updatedAt = NOW(3) WHERE productId = ${productId} AND quantity - reservedQuantity >= ${quantity}`;
    if (reserved === 0) throw httpError(409, "INSUFFICIENT_STOCK", `Not enough stock for ${line.productName}`);
  }
}

// Give an order's reserved stock back. Call it inside the transaction that moves the order to a state that will
// never ship (cancelled, expired unpaid, refunded before shipping), with the order row locked.
export async function releaseProductStock(tx: Tx, items: { productId: string; quantity: number }[]): Promise<void> {
  const released = unitsPerProduct(items);
  const productIds = [...released.keys()].sort();
  if (productIds.length === 0) return;
  await tx.$queryRaw`SELECT id FROM Product WHERE id IN (${Prisma.join(productIds)}) ORDER BY id FOR SHARE`;
  for (const productId of productIds) {
    const quantity = released.get(productId)!;
    await tx.$executeRaw`UPDATE Inventory SET reservedQuantity = GREATEST(reservedQuantity - ${quantity}, 0), updatedAt = NOW(3) WHERE productId = ${productId}`;
  }
}

// The admin product form's stock field: creates the product's Inventory row or overwrites its quantity (current
// behaviour; the switch-over stage replaces it with adjustStock / countStock, which respect reservations).
export async function setProductQuantity(tx: Tx, productId: string, quantity: number): Promise<void> {
  await tx.inventory.upsert({ where: { productId }, create: { productId, quantity }, update: { quantity } });
}

// ---- 2. ledger operations (switch-over stage) --------------------------------------------------------------------

export type StockKey = `P:${string}` | `V:${string}`;
export const productStockKey = (productId: string): StockKey => `P:${productId}`;
export const variantStockKey = (variantId: string): StockKey => `V:${variantId}`;

// Fixed SQL identifiers per stock table (never user input). Product-level rows keep their original column names.
const TABLES = {
  P: { table: Prisma.raw("Inventory"), id: Prisma.raw("productId"), onHand: Prisma.raw("quantity"), reserved: Prisma.raw("reservedQuantity") },
  V: { table: Prisma.raw("VariantInventory"), id: Prisma.raw("variantId"), onHand: Prisma.raw("onHand"), reserved: Prisma.raw("reserved") },
} as const;

function parseKey(key: string): { kind: "P" | "V"; id: string } {
  const match = /^([PV]):(.+)$/.exec(key);
  if (!match) throw new Error(`Invalid stock key ${key}`);
  return { kind: match[1] as "P" | "V", id: match[2] };
}

export type StockLine = { productId: string; variantId: string | null; quantity: number };
type KeyedUnits = { key: StockKey; productId: string; variantId: string | null; quantity: number; label: string };

// Which stock row each order line draws from, by the product's policy and stock level. TRACKED products without a
// stock row fail closed (decision D2); UNLIMITED products are returned separately and never stock-checked.
async function planStockKeys(tx: Tx, lines: StockLine[]): Promise<{ keyed: KeyedUnits[]; unlimited: StockLine[] }> {
  const productIds = [...new Set(lines.map((line) => line.productId))];
  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, inventoryPolicy: true, stockLevel: true, inventory: { select: { id: true } }, variants: { select: { id: true, name: true, inventory: { select: { id: true } } } } },
  });
  const byId = new Map(products.map((product) => [product.id, product]));
  const units = new Map<StockKey, KeyedUnits>();
  const unlimited: StockLine[] = [];
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) throw httpError(400, "VALIDATION_ERROR", "Quantity must be a positive whole number");
    const product = byId.get(line.productId);
    if (!product) throw httpError(409, "ITEM_UNAVAILABLE", "A product in this order no longer exists");
    if (product.inventoryPolicy === "UNLIMITED") { unlimited.push(line); continue; }
    let key: StockKey;
    let label = product.name;
    if (product.stockLevel === "VARIANT") {
      const variant = line.variantId ? product.variants.find((candidate) => candidate.id === line.variantId) : undefined;
      if (!variant) throw httpError(409, "VARIANT_REQUIRED", `Choose an option for ${product.name}`);
      if (!variant.inventory) throw httpError(409, "ITEM_NOT_STOCKED", `${product.name} (${variant.name}) is not available`);
      key = variantStockKey(variant.id);
      label = `${product.name} (${variant.name})`;
    } else {
      if (!product.inventory) throw httpError(409, "ITEM_NOT_STOCKED", `${product.name} is not available`);
      key = productStockKey(product.id);
    }
    const existing = units.get(key);
    units.set(key, { key, productId: product.id, variantId: key.startsWith("V:") ? line.variantId : null, quantity: (existing?.quantity ?? 0) + line.quantity, label });
  }
  return { keyed: [...units.values()].sort((a, b) => a.key.localeCompare(b.key)), unlimited };
}

async function lockProducts(tx: Tx, productIds: string[]): Promise<void> {
  const ids = [...new Set(productIds)].sort();
  if (ids.length) await tx.$queryRaw`SELECT id FROM Product WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`;
}

// Reserve stock for a placed order and record it. The order row must exist, be locked by the caller and have no
// stock state yet. Throws (and the caller's transaction rolls back) on any shortage: 409 INSUFFICIENT_STOCK.
export async function reserveForOrder(tx: Tx, orderId: string, lines: StockLine[]): Promise<{ keys: StockKey[] }> {
  const { keyed, unlimited } = await planStockKeys(tx, lines);
  await lockProducts(tx, [...keyed.map((unit) => unit.productId), ...unlimited.map((line) => line.productId)]);
  for (const unit of keyed) {
    const { kind, id } = parseKey(unit.key);
    const t = TABLES[kind];
    const changed = await tx.$executeRaw`UPDATE ${t.table} SET ${t.reserved} = ${t.reserved} + ${unit.quantity}, updatedAt = NOW(3) WHERE ${t.id} = ${id} AND ${t.onHand} - ${t.reserved} >= ${unit.quantity}`;
    if (changed === 0) throw httpError(409, "INSUFFICIENT_STOCK", `Not enough stock for ${unit.label}`);
  }
  const unlimitedUnits = unitsPerProduct(unlimited);
  const movements: Prisma.StockMovementCreateManyInput[] = [
    ...keyed.map((unit) => ({ kind: "RESERVE" as const, stockKey: unit.key, productId: unit.productId, variantId: unit.variantId, orderId, quantity: unit.quantity, reservedDelta: unit.quantity })),
    ...[...unlimitedUnits].map(([productId, quantity]) => ({ kind: "UNTRACKED_SALE" as const, stockKey: productStockKey(productId), productId, orderId, quantity })),
  ];
  if (movements.length) await tx.stockMovement.createMany({ data: movements });
  const state = keyed.length > 0 ? "RESERVED" : "NONE";
  const set = await tx.retailOrder.updateMany({ where: { id: orderId, stockState: null }, data: { stockState: state } });
  if (set.count !== 1) throw new Error(`Stock was already recorded for order ${orderId}`);
  return { keys: keyed.map((unit) => unit.key) };
}

// What an order still holds per stock key: the sum of its reservation movements (reserve/migration add, release and
// commit subtract). Release and commit replay exactly this, never the current cart, product or variant settings.
async function heldByOrder(tx: Tx, orderId: string): Promise<{ key: StockKey; productId: string; variantId: string | null; quantity: number }[]> {
  const rows = await tx.stockMovement.groupBy({
    by: ["stockKey", "productId", "variantId"],
    where: { orderId, kind: { in: ["RESERVE", "MIGRATION", "RELEASE", "COMMIT"] } },
    _sum: { reservedDelta: true },
  });
  return rows
    .map((row) => ({ key: row.stockKey as StockKey, productId: row.productId, variantId: row.variantId, quantity: row._sum.reservedDelta ?? 0 }))
    .filter((row) => row.quantity > 0)
    .sort((a, b) => a.key.localeCompare(b.key));
}

export type StockTransition = { changed: boolean; drift: { key: StockKey; quantity: number }[] };

// Move an order's reservation to RELEASED (cancelled, expired, refunded before dispatch) or COMMITTED (dispatched:
// physical stock leaves, decision D1). Exactly once: the state change is a compare-and-set from RESERVED under the
// caller's order lock, and each movement is unique per order, key and kind. A stock row that can't absorb the change
// (reserved below what the order holds) is never driven negative: it is reported as drift for a person to resolve.
async function settleOrder(tx: Tx, orderId: string, to: "RELEASED" | "COMMITTED", reason: string | null): Promise<StockTransition> {
  const moved = await tx.retailOrder.updateMany({ where: { id: orderId, stockState: "RESERVED" }, data: { stockState: to } });
  if (moved.count === 0) return { changed: false, drift: [] };
  const held = await heldByOrder(tx, orderId);
  await lockProducts(tx, held.map((row) => row.productId));
  const drift: StockTransition["drift"] = [];
  const movements: Prisma.StockMovementCreateManyInput[] = [];
  for (const row of held) {
    const { kind, id } = parseKey(row.key);
    const t = TABLES[kind];
    const changed = to === "COMMITTED"
      ? await tx.$executeRaw`UPDATE ${t.table} SET ${t.onHand} = ${t.onHand} - ${row.quantity}, ${t.reserved} = ${t.reserved} - ${row.quantity}, updatedAt = NOW(3) WHERE ${t.id} = ${id} AND ${t.reserved} >= ${row.quantity} AND ${t.onHand} >= ${row.quantity}`
      : await tx.$executeRaw`UPDATE ${t.table} SET ${t.reserved} = ${t.reserved} - ${row.quantity}, updatedAt = NOW(3) WHERE ${t.id} = ${id} AND ${t.reserved} >= ${row.quantity}`;
    if (changed === 0) drift.push({ key: row.key, quantity: row.quantity });
    const applied = changed === 0 ? 0 : row.quantity;
    movements.push({
      kind: to === "COMMITTED" ? "COMMIT" : "RELEASE",
      stockKey: row.key,
      productId: row.productId,
      variantId: row.variantId,
      orderId,
      quantity: row.quantity,
      reservedDelta: -applied,
      onHandDelta: to === "COMMITTED" ? -applied : 0,
      reason: changed === 0 ? `DRIFT: stock row could not absorb ${row.quantity}${reason ? `; ${reason}` : ""}` : reason,
    });
  }
  if (movements.length) await tx.stockMovement.createMany({ data: movements });
  return { changed: true, drift };
}

export const releaseForOrder = (tx: Tx, orderId: string, reason: string | null = null) => settleOrder(tx, orderId, "RELEASED", reason);
export const commitForOrder = (tx: Tx, orderId: string, reason: string | null = null) => settleOrder(tx, orderId, "COMMITTED", reason);

type StockRowRef = { key: StockKey; productId: string; variantId: string | null };

async function stockRowRef(tx: Tx, key: StockKey): Promise<StockRowRef> {
  const { kind, id } = parseKey(key);
  if (kind === "P") {
    const row = await tx.inventory.findUnique({ where: { productId: id }, select: { productId: true } });
    if (!row) throw httpError(404, "STOCK_NOT_FOUND", "This product has no stock record");
    return { key, productId: id, variantId: null };
  }
  const row = await tx.variantInventory.findUnique({ where: { variantId: id }, select: { productId: true } });
  if (!row) throw httpError(404, "STOCK_NOT_FOUND", "This variant has no stock record");
  return { key, productId: row.productId, variantId: id };
}

async function readStockRow(tx: Tx, key: StockKey): Promise<{ onHand: number; reserved: number }> {
  const { kind, id } = parseKey(key);
  const t = TABLES[kind];
  const rows = await tx.$queryRaw<{ onHand: number; reserved: number }[]>`SELECT ${t.onHand} AS onHand, ${t.reserved} AS reserved FROM ${t.table} WHERE ${t.id} = ${id}`;
  return { onHand: Number(rows[0].onHand), reserved: Number(rows[0].reserved) };
}

// Admin stock change by a delta (goods received, written off). Never below what is reserved, never negative.
export async function adjustStock(tx: Tx, input: { key: StockKey; delta: number; reason: string; actorUserId: string }): Promise<{ onHand: number; reserved: number }> {
  if (!Number.isSafeInteger(input.delta) || input.delta === 0) throw httpError(400, "VALIDATION_ERROR", "The adjustment must be a non-zero whole number");
  const ref = await stockRowRef(tx, input.key);
  await lockProducts(tx, [ref.productId]);
  const { kind, id } = parseKey(input.key);
  const t = TABLES[kind];
  const changed = await tx.$executeRaw`UPDATE ${t.table} SET ${t.onHand} = ${t.onHand} + ${input.delta}, updatedAt = NOW(3) WHERE ${t.id} = ${id} AND ${t.onHand} + ${input.delta} >= ${t.reserved} AND ${t.onHand} + ${input.delta} >= 0`;
  if (changed === 0) {
    const row = await readStockRow(tx, input.key);
    throw httpError(409, "BELOW_RESERVED", `On hand can't go below the ${row.reserved} unit(s) reserved for open orders`);
  }
  await tx.stockMovement.create({ data: { kind: "ADJUST", stockKey: input.key, productId: ref.productId, variantId: ref.variantId, quantity: Math.abs(input.delta), onHandDelta: input.delta, actorUserId: input.actorUserId, reason: input.reason } });
  return readStockRow(tx, input.key);
}

// Admin physical count: sets on-hand to the counted value, but only if nobody changed it since the admin read it
// (expectedOnHand) and only if the count still covers what is reserved.
export async function countStock(tx: Tx, input: { key: StockKey; onHand: number; expectedOnHand: number; reason: string; actorUserId: string }): Promise<{ onHand: number; reserved: number }> {
  if (!Number.isSafeInteger(input.onHand) || input.onHand < 0) throw httpError(400, "VALIDATION_ERROR", "The count must be a whole number of 0 or more");
  const ref = await stockRowRef(tx, input.key);
  await lockProducts(tx, [ref.productId]);
  const { kind, id } = parseKey(input.key);
  const t = TABLES[kind];
  const changed = await tx.$executeRaw`UPDATE ${t.table} SET ${t.onHand} = ${input.onHand}, updatedAt = NOW(3) WHERE ${t.id} = ${id} AND ${t.onHand} = ${input.expectedOnHand} AND ${input.onHand} >= ${t.reserved}`;
  if (changed === 0) {
    const row = await readStockRow(tx, input.key);
    if (row.onHand !== input.expectedOnHand) throw httpError(409, "STALE_COUNT", "Stock changed since you opened it; reload and count again");
    throw httpError(409, "BELOW_RESERVED", `The count can't be below the ${row.reserved} unit(s) reserved for open orders`);
  }
  const delta = input.onHand - input.expectedOnHand;
  await tx.stockMovement.create({ data: { kind: "COUNT", stockKey: input.key, productId: ref.productId, variantId: ref.variantId, quantity: Math.abs(delta), onHandDelta: delta, actorUserId: input.actorUserId, reason: input.reason } });
  return readStockRow(tx, input.key);
}

// ---- orphaned reservations (admin correction; works in the legacy and the ledger model) --------------------------

// Units of a product's reservedQuantity that belong to orders: the lines of every order that is not cancelled and whose
// stock the ledger has not settled. stockState NULL is the legacy model, where reservedQuantity also keeps dispatched
// orders (the backfill takes them off); RESERVED is held. COMMITTED, RELEASED and NONE orders hold nothing. A
// cancelled order gave its units back in both models. Deliberately conservative: it may count an order the ledger has
// not caught up with yet, never miss one, so a release can only ever be refused, not take units an order holds.
export async function unitsHeldByOrders(db: Db, productId: string): Promise<number> {
  const held = await db.retailOrderItem.aggregate({
    where: { productId, order: { status: { not: "CANCELLED" }, OR: [{ stockState: null }, { stockState: "RESERVED" }] } },
    _sum: { quantity: true },
  });
  return held._sum.quantity ?? 0;
}

export const ORPHAN_REASON_MIN = 10;
export const ORPHAN_REASON_MAX = 191; // StockMovement.reason is VARCHAR(191)
export const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;

export type OrphanReleaseInput = {
  productId: string;
  quantity: number;
  // What the admin saw when they decided: the release is refused if either number changed since (STALE_STOCK).
  expectedOnHand: number;
  expectedReserved: number;
  reason: string;
  // The client's idempotency key: used once, ever (the unique StockMovement.reference). A repeat is refused, not
  // replayed, so a retried or double-clicked request can never release twice.
  reference: string;
  actorUserId: string;
};

export type OrphanReleaseResult = {
  movement: { id: string; kind: "ORPHAN_RELEASE"; productId: string; quantity: number; reservedBefore: number; reservedAfter: number; onHandDelta: 0; actorUserId: string; reason: string; reference: string; createdAt: Date };
  stock: { onHand: number; reserved: number; available: number };
};

// Release reserved units of a product-level stock row that no order holds (e.g. a reservation whose order was
// deleted). The caller owns the transaction. Locks in the shared order (product FOR SHARE, then the stock row FOR
// UPDATE; no order row is written), then, with both held, checks in this order: reference unused, the stock row still
// shows what the admin saw, the quantity is within reservedQuantity, and within the units no order holds. One
// conditional UPDATE changes reservedQuantity only (on hand is never touched), and one append-only ORPHAN_RELEASE
// movement records who, why, how many, the reserved units before and after, and the reference. Any refusal throws
// before or instead of the write, so the transaction rolls back with nothing changed.
export async function releaseOrphanedReservation(tx: Tx, input: OrphanReleaseInput): Promise<OrphanReleaseResult> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw httpError(400, "VALIDATION_ERROR", "The quantity to release must be a whole number of 1 or more");
  if (reason.length < ORPHAN_REASON_MIN) throw httpError(400, "REASON_REQUIRED", `A reason of at least ${ORPHAN_REASON_MIN} characters is required`);
  if (reason.length > ORPHAN_REASON_MAX) throw httpError(400, "VALIDATION_ERROR", `The reason can be at most ${ORPHAN_REASON_MAX} characters`);
  if (typeof input.reference !== "string" || !REFERENCE_PATTERN.test(input.reference)) throw httpError(400, "VALIDATION_ERROR", "A reference key of 8 to 80 letters, digits, '.', '_', ':' or '-' is required");
  if (!Number.isSafeInteger(input.expectedOnHand) || !Number.isSafeInteger(input.expectedReserved)) throw httpError(400, "VALIDATION_ERROR", "The expected on-hand and reserved units are required");
  if (!input.actorUserId) throw new Error("releaseOrphanedReservation needs the acting admin");

  // Locking reads first: the plain reads below then see every transaction that held these locks before us.
  const products = await tx.$queryRaw<{ id: string; stockLevel: string }[]>`SELECT id, stockLevel FROM Product WHERE id = ${input.productId} FOR SHARE`;
  if (products.length === 0) throw httpError(404, "NOT_FOUND", "Product not found");
  if (products[0].stockLevel !== "PRODUCT") throw httpError(409, "VARIANT_LEVEL_STOCK", "This product keeps stock per variant; product-level reservations can't be released here");
  const rows = await tx.$queryRaw<{ quantity: number; reservedQuantity: number }[]>`SELECT quantity, reservedQuantity FROM Inventory WHERE productId = ${input.productId} FOR UPDATE`;
  if (rows.length === 0) throw httpError(404, "STOCK_NOT_FOUND", "This product has no stock record");
  const onHand = Number(rows[0].quantity);
  const reserved = Number(rows[0].reservedQuantity);

  if (await tx.stockMovement.findUnique({ where: { reference: input.reference }, select: { id: true } })) throw httpError(409, "DUPLICATE_REFERENCE", "This request was already submitted (reference key used before); nothing was changed");
  if (onHand !== input.expectedOnHand || reserved !== input.expectedReserved) throw httpError(409, "STALE_STOCK", `Stock changed since you opened it (now ${onHand} on hand, ${reserved} reserved); reload and check again`);
  if (input.quantity > reserved) throw httpError(409, "EXCEEDS_RESERVED", `Only ${reserved} unit(s) are reserved`);
  const held = await unitsHeldByOrders(tx, input.productId);
  const releasable = Math.max(0, reserved - held);
  if (input.quantity > releasable) throw httpError(409, "HELD_BY_ORDERS", `${held} of the ${reserved} reserved unit(s) belong to orders; at most ${releasable} can be released`);

  const changed = await tx.$executeRaw`UPDATE Inventory SET reservedQuantity = reservedQuantity - ${input.quantity}, updatedAt = NOW(3) WHERE productId = ${input.productId} AND quantity = ${onHand} AND reservedQuantity = ${reserved} AND reservedQuantity >= ${input.quantity}`;
  if (changed !== 1) throw new Error(`Stock row of ${input.productId} changed under its lock`);
  const reservedAfter = reserved - input.quantity;
  let movement;
  try {
    movement = await tx.stockMovement.create({
      data: { kind: "ORPHAN_RELEASE", stockKey: productStockKey(input.productId), productId: input.productId, quantity: input.quantity, onHandDelta: 0, reservedDelta: -input.quantity, actorUserId: input.actorUserId, reason, reference: input.reference, reservedBefore: reserved, reservedAfter },
    });
  } catch (error) {
    // A concurrent request with the same reference committed first (the unique index is the final guard).
    if ((error as { code?: string }).code === "P2002") throw httpError(409, "DUPLICATE_REFERENCE", "This request was already submitted (reference key used before); nothing was changed");
    throw error;
  }
  return {
    movement: { id: movement.id, kind: "ORPHAN_RELEASE", productId: input.productId, quantity: input.quantity, reservedBefore: reserved, reservedAfter, onHandDelta: 0, actorUserId: input.actorUserId, reason, reference: input.reference, createdAt: movement.createdAt },
    stock: { onHand, reserved: reservedAfter, available: onHand - reservedAfter },
  };
}

// What the admin dialog shows before a release: the stock row, the units orders hold, what could be released, and
// the product's previous releases (the audit trail). Plain reads only.
export async function orphanReleaseView(db: Db, productId: string) {
  const product = await db.product.findUnique({ where: { id: productId }, select: { id: true, name: true, stockLevel: true, inventory: { select: { quantity: true, reservedQuantity: true, updatedAt: true } } } });
  if (!product) throw httpError(404, "NOT_FOUND", "Product not found");
  const history = await db.stockMovement.findMany({ where: { kind: "ORPHAN_RELEASE", productId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, quantity: true, reservedBefore: true, reservedAfter: true, actorUserId: true, reason: true, reference: true, createdAt: true } });
  const actorIds = [...new Set(history.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)))];
  const actors = new Map((await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]));
  const stock = product.inventory;
  const held = stock ? await unitsHeldByOrders(db, productId) : 0;
  return {
    productId: product.id,
    name: product.name,
    stockLevel: product.stockLevel,
    stock: stock ? { onHand: stock.quantity, reserved: stock.reservedQuantity, available: stock.quantity - stock.reservedQuantity, updatedAt: stock.updatedAt } : null,
    heldByOrders: held,
    releasable: stock && product.stockLevel === "PRODUCT" ? Math.max(0, stock.reservedQuantity - held) : 0,
    history: history.map((row) => ({ ...row, actorName: row.actorUserId ? actors.get(row.actorUserId) ?? null : null })),
  };
}

// ---- 3. migration writes (used only by src/services/inventory-migration.ts) ----------------------------------------
// The backfill converts a product from the legacy numbers (quantity = units ever received, reservedQuantity also
// holding dispatched units) to the approved model (quantity = on hand, reservedQuantity = held for undispatched
// orders) by taking the C units of already-dispatched orders off both numbers, so available stock is unchanged.

export type ProductMigrationInput = {
  productId: string;
  oldQuantity: number;
  oldReserved: number;
  committedLines: { orderId: string; quantity: number }[];
  reservedLines: { orderId: string; quantity: number }[];
  // Units admins released (ORPHAN_RELEASE) while the product was still on the legacy numbers. Those movements are
  // already on the ledger with reservedDelta -n; the opening balance carries the units they released (+n, no order)
  // so the ledger still sums to the stock row. 0 for a product that never had one.
  releasedBeforeMigration?: number;
};

// Applies one product's conversion. The UPDATE only matches the exact numbers the plan was made from, so a change by
// anything else in between makes it return false (nothing written; the caller reports and a re-run picks it up).
export async function migrateProductStock(tx: Tx, input: ProductMigrationInput): Promise<boolean> {
  const committedUnits = input.committedLines.reduce((sum, line) => sum + line.quantity, 0);
  const key = productStockKey(input.productId);
  const changed = await tx.$executeRaw`UPDATE Inventory SET quantity = quantity - ${committedUnits}, reservedQuantity = reservedQuantity - ${committedUnits}, updatedAt = NOW(3) WHERE productId = ${input.productId} AND quantity = ${input.oldQuantity} AND reservedQuantity = ${input.oldReserved}`;
  if (changed === 0) return false;
  const newOnHand = input.oldQuantity - committedUnits;
  const newReserved = input.oldReserved - committedUnits;
  await tx.inventoryMigration.create({ data: { productId: input.productId, oldQuantity: input.oldQuantity, oldReserved: input.oldReserved, committedUnits, newOnHand, newReserved } });
  // Ledger opening balance: one row carries on-hand, one row per open order carries what that order holds.
  await tx.stockMovement.createMany({
    data: [
      { kind: "MIGRATION", stockKey: key, productId: input.productId, quantity: newOnHand, onHandDelta: newOnHand, reason: "opening balance (on hand)" },
      ...input.reservedLines.map((line) => ({ kind: "MIGRATION" as const, stockKey: key, productId: input.productId, orderId: line.orderId, quantity: line.quantity, reservedDelta: line.quantity, reason: "reserved before migration" })),
      ...input.committedLines.map((line) => ({ kind: "MIGRATION" as const, stockKey: key, productId: input.productId, orderId: line.orderId, quantity: line.quantity, reason: "dispatched before migration" })),
      ...(input.releasedBeforeMigration ? [{ kind: "MIGRATION" as const, stockKey: key, productId: input.productId, quantity: input.releasedBeforeMigration, reservedDelta: input.releasedBeforeMigration, reason: "reserved before migration, released by admin (orphan release)" }] : []),
    ],
  });
  return true;
}

// An order placed by the previous code after the product was migrated (cutover window): the previous code already
// added it to reservedQuantity, so only the ledger entry is written.
export async function adoptLegacyReservation(tx: Tx, input: { productId: string; orderId: string; quantity: number }): Promise<void> {
  await tx.stockMovement.create({ data: { kind: "MIGRATION", stockKey: productStockKey(input.productId), productId: input.productId, orderId: input.orderId, quantity: input.quantity, reservedDelta: input.quantity, reason: "reserved by previous code after migration" } });
}

// An order the previous code cancelled after migration: it already gave the units back (GREATEST clamp), so only the
// state and the ledger change. Exactly once (compare-and-set from RESERVED).
export async function recordLegacyRelease(tx: Tx, orderId: string): Promise<boolean> {
  const moved = await tx.retailOrder.updateMany({ where: { id: orderId, stockState: "RESERVED" }, data: { stockState: "RELEASED" } });
  if (moved.count === 0) return false;
  const held = await heldByOrder(tx, orderId);
  if (held.length) await tx.stockMovement.createMany({ data: held.map((row) => ({ kind: "RELEASE" as const, stockKey: row.key, productId: row.productId, variantId: row.variantId, orderId, quantity: row.quantity, reservedDelta: -row.quantity, reason: "released by previous code after migration" })) });
  return true;
}

// Rollback of one product to the legacy numbers, exactly: units dispatched before migration (the snapshot's C, or 0
// for a product that never had a snapshot) and units committed since (COMMIT movements) go back onto both numbers;
// every other change since (adjustments, counts, new reservations, releases) is already in the row and means the same
// in both models. Split in two so the caller can archive durably in between:
//  - planLegacyRestore reads everything the restore needs. With lock: false it is a pure read (dry run: no locking
//    read, no write). With lock: true it takes the product (FOR SHARE) and then the stock row (FOR UPDATE), the same
//    order as every other stock writer, and must run inside the caller's transaction;
//  - applyLegacyRestore writes exactly the plan: the row (only if it still holds the planned numbers), then deletes
//    exactly the planned ledger rows by id and the snapshot, checking every count; any mismatch throws so the caller's
//    transaction rolls back and nothing is lost.
export type LegacyRestorePlan = {
  productId: string;
  snapshot: { id: string; oldQuantity: number; oldReserved: number; committedUnits: number; newOnHand: number; newReserved: number; migratedAt: Date } | null;
  movements: { id: string; kind: string; stockKey: string; productId: string; variantId: string | null; orderId: string | null; quantity: number; onHandDelta: number; reservedDelta: number; actorUserId: string | null; reason: string | null; createdAt: Date }[];
  before: { quantity: number; reserved: number };
  committedBefore: number;
  committedSince: number;
  after: { quantity: number; reserved: number };
};

export async function planLegacyRestore(db: Db, productId: string, options: { lock: boolean }): Promise<LegacyRestorePlan> {
  const key = productStockKey(productId);
  let row: { quantity: number; reservedQuantity: number } | undefined;
  if (options.lock) {
    await lockProducts(db as Tx, [productId]);
    const rows = await db.$queryRaw<{ quantity: number; reservedQuantity: number }[]>`SELECT quantity, reservedQuantity FROM Inventory WHERE productId = ${productId} FOR UPDATE`;
    row = rows[0];
  } else {
    row = (await db.inventory.findUnique({ where: { productId }, select: { quantity: true, reservedQuantity: true } })) ?? undefined;
  }
  if (!row) throw new Error(`No stock row for product ${productId}`);
  const snapshot = await db.inventoryMigration.findUnique({ where: { productId } });
  // ORPHAN_RELEASE rows stay: they are the audit trail of an admin correction whose effect is already in the row and
  // means the same in the legacy model, so the rollback neither undoes nor deletes them.
  const movements = await db.stockMovement.findMany({ where: { stockKey: key, kind: { not: "ORPHAN_RELEASE" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const committedSince = -movements.filter((movement) => movement.kind === "COMMIT").reduce((total, movement) => total + movement.onHandDelta, 0);
  const committedBefore = snapshot?.committedUnits ?? 0;
  const add = committedBefore + committedSince;
  const before = { quantity: Number(row.quantity), reserved: Number(row.reservedQuantity) };
  return { productId, snapshot, movements, before, committedBefore, committedSince, after: { quantity: before.quantity + add, reserved: before.reserved + add } };
}

export async function applyLegacyRestore(tx: Tx, plan: LegacyRestorePlan): Promise<void> {
  const add = plan.after.quantity - plan.before.quantity;
  const updated = await tx.$executeRaw`UPDATE Inventory SET quantity = quantity + ${add}, reservedQuantity = reservedQuantity + ${add}, updatedAt = NOW(3) WHERE productId = ${plan.productId} AND quantity = ${plan.before.quantity} AND reservedQuantity = ${plan.before.reserved}`;
  if (updated !== 1) throw new Error(`Stock row of ${plan.productId} changed after it was planned; nothing was restored`);
  const ids = plan.movements.map((movement) => movement.id);
  if (ids.length) {
    const deleted = await tx.stockMovement.deleteMany({ where: { id: { in: ids } } });
    if (deleted.count !== ids.length) throw new Error(`Expected to delete ${ids.length} archived ledger row(s) of ${plan.productId}, deleted ${deleted.count}`);
  }
  const left = await tx.stockMovement.count({ where: { stockKey: productStockKey(plan.productId), kind: { not: "ORPHAN_RELEASE" } } });
  if (left !== 0) throw new Error(`${left} ledger row(s) of ${plan.productId} were not in the archive; nothing was restored`);
  if (plan.snapshot) {
    const removed = await tx.inventoryMigration.deleteMany({ where: { id: plan.snapshot.id } });
    if (removed.count !== 1) throw new Error(`Snapshot of ${plan.productId} changed after it was planned`);
  }
}

// Final rollback step: every remaining ledger row (and the order stock states) in scope, removed only after the caller
// archived them. Same plan/apply split; apply deletes exactly the planned ids and clears exactly the planned orders.
export type LedgerClearPlan = { movements: LegacyRestorePlan["movements"]; orderIds: string[] };

export async function planLedgerClear(db: Db, only?: string[]): Promise<LedgerClearPlan> {
  // ORPHAN_RELEASE rows are kept (see planLegacyRestore).
  const movements = await db.stockMovement.findMany({ where: { kind: { not: "ORPHAN_RELEASE" }, ...(only ? { productId: { in: only } } : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const orders = await db.retailOrder.findMany({ where: { stockState: { not: null }, ...(only ? { items: { some: { productId: { in: only } } } } : {}) }, select: { id: true }, orderBy: { id: "asc" } });
  return { movements, orderIds: orders.map((order) => order.id) };
}

export async function applyLedgerClear(tx: Tx, plan: LedgerClearPlan): Promise<{ movements: number; orders: number }> {
  const ids = plan.movements.map((movement) => movement.id);
  let movements = 0;
  if (ids.length) {
    movements = (await tx.stockMovement.deleteMany({ where: { id: { in: ids } } })).count;
    if (movements !== ids.length) throw new Error(`Expected to delete ${ids.length} archived ledger row(s), deleted ${movements}`);
  }
  let orders = 0;
  if (plan.orderIds.length) orders = (await tx.retailOrder.updateMany({ where: { id: { in: plan.orderIds } }, data: { stockState: null } })).count;
  return { movements, orders };
}

// The backfill's classification is written here too, so every stock-state change goes through this module.
export async function setOrderStockState(tx: Tx, orderIds: string[], state: "NONE" | "RESERVED" | "COMMITTED" | "RELEASED"): Promise<number> {
  if (orderIds.length === 0) return 0;
  const result = await tx.retailOrder.updateMany({ where: { id: { in: orderIds }, stockState: null }, data: { stockState: state } });
  return result.count;
}

// Units that can still be bought from a stock row (never negative). null = the product is not stock-checked.
export function availableUnits(row: { onHand: number; reserved: number } | null): number | null {
  return row ? Math.max(0, row.onHand - row.reserved) : null;
}

// Read-only view of a stock row, for reports and tests.
export async function stockSnapshot(db: Db, key: StockKey): Promise<{ onHand: number; reserved: number } | null> {
  const { kind, id } = parseKey(key);
  if (kind === "P") {
    const row = await db.inventory.findUnique({ where: { productId: id }, select: { quantity: true, reservedQuantity: true } });
    return row ? { onHand: row.quantity, reserved: row.reservedQuantity } : null;
  }
  const row = await db.variantInventory.findUnique({ where: { variantId: id }, select: { onHand: true, reserved: true } });
  return row ? { onHand: row.onHand, reserved: row.reserved } : null;
}
