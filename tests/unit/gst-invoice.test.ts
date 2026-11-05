import test from "node:test";
import assert from "node:assert/strict";
import { gstInvoiceSummary } from "../../src/shared/gst-invoice.js";

const sellerGstin = "33ABCDE1234F1Z5";

test("GST-inclusive product prices split into CGST and SGST for intra-state orders", () => {
  const summary = gstInvoiceSummary({
    subtotal: "118.00",
    discountTotal: "0.00",
    shippingAddress: { country: "IN", state: "Tamil Nadu" },
  }, sellerGstin);

  assert.deepEqual(summary, {
    taxableValue: "100.00",
    gstTotal: "18.00",
    split: { type: "intra", centralTax: "9.00", stateTax: "9.00" },
    sellerGstin,
  });
});

test("GST-inclusive product prices use IGST for inter-state orders", () => {
  const summary = gstInvoiceSummary({
    subtotal: "118.00",
    discountTotal: "0.00",
    shippingAddress: { country: "IN", state: "Karnataka" },
  }, sellerGstin);

  assert.deepEqual(summary.split, { type: "inter", integratedTax: "18.00" });
});

test("coupon discounts reduce taxable value and tax, with paise rounding reconciled", () => {
  const summary = gstInvoiceSummary({
    subtotal: "118.00",
    discountTotal: "10.00",
    shippingAddress: { country: "IN", state: "Tamil Nadu" },
  }, sellerGstin);

  assert.equal(summary.taxableValue, "91.53");
  assert.equal(summary.gstTotal, "16.47");
  assert.deepEqual(summary.split, { type: "intra", centralTax: "8.24", stateTax: "8.23" });
});

test("unrecognized place of supply still reports included GST but does not guess the split", () => {
  const summary = gstInvoiceSummary({
    subtotal: "118.00",
    discountTotal: "0.00",
    shippingAddress: { country: "IN", state: "Unknown" },
  }, sellerGstin);

  assert.equal(summary.gstTotal, "18.00");
  assert.equal(summary.split, null);
});
