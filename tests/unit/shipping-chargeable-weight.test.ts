import test from "node:test";
import assert from "node:assert/strict";
import { shippingChargeableWeightGrams } from "../../src/shared/shipping-chargeable-weight.js";

const bulky = { weightGrams: 12_000, lengthCm: 70, widthCm: 60, heightCm: 50 };

test("chargeable weight uses the greater of actual and volumetric weight per packed unit", () => {
  assert.equal(shippingChargeableWeightGrams([{ quantity: 1, product: bulky }]), 42_000);
  assert.equal(shippingChargeableWeightGrams([{ quantity: 1, product: { ...bulky, weightGrams: 50_000 } }]), 50_000);
});

test("chargeable weight adds the packed-unit chargeable weight for each cart quantity", () => {
  assert.equal(shippingChargeableWeightGrams([{ quantity: 2, product: bulky }]), 84_000);
  assert.equal(shippingChargeableWeightGrams([
    { quantity: 1, product: bulky },
    { quantity: 1, product: { weightGrams: 2_000, lengthCm: 20, widthCm: 20, heightCm: 20 } },
  ]), 44_000);
});

test("chargeable weight refuses missing, fractional, zero, or unsafe parcel measurements", () => {
  for (const product of [
    { ...bulky, weightGrams: null },
    { ...bulky, widthCm: null },
    { ...bulky, heightCm: 0 },
    { ...bulky, lengthCm: 10.5 },
  ]) {
    assert.equal(shippingChargeableWeightGrams([{ quantity: 1, product }]), null);
  }
  assert.equal(shippingChargeableWeightGrams([]), null);
});
