import { httpError } from "../shared/http.js";

// Razorpay credentials. All three come from the server environment only (Secret Manager in production) and are never
// logged, returned or put in a NEXT_PUBLIC_ variable. The key id is the one value the browser may see: Razorpay
// Checkout needs it to open the payment form.
//
//   RAZORPAY_KEY_ID          rzp_test_... (test mode) or rzp_live_...
//   RAZORPAY_KEY_SECRET      API secret for that key id: signs API calls and verifies checkout signatures
//   RAZORPAY_WEBHOOK_SECRET  the secret set on the webhook in the Razorpay dashboard (not the API secret)
//   RAZORPAY_ALLOW_LIVE_KEYS "true" to accept rzp_live_ keys; anything else refuses them, so a live key can't be
//                            switched on by accident while payments are still being tested
export type RazorpayConfig = { keyId: string; keySecret: string; webhookSecret: string; mode: "test" | "live" };

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;

// Refuses (503) before anything is touched when payments are not set up, so a half-configured environment fails
// loudly instead of taking money it can't confirm. Error messages name variables, never their values.
export function readRazorpayConfig(env: NodeJS.ProcessEnv = process.env): RazorpayConfig {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!keyId || !keySecret || !webhookSecret) throw httpError(503, "PAYMENTS_NOT_CONFIGURED", "Online payment is not available right now");
  const match = KEY_ID.exec(keyId);
  if (!match) throw httpError(503, "PAYMENTS_NOT_CONFIGURED", "RAZORPAY_KEY_ID is not a Razorpay key id");
  const mode = match[1] as "test" | "live";
  if (mode === "live" && env.RAZORPAY_ALLOW_LIVE_KEYS !== "true") throw httpError(503, "PAYMENTS_LIVE_MODE_BLOCKED", "Live Razorpay keys are configured but RAZORPAY_ALLOW_LIVE_KEYS is not true");
  return { keyId, keySecret, webhookSecret, mode };
}

// The webhook secret alone, for the webhook route: it must work even if the API keys are being rotated.
export function readWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret) throw httpError(503, "PAYMENTS_NOT_CONFIGURED", "Payment webhooks are not configured");
  return secret;
}
