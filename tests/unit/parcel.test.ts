import test from "node:test";
import assert from "node:assert/strict";
import { parcelFor } from "../../src/shared/parcel.js";

const packed = { weightGrams: 9000, lengthCm: 70, widthCm: 60, heightCm: 50 };

test("one unit of a product with its packed weight and size is booked with exactly those values", () => {
  assert.deepEqual(parcelFor([{ quantity: 1, product: packed }]), { parcel: packed });
});

test("anything missing, zero, negative or fractional is a problem for an admin, never filled in", () => {
  for (const change of [{ weightGrams: null }, { lengthCm: null }, { widthCm: 0 }, { heightCm: -5 }, { weightGrams: 1.5 }]) {
    assert.deepEqual(parcelFor([{ quantity: 1, product: { ...packed, ...change } }]), { problem: "PARCEL_DETAILS_MISSING" }, JSON.stringify(change));
  }
});

test("more than one unit, or no units, needs an admin to pack and measure the parcel", () => {
  assert.deepEqual(parcelFor([{ quantity: 2, product: packed }]), { problem: "MULTI_PARCEL_ORDER" });
  assert.deepEqual(parcelFor([{ quantity: 1, product: packed }, { quantity: 1, product: packed }]), { problem: "MULTI_PARCEL_ORDER" });
  assert.deepEqual(parcelFor([]), { problem: "MULTI_PARCEL_ORDER" });
});
