import test from "node:test";
import assert from "node:assert/strict";
import { computeTotals, fromMinor, mergeCartLines, shippingMinor, toMinor, unitPriceMinor, unitsPerProduct } from "../../src/shared/order-pricing.js";

test("amounts convert to paise and back without floating-point drift", () => {
  assert.equal(toMinor("249.99"), 24_999);
  assert.equal(toMinor(0.1 + 0.2), 30);
  assert.equal(toMinor("15000"), 1_500_000);
  assert.equal(fromMinor(24_999), "249.99");
  assert.equal(fromMinor(5), "0.05");
  assert.equal(fromMinor(1_500_000), "15000.00");
  assert.throws(() => toMinor("abc"));
  assert.throws(() => toMinor(-1));
});

test("a variant's own price wins; a variant without a price uses the product's", () => {
  assert.equal(unitPriceMinor({ price: "100" }, { price: "80.50" }), 8_050);
  assert.equal(unitPriceMinor({ price: "100" }, { price: null }), 10_000);
  assert.equal(unitPriceMinor({ price: "100" }, null), 10_000);
  assert.equal(unitPriceMinor({ price: "100" }), 10_000);
});

test("shipping: standard is free from the threshold, express never is", () => {
  assert.equal(shippingMinor("standard", 999_999), 49_900);
  assert.equal(shippingMinor("standard", 1_000_000), 0);
  assert.equal(shippingMinor("express", 5_000_000), 99_900);
});

test("totals are computed from unit prices and quantities only", () => {
  const totals = computeTotals([{ unitMinor: 1_500_000, quantity: 2 }, { unitMinor: 24_999, quantity: 3 }], "standard");
  assert.deepEqual(totals, { subtotalMinor: 3_074_997, shippingMinor: 0, totalMinor: 3_074_997 });
  const small = computeTotals([{ unitMinor: 10_000, quantity: 1 }], "express");
  assert.deepEqual(small, { subtotalMinor: 10_000, shippingMinor: 99_900, totalMinor: 109_900 });
  assert.equal(computeTotals([], "standard").totalMinor, 49_900);
});

test("duplicate cart lines merge and quantities are capped at 99", () => {
  const merged = mergeCartLines([
    { productId: "p1", quantity: 2 },
    { productId: "p1", variantId: null, quantity: 3 },
    { productId: "p1", variantId: "v1", quantity: 1 },
    { productId: "p2", quantity: 90 },
    { productId: "p2", quantity: 20 },
  ]);
  assert.deepEqual(merged, [
    { productId: "p1", variantId: null, quantity: 5 },
    { productId: "p1", variantId: "v1", quantity: 1 },
    { productId: "p2", variantId: null, quantity: 99 },
  ]);
});

test("units per product add up across variants", () => {
  const totals = unitsPerProduct([{ productId: "p1", quantity: 2 }, { productId: "p1", quantity: 3 }, { productId: "p2", quantity: 1 }]);
  assert.deepEqual([...totals], [["p1", 5], ["p2", 1]]);
});
