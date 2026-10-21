// Payments x Delhivery: the payment states this system produces (unpaid, failed, cancelled, refunded, flagged,
// paid) against the real shipment code. Razorpay and Delhivery are both in-memory fakes that fail the test on any
// request to another host; no network, no real shipment, no real payment. Runs only against the isolated test database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const WEBHOOK_SECRET = "test-only-webhook-secret-not-real";
// Live-format fake keys (Razorpay is an in-memory fake): a payment confirmed here is a "live" payment, the only kind
// that may ship. The test-mode case switches to a rzp_test_ key on purpose.
const LIVE_KEY_ID = "rzp_live_ChamaroFake01";
const TEST_KEY_ID = "rzp_test_ChamaroFake01";
Object.assign(process.env, {
  RAZORPAY_KEY_ID: LIVE_KEY_ID,
  RAZORPAY_ALLOW_LIVE_KEYS: "true",
  // Fake live-format keys in a test run (APP_ENV=development): the explicit test-only override.
  RAZORPAY_ALLOW_LIVE_OUTSIDE_PRODUCTION: "true",
  RAZORPAY_KEY_SECRET: "test-only-key-secret-not-real",
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  DELHIVERY_ENABLED: "true",
  DELHIVERY_API_BASE_URL: "https://staging-express.delhivery.com",
  DELHIVERY_API_TOKEN: "fakestagingtoken000000000001",
  DELHIVERY_PICKUP_LOCATION: "Chamaro Test Warehouse",
  DELHIVERY_WEBHOOK_SECRET: "test-delhivery-webhook-secret-0001",
  APP_ENV: "development",
});

const skipReason = await isolatedDatabaseSkipReason();
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
const { RazorpayError, setRazorpayClientForTests } = await import("../../src/providers/razorpay.provider.js");
type RemotePayment = import("../../src/providers/razorpay.provider.js").RemotePayment;
type RemoteRefund = import("../../src/providers/razorpay.provider.js").RemoteRefund;
const { setDelhiveryFetchForTests } = await import("../../src/providers/delhivery.provider.js");
const { setEmailClientForTests } = await import("../../src/services/email.service.js");
setEmailClientForTests({ emails: { send: async () => ({ data: { id: "re_1" }, error: null }) } });

const rid = () => randomBytes(7).toString("hex");

// ---- fake Razorpay ---------------------------------------------------------------------------------------------------
const orders = new Map<string, number>();
const payments = new Map<string, RemotePayment>();
const refunds: RemoteRefund[] = [];
const razorpay = {
  async fetchRefunds(paymentId: string) { return refunds.filter((r) => r.paymentId === paymentId).map((r) => ({ ...r })); },
  async createOrder(input: { amountMinor: number; currency: "INR"; receipt: string }) { const id = `order_${rid()}`; orders.set(id, input.amountMinor); return { id, amountMinor: input.amountMinor, currency: "INR", status: "created" }; },
  async fetchPayment(id: string) { const p = payments.get(id); if (!p) throw new RazorpayError("RAZORPAY_REJECTED", 400, "rejected"); return { ...p }; },
  async fetchOrderPayments(orderId: string) { return [...payments.values()].filter((p) => p.orderId === orderId).map((p) => ({ ...p })); },
  async capturePayment(id: string) { const p = payments.get(id)!; p.status = "captured"; return { ...p }; },
};
// A full refund Razorpay has processed (the only kind that counts).
function refundFully(paymentId: string) {
  const p = payments.get(paymentId)!;
  refunds.push({ id: `rfnd_${rid()}`, paymentId, amountMinor: p.amountMinor, status: "processed" });
  p.status = "refunded";
  p.amountRefundedMinor = p.amountMinor;
}
function pay(orderId: string, status: "captured" | "failed", amountMinor = orders.get(orderId)!) {
  const id = `pay_${rid()}`;
  payments.set(id, { id, orderId, status, amountMinor, currency: "INR", amountRefundedMinor: 0, method: "upi", errorCode: status === "failed" ? "BAD_REQUEST_ERROR" : null, errorReason: null });
  return id;
}

// ---- fake Delhivery (just enough for create) -------------------------------------------------------------------------
const delhivery = { creates: 0, shipments: new Map<string, string>(), nextAwb: 9200000000000 };
setDelhiveryFetchForTests(async (rawUrl, init) => {
  const url = new URL(rawUrl);
  assert.equal(url.origin, "https://staging-express.delhivery.com", "only Delhivery staging is ever called");
  const json = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body) });
  if (url.pathname === "/c/api/pin-codes/json/") return json({ delivery_codes: [{ postal_code: { pin: Number(url.searchParams.get("filter_codes")), pre_paid: "Y", cod: "Y", pickup: "Y", is_oda: "N" } }] });
  if (url.pathname === "/api/cmu/create.json") {
    delhivery.creates++;
    const ref = JSON.parse(new URLSearchParams(init.body).get("data")!).shipments[0].order as string;
    const awb = String(delhivery.nextAwb++);
    delhivery.shipments.set(ref, awb);
    return json({ success: true, upload_wbn: "UPL1", packages: [{ status: "Success", waybill: awb, refnum: ref, remarks: [] }] });
  }
  return json({ Error: "No such waybill or Order Id found" });
});

class Shop {
  unique = rid();
  userIds: string[] = [];
  productIds: string[] = [];
  eventIds: string[] = [];
  categoryId?: string;
  private counter = 0;
  constructor(readonly app: App) {}

  async admin() {
    const user = await this.app.prisma.user.create({ data: { name: "Ship Admin", email: `admin-${this.unique}-${++this.counter}@example.test`, passwordHash: "unused", role: "ADMIN" } });
    this.userIds.push(user.id);
    return { authorization: `Bearer ${this.app.jwt.sign({ sub: user.id, role: "ADMIN" })}` };
  }

  // A placed order whose payment is open at the gateway; no payment has happened yet.
  async openOrder() {
    this.categoryId ??= (await this.app.prisma.category.create({ data: { name: `PD ${this.unique}`, slug: `pd-${this.unique}` } })).id;
    const n = ++this.counter;
    const product = await this.app.prisma.product.create({ data: { name: `Chair ${n} ${this.unique}`, slug: `pd-chair-${n}-${this.unique}`, price: "12000.00", status: "ACTIVE", categoryId: this.categoryId, inventory: { create: { quantity: 10 } } } });
    this.productIds.push(product.id);
    const user = await this.app.prisma.user.create({ data: { name: "Buyer", email: `buyer-${this.unique}-${n}@example.test`, passwordHash: "unused", emailVerifiedAt: new Date(), role: "CUSTOMER", customer: { create: { customerType: "RETAIL" } } } });
    this.userIds.push(user.id);
    const headers = { authorization: `Bearer ${this.app.jwt.sign({ sub: user.id, role: "CUSTOMER" })}` };
    const address = await this.app.inject({ method: "POST", url: "/api/v1/addresses", headers, payload: { name: "Asha Rao", phone: "+91 98765 43210", addressLine1: "12 MG Road #4", city: "Bengaluru", state: "Karnataka", postalCode: "560001" } });
    await this.app.inject({ method: "PUT", url: "/api/v1/cart", headers, payload: { items: [{ productId: product.id, quantity: 1 }] } });
    const placed = await this.app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...headers, "idempotency-key": `pd-${rid()}` }, payload: { addressId: address.json().data.id, shippingMethod: "standard" } });
    assert.equal(placed.statusCode, 201, placed.body);
    const orderId = placed.json().data.id as string;
    await this.app.prisma.checkoutVerification.upsert({ where: { userId: user.id }, create: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) }, update: { expiresAt: new Date(Date.now() + 600_000) } });
    const opened = await this.app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/payment`, headers });
    assert.equal(opened.statusCode, 200, opened.body);
    return { orderId, headers, razorpayOrderId: opened.json().data.razorpayOrderId as string, amount: opened.json().data.amount as number };
  }

  webhook(event: string, paymentId: string) {
    const p = payments.get(paymentId)!;
    const eventId = `evt_${rid()}`;
    this.eventIds.push(eventId);
    const raw = JSON.stringify({ event, payload: { payment: { entity: { id: p.id, order_id: p.orderId } } } });
    return this.app.inject({ method: "POST", url: "/api/v1/payments/razorpay/webhook", headers: { "content-type": "application/json", "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex"), "x-razorpay-event-id": eventId }, payload: raw });
  }

  ship(admin: Record<string, string>, orderId: string) {
    return this.app.inject({ method: "POST", url: `/api/v1/admin/orders/${orderId}/shipment`, headers: admin, payload: { weightGrams: 12000 } });
  }

  order(orderId: string) {
    return this.app.prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, shipment: true } });
  }

  async cleanup() {
    const { prisma } = this.app;
    const customers = await prisma.customer.findMany({ where: { userId: { in: this.userIds } }, select: { id: true } }).catch(() => []);
    const ids = (await prisma.retailOrder.findMany({ where: { customerId: { in: customers.map((c) => c.id) } }, select: { id: true } }).catch(() => [])).map((o) => o.id);
    await prisma.shipment.deleteMany({ where: { orderId: { in: ids } } }).catch(() => undefined);
    await prisma.payment.deleteMany({ where: { orderId: { in: ids } } }).catch(() => undefined);
    await prisma.paymentWebhookEvent.deleteMany({ where: { eventId: { in: this.eventIds } } }).catch(() => undefined);
    await prisma.retailOrder.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    await prisma.product.deleteMany({ where: { id: { in: this.productIds } } }).catch(() => undefined);
    if (this.categoryId) await prisma.category.delete({ where: { id: this.categoryId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: this.userIds } } }).catch(() => undefined);
  }
}

async function withShop(run: (shop: Shop) => Promise<void>) {
  orders.clear();
  payments.clear();
  refunds.length = 0;
  delhivery.creates = 0;
  delhivery.shipments.clear();
  setRazorpayClientForTests(razorpay as never);
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const shop = new Shop(app);
  try {
    await run(shop);
  } finally {
    await shop.cleanup();
    await app.close();
    setRazorpayClientForTests(undefined);
  }
}

test("no Delhivery shipment is created for an unpaid, failed, cancelled, refunded or flagged order; a paid one gets exactly one", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const admin = await shop.admin();

    const unpaid = await shop.openOrder();

    const failed = await shop.openOrder();
    await shop.webhook("payment.failed", pay(failed.razorpayOrderId, "failed"));

    const cancelled = await shop.openOrder();
    assert.equal((await shop.app.inject({ method: "POST", url: `/api/v1/orders/${cancelled.orderId}/cancel`, headers: cancelled.headers })).statusCode, 200);

    const refunded = await shop.openOrder();
    const refundedPayment = pay(refunded.razorpayOrderId, "captured");
    await shop.webhook("payment.captured", refundedPayment);
    refundFully(refundedPayment);
    await shop.webhook("refund.processed", refundedPayment);

    const flagged = await shop.openOrder();
    await shop.webhook("payment.captured", pay(flagged.razorpayOrderId, "captured", 100));

    const states: Record<string, [string, string]> = {};
    for (const [label, o] of [["unpaid", unpaid], ["failed", failed], ["cancelled", cancelled], ["refunded", refunded], ["flagged", flagged]] as const) {
      const row = await shop.order(o.orderId);
      states[label] = [row.status, row.paymentStatus];
      const res = await shop.ship(admin, o.orderId);
      assert.equal(res.statusCode, 409, `${label}: ${res.body}`);
      assert.equal(row.shipment, null);
    }
    assert.deepEqual(states, { unpaid: ["PENDING", "UNPAID"], failed: ["PENDING", "UNPAID"], cancelled: ["CANCELLED", "UNPAID"], refunded: ["CANCELLED", "REFUNDED"], flagged: ["PENDING", "UNPAID"] });
    assert.equal(delhivery.creates, 0, "Delhivery was never asked to create a shipment");

    const paid = await shop.openOrder();
    await shop.webhook("payment.captured", pay(paid.razorpayOrderId, "captured"));
    const first = await shop.ship(admin, paid.orderId);
    assert.equal(first.statusCode, 200, first.body);
    const again = await shop.ship(admin, paid.orderId);
    assert.equal(again.statusCode, 200);
    assert.equal(delhivery.creates, 1, "one shipment, even when the request is repeated");
    assert.ok((await shop.order(paid.orderId)).shipment?.waybill);
  }));

test("a refund after the courier shipment exists keeps the shipment and flags the payment for a person", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const admin = await shop.admin();
    const o = await shop.openOrder();
    const paymentId = pay(o.razorpayOrderId, "captured");
    await shop.webhook("payment.captured", paymentId);
    assert.equal((await shop.ship(admin, o.orderId)).statusCode, 200);

    refundFully(paymentId);
    await shop.webhook("refund.processed", paymentId);

    const row = await shop.order(o.orderId);
    assert.equal(row.paymentStatus, "REFUNDED");
    // Creating the courier shipment moved it to PROCESSING; the refund must not cancel it out from under the shipment.
    assert.equal(row.status, "PROCESSING", "the order is not cancelled out from under a live shipment");
    assert.ok(row.shipment?.waybill, "the shipment is untouched; cancelling it is a person's decision");
    assert.deepEqual([row.payments[0].needsReview, row.payments[0].reviewReason], [true, "REFUNDED_AFTER_DISPATCH"]);
    // A refunded order can't get a second shipment either.
    assert.equal((await shop.ship(admin, o.orderId)).statusCode, 200, "the existing shipment is returned, not recreated");
    assert.equal(delhivery.creates, 1);
  }));

test("a test-mode payment never creates a Delhivery shipment, even though the order is PAID", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const admin = await shop.admin();
    process.env.RAZORPAY_KEY_ID = TEST_KEY_ID;
    try {
      const o = await shop.openOrder();
      await shop.webhook("payment.captured", pay(o.razorpayOrderId, "captured"));
      const row = await shop.order(o.orderId);
      assert.deepEqual([row.paymentStatus, row.payments[0].mode], ["PAID", "test"]);
      const res = await shop.ship(admin, o.orderId);
      assert.deepEqual([res.statusCode, res.json().error.code], [409, "ORDER_NOT_PAID_LIVE"]);
      assert.equal((await shop.order(o.orderId)).shipment, null, "no shipment row");
      assert.equal(delhivery.creates, 0, "Delhivery was never asked");
      // Manual shipping refuses it too.
      const manual = await shop.app.inject({ method: "POST", url: `/api/v1/admin/orders/${o.orderId}/ship`, headers: admin, payload: { carrier: "Delhivery", trackingNumber: "AWB1" } });
      assert.deepEqual([manual.statusCode, manual.json().error.code], [409, "ORDER_PAID_IN_TEST_MODE"]);
    } finally {
      process.env.RAZORPAY_KEY_ID = LIVE_KEY_ID;
    }
  }));

test("an order marked PAID without a live Razorpay payment (e.g. edited by hand) is never shipped", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const admin = await shop.admin();
    const o = await shop.openOrder();
    await shop.app.prisma.retailOrder.update({ where: { id: o.orderId }, data: { paymentStatus: "PAID", status: "CONFIRMED" } });
    const res = await shop.ship(admin, o.orderId);
    assert.deepEqual([res.statusCode, res.json().error.code], [409, "ORDER_NOT_PAID_LIVE"]);
    assert.equal(delhivery.creates, 0);
  }));
