// Pure planner for product-variant updates (no database).
import test from "node:test";
import assert from "node:assert/strict";
import { checkSkuPartition, isReferenced, planVariantSync, skuKey, type ExistingVariant } from "../../src/shared/variant-sync.js";

const existing = (id: string, sku: string, over: Partial<ExistingVariant> = {}): ExistingVariant => ({ id, sku, status: "ACTIVE", cartItems: 0, retailOrderItems: 0, ...over });
const input = (sku: string, over: Record<string, unknown> = {}) => ({ name: `Name ${sku}`, sku, options: { colour: "black" }, ...over });

test("an existing SKU is updated in place and keeps its ID", () => {
  const plan = planVariantSync([existing("v1", "A")], [input("A", { name: "Renamed", price: 25 })]);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.archive, []);
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].id, "v1");
  assert.equal(plan.update[0].data.name, "Renamed");
  assert.equal(plan.update[0].data.price, 25);
});

test("SKUs match case-insensitively, like the database's unique index", () => {
  const plan = planVariantSync([existing("v1", "AB-1")], [input("ab-1")]);
  assert.equal(plan.update[0].id, "v1");
  assert.equal(plan.update[0].data.sku, "ab-1");
  assert.deepEqual(plan.create, []);
});

test("a new SKU is created and defaults to ACTIVE", () => {
  const plan = planVariantSync([existing("v1", "A")], [input("A"), input("B")]);
  assert.deepEqual(plan.create.map((variant) => [variant.sku, variant.status]), [["B", "ACTIVE"]]);
  assert.equal(plan.update.length, 1);
});

test("an omitted, unreferenced variant is removed", () => {
  const plan = planVariantSync([existing("v1", "A"), existing("v2", "B")], [input("A")]);
  assert.deepEqual(plan.remove, ["v2"]);
  assert.deepEqual(plan.archive, []);
});

test("an omitted variant in a cart or on an order is archived, never removed", () => {
  const plan = planVariantSync(
    [existing("cart", "C", { cartItems: 2 }), existing("order", "O", { retailOrderItems: 1 }), existing("both", "X", { cartItems: 1, retailOrderItems: 1 }), existing("free", "F")],
    [],
  );
  assert.deepEqual(plan.archive.sort(), ["both", "cart", "order"]);
  assert.deepEqual(plan.remove, ["free"]);
});

test("an omitted referenced variant that is already archived needs no change", () => {
  const plan = planVariantSync([existing("v1", "A", { status: "ARCHIVED", retailOrderItems: 3 })], []);
  assert.deepEqual(plan, { update: [], create: [], remove: [], archive: [] });
});

test("resending a variant re-activates it (omitted status means ACTIVE, as a full replacement did)", () => {
  const plan = planVariantSync([existing("v1", "A", { status: "ARCHIVED", cartItems: 1 })], [input("A")]);
  assert.equal(plan.update[0].data.status, "ACTIVE");
  assert.deepEqual(plan.archive, []);
});

test("an omitted price clears the variant price; an explicit status is kept", () => {
  const plan = planVariantSync([existing("v1", "A")], [input("A", { status: "DRAFT" })]);
  assert.equal(plan.update[0].data.price, null);
  assert.equal(plan.update[0].data.status, "DRAFT");
});

test("duplicate SKUs in one request are rejected with the DUPLICATE_RECORD error", () => {
  assert.throws(
    () => planVariantSync([], [input("A"), input("a")]),
    (error: Error & { statusCode?: number; code?: string }) => error.statusCode === 409 && error.code === "DUPLICATE_RECORD",
  );
});

test("isReferenced counts carts and orders", () => {
  assert.equal(isReferenced({ cartItems: 0, retailOrderItems: 0 }), false);
  assert.equal(isReferenced({ cartItems: 1, retailOrderItems: 0 }), true);
  assert.equal(isReferenced({ cartItems: 0, retailOrderItems: 1 }), true);
});

// ---- SKU equivalence: the planner's key versus the database's collation ----------------------------------
// utf8mb4_unicode_ci is case-insensitive, accent-insensitive and PAD SPACE (trailing spaces are ignored). The key only
// claims what is certain (case and trailing spaces); checkSkuPartition makes the database confirm the rest.

test("skuKey folds case and trailing spaces only", () => {
  assert.equal(skuKey("AB-1"), skuKey("ab-1"));
  assert.equal(skuKey("ab-1"), skuKey("ab-1  "));
  assert.notEqual(skuKey(" ab-1"), skuKey("ab-1"), "leading spaces are significant");
  assert.notEqual(skuKey("ab-1"), skuKey("ab-1\t"), "only spaces are padding");
  assert.notEqual(skuKey("cafe"), skuKey("café"), "accents are left for the database to judge");
  assert.notEqual(skuKey("strasse"), skuKey("straße"));
  assert.notEqual(skuKey("ABC"), skuKey("ＡＢＣ"), "full-width letters are left for the database to judge");
  assert.notEqual(skuKey("a​b"), skuKey("ab"), "zero-width characters are left for the database to judge");
});

const ambiguous = (error: Error & { statusCode?: number; code?: string }) => error.statusCode === 409 && error.code === "AMBIGUOUS_SKU";

test("checkSkuPartition accepts agreement in both directions", () => {
  assert.doesNotThrow(() => checkSkuPartition(["AB-1", "ab-1", "XY-2"], [0, 0, 2]));
  assert.doesNotThrow(() => checkSkuPartition(["a", "b"], [0, 1]));
  assert.doesNotThrow(() => checkSkuPartition([], []));
});

test("checkSkuPartition rejects SKUs the database merges but the planner keeps apart (accents, ß, full-width, ...)", () => {
  assert.throws(() => checkSkuPartition(["cafe", "café"], [0, 0]), ambiguous);
  assert.throws(() => checkSkuPartition(["strasse", "STRAßE"], [0, 0]), ambiguous);
  assert.throws(() => checkSkuPartition(["ABC", "ＡＢＣ"], [0, 0]), ambiguous);
});

test("checkSkuPartition rejects SKUs the planner merges but the database keeps apart", () => {
  assert.throws(() => checkSkuPartition(["AB-1", "ab-1"], [0, 1]), ambiguous);
});

test("checkSkuPartition looks at every pair, not just neighbours", () => {
  assert.throws(() => checkSkuPartition(["a", "b", "c", "A"], [0, 1, 2, 3]), ambiguous);
  assert.throws(() => checkSkuPartition(["a", "b", "á"], [0, 1, 0]), ambiguous);
});
