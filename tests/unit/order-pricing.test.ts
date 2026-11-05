import test from "node:test";
import assert from "node:assert/strict";
import { chairCount, computeTotals, eligibleCouponMinor, fromMinor, legacyShippingMinor, mergeCartLines, toMinor, unitPriceMinor, unitsPerProduct } from "../../src/shared/order-pricing.js";

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

test("totals include the server-verified Delhivery estimate", () => {
  const totals = computeTotals([{ unitMinor: 1_500_000, quantity: 2 }, { unitMinor: 24_999, quantity: 3 }], 12_345);
  assert.deepEqual(totals, { subtotalMinor: 3_074_997, discountMinor: 0, shippingMinor: 12_345, totalMinor: 3_087_342 });
  const discounted = computeTotals([{ unitMinor: 10_000, quantity: 1 }], 1_250, 500);
  assert.deepEqual(discounted, { subtotalMinor: 10_000, discountMinor: 500, shippingMinor: 1_250, totalMinor: 10_750 });
});

test("legacy checkout shipping prices are server-calculated during storefront rollout", () => {
  assert.equal(legacyShippingMinor("standard", 0), 49_900);
  assert.equal(legacyShippingMinor("standard", 1), 49_900);
  assert.equal(legacyShippingMinor("standard", 2), 0);
  assert.equal(legacyShippingMinor("express", 2), 99_900);
});

test("coupon discounts apply only to qualifying chair lines", () => {
  const lines = [
    { name: "Boss Chair", category: { slug: "boss-chairs", name: "Boss Chairs" }, unitMinor: 100_000, quantity: 2 },
    { name: "Dining Chair", category: { slug: "dining", name: "Dining" }, unitMinor: 50_000, quantity: 1 },
    { name: "Desk", category: { slug: "office", name: "Office" }, unitMinor: 200_000, quantity: 1 },
  ];
  assert.equal(eligibleCouponMinor("WELCOME10", lines), 20_000);
  assert.equal(eligibleCouponMinor("WELCOME5", lines), 12_500);
  assert.equal(chairCount(lines), 3);
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
