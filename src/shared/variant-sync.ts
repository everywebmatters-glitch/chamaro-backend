// Product-variant updates that keep variant IDs (and so cart and order references) stable.
// PUT /admin/products/:id treats its `variants` array as the product's full variant list. Variants are
// matched by SKU, which is unique across the catalogue:
//   - SKU already on the product -> updated in place (same ID)
//   - new SKU                    -> created
//   - omitted SKU                -> deleted if nothing references it, otherwise archived
import type { PrismaClient } from "../../generated/prisma/client.js";

export type VariantStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

export type VariantInput = { name: string; sku: string; price?: number; options: object; status?: VariantStatus };

export type ExistingVariant = { id: string; sku: string; status: VariantStatus; cartItems: number; retailOrderItems: number };

export type VariantPlan = {
  update: { id: string; data: { name: string; sku: string; price: number | null; options: object; status: VariantStatus } }[];
  create: { name: string; sku: string; price?: number; options: object; status: VariantStatus }[];
  // Omitted variants nothing references: safe to delete.
  remove: string[];
  // Omitted variants a cart or order references: kept, but taken off sale.
  archive: string[];
};

// The planner's own idea of "the same SKU": ASCII-style case folding and ignored trailing spaces, which is
// what the database's PAD SPACE, case-insensitive collation (utf8mb4_unicode_ci) is certain to agree on.
// That collation also equates other things (accents, "ß" and "ss", full-width letters, ...) that this key
// deliberately does not guess at. Instead of trusting either side, assertSkuEquivalenceMatchesDatabase asks
// the database about every SKU involved and refuses the update when the two disagree, before any change.
export const skuKey = (sku: string) => sku.toLowerCase().replace(/ +$/, "");

export function isReferenced(variant: Pick<ExistingVariant, "cartItems" | "retailOrderItems">): boolean {
  return variant.cartItems > 0 || variant.retailOrderItems > 0;
}

export function planVariantSync(existing: ExistingVariant[], input: VariantInput[]): VariantPlan {
  const byKey = new Map(existing.map((variant) => [skuKey(variant.sku), variant]));
  const seen = new Set<string>();
  const plan: VariantPlan = { update: [], create: [], remove: [], archive: [] };

  for (const variant of input) {
    const key = skuKey(variant.sku);
    // Same error the unique SKU index would raise (mapped to 409 DUPLICATE_RECORD by the error handler).
    if (seen.has(key)) throw Object.assign(new Error("A record with that value already exists"), { statusCode: 409, code: "DUPLICATE_RECORD" });
    seen.add(key);

    const status = variant.status ?? "ACTIVE";
    const current = byKey.get(key);
    if (current) plan.update.push({ id: current.id, data: { name: variant.name, sku: variant.sku, price: variant.price ?? null, options: variant.options, status } });
    else plan.create.push({ name: variant.name, sku: variant.sku, ...(variant.price !== undefined ? { price: variant.price } : {}), options: variant.options, status });
  }

  for (const variant of existing) {
    if (seen.has(skuKey(variant.sku))) continue;
    if (!isReferenced(variant)) plan.remove.push(variant.id);
    // Already archived and still referenced: nothing to change.
    else if (variant.status !== "ARCHIVED") plan.archive.push(variant.id);
  }
  return plan;
}

type Tx = Pick<PrismaClient, "productVariant">;

// Applies the plan inside the caller's transaction, except for `create` (the caller creates those with the
// product update). Deletion re-checks references in the delete itself, so a cart or order that appeared
// since the plan was made turns the delete into an archive instead of dropping the reference.
export async function applyVariantPlan(tx: Tx, plan: VariantPlan): Promise<void> {
  for (const { id, data } of plan.update) await tx.productVariant.update({ where: { id }, data: { ...data, options: data.options as never } });
  if (plan.remove.length) {
    await tx.productVariant.deleteMany({ where: { id: { in: plan.remove }, cartItems: { none: {} }, retailOrderItems: { none: {} } } });
    await tx.productVariant.updateMany({ where: { id: { in: plan.remove } }, data: { status: "ARCHIVED" } });
  }
  if (plan.archive.length) await tx.productVariant.updateMany({ where: { id: { in: plan.archive } }, data: { status: "ARCHIVED" } });
}

export const variantReferenceCounts = { select: { id: true, sku: true, status: true, _count: { select: { cartItems: true, retailOrderItems: true } } } } as const;

export function toExistingVariant(row: { id: string; sku: string; status: VariantStatus; _count: { cartItems: number; retailOrderItems: number } }): ExistingVariant {
  return { id: row.id, sku: row.sku, status: row.status, cartItems: row._count.cartItems, retailOrderItems: row._count.retailOrderItems };
}

const ambiguousSku = () =>
  Object.assign(new Error("Two SKUs differ only in ways the database ignores (such as accents or look-alike characters). Use one spelling per SKU."), { statusCode: 409, code: "AMBIGUOUS_SKU" });

// Pure: the planner's grouping of SKUs (equal keys) must be exactly the database's grouping (equal classes).
export function checkSkuPartition(skus: string[], databaseClasses: number[]): void {
  const classOfKey = new Map<string, number>();
  const keyOfClass = new Map<number, string>();
  skus.forEach((sku, index) => {
    const key = skuKey(sku);
    const cls = databaseClasses[index];
    if ((classOfKey.get(key) ?? cls) !== cls || (keyOfClass.get(cls) ?? key) !== key) throw ambiguousSku();
    classOfKey.set(key, cls);
    keyOfClass.set(cls, key);
  });
}

type SqlTx = Pick<PrismaClient, "$queryRaw" | "$queryRawUnsafe">;

async function skuCollation(tx: SqlTx): Promise<string> {
  const rows = await tx.$queryRaw<Record<string, string>[]>`SELECT COLLATION_NAME AS collation_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductVariant' AND COLUMN_NAME = 'sku'`;
  const name = rows[0]?.collation_name ?? rows[0]?.COLLATION_NAME;
  // Only a plain utf8mb4 collation name is ever put into SQL text.
  if (!name || !/^utf8mb4_[a-z0-9_]+$/i.test(name)) throw Object.assign(new Error("Unsupported ProductVariant.sku collation"), { statusCode: 500, code: "SKU_COLLATION_UNSUPPORTED" });
  return name;
}

// Which SKUs does the database treat as equal? Compares every SKU with every other under the column's own
// collation and returns, per input position, the lowest position of an equal SKU (its class).
export async function databaseSkuClasses(tx: SqlTx, skus: string[]): Promise<number[]> {
  const distinct = [...new Set(skus)];
  if (!distinct.length) return [];
  const collation = await skuCollation(tx);
  const values = distinct.map((_, index) => `SELECT ${index} AS i, CAST(? AS CHAR CHARACTER SET utf8mb4) AS v`).join(" UNION ALL ");
  const rows = await tx.$queryRawUnsafe<{ i: number | bigint; cls: number | bigint }[]>(
    `SELECT a.i AS i, MIN(b.i) AS cls FROM (${values}) a JOIN (${values}) b ON a.v COLLATE ${collation} = b.v COLLATE ${collation} GROUP BY a.i`,
    ...distinct,
    ...distinct,
  );
  const classOf = new Map(rows.map((row) => [Number(row.i), Number(row.cls)]));
  return skus.map((sku) => {
    const cls = classOf.get(distinct.indexOf(sku));
    if (cls === undefined) throw ambiguousSku();
    return cls;
  });
}

export async function assertSkuEquivalenceMatchesDatabase(tx: SqlTx, skus: string[]): Promise<void> {
  checkSkuPartition(skus, await databaseSkuClasses(tx, skus));
}
