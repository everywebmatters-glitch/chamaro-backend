import { createHmac, timingSafeEqual } from "node:crypto";
import type { RazorpayConfig } from "../config/razorpay.js";

// Razorpay REST API (https://api.razorpay.com/v1), HTTP Basic auth with the key id and secret. Only these calls are
// used: create an order, read a payment, list an order's payments, capture an authorized payment, list a payment's
// refunds.
//
// What comes back is reduced to RemotePayment: ids, amounts, status, method and the fixed error code/step. The rest
// of Razorpay's payment entity (email, phone, VPA, card network/last4, bank, notes) is dropped here, so it can never
// be stored or logged by the code that uses this module.

const API = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 10_000;

export const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;
export const ORDER_ID = /^order_[A-Za-z0-9]{6,40}$/;

export type RemotePaymentStatus = "created" | "authorized" | "captured" | "refunded" | "failed";
export type RemotePayment = {
  id: string;
  orderId: string | null;
  status: RemotePaymentStatus;
  amountMinor: number;
  currency: string;
  amountRefundedMinor: number;
  method: string | null;
  errorCode: string | null;
  errorReason: string | null;
};
export type RemoteOrder = { id: string; amountMinor: number; currency: string; status: string };
// A refund's state as Razorpay reports it: "pending" while Razorpay is still trying, "processed" is final and successful,
// "failed" means the money was not returned.
export type RemoteRefundStatus = "pending" | "processed" | "failed";
export type RemoteRefund = { id: string; paymentId: string; amountMinor: number; status: RemoteRefundStatus };
const REFUND_STATUSES = new Set<RemoteRefundStatus>(["pending", "processed", "failed"]);
export const REFUND_ID = /^rfnd_[A-Za-z0-9]{6,40}$/;

export type RazorpayClient = {
  createOrder(input: { amountMinor: number; currency: "INR"; receipt: string; notes: Record<string, string> }): Promise<RemoteOrder>;
  fetchPayment(paymentId: string): Promise<RemotePayment>;
  fetchOrderPayments(orderId: string): Promise<RemotePayment[]>;
  capturePayment(paymentId: string, amountMinor: number, currency: "INR"): Promise<RemotePayment>;
  fetchRefunds(paymentId: string): Promise<RemoteRefund[]>;
};

// `outcome: "unknown"` means the request may or may not have taken effect at Razorpay (timeout, 5xx, network):
// callers must read the state back instead of assuming either way. `code` is fixed text; Razorpay's own error code
// (e.g. BAD_REQUEST_ERROR) is kept in `providerCode`, its description is never kept.
export class RazorpayError extends Error {
  constructor(readonly code: string, readonly status: number | null, readonly outcome: "rejected" | "unknown", readonly providerCode: string | null = null) {
    super(`Razorpay request failed: ${code}`);
    this.name = "RazorpayError";
  }
}

const FIXED = /^[A-Za-z0-9_.-]{1,64}$/;
const fixed = (value: unknown): string | null => (typeof value === "string" && FIXED.test(value) ? value : null);
const minor = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : -1);
const STATUSES = new Set<RemotePaymentStatus>(["created", "authorized", "captured", "refunded", "failed"]);

export function toRemotePayment(entity: unknown): RemotePayment {
  const e = (entity ?? {}) as Record<string, unknown>;
  const id = typeof e.id === "string" && PAYMENT_ID.test(e.id) ? e.id : null;
  const status = typeof e.status === "string" && STATUSES.has(e.status as RemotePaymentStatus) ? (e.status as RemotePaymentStatus) : null;
  if (!id || !status) throw new RazorpayError("RAZORPAY_BAD_RESPONSE", null, "unknown");
  return {
    id,
    orderId: typeof e.order_id === "string" && ORDER_ID.test(e.order_id) ? e.order_id : null,
    status,
    amountMinor: minor(e.amount),
    currency: typeof e.currency === "string" && /^[A-Z]{3}$/.test(e.currency) ? e.currency : "",
    amountRefundedMinor: Math.max(0, minor(e.amount_refunded)),
    method: fixed(e.method),
    errorCode: fixed(e.error_code),
    errorReason: fixed(e.error_reason),
  };
}

export function toRemoteRefund(entity: unknown): RemoteRefund {
  const e = (entity ?? {}) as Record<string, unknown>;
  const id = typeof e.id === "string" && REFUND_ID.test(e.id) ? e.id : null;
  const paymentId = typeof e.payment_id === "string" && PAYMENT_ID.test(e.payment_id) ? e.payment_id : null;
  const status = typeof e.status === "string" && REFUND_STATUSES.has(e.status as RemoteRefundStatus) ? (e.status as RemoteRefundStatus) : null;
  if (!id || !paymentId || !status) throw new RazorpayError("RAZORPAY_BAD_RESPONSE", null, "unknown");
  return { id, paymentId, amountMinor: minor(e.amount), status };
}

// Constant-time comparison of two hex HMACs (lengths are equal by construction once the input is valid hex).
function hmacMatches(expectedHex: string, given: unknown): boolean {
  if (typeof given !== "string" || !/^[a-f0-9]{64}$/i.test(given)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(given.toLowerCase(), "hex"));
}

// Razorpay Checkout's success handler returns razorpay_signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret).
export function checkoutSignatureValid(orderId: string, paymentId: string, signature: unknown, keySecret: string): boolean {
  return hmacMatches(createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex"), signature);
}

// X-Razorpay-Signature = HMAC_SHA256(raw request body, webhook secret). Must be computed over the exact bytes received.
export function webhookSignatureValid(rawBody: Buffer, signature: unknown, webhookSecret: string): boolean {
  return hmacMatches(createHmac("sha256", webhookSecret).update(rawBody).digest("hex"), signature);
}

export function createRazorpayClient(config: Pick<RazorpayConfig, "keyId" | "keySecret">, fetchImpl: typeof fetch = fetch): RazorpayClient {
  const auth = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString("base64")}`;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method,
        headers: { authorization: auth, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new RazorpayError("RAZORPAY_UNREACHABLE", null, "unknown");
    }
    const json = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    if (response.ok && json) return json;
    const providerCode = fixed(json?.error?.code);
    if (response.status === 401) throw new RazorpayError("RAZORPAY_AUTH_FAILED", 401, "rejected", providerCode);
    if (response.status >= 500 || response.status === 429 || !json) throw new RazorpayError("RAZORPAY_UNAVAILABLE", response.status, "unknown", providerCode);
    throw new RazorpayError("RAZORPAY_REJECTED", response.status, "rejected", providerCode);
  }

  return {
    async createOrder(input) {
      const order = (await call("POST", "/orders", { amount: input.amountMinor, currency: input.currency, receipt: input.receipt, notes: input.notes })) as Record<string, unknown>;
      if (typeof order.id !== "string" || !ORDER_ID.test(order.id)) throw new RazorpayError("RAZORPAY_BAD_RESPONSE", null, "unknown");
      return { id: order.id, amountMinor: minor(order.amount), currency: String(order.currency ?? ""), status: String(order.status ?? "") };
    },
    async fetchPayment(paymentId) {
      if (!PAYMENT_ID.test(paymentId)) throw new RazorpayError("RAZORPAY_BAD_ID", null, "rejected");
      return toRemotePayment(await call("GET", `/payments/${paymentId}`));
    },
    async fetchOrderPayments(orderId) {
      if (!ORDER_ID.test(orderId)) throw new RazorpayError("RAZORPAY_BAD_ID", null, "rejected");
      const list = (await call("GET", `/orders/${orderId}/payments`)) as { items?: unknown };
      if (!Array.isArray(list.items)) throw new RazorpayError("RAZORPAY_BAD_RESPONSE", null, "unknown");
      return list.items.map(toRemotePayment);
    },
    async capturePayment(paymentId, amountMinor, currency) {
      if (!PAYMENT_ID.test(paymentId)) throw new RazorpayError("RAZORPAY_BAD_ID", null, "rejected");
      return toRemotePayment(await call("POST", `/payments/${paymentId}/capture`, { amount: amountMinor, currency }));
    },
    // Razorpay returns the last 10 refunds unless asked for more; 100 is its page maximum, far above what one order sees.
    async fetchRefunds(paymentId) {
      if (!PAYMENT_ID.test(paymentId)) throw new RazorpayError("RAZORPAY_BAD_ID", null, "rejected");
      const list = (await call("GET", `/payments/${paymentId}/refunds?count=100`)) as { items?: unknown };
      if (!Array.isArray(list.items)) throw new RazorpayError("RAZORPAY_BAD_RESPONSE", null, "unknown");
      return list.items.map(toRemoteRefund);
    },
  };
}

// Tests only: every payment-service call goes through this fake instead of the real API (undefined restores it).
let testClient: RazorpayClient | undefined;
export function setRazorpayClientForTests(fake: RazorpayClient | undefined): void {
  testClient = fake;
}
export function razorpayClientFor(config: Pick<RazorpayConfig, "keyId" | "keySecret">): RazorpayClient {
  return testClient ?? createRazorpayClient(config);
}
