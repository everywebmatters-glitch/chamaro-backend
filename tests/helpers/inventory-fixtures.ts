// Fixtures for the inventory ledger tests. Rows are written directly with Prisma (no HTTP), so hundreds of orders can
// be set up quickly. Only used by test files that pass the isolated-database guard (helpers/throwaway-db.ts).
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client.js";
import { errorResponse } from "../../src/middleware/error.middleware.js";

export const rid = () => randomBytes(6).toString("hex");

// A client like one API instance (connectionLimit 10, as src/plugins/prisma.ts) or smaller, for pool tests.
export function testPrisma(connectionLimit = 10, acquireTimeout = 10_000, options: { readOnly?: boolean } = {}): PrismaClient {
  const url = new URL(process.env.DATABASE_URL!);
  const adapter = new PrismaMariaDb({
    host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), connectionLimit, acquireTimeout, connectTimeout: 10_000,
    // Every connection of a read-only client is a read-only session: the server refuses any write AND any locking
    // read (error 1792), so code run through it is proven not to write or lock.
    ...(options.readOnly ? { initSql: "SET SESSION TRANSACTION READ ONLY" } : {}),
  } as ConstructorParameters<typeof PrismaMariaDb>[0]);
  return new PrismaClient({ adapter });
}

// DDL that MySQL refuses over the prepared-statement protocol (CREATE/DROP TRIGGER), run as a plain text query on a
// one-off connection to the isolated test database. Tests only (failure injection).
export async function execDdl(sql: string): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  const mariadb = await import("mariadb");
  const conn = await mariadb.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) });
  try { await conn.query(sql); } finally { await conn.end(); }
}

// Rollback archives written by tests go into ONE temporary directory per test process, created on first use. A test
// file that creates archives registers `after(cleanupArchives)`; node:test runs `after` hooks even when assertions
// fail, and cleanup only ever removes that directory (never anything else).
const ARCHIVE_DIR_PREFIX = "chamaro-inventory-archive-";
let archiveDir: string | null = null;

// A fresh archive path for rollback tests (never reused: archives are created exclusively).
export function archivePath(label: string): string {
  const dir = archiveDir ?? mkdtempSync(join(tmpdir(), ARCHIVE_DIR_PREFIX));
  archiveDir = dir;
  return join(dir, `${label}-${rid()}.jsonl`);
}

export function cleanupArchives(): void {
  if (!archiveDir) return;
  const dir = resolve(archiveDir);
  // Only the directory this process created: directly inside the OS temp dir, with our prefix.
  if (dirname(dir) !== resolve(tmpdir()) || !basename(dir).startsWith(ARCHIVE_DIR_PREFIX)) throw new Error(`Refusing to remove ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  archiveDir = null;
}

export async function category(db: PrismaClient) {
  const id = rid();
  return db.category.create({ data: { name: `Test category ${id}`, slug: `test-category-${id}` } });
}

type ProductSpec = {
  categoryId: string;
  name?: string;
  quantity?: number | null; // null = no Inventory row
  reserved?: number;
  policy?: "TRACKED" | "UNLIMITED";
  stockLevel?: "PRODUCT" | "VARIANT";
  variants?: { name: string; onHand?: number | null; reserved?: number; options?: Record<string, unknown> }[];
  legacy?: boolean;
};

export async function product(db: PrismaClient, spec: ProductSpec) {
  const id = rid();
  const created = await db.product.create({
    data: {
      name: spec.name ?? `Test chair ${id}`,
      slug: `test-chair-${id}`,
      price: "1000.00",
      status: "ACTIVE",
      categoryId: spec.categoryId,
      inventoryPolicy: spec.policy ?? "TRACKED",
      stockLevel: spec.stockLevel ?? "PRODUCT",
      ...(spec.quantity === null || spec.quantity === undefined ? {} : { inventory: { create: { quantity: spec.quantity, reservedQuantity: spec.reserved ?? 0 } } }),
    },
  });
  // Opening balance on the ledger, as the backfill (or, later, product creation with an initial count) writes it, so a
  // stock row and its ledger agree from the start. legacy: true leaves the ledger empty (pre-migration data).
  const opening = (stockKey: string, onHand: number, reserved: number, variantId: string | null) =>
    spec.legacy ? Promise.resolve() : db.stockMovement.create({ data: { kind: "MIGRATION", stockKey, productId: created.id, variantId, quantity: onHand, onHandDelta: onHand, reservedDelta: reserved, reason: "test opening balance" } }).then(() => undefined);
  if (spec.quantity !== null && spec.quantity !== undefined) await opening(`P:${created.id}`, spec.quantity, spec.reserved ?? 0, null);
  const variants = [];
  for (const variant of spec.variants ?? []) {
    const row = await db.productVariant.create({ data: { productId: created.id, name: variant.name, sku: `SKU-${id}-${variant.name}`.slice(0, 120), options: (variant.options ?? { Color: variant.name }) as never, status: "ACTIVE" } });
    if (variant.onHand !== null && variant.onHand !== undefined) {
      await db.variantInventory.create({ data: { variantId: row.id, productId: created.id, onHand: variant.onHand, reserved: variant.reserved ?? 0 } });
      await opening(`V:${row.id}`, variant.onHand, variant.reserved ?? 0, row.id);
    }
    variants.push(row);
  }
  return { ...created, variants };
}

export async function customer(db: PrismaClient) {
  const id = rid();
  const user = await db.user.create({ data: { name: `Buyer ${id}`, email: `buyer-${id}@example.test`, passwordHash: "x:y", role: "CUSTOMER" } });
  return db.customer.create({ data: { userId: user.id } });
}

type OrderSpec = {
  customerId: string;
  items: { productId: string; variantId?: string | null; quantity: number }[];
  status?: "PENDING" | "CONFIRMED" | "PROCESSING" | "SHIPPED" | "COMPLETED" | "CANCELLED";
  paymentStatus?: "UNPAID" | "PAID" | "REFUNDED";
  trackingNumber?: string | null;
  stockState?: "NONE" | "RESERVED" | "COMMITTED" | "RELEASED" | null;
};

// An order row with its items. Stock is NOT touched: tests decide whether and how units were reserved.
export async function order(db: PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0], spec: OrderSpec) {
  return db.retailOrder.create({
    data: {
      customerId: spec.customerId,
      status: spec.status ?? "PENDING",
      paymentStatus: spec.paymentStatus ?? "UNPAID",
      subtotal: "1000.00",
      total: "1000.00",
      trackingNumber: spec.trackingNumber ?? null,
      stockState: spec.stockState ?? null,
      items: { create: spec.items.map((item) => ({ productId: item.productId, variantId: item.variantId ?? null, quantity: item.quantity, unitPrice: "1000.00", productName: "Test chair" })) },
    },
  });
}

export async function stockRow(db: PrismaClient, productId: string) {
  return db.inventory.findUnique({ where: { productId }, select: { quantity: true, reservedQuantity: true } });
}

export async function variantRow(db: PrismaClient, variantId: string) {
  return db.variantInventory.findUnique({ where: { variantId }, select: { onHand: true, reserved: true } });
}

// The ledger invariants of the approved plan for one stock key: the row equals the ledger sums, 0 <= reserved <=
// on hand, and reserved equals what open orders hold.
export async function ledgerInvariants(db: PrismaClient, key: string): Promise<string[]> {
  const problems: string[] = [];
  const [kind, id] = [key.slice(0, 1), key.slice(2)];
  const row = kind === "P"
    ? await db.inventory.findUnique({ where: { productId: id } }).then((r) => r && { onHand: r.quantity, reserved: r.reservedQuantity })
    : await db.variantInventory.findUnique({ where: { variantId: id } }).then((r) => r && { onHand: r.onHand, reserved: r.reserved });
  if (!row) return [`no stock row for ${key}`];
  const sums = await db.stockMovement.aggregate({ where: { stockKey: key }, _sum: { onHandDelta: true, reservedDelta: true } });
  if ((sums._sum.onHandDelta ?? 0) !== row.onHand) problems.push(`onHand ${row.onHand} ≠ ledger ${sums._sum.onHandDelta ?? 0}`);
  if ((sums._sum.reservedDelta ?? 0) !== row.reserved) problems.push(`reserved ${row.reserved} ≠ ledger ${sums._sum.reservedDelta ?? 0}`);
  if (row.reserved < 0 || row.onHand < 0) problems.push("negative");
  if (row.reserved > row.onHand) problems.push(`reserved ${row.reserved} > onHand ${row.onHand}`);
  return problems;
}

// For concurrency tests: the HTTP answer the API's error handler would give for a thrown error, e.g.
// "409 INSUFFICIENT_STOCK", "503 TRY_AGAIN" or "500 INTERNAL_ERROR".
export function outcomeOf(error: unknown): string {
  const response = errorResponse(error as Parameters<typeof errorResponse>[0]);
  return `${response.statusCode} ${response.code}`;
}
