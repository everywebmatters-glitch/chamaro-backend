// Razorpay payments: opening payment, the checkout callback, webhooks, capture, failures, duplicates, late and
// out-of-order events, refunds, reconciliation, unpaid-order expiry and the shipping guard. Razorpay is an in-memory
// fake (no network); emails go to a fake Resend client. Runs only against the isolated local test database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

// Test-only credentials (not real keys); read by the config on each call.
const KEY_ID = "rzp_test_ChamaroFake01";
const KEY_SECRET = "test-only-key-secret-not-real";
const WEBHOOK_SECRET = "test-only-webhook-secret-not-real";
process.env.RAZORPAY_KEY_ID = KEY_ID;
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ORDER_PAYMENT_TTL_MINUTES = "60";

const skipReason = await isolatedDatabaseSkipReason();
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
const { RazorpayError, setRazorpayClientForTests } = await import("../../src/providers/razorpay.provider.js");
type RazorpayClient = import("../../src/providers/razorpay.provider.js").RazorpayClient;
type RemotePayment = import("../../src/providers/razorpay.provider.js").RemotePayment;
type RemoteRefund = import("../../src/providers/razorpay.provider.js").RemoteRefund;

const emails: { to: string; subject: string; html: string; text: string }[] = [];
const { setEmailClientForTests } = await import("../../src/services/email.service.js");
setEmailClientForTests({ emails: { send: async (message) => { emails.push(message); return { data: { id: `re_${emails.length}` }, error: null }; } } });

const rid = () => randomBytes(7).toString("hex");

// Razorpay as this system sees it: orders, payments, capture. `pay()` and `refund()` play the customer and the
// dashboard. Everything is copied in and out, like JSON over the network.
class FakeRazorpay implements RazorpayClient {
  orders = new Map<string, { amountMinor: number; receipt: string }>();
  payments = new Map<string, RemotePayment>();
  refunds: RemoteRefund[] = [];
  calls: string[] = [];
  down = false;

  private guard(name: string) {
    this.calls.push(name);
    if (this.down) throw new RazorpayError("RAZORPAY_UNREACHABLE", null, "unknown");
  }
  async createOrder(input: { amountMinor: number; currency: "INR"; receipt: string }) {
    this.guard("createOrder");
    const id = `order_${rid()}`;
    this.orders.set(id, { amountMinor: input.amountMinor, receipt: input.receipt });
    return { id, amountMinor: input.amountMinor, currency: "INR", status: "created" };
  }
  async fetchPayment(id: string) {
    this.guard("fetchPayment");
    const payment = this.payments.get(id);
    if (!payment) throw new RazorpayError("RAZORPAY_REJECTED", 400, "rejected", "BAD_REQUEST_ERROR");
    return { ...payment };
  }
  async fetchOrderPayments(orderId: string) {
    this.guard("fetchOrderPayments");
    return [...this.payments.values()].filter((payment) => payment.orderId === orderId).map((payment) => ({ ...payment }));
  }
  async capturePayment(id: string, amountMinor: number) {
    this.guard("capturePayment");
    const payment = this.payments.get(id);
    if (!payment || payment.status !== "authorized" || payment.amountMinor !== amountMinor) throw new RazorpayError("RAZORPAY_REJECTED", 400, "rejected", "BAD_REQUEST_ERROR");
    payment.status = "captured";
    return { ...payment };
  }
  async fetchRefunds(paymentId: string) {
    this.guard("fetchRefunds");
    return this.refunds.filter((refund) => refund.paymentId === paymentId).map((refund) => ({ ...refund }));
  }
  pay(orderId: string, status: "captured" | "authorized" | "failed", amountMinor?: number) {
    const id = `pay_${rid()}`;
    this.payments.set(id, { id, orderId, status, amountMinor: amountMinor ?? this.orders.get(orderId)!.amountMinor, currency: "INR", amountRefundedMinor: 0, method: "upi", errorCode: status === "failed" ? "BAD_REQUEST_ERROR" : null, errorReason: status === "failed" ? "payment_failed" : null });
    return id;
  }
  // Like Razorpay's payment entity, amount_refunded and status move as soon as a refund is requested; only the refund
  // list says whether it was processed. Returns the refund id; settleRefund() moves it to processed or failed.
  refund(paymentId: string, amountMinor: number, status: RemoteRefund["status"] = "processed") {
    const payment = this.payments.get(paymentId)!;
    const id = `rfnd_${rid()}`;
    this.refunds.push({ id, paymentId, amountMinor, status });
    payment.amountRefundedMinor += amountMinor;
    if (payment.amountRefundedMinor >= payment.amountMinor) payment.status = "refunded";
    return id;
  }
  settleRefund(refundId: string, status: "processed" | "failed") {
    const refund = this.refunds.find((candidate) => candidate.id === refundId)!;
    refund.status = status;
    if (status === "failed") {
      const payment = this.payments.get(refund.paymentId)!;
      payment.amountRefundedMinor -= refund.amountMinor;
      if (payment.amountRefundedMinor < payment.amountMinor) payment.status = "captured";
    }
  }
}

let gateway = new FakeRazorpay();

async function withShop(run: (shop: Shop) => Promise<void>) {
  emails.length = 0;
  gateway = new FakeRazorpay();
  setRazorpayClientForTests(gateway);
  const { loggerOptions } = await import("../../src/config/logger.js");
  const logs: string[] = [];
  Object.assign(loggerOptions as object, { level: "trace", stream: new Writable({ write(chunk, _enc, done) { logs.push(String(chunk)); done(); } }) });
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const shop = new Shop(app, logs);
  try {
    await run(shop);
  } finally {
    await shop.cleanup();
    await app.close();
    setRazorpayClientForTests(undefined);
  }
}

class Shop {
  unique = rid();
  userIds: string[] = [];
  productIds: string[] = [];
  eventIds: string[] = [];
  categoryId?: string;
  private counter = 0;
  constructor(readonly app: App, readonly logs: string[]) {}

  async product(stock = 5, price = "1000.00") {
    this.categoryId ??= (await this.app.prisma.category.create({ data: { name: `Pay ${this.unique}`, slug: `pay-${this.unique}` } })).id;
    const n = ++this.counter;
    const product = await this.app.prisma.product.create({ data: { name: `Chair ${n} ${this.unique}`, slug: `pay-chair-${n}-${this.unique}`, price, status: "ACTIVE", categoryId: this.categoryId, inventory: { create: { quantity: stock } } } });
    this.productIds.push(product.id);
    return product;
  }

  async customer(label = "buyer") {
    const user = await this.app.prisma.user.create({ data: { name: `Customer ${label}`, email: `${label}-${this.unique}-${++this.counter}@example.test`, passwordHash: "unused", emailVerifiedAt: new Date(), role: "CUSTOMER", customer: { create: { customerType: "RETAIL" } } } });
    this.userIds.push(user.id);
    return { user, headers: { authorization: `Bearer ${this.app.jwt.sign({ sub: user.id, role: "CUSTOMER" })}` } };
  }

  async admin() {
    const user = await this.app.prisma.user.create({ data: { name: "Pay Admin", email: `pay-admin-${this.unique}-${++this.counter}@example.test`, passwordHash: "unused", role: "ADMIN" } });
    this.userIds.push(user.id);
    return { authorization: `Bearer ${this.app.jwt.sign({ sub: user.id, role: "ADMIN" })}` };
  }

  // A customer with a placed (PENDING, UNPAID) order for `quantity` of a 1000.00 product: total 1499.00 with standard shipping.
  async placedOrder(quantity = 1, stock = 5) {
    const product = await this.product(stock);
    const customer = await this.customer();
    const address = (await this.app.inject({ method: "POST", url: "/api/v1/addresses", headers: customer.headers, payload: { name: "Asha Rao", phone: "+91 98765 43210", addressLine1: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: "560001" } })).json().data.id;
    assert.equal((await this.app.inject({ method: "PUT", url: "/api/v1/cart", headers: customer.headers, payload: { items: [{ productId: product.id, quantity }] } })).statusCode, 200);
    const placed = await this.app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...customer.headers, "idempotency-key": `key-${rid()}` }, payload: { addressId: address, shippingMethod: "standard" } });
    assert.equal(placed.statusCode, 201, placed.body);
    return { ...customer, product, order: placed.json().data as { id: string; total: string } };
  }

  // The emailed checkout code step, done directly: it is tested with checkout.routes, not here.
  async verifyCheckout(userId: string) {
    await this.app.prisma.checkoutVerification.upsert({ where: { userId }, create: { userId, expiresAt: new Date(Date.now() + 10 * 60_000) }, update: { expiresAt: new Date(Date.now() + 10 * 60_000) } });
  }

  startPayment(headers: Record<string, string>, orderId: string) {
    return this.app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/payment`, headers });
  }

  async openPayment(customer: { user: { id: string }; headers: Record<string, string> }, orderId: string) {
    await this.verifyCheckout(customer.user.id);
    const res = await this.startPayment(customer.headers, orderId);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data as { razorpayOrderId: string; amount: number; currency: string; keyId: string; mode: string };
  }

  confirm(headers: Record<string, string>, orderId: string, razorpayOrderId: string, razorpayPaymentId: string, signature = createHmac("sha256", KEY_SECRET).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex")) {
    return this.app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/payment/verify`, headers, payload: { razorpayOrderId, razorpayPaymentId, razorpaySignature: signature } });
  }

  webhook(event: string, payload: object, options: { eventId?: string; secret?: string } = {}) {
    const eventId = options.eventId ?? `evt_${rid()}`;
    this.eventIds.push(eventId);
    const raw = JSON.stringify({ entity: "event", event, payload, created_at: Math.floor(Date.now() / 1000) });
    const signature = createHmac("sha256", options.secret ?? WEBHOOK_SECRET).update(raw).digest("hex");
    return this.app.inject({ method: "POST", url: "/api/v1/payments/razorpay/webhook", headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": eventId }, payload: raw });
  }

  // A webhook body the way Razorpay sends it, including the customer contact details this system must not keep.
  paymentWebhook(event: string, paymentId: string, extra: object = {}) {
    const p = gateway.payments.get(paymentId)!;
    return this.webhook(event, { payment: { entity: { id: p.id, order_id: p.orderId, status: p.status, amount: p.amountMinor, currency: "INR", email: "leak-check@example.test", contact: "+919999999999", vpa: "leak@upi" } }, ...extra });
  }

  async order(orderId: string) {
    return this.app.prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } });
  }

  async reserved(productId: string) {
    return (await this.app.prisma.inventory.findUniqueOrThrow({ where: { productId } })).reservedQuantity;
  }

  confirmations(orderId: string) {
    return this.app.prisma.emailNotification.count({ where: { orderId, kind: "ORDER_CONFIRMED" } });
  }

  async ageOrder(orderId: string, minutes: number) {
    await this.app.prisma.retailOrder.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - minutes * 60_000) } });
  }

  async cleanup() {
    const { prisma } = this.app;
    const customers = await prisma.customer.findMany({ where: { userId: { in: this.userIds } }, select: { id: true } }).catch(() => []);
    const orders = await prisma.retailOrder.findMany({ where: { customerId: { in: customers.map((c) => c.id) } }, select: { id: true } }).catch(() => []);
    await prisma.payment.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } }).catch(() => undefined);
    await prisma.paymentWebhookEvent.deleteMany({ where: { eventId: { in: this.eventIds } } }).catch(() => undefined);
    await prisma.retailOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } }).catch(() => undefined);
    await prisma.product.deleteMany({ where: { id: { in: this.productIds } } }).catch(() => undefined);
    if (this.categoryId) await prisma.category.delete({ where: { id: this.categoryId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: this.userIds } } }).catch(() => undefined);
  }
}

// ---- opening payment ------------------------------------------------------------------------------------------------

test("payment opens only after the checkout code, for the server's total, and a retry reuses the same gateway order", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder(2);
    assert.equal(order.total, "2499.00", "2 x 1000.00 plus 499.00 standard shipping (free only from 10000)");
    const total = 2000_00 + 499_00;

    const unverified = await shop.startPayment(headers, order.id);
    assert.deepEqual([unverified.statusCode, unverified.json().error.code], [403, "CHECKOUT_NOT_VERIFIED"]);

    const opened = await shop.openPayment({ user, headers }, order.id);
    const { timeoutSeconds, ...shape } = opened as typeof opened & { timeoutSeconds: number };
    assert.deepEqual({ ...shape, razorpayOrderId: "x" }, { orderId: order.id, keyId: KEY_ID, mode: "test", razorpayOrderId: "x", amount: total, currency: "INR" });
    assert.ok(timeoutSeconds > 0 && timeoutSeconds <= 60 * 60, "Checkout closes when the time to pay runs out");
    assert.equal(gateway.orders.get(opened.razorpayOrderId)!.amountMinor, total, "the gateway order is for the stored total");
    assert.equal(gateway.orders.get(opened.razorpayOrderId)!.receipt, order.id);

    // No new checkout code needed to reopen the same payment, and no second gateway order.
    const again = await shop.startPayment(headers, order.id);
    assert.equal(again.json().data.razorpayOrderId, opened.razorpayOrderId);
    assert.equal(gateway.calls.filter((call) => call === "createOrder").length, 1);
    assert.ok(!JSON.stringify(again.json()).includes(KEY_SECRET), "the key secret is never returned");
  }));

test("a customer cannot open or confirm payment for someone else's order; admins cannot use customer routes", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const other = await shop.customer("other");
    await shop.verifyCheckout(other.user.id);
    assert.equal((await shop.startPayment(other.headers, order.id)).statusCode, 404);
    const paymentId = gateway.pay(opened.razorpayOrderId, "captured");
    assert.equal((await shop.confirm(other.headers, order.id, opened.razorpayOrderId, paymentId)).statusCode, 404);
    assert.equal((await shop.startPayment(await shop.admin(), order.id)).statusCode, 403);
    assert.equal((await shop.order(order.id)).paymentStatus, "UNPAID");
  }));

test("extra fields such as an amount or status in the callback are refused", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const res = await shop.app.inject({ method: "POST", url: `/api/v1/orders/${order.id}/payment/verify`, headers, payload: { razorpayOrderId: opened.razorpayOrderId, razorpayPaymentId: `pay_${rid()}`, razorpaySignature: "a".repeat(64), status: "captured", amount: 1 } });
    assert.equal(res.statusCode, 400);
  }));

// ---- the checkout callback ------------------------------------------------------------------------------------------

test("a captured payment confirmed by the checkout callback marks the order paid once, with one email", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const paymentId = gateway.pay(opened.razorpayOrderId, "captured");

    const res = await shop.confirm(headers, order.id, opened.razorpayOrderId, paymentId);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.outcome, "paid");
    const paid = await shop.order(order.id);
    assert.deepEqual([paid.paymentStatus, paid.status], ["PAID", "CONFIRMED"]);
    assert.deepEqual([paid.payments[0].status, paid.payments[0].providerPaymentId, paid.payments[0].method], ["CAPTURED", paymentId, "upi"]);

    const repeat = await shop.confirm(headers, order.id, opened.razorpayOrderId, paymentId);
    assert.equal(repeat.json().data.outcome, "already_paid");
    assert.equal(await shop.confirmations(order.id), 1);
    assert.equal(emails.filter((m) => m.subject.includes("confirmed: payment received")).length, 1);
  }));

test("a forged or mismatched signature is refused and changes nothing", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const paymentId = gateway.pay(opened.razorpayOrderId, "captured");
    const forged = createHmac("sha256", "wrong-secret").update(`${opened.razorpayOrderId}|${paymentId}`).digest("hex");
    const res = await shop.confirm(headers, order.id, opened.razorpayOrderId, paymentId, forged);
    assert.deepEqual([res.statusCode, res.json().error.code], [400, "PAYMENT_SIGNATURE_INVALID"]);
    assert.ok(!gateway.calls.includes("fetchPayment"), "nothing is read from the gateway for a bad signature");

    // A real signature for a payment that belongs to another gateway order.
    const other = await shop.placedOrder();
    const otherOpened = await shop.openPayment(other, other.order.id);
    const otherPayment = gateway.pay(otherOpened.razorpayOrderId, "captured");
    const swapped = await shop.confirm(headers, order.id, opened.razorpayOrderId, otherPayment, createHmac("sha256", KEY_SECRET).update(`${opened.razorpayOrderId}|${otherPayment}`).digest("hex"));
    assert.equal(swapped.statusCode, 400);
    assert.equal((await shop.order(order.id)).paymentStatus, "UNPAID");
    assert.equal((await shop.order(other.order.id)).paymentStatus, "UNPAID", "the other order is untouched too");
  }));

test("a callback for a payment that actually failed does not pay the order; a later successful try does", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const failed = gateway.pay(opened.razorpayOrderId, "failed");
    const res = await shop.confirm(headers, order.id, opened.razorpayOrderId, failed);
    assert.equal(res.json().data.outcome, "failed");
    let row = await shop.order(order.id);
    assert.deepEqual([row.paymentStatus, row.payments[0].status, row.payments[0].lastErrorCode], ["UNPAID", "FAILED", "BAD_REQUEST_ERROR"]);

    // Retrying reuses the same gateway order (no new checkout code), and this time it works.
    assert.equal((await shop.startPayment(headers, order.id)).json().data.razorpayOrderId, opened.razorpayOrderId);
    const good = gateway.pay(opened.razorpayOrderId, "captured");
    assert.equal((await shop.confirm(headers, order.id, opened.razorpayOrderId, good)).json().data.outcome, "paid");
    row = await shop.order(order.id);
    assert.deepEqual([row.paymentStatus, row.payments[0].status, row.payments[0].providerPaymentId], ["PAID", "CAPTURED", good]);
  }));

test("an authorized payment is captured by the server for the stored amount", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const paymentId = gateway.pay(opened.razorpayOrderId, "authorized");
    assert.equal((await shop.confirm(headers, order.id, opened.razorpayOrderId, paymentId)).json().data.outcome, "paid");
    assert.equal(gateway.calls.filter((c) => c === "capturePayment").length, 1);
    assert.equal(gateway.payments.get(paymentId)!.status, "captured");
    assert.equal((await shop.order(order.id)).payments[0].status, "CAPTURED");
  }));

test("a payment for a different amount never marks the order paid and is flagged", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const paymentId = gateway.pay(opened.razorpayOrderId, "captured", 100);
    assert.equal((await shop.confirm(headers, order.id, opened.razorpayOrderId, paymentId)).json().data.outcome, "review");
    const row = await shop.order(order.id);
    assert.deepEqual([row.paymentStatus, row.payments[0].needsReview, row.payments[0].reviewReason], ["UNPAID", true, "AMOUNT_MISMATCH"]);
    assert.equal((await shop.startPayment(headers, order.id)).json().error.code, "PAYMENT_IN_PROGRESS", "no new payment while money needs review");
  }));

// ---- webhooks ---------------------------------------------------------------------------------------------------------

test("webhooks: bad signature refused; a valid one pays the order; a redelivery is a no-op; a late failure undoes nothing", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const paymentId = gateway.pay(opened.razorpayOrderId, "captured");

    const forged = await shop.webhook("payment.captured", { payment: { entity: { id: paymentId, order_id: opened.razorpayOrderId } } }, { secret: "not-the-secret" });
    assert.deepEqual([forged.statusCode, forged.json().error.code], [401, "WEBHOOK_SIGNATURE_INVALID"]);
    assert.equal(await shop.app.prisma.paymentWebhookEvent.count({ where: { eventId: { in: shop.eventIds } } }), 0, "a forged event is not recorded");

    const eventId = `evt_${rid()}`;
    const first = await shop.webhook("payment.captured", { payment: { entity: { id: paymentId, order_id: opened.razorpayOrderId } } }, { eventId });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual([(await shop.order(order.id)).paymentStatus, (await shop.order(order.id)).status], ["PAID", "CONFIRMED"]);
    const redelivered = await shop.webhook("payment.captured", { payment: { entity: { id: paymentId, order_id: opened.razorpayOrderId } } }, { eventId });
    assert.equal(redelivered.json().data.duplicate, true);

    // An earlier failed try reported after the capture (out of order) changes nothing.
    const failedTry = gateway.pay(opened.razorpayOrderId, "failed");
    assert.equal((await shop.paymentWebhook("payment.failed", failedTry)).statusCode, 200);
    const row = await shop.order(order.id);
    assert.deepEqual([row.paymentStatus, row.payments[0].status, row.payments[0].providerPaymentId], ["PAID", "CAPTURED", paymentId]);
    assert.equal(await shop.confirmations(order.id), 1);
  }));

test("a webhook body cannot fake a capture: the state is read back from Razorpay", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const failed = gateway.pay(opened.razorpayOrderId, "failed");
    // A correctly signed body that claims "captured" for a payment Razorpay reports as failed.
    await shop.webhook("payment.captured", { payment: { entity: { id: failed, order_id: opened.razorpayOrderId, status: "captured", amount: opened.amount } } });
    assert.equal((await shop.order(order.id)).paymentStatus, "UNPAID");
  }));

test("the checkout callback and the webhook arriving together confirm the order once", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const paymentId = gateway.pay(opened.razorpayOrderId, "authorized");
    const results = await Promise.all([
      shop.confirm(headers, order.id, opened.razorpayOrderId, paymentId),
      shop.paymentWebhook("payment.authorized", paymentId),
      shop.paymentWebhook("payment.authorized", paymentId),
      shop.confirm(headers, order.id, opened.razorpayOrderId, paymentId),
    ]);
    for (const res of results) assert.equal(res.statusCode, 200, res.body);
    const row = await shop.order(order.id);
    assert.deepEqual([row.paymentStatus, row.status, row.payments.length, row.payments[0].status], ["PAID", "CONFIRMED", 1, "CAPTURED"]);
    assert.equal(await shop.confirmations(order.id), 1);
    assert.equal(gateway.payments.get(paymentId)!.status, "captured");
  }));

test("money for an order that was cancelled, or a second payment, never changes the order and is flagged", { skip: skipReason }, () =>
  withShop(async (shop) => {
    // Cancelled before the payment landed.
    const late = await shop.placedOrder();
    const lateOpened = await shop.openPayment(late, late.order.id);
    assert.equal((await shop.app.inject({ method: "POST", url: `/api/v1/orders/${late.order.id}/cancel`, headers: late.headers })).statusCode, 200);
    const authorizedLate = gateway.pay(lateOpened.razorpayOrderId, "authorized");
    await shop.paymentWebhook("payment.authorized", authorizedLate);
    assert.equal(gateway.payments.get(authorizedLate)!.status, "authorized", "not captured: Razorpay returns it by itself");
    const capturedLate = gateway.pay(lateOpened.razorpayOrderId, "captured");
    await shop.paymentWebhook("payment.captured", capturedLate);
    let row = await shop.order(late.order.id);
    assert.deepEqual([row.status, row.paymentStatus, row.payments[0].needsReview], ["CANCELLED", "UNPAID", true]);

    // Two successful payments on one gateway order: the second is never taken as the order's payment.
    const twice = await shop.placedOrder();
    const opened = await shop.openPayment(twice, twice.order.id);
    const firstPay = gateway.pay(opened.razorpayOrderId, "captured");
    await shop.paymentWebhook("payment.captured", firstPay);
    const secondPay = gateway.pay(opened.razorpayOrderId, "captured");
    await shop.paymentWebhook("payment.captured", secondPay);
    row = await shop.order(twice.order.id);
    assert.deepEqual([row.paymentStatus, row.payments[0].providerPaymentId, row.payments[0].needsReview, row.payments[0].reviewReason], ["PAID", firstPay, true, "SECOND_PAYMENT_ON_GATEWAY_ORDER"]);
    assert.equal(await shop.confirmations(twice.order.id), 1);

    const admin = await shop.admin();
    const review = await shop.app.inject({ method: "GET", url: "/api/v1/admin/payments?needsReview=true&limit=100", headers: admin });
    assert.equal(review.statusCode, 200);
    const flagged = (review.json().data as { orderId: string }[]).map((p) => p.orderId);
    assert.ok(flagged.includes(late.order.id) && flagged.includes(twice.order.id));
    assert.equal((await shop.app.inject({ method: "GET", url: "/api/v1/admin/payments", headers: twice.headers })).statusCode, 403);
  }));

// ---- refunds ------------------------------------------------------------------------------------------------------------

test("a full refund before dispatch refunds and cancels the order and releases stock; a partial refund keeps it paid", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const full = await shop.placedOrder(2);
    const opened = await shop.openPayment(full, full.order.id);
    const paymentId = gateway.pay(opened.razorpayOrderId, "captured");
    await shop.paymentWebhook("payment.captured", paymentId);
    assert.equal(await shop.reserved(full.product.id), 2);
    gateway.refund(paymentId, opened.amount);
    const res = await shop.webhook("refund.processed", { refund: { entity: { id: `rfnd_${rid()}`, payment_id: paymentId, amount: opened.amount } } });
    assert.equal(res.statusCode, 200, res.body);
    let row = await shop.order(full.order.id);
    assert.deepEqual([row.paymentStatus, row.status, row.payments[0].status, row.payments[0].amountRefundedMinor], ["REFUNDED", "CANCELLED", "REFUNDED", opened.amount]);
    assert.equal(await shop.reserved(full.product.id), 0);

    const partial = await shop.placedOrder();
    const partialOpened = await shop.openPayment(partial, partial.order.id);
    const partialPayment = gateway.pay(partialOpened.razorpayOrderId, "captured");
    await shop.paymentWebhook("payment.captured", partialPayment);
    gateway.refund(partialPayment, 500_00);
    await shop.webhook("refund.processed", { refund: { entity: { id: `rfnd_${rid()}`, payment_id: partialPayment } } });
    row = await shop.order(partial.order.id);
    assert.deepEqual([row.paymentStatus, row.status, row.payments[0].status, row.payments[0].amountRefundedMinor], ["PAID", "CONFIRMED", "PARTIALLY_REFUNDED", 500_00]);
  }));

// ---- reconciliation and expiry ----------------------------------------------------------------------------------------

test("the worker picks up a payment whose callback and webhook were both lost", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    gateway.pay(opened.razorpayOrderId, "captured");
    await shop.app.prisma.payment.updateMany({ where: { orderId: order.id }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    const { createPaymentService } = await import("../../src/services/payment.service.js");
    const result = await createPaymentService(shop.app.prisma).reconcile(500);
    assert.ok(result.paid >= 1, JSON.stringify(result));
    assert.equal((await shop.order(order.id)).paymentStatus, "PAID");
  }));

test("expiry cancels unpaid orders and releases stock, but never one whose money arrived or can't be checked", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { createPaymentService } = await import("../../src/services/payment.service.js");
    const service = createPaymentService(shop.app.prisma);

    const abandoned = await shop.placedOrder(3);
    const paidLate = await shop.placedOrder();
    const paidOpened = await shop.openPayment(paidLate, paidLate.order.id);
    gateway.pay(paidOpened.razorpayOrderId, "captured");
    const unknown = await shop.placedOrder();
    await shop.openPayment(unknown, unknown.order.id);
    const fresh = await shop.placedOrder();
    // Past the 60-minute payment window but inside the 15-minute grace: a late Checkout may still finish.
    const inGrace = await shop.placedOrder();
    await shop.ageOrder(inGrace.order.id, 70);
    for (const o of [abandoned, paidLate, unknown]) await shop.ageOrder(o.order.id, 80);

    // The gateway is down only for `unknown`'s check: take it down after the others have been read.
    const original = gateway.fetchOrderPayments.bind(gateway);
    const unknownGatewayOrder = (await shop.order(unknown.order.id)).payments[0].providerOrderId;
    gateway.fetchOrderPayments = async (id: string) => {
      if (id === unknownGatewayOrder) throw new RazorpayError("RAZORPAY_UNREACHABLE", null, "unknown");
      return original(id);
    };
    await service.expireUnpaidOrders(500);

    const a = await shop.order(abandoned.order.id);
    assert.deepEqual([a.status, a.paymentStatus], ["CANCELLED", "UNPAID"]);
    assert.equal(await shop.reserved(abandoned.product.id), 0);
    assert.ok(emails.some((m) => m.subject.includes(abandoned.order.id) && m.text.includes("payment was not completed in time")));
    assert.deepEqual([(await shop.order(paidLate.order.id)).paymentStatus, (await shop.order(paidLate.order.id)).status], ["PAID", "CONFIRMED"]);
    assert.equal((await shop.order(unknown.order.id)).status, "PENDING", "kept while its payment can't be checked");
    assert.equal((await shop.order(fresh.order.id)).status, "PENDING", "not yet due");
    assert.equal((await shop.order(inGrace.order.id)).status, "PENDING", "kept during the grace period");

    const expired = await shop.startPayment(abandoned.headers, abandoned.order.id);
    assert.equal(expired.json().error.code, "ORDER_NOT_PAYABLE");
  }));

// ---- shipping guard (manual shipping on this branch; Delhivery uses the same PAID check) -----------------------------

test("only a genuinely paid order can be shipped: unpaid, failed, cancelled, refunded and flagged ones cannot", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const admin = await shop.admin();
    const ship = (orderId: string) => shop.app.inject({ method: "POST", url: `/api/v1/admin/orders/${orderId}/ship`, headers: admin, payload: { carrier: "Delhivery", trackingNumber: `AWB${rid()}` } });

    const unpaid = await shop.placedOrder();
    const failed = await shop.placedOrder();
    const failedOpened = await shop.openPayment(failed, failed.order.id);
    await shop.paymentWebhook("payment.failed", gateway.pay(failedOpened.razorpayOrderId, "failed"));
    const cancelled = await shop.placedOrder();
    await shop.app.inject({ method: "POST", url: `/api/v1/orders/${cancelled.order.id}/cancel`, headers: cancelled.headers });
    const refunded = await shop.placedOrder();
    const refundedOpened = await shop.openPayment(refunded, refunded.order.id);
    const refundedPayment = gateway.pay(refundedOpened.razorpayOrderId, "captured");
    await shop.paymentWebhook("payment.captured", refundedPayment);
    gateway.refund(refundedPayment, refundedOpened.amount);
    await shop.paymentWebhook("refund.processed", refundedPayment);
    const mismatched = await shop.placedOrder();
    const mismatchedOpened = await shop.openPayment(mismatched, mismatched.order.id);
    await shop.paymentWebhook("payment.captured", gateway.pay(mismatchedOpened.razorpayOrderId, "captured", 1));

    for (const [label, o] of [["unpaid", unpaid], ["failed", failed], ["cancelled", cancelled], ["refunded", refunded], ["amount mismatch", mismatched]] as const) {
      const res = await ship(o.order.id);
      assert.equal(res.statusCode, 409, `${label}: ${res.body}`);
    }

    // Paid in test mode (sandbox keys): PAID, but no real money moved, so it is never shipped.
    const sandbox = await shop.placedOrder();
    const sandboxOpened = await shop.openPayment(sandbox, sandbox.order.id);
    await shop.paymentWebhook("payment.captured", gateway.pay(sandboxOpened.razorpayOrderId, "captured"));
    assert.equal((await shop.order(sandbox.order.id)).paymentStatus, "PAID");
    const sandboxShip = await ship(sandbox.order.id);
    assert.deepEqual([sandboxShip.statusCode, sandboxShip.json().error.code], [409, "ORDER_PAID_IN_TEST_MODE"]);
    const { orderPaidLive } = await import("../../src/services/payment.service.js");
    assert.equal(await orderPaidLive(shop.app.prisma, sandbox.order.id), false);

    // Paid with live keys: shipped.
    process.env.RAZORPAY_KEY_ID = "rzp_live_ChamaroFake01";
    process.env.RAZORPAY_ALLOW_LIVE_KEYS = "true";
    try {
      const paid = await shop.placedOrder();
      const paidOpened = await shop.openPayment(paid, paid.order.id);
      assert.equal(paidOpened.mode, "live");
      await shop.paymentWebhook("payment.captured", gateway.pay(paidOpened.razorpayOrderId, "captured"));
      assert.equal(await orderPaidLive(shop.app.prisma, paid.order.id), true);
      assert.equal((await ship(paid.order.id)).statusCode, 200);
    } finally {
      process.env.RAZORPAY_KEY_ID = KEY_ID;
      delete process.env.RAZORPAY_ALLOW_LIVE_KEYS;
    }
  }));

test("after switching to live keys, sandbox payments are never read back, reused or confirmed with them", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { createPaymentService } = await import("../../src/services/payment.service.js");
    const placed = await shop.placedOrder();
    const opened = await shop.openPayment(placed, placed.order.id);
    const testPayment = gateway.pay(opened.razorpayOrderId, "captured");
    await shop.app.prisma.payment.updateMany({ where: { orderId: placed.order.id }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });

    process.env.RAZORPAY_KEY_ID = "rzp_live_ChamaroFake01";
    process.env.RAZORPAY_ALLOW_LIVE_KEYS = "true";
    try {
      gateway.calls.length = 0;
      await createPaymentService(shop.app.prisma).reconcile(500);
      assert.equal(gateway.calls.filter((call) => call === "fetchOrderPayments").length, 0, "test gateway orders are not read with live keys");
      const callback = await shop.confirm(placed.headers, placed.order.id, opened.razorpayOrderId, testPayment);
      assert.equal(callback.statusCode, 404, "a test-mode gateway order can't be confirmed with live keys");
      await shop.verifyCheckout(placed.user.id);
      const reopened = await shop.startPayment(placed.headers, placed.order.id);
      assert.equal(reopened.statusCode, 200, reopened.body);
      assert.notEqual(reopened.json().data.razorpayOrderId, opened.razorpayOrderId, "a new live gateway order, not the sandbox one");
      assert.equal(reopened.json().data.mode, "live");
      assert.equal((await shop.order(placed.order.id)).paymentStatus, "UNPAID");
    } finally {
      process.env.RAZORPAY_KEY_ID = KEY_ID;
      delete process.env.RAZORPAY_ALLOW_LIVE_KEYS;
    }
  }));

// ---- configuration and secrets ----------------------------------------------------------------------------------------

test("without credentials payment is refused before anything is touched", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    await shop.verifyCheckout(user.id);
    const saved = process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_SECRET;
    try {
      const res = await shop.startPayment(headers, order.id);
      // The shared error handler reports every 5xx as 500 and keeps only the code (as it does for EMAIL_SEND_FAILED).
      assert.deepEqual([res.statusCode, res.json().error.code], [500, "PAYMENTS_NOT_CONFIGURED"]);
      assert.equal(gateway.calls.length, 0);
      assert.ok(await shop.app.prisma.checkoutVerification.findUnique({ where: { userId: user.id } }), "the checkout verification was not used up");
    } finally {
      process.env.RAZORPAY_KEY_SECRET = saved;
    }
  }));

test("no secret, signature or customer contact detail reaches the logs or the database", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { order, user, headers } = await shop.placedOrder();
    const opened = await shop.openPayment({ user, headers }, order.id);
    const paymentId = gateway.pay(opened.razorpayOrderId, "captured");
    const signature = createHmac("sha256", KEY_SECRET).update(`${opened.razorpayOrderId}|${paymentId}`).digest("hex");
    await shop.confirm(headers, order.id, opened.razorpayOrderId, paymentId, signature);
    await shop.paymentWebhook("payment.captured", paymentId);
    await shop.webhook("payment.captured", { payment: { entity: { id: paymentId } } }, { secret: "wrong" });

    const logs = shop.logs.join("\n");
    for (const secret of [KEY_SECRET, WEBHOOK_SECRET, signature, "leak-check@example.test", "+919999999999", "leak@upi", user.email]) assert.ok(!logs.includes(secret), `logs contain ${secret.slice(0, 6)}...`);
    const rows = JSON.stringify(await shop.app.prisma.payment.findMany({ where: { orderId: order.id } })) + JSON.stringify(await shop.app.prisma.paymentWebhookEvent.findMany({ where: { eventId: { in: shop.eventIds } } }));
    for (const secret of [signature, "leak-check@example.test", "+919999999999", "leak@upi"]) assert.ok(!rows.includes(secret), `database contains ${secret.slice(0, 6)}...`);
  }));

test("a customer cannot cancel an order while its payment is being confirmed; a failed try still allows it", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const placed = await shop.placedOrder(1);
    const opened = await shop.openPayment(placed, placed.order.id);
    const cancel = () => shop.app.inject({ method: "POST", url: `/api/v1/orders/${placed.order.id}/cancel`, headers: placed.headers });

    // Recorded as AUTHORIZED but not yet applied to the order (e.g. its capture is still in flight): the order service
    // itself refuses, whatever the route did before it.
    const authorized = gateway.pay(opened.razorpayOrderId, "authorized");
    await shop.app.prisma.payment.update({ where: { providerOrderId: opened.razorpayOrderId }, data: { status: "AUTHORIZED", providerPaymentId: authorized } });
    const { createOrderService } = await import("../../src/services/order.service.js");
    await assert.rejects(createOrderService(shop.app.prisma).cancelOrder(placed.user.id, placed.order.id), { code: "PAYMENT_IN_PROGRESS", statusCode: 409 });
    // Through the route, Razorpay is asked first: the authorized payment is captured and the order paid instead.
    const refused = await cancel();
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error.code, "ORDER_NOT_CANCELLABLE");
    assert.equal((await shop.order(placed.order.id)).paymentStatus, "PAID");
    assert.equal((await shop.order(placed.order.id)).status, "CONFIRMED", "paid, not cancelled");
    assert.equal(await shop.reserved(placed.product.id), 1, "the stock stays reserved for the order");

    // A failed (or never-used) gateway order does not block it.
    const other = await shop.placedOrder(1);
    const otherOpened = await shop.openPayment(other, other.order.id);
    const failed = gateway.pay(otherOpened.razorpayOrderId, "failed");
    assert.equal((await shop.confirm(other.headers, other.order.id, otherOpened.razorpayOrderId, failed)).json().data.outcome, "failed");
    const allowed = await shop.app.inject({ method: "POST", url: `/api/v1/orders/${other.order.id}/cancel`, headers: other.headers });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().data.status, "CANCELLED");
  }));

test("Checkout is told how long is left to pay; the time runs from when the order was placed", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const placed = await shop.placedOrder();
    await shop.ageOrder(placed.order.id, 20);
    const opened = (await shop.openPayment(placed, placed.order.id)) as unknown as { timeoutSeconds: number };
    assert.ok(opened.timeoutSeconds > 39 * 60 && opened.timeoutSeconds <= 40 * 60, String(opened.timeoutSeconds));
    await shop.ageOrder(placed.order.id, 61);
    assert.equal((await shop.startPayment(placed.headers, placed.order.id)).json().error.code, "ORDER_PAYMENT_EXPIRED");
  }));

test("a refund counts only once Razorpay processes it: a pending refund leaves the order paid, a failed one is recorded", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const placed = await shop.placedOrder(2);
    const opened = await shop.openPayment(placed, placed.order.id);
    const paymentId = gateway.pay(opened.razorpayOrderId, "captured");
    await shop.paymentWebhook("payment.captured", paymentId);

    // Requested (pending): Razorpay's payment already says "refunded", but nothing changes here yet.
    const refundId = gateway.refund(paymentId, opened.amount, "pending");
    assert.equal(gateway.payments.get(paymentId)!.status, "refunded");
    await shop.webhook("refund.created", { refund: { entity: { id: refundId, payment_id: paymentId, amount: opened.amount, status: "pending" } } });
    let row = await shop.order(placed.order.id);
    assert.deepEqual([row.paymentStatus, row.status, row.payments[0].status, row.payments[0].amountRefundedMinor], ["PAID", "CONFIRMED", "CAPTURED", 0]);
    assert.equal(await shop.reserved(placed.product.id), 2, "stock stays with the order");

    // It fails: still paid, and the failure is recorded for a person.
    gateway.settleRefund(refundId, "failed");
    await shop.webhook("refund.failed", { refund: { entity: { id: refundId, payment_id: paymentId, amount: opened.amount, status: "failed" } } });
    row = await shop.order(placed.order.id);
    assert.deepEqual([row.paymentStatus, row.payments[0].status, row.payments[0].lastErrorCode], ["PAID", "CAPTURED", "REFUND_FAILED"]);

    // A second refund that is processed: now the order is refunded and cancelled, stock released.
    const retried = gateway.refund(paymentId, opened.amount, "pending");
    gateway.settleRefund(retried, "processed");
    await shop.webhook("refund.processed", { refund: { entity: { id: retried, payment_id: paymentId, amount: opened.amount, status: "processed" } } });
    row = await shop.order(placed.order.id);
    assert.deepEqual([row.paymentStatus, row.status, row.payments[0].status, row.payments[0].amountRefundedMinor], ["REFUNDED", "CANCELLED", "REFUNDED", opened.amount]);
    assert.equal(await shop.reserved(placed.product.id), 0);
  }));

test("the worker applies a refund made in the Razorpay dashboard only once it is processed", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { createPaymentService } = await import("../../src/services/payment.service.js");
    const placed = await shop.placedOrder();
    const opened = await shop.openPayment(placed, placed.order.id);
    const paymentId = gateway.pay(opened.razorpayOrderId, "captured");
    await shop.paymentWebhook("payment.captured", paymentId);
    const refundId = gateway.refund(paymentId, opened.amount, "pending");
    const stale = () => shop.app.prisma.payment.updateMany({ where: { orderId: placed.order.id }, data: { lastSyncedAt: new Date(Date.now() - 7 * 60 * 60_000) } });
    await stale();
    await createPaymentService(shop.app.prisma).reconcile(500);
    assert.equal((await shop.order(placed.order.id)).paymentStatus, "PAID", "pending refund: unchanged");
    gateway.settleRefund(refundId, "processed");
    await stale();
    await createPaymentService(shop.app.prisma).reconcile(500);
    assert.equal((await shop.order(placed.order.id)).paymentStatus, "REFUNDED");
  }));

test("a payment Razorpay has taken but this system hasn't seen yet blocks the customer's cancellation", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const placed = await shop.placedOrder();
    const opened = await shop.openPayment(placed, placed.order.id);
    // Captured at Razorpay (e.g. auto-capture); the callback and webhook have not arrived.
    gateway.pay(opened.razorpayOrderId, "captured");
    const cancel = await shop.app.inject({ method: "POST", url: `/api/v1/orders/${placed.order.id}/cancel`, headers: placed.headers });
    assert.equal(cancel.statusCode, 409);
    assert.equal(cancel.json().error.code, "ORDER_NOT_CANCELLABLE", "the payment was applied first, so the order is paid");
    const row = await shop.order(placed.order.id);
    assert.deepEqual([row.status, row.paymentStatus, row.payments[0].needsReview], ["CONFIRMED", "PAID", false]);
    assert.equal(await shop.confirmations(placed.order.id), 1);

    // If Razorpay can't be asked, the cancellation is refused rather than guessed.
    const other = await shop.placedOrder();
    await shop.openPayment(other, other.order.id);
    gateway.down = true;
    const refused = await shop.app.inject({ method: "POST", url: `/api/v1/orders/${other.order.id}/cancel`, headers: other.headers });
    gateway.down = false;
    assert.equal(refused.json().error.code, "PAYMENT_GATEWAY_UNAVAILABLE");
    assert.equal((await shop.order(other.order.id)).status, "PENDING");
  }));

test("payment confirmation racing the customer's cancellation: never both, never money on a cancelled order unflagged", { skip: skipReason }, () =>
  withShop(async (shop) => {
    for (let round = 0; round < 4; round++) {
      const placed = await shop.placedOrder();
      const opened = await shop.openPayment(placed, placed.order.id);
      const paymentId = gateway.pay(opened.razorpayOrderId, "captured");
      const [confirmed, cancelled] = await Promise.all([
        shop.confirm(placed.headers, placed.order.id, opened.razorpayOrderId, paymentId),
        shop.app.inject({ method: "POST", url: `/api/v1/orders/${placed.order.id}/cancel`, headers: placed.headers }),
      ]);
      const row = await shop.order(placed.order.id);
      if (row.status === "CANCELLED") {
        // Only possible if the cancel won outright; then the payment must be flagged for a refund, never applied.
        assert.equal(row.paymentStatus, "UNPAID", `round ${round}`);
        assert.equal(row.payments[0].needsReview, true, `round ${round}`);
      } else {
        assert.deepEqual([row.status, row.paymentStatus], ["CONFIRMED", "PAID"], `round ${round}`);
        assert.equal(cancelled.statusCode, 409, `round ${round}: ${cancelled.body}`);
        assert.equal(await shop.confirmations(placed.order.id), 1, `round ${round}`);
      }
      assert.equal(confirmed.statusCode, 200, `round ${round}: ${confirmed.body}`);
    }
  }));
