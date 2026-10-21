// Razorpay configuration and signature checks: pure functions, no network, fake values only.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readRazorpayConfig, readWebhookSecret } from "../../src/config/razorpay.js";
import { checkoutSignatureValid, toRemotePayment, toRemoteRefund, webhookSignatureValid } from "../../src/providers/razorpay.provider.js";

const LIVE = { RAZORPAY_KEY_ID: "rzp_live_ChamaroFake01", RAZORPAY_KEY_SECRET: "fake-live-key-secret-0001", RAZORPAY_WEBHOOK_SECRET: "fake-live-webhook-0001" };
const TEST = { ...LIVE, RAZORPAY_KEY_ID: "rzp_test_ChamaroFake01" };
const code = (run: () => unknown) => {
  try {
    run();
    return "OK";
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

test("live keys work only in production with RAZORPAY_ALLOW_LIVE_KEYS=true; the mode comes from the key id itself", () => {
  const prod = { APP_ENV: "production" };
  assert.equal(code(() => readRazorpayConfig({ ...LIVE, ...prod })), "PAYMENTS_LIVE_MODE_BLOCKED");
  assert.equal(code(() => readRazorpayConfig({ ...LIVE, ...prod, RAZORPAY_ALLOW_LIVE_KEYS: "1" })), "PAYMENTS_LIVE_MODE_BLOCKED", "only the exact value true");
  assert.equal(readRazorpayConfig({ ...LIVE, ...prod, RAZORPAY_ALLOW_LIVE_KEYS: "true" }).mode, "live");
  // A developer machine (APP_ENV=development) with live keys in .env, even with the flag, never goes live.
  assert.equal(code(() => readRazorpayConfig({ ...LIVE, APP_ENV: "development", RAZORPAY_ALLOW_LIVE_KEYS: "true" })), "PAYMENTS_LIVE_MODE_BLOCKED");
  assert.equal(code(() => readRazorpayConfig({ ...LIVE, RAZORPAY_ALLOW_LIVE_KEYS: "true" })), "PAYMENTS_LIVE_MODE_BLOCKED", "no APP_ENV at all");
  assert.equal(readRazorpayConfig({ ...TEST }).mode, "test");
  // The flag never turns a test key into live mode.
  assert.equal(readRazorpayConfig({ ...TEST, RAZORPAY_ALLOW_LIVE_KEYS: "true" }).mode, "test");
});

test("missing, malformed or mixed-up credentials are refused before anything is touched, without echoing them", () => {
  const allow = { RAZORPAY_ALLOW_LIVE_KEYS: "true", APP_ENV: "production" };
  for (const [label, env] of [
    ["no key id", { ...LIVE, ...allow, RAZORPAY_KEY_ID: "" }],
    ["no key secret", { ...LIVE, ...allow, RAZORPAY_KEY_SECRET: "" }],
    ["no webhook secret", { ...LIVE, ...allow, RAZORPAY_WEBHOOK_SECRET: "" }],
    ["not a key id", { ...LIVE, ...allow, RAZORPAY_KEY_ID: "live_ChamaroFake01" }],
    ["secret with a space", { ...LIVE, ...allow, RAZORPAY_KEY_SECRET: "fake live secret" }],
    ["webhook secret with a newline inside", { ...LIVE, ...allow, RAZORPAY_WEBHOOK_SECRET: "fake\nwebhook" }],
    ["webhook secret = key secret", { ...LIVE, ...allow, RAZORPAY_WEBHOOK_SECRET: LIVE.RAZORPAY_KEY_SECRET }],
  ] as const) {
    let message = "";
    try {
      readRazorpayConfig(env);
    } catch (error) {
      message = (error as Error).message;
      assert.equal((error as { code?: string }).code, "PAYMENTS_NOT_CONFIGURED", label);
    }
    assert.ok(message, `${label}: refused`);
    for (const value of Object.values(env)) if (value.length > 8) assert.ok(!message.includes(value), `${label}: message never contains a value`);
  }
  // Surrounding whitespace from a secret file (a trailing newline) is trimmed, not refused.
  assert.equal(readRazorpayConfig({ ...LIVE, ...allow, RAZORPAY_KEY_SECRET: `${LIVE.RAZORPAY_KEY_SECRET}\n` }).keySecret, LIVE.RAZORPAY_KEY_SECRET);
  assert.equal(code(() => readWebhookSecret({})), "PAYMENTS_NOT_CONFIGURED");
});

test("the checkout signature is HMAC-SHA256 of order_id|payment_id with the key secret, compared exactly", () => {
  const secret = "fake-live-key-secret-0001";
  const good = createHmac("sha256", secret).update("order_ABC123def|pay_XYZ789ghi").digest("hex");
  assert.equal(checkoutSignatureValid("order_ABC123def", "pay_XYZ789ghi", good, secret), true);
  assert.equal(checkoutSignatureValid("order_ABC123def", "pay_XYZ789ghi", good.toUpperCase(), secret), true, "hex case doesn't matter");
  assert.equal(checkoutSignatureValid("order_ABC123def", "pay_OTHER0000", good, secret), false, "another payment");
  assert.equal(checkoutSignatureValid("order_OTHER0000", "pay_XYZ789ghi", good, secret), false, "another order");
  assert.equal(checkoutSignatureValid("order_ABC123def", "pay_XYZ789ghi", good, "another-secret"), false, "another secret");
  for (const bad of [undefined, "", good.slice(0, 63), `${good}0`, "z".repeat(64), 42]) assert.equal(checkoutSignatureValid("order_ABC123def", "pay_XYZ789ghi", bad, secret), false, String(bad));
});

test("the webhook signature is checked over the exact raw bytes received", () => {
  const secret = "fake-live-webhook-0001";
  const raw = Buffer.from('{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_XYZ789ghi"}}}}');
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(webhookSignatureValid(raw, signature, secret), true);
  // Re-serialised JSON (different spacing) is different bytes: refused.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 1));
  assert.equal(webhookSignatureValid(reserialised, signature, secret), false);
  assert.equal(webhookSignatureValid(Buffer.from(raw.toString().replace("captured", "failed")), signature, secret), false, "tampered body");
  assert.equal(webhookSignatureValid(raw, signature, "fake-live-key-secret-0001"), false, "signed with the API secret instead");
  assert.equal(webhookSignatureValid(raw, undefined, secret), false);
  assert.equal(webhookSignatureValid(raw, ["a", "b"], secret), false);
});

test("Razorpay answers are reduced to ids, amounts and fixed codes; customer contact details are dropped", () => {
  const payment = toRemotePayment({ id: "pay_XYZ789ghi", order_id: "order_ABC123def", status: "captured", amount: 149900, currency: "INR", amount_refunded: 0, method: "upi", email: "a@example.test", contact: "+919999999999", vpa: "a@upi", card: { last4: "4242" }, error_description: "free text" });
  assert.deepEqual(Object.keys(payment).sort(), ["amountMinor", "amountRefundedMinor", "currency", "errorCode", "errorReason", "id", "method", "orderId", "status"]);
  assert.ok(!JSON.stringify(payment).includes("example.test") && !JSON.stringify(payment).includes("4242"));
  assert.throws(() => toRemotePayment({ id: "pay_XYZ789ghi", status: "stolen" }), { code: "RAZORPAY_BAD_RESPONSE" });
  assert.deepEqual(toRemoteRefund({ id: "rfnd_ABC123def", payment_id: "pay_XYZ789ghi", amount: 100, status: "pending", notes: { a: "b" } }), { id: "rfnd_ABC123def", paymentId: "pay_XYZ789ghi", amountMinor: 100, status: "pending" });
  assert.throws(() => toRemoteRefund({ id: "rfnd_ABC123def", payment_id: "pay_XYZ789ghi", amount: 100, status: "unknown" }), { code: "RAZORPAY_BAD_RESPONSE" });
});
