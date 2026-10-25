import test from "node:test";
import assert from "node:assert/strict";
import { computeTotals, couponDiscountMinor, fromMinor, isBossChairLine, isChairLine, mergeCartLines, shippingMinor, toMinor, unitPriceMinor, unitsPerProduct } from "../../src/shared/order-pricing.js";

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

test("standard shipping is free with two or more chairs; express always costs extra", () => {
  assert.equal(shippingMinor("standard", 0), 49_900);
  assert.equal(shippingMinor("standard", 1), 49_900);
  assert.equal(shippingMinor("standard", 2), 0);
  assert.equal(shippingMinor("express", 5), 99_900);
});

test("totals are computed from unit prices and quantities only", () => {
  const totals = computeTotals([{ unitMinor: 1_500_000, quantity: 2, productName: "Office Chair" }, { unitMinor: 24_999, quantity: 3, productName: "Boss Chair" }], "standard");
  assert.deepEqual(totals, { subtotalMinor: 3_074_997, discountMinor: 0, shippingMinor: 0, totalMinor: 3_074_997 });
  const small = computeTotals([{ unitMinor: 10_000, quantity: 1 }], "express");
  assert.deepEqual(small, { subtotalMinor: 10_000, discountMinor: 0, shippingMinor: 99_900, totalMinor: 109_900 });
  assert.deepEqual(computeTotals([], "standard"), { subtotalMinor: 0, discountMinor: 0, shippingMinor: 49_900, totalMinor: 49_900 });
});

test("WELCOME10 discounts Boss chairs only and WELCOME5 discounts chair lines", () => {
  const lines = [
    { unitMinor: 10_001, quantity: 2, productName: "Boss Chair" },
    { unitMinor: 20_000, quantity: 1, productName: "Executive Chair" },
    { unitMinor: 5_000, quantity: 1, productName: "Desk" },
  ];
  assert.equal(isChairLine(lines[0]), true);
  assert.equal(isBossChairLine(lines[0]), true);
  assert.equal(couponDiscountMinor(lines, "WELCOME10"), 2_000);
  assert.equal(couponDiscountMinor(lines, "WELCOME5"), 2_000);
  assert.deepEqual(computeTotals(lines, "standard", "WELCOME10"), {
    subtotalMinor: 45_002,
    discountMinor: 2_000,
    shippingMinor: 0,
    totalMinor: 43_002,
  });
  assert.equal(couponDiscountMinor([{ unitMinor: 1000, quantity: 1, productName: "Desk" }], "WELCOME5"), 0);
  assert.equal(computeTotals([{ unitMinor: 1000, quantity: 1, productName: "Office Chair" }], "standard").shippingMinor, 49_900);
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
