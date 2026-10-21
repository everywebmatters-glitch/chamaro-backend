// Automatic courier booking after a verified live payment: queued in the payment's transaction, booked by the
// shipment worker, idempotent under duplicate webhooks, retries and concurrent workers, and safe when the parcel,
// the address or Delhivery is a problem. Razorpay and Delhivery are in-memory fakes that fail the test on any request
// to another host: no network, no real payment, no real shipment. Runs only against the isolated test database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const WEBHOOK_SECRET = "test-only-webhook-secret-not-real";
Object.assign(process.env, {
  RAZORPAY_KEY_ID: "rzp_live_ChamaroFake01",
  RAZORPAY_KEY_SECRET: "test-only-key-secret-not-real",
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  RAZORPAY_ALLOW_LIVE_KEYS: "true",
  // Fake live-format keys in a test run: the explicit test-only override.
  RAZORPAY_ALLOW_LIVE_OUTSIDE_PRODUCTION: "true",
  DELHIVERY_ENABLED: "true",
  DELHIVERY_AUTO_BOOKING: "true",
  DELHIVERY_API_BASE_URL: "https://staging-express.delhivery.com",
  DELHIVERY_API_TOKEN: "fakestagingtoken000000000001",
  DELHIVERY_PICKUP_LOCATION: "Chamaro Test Warehouse",
  DELHIVERY_WEBHOOK_SECRET: "test-delhivery-webhook-secret-00000001",
  APP_ENV: "development",
});

const skipReason = await isolatedDatabaseSkipReason();
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
const { RazorpayError, setRazorpayClientForTests } = await import("../../src/providers/razorpay.provider.js");
type RemotePayment = import("../../src/providers/razorpay.provider.js").RemotePayment;
const { setDelhiveryFetchForTests } = await import("../../src/providers/delhivery.provider.js");
const { setEmailClientForTests } = await import("../../src/services/email.service.js");
const { createShipmentService, AUTO_BOOKING_MAX_ATTEMPTS } = await import("../../src/services/shipment.service.js");
setEmailClientForTests({ emails: { send: async () => ({ data: { id: "re_1" }, error: null }) } });

const rid = () => randomBytes(7).toString("hex");

// ---- fake Razorpay -----------------------------------------------------------------------------------------------------
const gatewayOrders = new Map<string, number>();
const payments = new Map<string, RemotePayment>();
setRazorpayClientForTests({
  async createOrder(input: { amountMinor: number }) { const id = `order_${rid()}`; gatewayOrders.set(id, input.amountMinor); return { id, amountMinor: input.amountMinor, currency: "INR", status: "created" }; },
  async fetchPayment(id: string) { const p = payments.get(id); if (!p) throw new RazorpayError("RAZORPAY_REJECTED", 400, "rejected"); return { ...p }; },
  async fetchOrderPayments(orderId: string) { return [...payments.values()].filter((p) => p.orderId === orderId).map((p) => ({ ...p })); },
  async capturePayment(id: string) { const p = payments.get(id)!; p.status = "captured"; return { ...p }; },
  async fetchRefunds() { return []; },
} as never);

// ---- fake Delhivery ----------------------------------------------------------------------------------------------------
// mode: ok | reject (400, nothing created) | timeout-created (Delhivery creates it but the answer is lost) | timeout
const delhivery = { creates: 0, inFlight: 0, maxInFlight: 0, mode: "ok" as "ok" | "reject" | "timeout-created" | "timeout", nonServiceable: new Set<string>(), byRef: new Map<string, string>(), next: 9300000000000 };
setDelhiveryFetchForTests(async (rawUrl, init) => {
  const url = new URL(rawUrl);
  assert.equal(url.origin, "https://staging-express.delhivery.com", "only Delhivery staging is ever called");
  const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
  if (url.pathname === "/c/api/pin-codes/json/") {
    const pin = url.searchParams.get("filter_codes")!;
    return json(200, { delivery_codes: delhivery.nonServiceable.has(pin) ? [] : [{ postal_code: { pin: Number(pin), pre_paid: "Y", cod: "Y", pickup: "Y", is_oda: "N" } }] });
  }
  if (url.pathname === "/api/cmu/create.json") {
    delhivery.inFlight++;
    delhivery.maxInFlight = Math.max(delhivery.maxInFlight, delhivery.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    delhivery.inFlight--;
    const ref = JSON.parse(new URLSearchParams(init.body).get("data")!).shipments[0].order as string;
    if (delhivery.mode === "reject") return json(400, { error: "Invalid consignee details" });
    if (delhivery.mode === "timeout") throw new Error("timeout");
    delhivery.creates++;
    const awb = delhivery.byRef.get(ref) ?? String(delhivery.next++);
    delhivery.byRef.set(ref, awb);
    if (delhivery.mode === "timeout-created") throw new Error("timeout after Delhivery created it");
    return json(200, { success: true, upload_wbn: `UPL${awb}`, packages: [{ status: "Success", waybill: awb, refnum: ref, remarks: [] }] });
  }
  if (url.pathname === "/api/v1/packages/json/") {
    const ref = url.searchParams.get("ref_ids");
    const awb = ref ? delhivery.byRef.get(ref) : undefined;
    return awb ? json(200, { ShipmentData: [{ Shipment: { AWB: awb, ReferenceNo: ref, Status: { Status: "Manifested", StatusType: "UD", StatusDateTime: "2026-10-21T10:00:00" }, Scans: [] } }] }) : json(200, { Error: "No such waybill or Order Id found" });
  }
  throw new Error(`unexpected Delhivery call ${url.pathname}`);
});

type Packed = { weightGrams: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null };
const PACKED: Packed = { weightGrams: 9000, lengthCm: 70, widthCm: 60, heightCm: 50 };

class Shop {
  unique = rid();
  userIds: string[] = [];
  productIds: string[] = [];
  eventIds: string[] = [];
  categoryId?: string;
  private counter = 0;
  readonly worker: ReturnType<typeof createShipmentService>;
  constructor(readonly app: App) {
    this.worker = createShipmentService(app.prisma);
  }

  async admin() {
    const user = await this.app.prisma.user.create({ data: { name: "Ship Admin", email: `admin-${this.unique}-${++this.counter}@example.test`, passwordHash: "unused", role: "ADMIN" } });
    this.userIds.push(user.id);
    return { authorization: `Bearer ${this.app.jwt.sign({ sub: user.id, role: "ADMIN" })}` };
  }

  // A placed order whose live payment is open at the gateway.
  async openOrder(options: { packed?: Packed; quantity?: number; postalCode?: string } = {}) {
    this.categoryId ??= (await this.app.prisma.category.create({ data: { name: `AB ${this.unique}`, slug: `ab-${this.unique}` } })).id;
    const n = ++this.counter;
    const product = await this.app.prisma.product.create({ data: { name: `Chair ${n} ${this.unique}`, slug: `ab-chair-${n}-${this.unique}`, price: "4000.00", status: "ACTIVE", categoryId: this.categoryId, inventory: { create: { quantity: 10 } }, ...(options.packed ?? PACKED) } });
    this.productIds.push(product.id);
    const user = await this.app.prisma.user.create({ data: { name: "Buyer", email: `buyer-${this.unique}-${n}@example.test`, passwordHash: "unused", emailVerifiedAt: new Date(), role: "CUSTOMER", customer: { create: { customerType: "RETAIL" } } } });
    this.userIds.push(user.id);
    const headers = { authorization: `Bearer ${this.app.jwt.sign({ sub: user.id, role: "CUSTOMER" })}` };
    const address = await this.app.inject({ method: "POST", url: "/api/v1/addresses", headers, payload: { name: "Asha Rao", phone: "+91 98765 43210", addressLine1: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: options.postalCode ?? "560001" } });
    await this.app.inject({ method: "PUT", url: "/api/v1/cart", headers, payload: { items: [{ productId: product.id, quantity: options.quantity ?? 1 }] } });
    const placed = await this.app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...headers, "idempotency-key": `ab-${rid()}` }, payload: { addressId: address.json().data.id, shippingMethod: "standard" } });
    assert.equal(placed.statusCode, 201, placed.body);
    const orderId = placed.json().data.id as string;
    await this.app.prisma.checkoutVerification.upsert({ where: { userId: user.id }, create: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) }, update: { expiresAt: new Date(Date.now() + 600_000) } });
    const opened = await this.app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/payment`, headers });
    assert.equal(opened.statusCode, 200, opened.body);
    return { orderId, headers, razorpayOrderId: opened.json().data.razorpayOrderId as string };
  }

  // The customer pays: Razorpay captures it and sends the payment webhook.
  async pay(razorpayOrderId: string) {
    const id = `pay_${rid()}`;
    payments.set(id, { id, orderId: razorpayOrderId, status: "captured", amountMinor: gatewayOrders.get(razorpayOrderId)!, currency: "INR", amountRefundedMinor: 0, method: "upi", errorCode: null, errorReason: null });
    await this.webhook("payment.captured", id);
    return id;
  }

  webhook(event: string, paymentId: string) {
    const p = payments.get(paymentId)!;
    const eventId = `evt_${rid()}`;
    this.eventIds.push(eventId);
    const raw = JSON.stringify({ event, payload: { payment: { entity: { id: p.id, order_id: p.orderId } } } });
    return this.app.inject({ method: "POST", url: "/api/v1/payments/razorpay/webhook", headers: { "content-type": "application/json", "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex"), "x-razorpay-event-id": eventId }, payload: raw });
  }

  shipment(orderId: string) {
    return this.app.prisma.shipment.findUnique({ where: { orderId } });
  }

  async dueNow(orderId: string) {
    await this.app.prisma.shipment.updateMany({ where: { orderId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
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
  gatewayOrders.clear();
  payments.clear();
  Object.assign(delhivery, { creates: 0, inFlight: 0, maxInFlight: 0, mode: "ok" });
  delhivery.nonServiceable.clear();
  delhivery.byRef.clear();
  process.env.DELHIVERY_AUTO_BOOKING = "true";
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const shop = new Shop(app);
  try {
    await run(shop);
  } finally {
    await shop.cleanup();
    await app.close();
  }
}

test("a verified live payment queues one booking without calling Delhivery; the worker books it; no shipped email until pickup", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const o = await shop.openOrder();
    await shop.pay(o.razorpayOrderId);
    let row = await shop.shipment(o.orderId);
    assert.deepEqual([row?.status, row?.autoBooked, row?.weightGrams, row?.lengthCm, row?.waybill], ["QUEUED", true, 9000, 70, null]);
    assert.equal(delhivery.creates, 0, "the webhook request never calls Delhivery");

    const result = await shop.worker.bookDue();
    assert.equal(result.booked, 1, JSON.stringify(result));
    row = await shop.shipment(o.orderId);
    assert.equal(row?.status, "MANIFESTED");
    assert.ok(row?.waybill && row.uploadWbn);
    const order = await shop.app.prisma.retailOrder.findUniqueOrThrow({ where: { id: o.orderId } });
    assert.deepEqual([order.paymentStatus, order.status, order.carrier, order.trackingNumber], ["PAID", "PROCESSING", "Delhivery", row?.waybill]);
    // The customer is emailed when the courier's own tracking shows the pickup, not at booking.
    assert.equal(await shop.app.prisma.emailNotification.count({ where: { orderId: o.orderId, kind: "ORDER_SHIPPED" } }), 0);
    // The customer sees the AWB on their order.
    const mine = (await shop.app.inject({ method: "GET", url: `/api/v1/orders/${o.orderId}`, headers: o.headers })).json().data;
    assert.equal(mine.shipment.trackingNumber, row?.waybill);
    assert.equal(JSON.stringify(mine).includes("uploadWbn"), false, "booking internals stay admin-only");
  }));

test("duplicate and late Razorpay webhooks and repeated worker runs book exactly one shipment", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const o = await shop.openOrder();
    const paymentId = await shop.pay(o.razorpayOrderId);
    await shop.webhook("payment.captured", paymentId);
    await shop.webhook("order.paid", paymentId);
    assert.equal(await shop.app.prisma.shipment.count({ where: { orderId: o.orderId } }), 1);
    await shop.worker.bookDue();
    await shop.worker.bookDue();
    await shop.webhook("payment.captured", paymentId);
    await shop.worker.bookDue();
    assert.equal(delhivery.creates, 1);
  }));

test("concurrent workers book a queued order once", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const o = await shop.openOrder();
    await shop.pay(o.razorpayOrderId);
    const results = await Promise.all([1, 2, 3, 4].map(() => createShipmentService(shop.app.prisma).bookDue()));
    assert.equal(delhivery.creates, 1, JSON.stringify(results));
    assert.equal(results.reduce((sum, r) => sum + r.booked, 0), 1);
    assert.equal((await shop.shipment(o.orderId))?.status, "MANIFESTED");
  }));

test("missing packed size or several units: the order stays paid and is flagged for an admin; nothing is guessed", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const admin = await shop.admin();
    const noSize = await shop.openOrder({ packed: { weightGrams: 9000, lengthCm: null, widthCm: 60, heightCm: 50 } });
    await shop.pay(noSize.razorpayOrderId);
    const two = await shop.openOrder({ quantity: 2 });
    await shop.pay(two.razorpayOrderId);
    for (const [o, problem] of [[noSize, "PARCEL_DETAILS_MISSING"], [two, "MULTI_PARCEL_ORDER"]] as const) {
      const row = await shop.shipment(o.orderId);
      assert.deepEqual([row?.status, row?.lastErrorCode, row?.needsReconcile], ["CREATE_FAILED", problem, false]);
      assert.equal((await shop.app.prisma.retailOrder.findUniqueOrThrow({ where: { id: o.orderId } })).paymentStatus, "PAID");
    }
    assert.equal((await shop.worker.bookDue()).due, 0, "the worker never books without a parcel");
    assert.equal(delhivery.creates, 0);

    // The admin enters the parcel and retries from Retail Orders.
    const retry = await shop.app.inject({ method: "POST", url: `/api/v1/admin/orders/${two.orderId}/shipment`, headers: admin, payload: { weightGrams: 18000, lengthCm: 70, widthCm: 60, heightCm: 100 } });
    assert.equal(retry.statusCode, 200, retry.body);
    const row = await shop.shipment(two.orderId);
    assert.deepEqual([row?.status, row?.weightGrams, row?.heightCm], ["MANIFESTED", 18000, 100]);
    assert.equal(delhivery.creates, 1);
  }));

test("an unserviceable PIN code or a Delhivery rejection keeps the order paid, records the error and is not retried automatically", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const far = await shop.openOrder({ postalCode: "799999" });
    delhivery.nonServiceable.add("799999");
    await shop.pay(far.razorpayOrderId);
    await shop.worker.bookDue();
    let row = await shop.shipment(far.orderId);
    assert.deepEqual([row?.status, row?.lastErrorCode, row?.needsReconcile], ["CREATE_FAILED", "PINCODE_NOT_SERVICEABLE", false]);

    delhivery.mode = "reject";
    const rejected = await shop.openOrder();
    await shop.pay(rejected.razorpayOrderId);
    await shop.worker.bookDue();
    row = await shop.shipment(rejected.orderId);
    assert.deepEqual([row?.status, row?.lastErrorCode, row?.lastErrorRemark, row?.needsReconcile], ["CREATE_FAILED", "DELHIVERY_REJECTED", "Invalid consignee details", false]);

    const before = await shop.app.prisma.shipment.findMany({ where: { orderId: { in: [far.orderId, rejected.orderId] } }, select: { attempts: true } });
    await shop.dueNow(far.orderId);
    await shop.dueNow(rejected.orderId);
    assert.equal((await shop.worker.bookDue()).due, 0, "refusals wait for an admin");
    assert.deepEqual(await shop.app.prisma.shipment.findMany({ where: { orderId: { in: [far.orderId, rejected.orderId] } }, select: { attempts: true } }), before);
    for (const o of [far, rejected]) assert.equal((await shop.app.prisma.retailOrder.findUniqueOrThrow({ where: { id: o.orderId } })).paymentStatus, "PAID");
  }));

test("a timeout after Delhivery created the shipment: the retry finds and adopts it instead of creating a second", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const o = await shop.openOrder();
    await shop.pay(o.razorpayOrderId);
    delhivery.mode = "timeout-created";
    assert.equal((await shop.worker.bookDue()).retryLater, 1);
    let row = await shop.shipment(o.orderId);
    assert.deepEqual([row?.status, row?.needsReconcile, row?.waybill], ["CREATE_FAILED", true, null]);
    assert.ok(row?.nextAttemptAt && row.nextAttemptAt > new Date(), "the retry waits");
    assert.equal((await shop.worker.bookDue()).due, 0, "not retried before it is due");

    delhivery.mode = "ok";
    await shop.dueNow(o.orderId);
    assert.equal((await shop.worker.bookDue()).booked, 1);
    row = await shop.shipment(o.orderId);
    assert.equal(row?.status, "MANIFESTED");
    assert.equal(row?.waybill, delhivery.byRef.get(o.orderId), "the AWB Delhivery already created");
    assert.equal(delhivery.creates, 1, "created once at Delhivery");
  }));

test("a timeout where nothing was created is retried with backoff and gives up after the last attempt", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const o = await shop.openOrder();
    await shop.pay(o.razorpayOrderId);
    delhivery.mode = "timeout";
    for (let attempt = 1; attempt <= AUTO_BOOKING_MAX_ATTEMPTS; attempt++) {
      await shop.dueNow(o.orderId);
      await shop.worker.bookDue();
    }
    const row = await shop.shipment(o.orderId);
    assert.deepEqual([row?.status, row?.attempts], ["CREATE_FAILED", AUTO_BOOKING_MAX_ATTEMPTS]);
    await shop.dueNow(o.orderId);
    assert.equal((await shop.worker.bookDue()).due, 0, "stops after the last attempt; an admin retries");
    assert.equal(delhivery.creates, 0);
    assert.equal((await shop.app.prisma.retailOrder.findUniqueOrThrow({ where: { id: o.orderId } })).paymentStatus, "PAID");
  }));

test("with automatic booking off nothing is queued; a test-mode payment never queues a booking", { skip: skipReason }, () =>
  withShop(async (shop) => {
    process.env.DELHIVERY_AUTO_BOOKING = "";
    const off = await shop.openOrder();
    await shop.pay(off.razorpayOrderId);
    assert.equal(await shop.shipment(off.orderId), null);
    process.env.DELHIVERY_AUTO_BOOKING = "true";

    process.env.RAZORPAY_KEY_ID = "rzp_test_ChamaroFake01";
    try {
      const sandbox = await shop.openOrder();
      await shop.pay(sandbox.razorpayOrderId);
      assert.equal((await shop.app.prisma.retailOrder.findUniqueOrThrow({ where: { id: sandbox.orderId } })).paymentStatus, "PAID");
      assert.equal(await shop.shipment(sandbox.orderId), null);
    } finally {
      process.env.RAZORPAY_KEY_ID = "rzp_live_ChamaroFake01";
    }
    assert.equal(delhivery.creates, 0);
  }));

test("shipping by hand still works: a booking that never reached Delhivery is withdrawn, never booked afterwards", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const admin = await shop.admin();
    const o = await shop.openOrder();
    await shop.pay(o.razorpayOrderId);
    const manual = await shop.app.inject({ method: "POST", url: `/api/v1/admin/orders/${o.orderId}/ship`, headers: admin, payload: { carrier: "Blue Dart", trackingNumber: "BD-1001" } });
    assert.equal(manual.statusCode, 200, manual.body);
    assert.deepEqual([(await shop.shipment(o.orderId))?.status, (await shop.shipment(o.orderId))?.lastErrorCode], ["CANCELLED", "SHIPPED_BY_HAND"]);
    await shop.worker.bookDue();
    assert.equal(delhivery.creates, 0);
    assert.equal(await shop.app.prisma.emailNotification.count({ where: { orderId: o.orderId, kind: "ORDER_SHIPPED" } }), 1, "one shipped email, from the manual shipment");

    // Once Delhivery has the shipment, shipping by hand is refused.
    const booked = await shop.openOrder();
    await shop.pay(booked.razorpayOrderId);
    await shop.worker.bookDue();
    const refused = await shop.app.inject({ method: "POST", url: `/api/v1/admin/orders/${booked.orderId}/ship`, headers: admin, payload: { carrier: "Blue Dart", trackingNumber: "BD-1002" } });
    assert.deepEqual([refused.statusCode, refused.json().error.code], [409, "SHIPMENT_MANAGED_BY_COURIER"]);
  }));

test("an order refunded before the worker runs is not booked; its queued booking is withdrawn", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const o = await shop.openOrder();
    await shop.pay(o.razorpayOrderId);
    await shop.app.prisma.retailOrder.update({ where: { id: o.orderId }, data: { paymentStatus: "REFUNDED", status: "CANCELLED" } });
    assert.equal((await shop.worker.bookDue()).withdrawn, 1);
    assert.deepEqual([(await shop.shipment(o.orderId))?.status, (await shop.shipment(o.orderId))?.lastErrorCode], ["CANCELLED", "ORDER_NOT_PAID"]);
    assert.equal(delhivery.creates, 0);
  }));
