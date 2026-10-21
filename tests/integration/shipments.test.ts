// Delhivery shipments end to end through the API: paid-only creation, duplicate prevention, unknown-outcome recovery,
// tracking sync, the shipped/delivered emails, the webhook, and what customers may see.
// Runs only against the isolated local test database. Delhivery is a fake (setDelhiveryFetchForTests) that fails the
// test on any request to a host other than Delhivery staging; every email goes to a fake Resend client.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

// Test values only. Set after dotenv, so whatever .env holds for Delhivery is never used here.
const WEBHOOK_SECRET = "test-webhook-Q8v2LmZr4TnW7pXy1sDfH6jK";
Object.assign(process.env, {
  DELHIVERY_ENABLED: "true",
  DELHIVERY_API_BASE_URL: "https://staging-express.delhivery.com",
  DELHIVERY_API_TOKEN: "fakestagingtoken000000000001",
  DELHIVERY_PICKUP_LOCATION: "Chamaro Test Warehouse",
  DELHIVERY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  APP_ENV: "development",
});
delete process.env.DELHIVERY_SELLER_GST_TIN;
delete process.env.DELHIVERY_HSN_CODE;

const skipReason = await isolatedDatabaseSkipReason();
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;

// ---- fake email provider -------------------------------------------------------------------------------------------
const outbox: { to: string; subject: string; html: string; text: string }[] = [];
const { setEmailClientForTests } = await import("../../src/services/email.service.js");
setEmailClientForTests({ emails: { send: async (message) => { outbox.push(message); return { data: { id: `re_${outbox.length}` }, error: null }; } } });

// ---- fake Delhivery ------------------------------------------------------------------------------------------------
type FakeShipment = { awb: string; ref: string; status: { Status: string; StatusType: string; StatusDateTime: string; StatusLocation: string; Instructions: string }; scans: object[] };
const fake = {
  calls: [] as { path: string; params: URLSearchParams; body?: string }[],
  shipments: new Map<string, FakeShipment>(),
  nextAwb: 9100000000000,
  createMode: "ok" as "ok" | "lose-answer" | "reject" | "throw",
  nonServiceable: new Set<string>(),
  creates() { return this.calls.filter((call) => call.path === "/api/cmu/create.json").length; },
  scan(awb: string, StatusType: string, Status: string, at: string) {
    const shipment = this.shipments.get(awb)!;
    shipment.status = { Status, StatusType, StatusDateTime: at, StatusLocation: "Bengaluru_Hub (Karnataka)", Instructions: `${Status} scan` };
    shipment.scans.push({ ScanDetail: { Scan: Status, ScanType: StatusType, ScanDateTime: at, ScannedLocation: "Bengaluru_Hub (Karnataka)", Instructions: `${Status} scan` } });
  },
  reset() { this.calls.length = 0; this.shipments.clear(); this.createMode = "ok"; this.nonServiceable.clear(); },
};
const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
const { setDelhiveryFetchForTests } = await import("../../src/providers/delhivery.provider.js");
setDelhiveryFetchForTests(async (rawUrl, init) => {
  const url = new URL(rawUrl);
  assert.equal(url.origin, "https://staging-express.delhivery.com", "only Delhivery staging is ever called");
  assert.equal(init.headers.Authorization, "Token fakestagingtoken000000000001");
  fake.calls.push({ path: url.pathname, params: url.searchParams, body: init.body });
  if (url.pathname === "/c/api/pin-codes/json/") {
    const pin = url.searchParams.get("filter_codes")!;
    return json(200, fake.nonServiceable.has(pin) ? { delivery_codes: [] } : { delivery_codes: [{ postal_code: { pin: Number(pin), pre_paid: "Y", cod: "Y", pickup: "Y", is_oda: "N" } }] });
  }
  if (url.pathname === "/api/cmu/create.json") {
    if (fake.createMode === "throw") throw new TypeError("fetch failed");
    const data = JSON.parse(new URLSearchParams(init.body).get("data")!);
    const ref = data.shipments[0].order as string;
    if (fake.createMode === "reject") return json(200, { success: false, error: true, rmk: "ClientWarehouse matching query does not exist.", packages: [] });
    if ([...fake.shipments.values()].some((shipment) => shipment.ref === ref)) return json(200, { success: false, packages: [{ status: "Fail", waybill: "", refnum: ref, remarks: ["Duplicate order id"] }] });
    const awb = String(fake.nextAwb++);
    fake.shipments.set(awb, { awb, ref, status: { Status: "Manifested", StatusType: "UD", StatusDateTime: "2026-10-20T10:00:00", StatusLocation: "Bengaluru_Hub (Karnataka)", Instructions: "Manifest uploaded" }, scans: [] });
    fake.scan(awb, "UD", "Manifested", "2026-10-20T10:00:00");
    // Delhivery created it, but the answer never arrived.
    if (fake.createMode === "lose-answer") throw new TypeError("socket hang up");
    return json(200, { success: true, upload_wbn: "UPL1", packages: [{ status: "Success", waybill: awb, refnum: ref, remarks: [] }] });
  }
  if (url.pathname === "/api/v1/packages/json/") {
    const waybills = url.searchParams.get("waybill")?.split(",");
    const ref = url.searchParams.get("ref_ids");
    const found = [...fake.shipments.values()].filter((shipment) => (waybills ? waybills.includes(shipment.awb) : shipment.ref === ref));
    if (found.length === 0) return json(200, { Error: "No such waybill or Order Id found" });
    return json(200, { ShipmentData: found.map((shipment) => ({ Shipment: { AWB: shipment.awb, ReferenceNo: shipment.ref, Status: shipment.status, Scans: shipment.scans } })) });
  }
  if (url.pathname === "/api/p/edit") return json(200, { status: true, waybill: JSON.parse(init.body!).waybill, remark: "Shipment has been cancelled" });
  return json(404, {});
});

// ---- shop helpers --------------------------------------------------------------------------------------------------
async function withShop(run: (shop: Shop) => Promise<void>) {
  outbox.length = 0;
  fake.reset();
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

class Shop {
  unique = randomBytes(5).toString("hex");
  userIds: string[] = [];
  productIds: string[] = [];
  categoryId?: string;
  private counter = 0;
  constructor(readonly app: App) {}

  async customer(label = "c") {
    const user = await this.app.prisma.user.create({ data: { name: `Customer ${label}`, email: `${label}-${this.unique}-${++this.counter}@example.test`, passwordHash: "unused", emailVerifiedAt: new Date(), role: "CUSTOMER", customer: { create: { customerType: "RETAIL" } } } });
    this.userIds.push(user.id);
    return { user, headers: { authorization: `Bearer ${this.app.jwt.sign({ sub: user.id, role: "CUSTOMER" })}` } };
  }

  async admin() {
    const user = await this.app.prisma.user.create({ data: { name: "Ship Admin", email: `admin-${this.unique}-${++this.counter}@example.test`, passwordHash: "unused", role: "ADMIN" } });
    this.userIds.push(user.id);
    return { headers: { authorization: `Bearer ${this.app.jwt.sign({ sub: user.id, role: "ADMIN" })}` } };
  }

  // A placed order (through the API) for a new customer; `paid` stands in for a verified payment confirmation, which
  // the API cannot record yet. Test database only.
  async order(options: { paid?: boolean; price?: string; postalCode?: string; label?: string } = {}) {
    this.categoryId ??= (await this.app.prisma.category.create({ data: { name: `Ship ${this.unique}`, slug: `ship-${this.unique}` } })).id;
    const n = ++this.counter;
    const product = await this.app.prisma.product.create({ data: { name: `Chair ${n} ${this.unique}`, slug: `ship-chair-${n}-${this.unique}`, price: options.price ?? "12000.00", status: "ACTIVE", categoryId: this.categoryId, inventory: { create: { quantity: 10 } } } });
    this.productIds.push(product.id);
    const buyer = await this.customer(options.label ?? "buyer");
    const address = await this.app.inject({ method: "POST", url: "/api/v1/addresses", headers: buyer.headers, payload: { name: "Asha Rao", phone: "+91 98765 43210", addressLine1: "12 MG Road #4", city: "Bengaluru", state: "Karnataka", postalCode: options.postalCode ?? "560001" } });
    await this.app.inject({ method: "PUT", url: "/api/v1/cart", headers: buyer.headers, payload: { items: [{ productId: product.id, quantity: 1 }] } });
    const placed = await this.app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...buyer.headers, "idempotency-key": `ship-${randomBytes(8).toString("hex")}` }, payload: { addressId: address.json().data.id, shippingMethod: "standard" } });
    assert.equal(placed.statusCode, 201, placed.body);
    const orderId = placed.json().data.id as string;
    // Paid the way payment.service records a captured LIVE Razorpay payment: shipping requires one (orderPaidLive).
    if (options.paid ?? true) {
      const order = await this.app.prisma.retailOrder.update({ where: { id: orderId }, data: { paymentStatus: "PAID" } });
      await this.app.prisma.payment.create({ data: { orderId, mode: "live", providerOrderId: `order_${randomBytes(8).toString("hex")}`, providerPaymentId: `pay_${randomBytes(8).toString("hex")}`, amountMinor: Math.round(Number(order.total) * 100), status: "CAPTURED", capturedAt: new Date() } });
    }
    return { orderId, buyer };
  }

  ship(adminHeaders: Record<string, string>, orderId: string, payload: object = { weightGrams: 12000 }) {
    return this.app.inject({ method: "POST", url: `/api/v1/admin/orders/${orderId}/shipment`, headers: adminHeaders, payload });
  }

  // `null` sends no Authorization header at all.
  webhook(body: unknown, authorization: string | null = `Bearer ${WEBHOOK_SECRET}`) {
    return this.app.inject({ method: "POST", url: "/api/v1/webhooks/delhivery/scans", headers: authorization ? { authorization } : {}, payload: body as object });
  }

  async cleanup() {
    const { prisma } = this.app;
    const customers = await prisma.customer.findMany({ where: { userId: { in: this.userIds } }, select: { id: true } }).catch(() => []);
    const orderWhere = { order: { customerId: { in: customers.map((customer) => customer.id) } } };
    await prisma.shipment.deleteMany({ where: orderWhere }).catch(() => undefined);
    await prisma.payment.deleteMany({ where: { order: { customerId: { in: customers.map((customer) => customer.id) } } } }).catch(() => undefined);
    await prisma.retailOrder.deleteMany({ where: { customerId: { in: customers.map((customer) => customer.id) } } }).catch(() => undefined);
    await prisma.product.deleteMany({ where: { id: { in: this.productIds } } }).catch(() => undefined);
    if (this.categoryId) await prisma.category.delete({ where: { id: this.categoryId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: this.userIds } } }).catch(() => undefined);
  }
}

const shipmentOf = (app: App, orderId: string) => app.prisma.shipment.findUniqueOrThrow({ where: { orderId }, include: { events: true } });
const emailsFor = (app: App, orderId: string) => app.prisma.emailNotification.findMany({ where: { orderId, kind: { in: ["ORDER_SHIPPED", "ORDER_DELIVERED"] } }, orderBy: { createdAt: "asc" } });

// ---- creating shipments --------------------------------------------------------------------------------------------

test("shipping switched off: 503 SHIPPING_DISABLED, nothing recorded, Delhivery never called", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const admin = await shop.admin();
    const { orderId } = await shop.order();
    process.env.DELHIVERY_ENABLED = "false";
    try {
      const refused = await shop.ship(admin.headers, orderId);
      assert.equal(refused.statusCode, 503, refused.body);
      assert.equal(refused.json().error.code, "SHIPPING_DISABLED");
      const webhook = await shop.webhook({ Shipment: { AWB: "1" } });
      assert.equal(webhook.statusCode, 503);
    } finally {
      process.env.DELHIVERY_ENABLED = "true";
    }
    assert.equal(fake.calls.length, 0);
    assert.equal(await shop.app.prisma.shipment.count({ where: { orderId } }), 0);
  }));

test("unpaid, refunded and cancelled orders are refused before Delhivery is called", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const unpaid = await shop.order({ paid: false, label: "unpaid" });
    const refunded = await shop.order({ label: "refunded" });
    await app.prisma.retailOrder.update({ where: { id: refunded.orderId }, data: { paymentStatus: "REFUNDED" } });
    const cancelled = await shop.order({ paid: false, label: "cancelled" });
    await app.inject({ method: "POST", url: `/api/v1/orders/${cancelled.orderId}/cancel`, headers: cancelled.buyer.headers });

    for (const [orderId, code] of [[unpaid.orderId, "ORDER_NOT_PAID"], [refunded.orderId, "ORDER_NOT_PAID"], [cancelled.orderId, "ORDER_NOT_PAID"], ["no-such-order", "NOT_FOUND"]]) {
      const refused = await shop.ship(admin.headers, orderId);
      assert.equal(refused.json().error.code, code, orderId);
    }
    assert.equal(fake.calls.length, 0, "Delhivery never called");
    assert.equal(await app.prisma.shipment.count({ where: { orderId: { in: [unpaid.orderId, refunded.orderId, cancelled.orderId] } } }), 0);

    // A customer cannot reach the admin route at all, for their own paid order either.
    const paid = await shop.order({ label: "paid" });
    assert.equal((await shop.ship(paid.buyer.headers, paid.orderId)).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: `/api/v1/admin/orders/${paid.orderId}/shipment`, payload: {} })).statusCode, 401);
    assert.equal(fake.calls.length, 0);
  }));

test("a paid order gets exactly one shipment with Delhivery's AWB, even with retries and simultaneous requests", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const { orderId } = await shop.order();

    const burst = await Promise.all([1, 2, 3, 4].map(() => shop.ship(admin.headers, orderId)));
    const codes = burst.map((response) => response.statusCode);
    assert.ok(codes.includes(200), burst.map((response) => response.body).join(" | "));
    for (const response of burst) if (response.statusCode !== 200) assert.equal(response.json().error.code, "SHIPMENT_IN_PROGRESS");
    assert.equal(fake.creates(), 1, "one create call");

    const shipment = await shipmentOf(app, orderId);
    const awb = [...fake.shipments.keys()][0];
    assert.deepEqual([shipment.status, shipment.waybill, shipment.providerOrderRef, shipment.weightGrams], ["MANIFESTED", awb, orderId, 12000]);
    const order = await app.prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId } });
    assert.deepEqual([order.status, order.carrier, order.trackingNumber, order.shippedAt], ["PROCESSING", "Delhivery", awb, null], "manifested is not shipped");
    assert.equal(outbox.filter((message) => /shipped|delivered/i.test(message.subject)).length, 0, "no email before the courier has the package");

    const retry = await shop.ship(admin.headers, orderId);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().data.shipment.waybill, awb);
    assert.equal(fake.creates(), 1, "a retry calls nothing");

    // The sent payload is prepaid, for this order, to the configured warehouse.
    const sent = JSON.parse(new URLSearchParams(fake.calls.find((call) => call.path === "/api/cmu/create.json")!.body).get("data")!);
    assert.deepEqual([sent.shipments[0].order, sent.shipments[0].payment_mode, sent.shipments[0].pin, sent.pickup_location.name], [orderId, "Prepaid", "560001", "Chamaro Test Warehouse"]);
  }));

test("an answer lost after Delhivery created the shipment: the retry finds and adopts it instead of creating again", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const { orderId } = await shop.order();
    fake.createMode = "lose-answer";
    const lost = await shop.ship(admin.headers, orderId);
    assert.equal(lost.statusCode, 502, lost.body);
    assert.equal(lost.json().error.code, "DELHIVERY_UNAVAILABLE");
    const failed = await shipmentOf(app, orderId);
    assert.deepEqual([failed.status, failed.waybill, failed.needsReconcile, failed.lastErrorCode], ["CREATE_FAILED", null, true, "DELHIVERY_UNAVAILABLE"]);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${orderId}`, headers: (await shop.admin()).headers })).statusCode, 403);

    fake.createMode = "ok";
    const retried = await shop.ship(admin.headers, orderId);
    assert.equal(retried.statusCode, 200, retried.body);
    const awb = [...fake.shipments.keys()][0];
    assert.equal(retried.json().data.shipment.waybill, awb, "the AWB Delhivery already assigned");
    assert.equal(fake.creates(), 1, "no second create call");
    assert.equal(fake.shipments.size, 1);
    assert.ok(fake.calls.some((call) => call.path === "/api/v1/packages/json/" && call.params.get("ref_ids") === orderId), "looked the order up first");
  }));

test("Delhivery rejections and unserviceable PIN codes leave no shipment and can be retried", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const { orderId } = await shop.order();
    fake.createMode = "reject";
    const rejected = await shop.ship(admin.headers, orderId);
    assert.equal(rejected.statusCode, 502);
    assert.equal(rejected.json().error.code, "DELHIVERY_REJECTED");
    const failed = await shipmentOf(app, orderId);
    assert.deepEqual([failed.status, failed.waybill, failed.needsReconcile, failed.lastErrorRemark], ["CREATE_FAILED", null, false, "ClientWarehouse matching query does not exist."]);
    assert.equal((await app.prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId } })).trackingNumber, null);

    fake.createMode = "ok";
    assert.equal((await shop.ship(admin.headers, orderId)).statusCode, 200);
    assert.equal((await shipmentOf(app, orderId)).status, "MANIFESTED");

    const far = await shop.order({ postalCode: "799999", label: "far" });
    fake.nonServiceable.add("799999");
    const unserviceable = await shop.ship(admin.headers, far.orderId);
    assert.equal(unserviceable.statusCode, 409);
    assert.equal(unserviceable.json().error.code, "PINCODE_NOT_SERVICEABLE");
    assert.equal(fake.creates(), 2, "no create call for an unserviceable PIN");
  }));

test("orders of Rs. 50,000 or more need an e-waybill", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const admin = await shop.admin();
    const { orderId } = await shop.order({ price: "52000.00" });
    const refused = await shop.ship(admin.headers, orderId);
    assert.equal(refused.json().error.code, "EWAYBILL_REQUIRED");
    assert.equal(fake.calls.length, 0);
    assert.equal((await shop.ship(admin.headers, orderId, { ewaybill: "123456789012" })).statusCode, 200);
    const sent = JSON.parse(new URLSearchParams(fake.calls.find((call) => call.path === "/api/cmu/create.json")!.body).get("data")!);
    assert.equal(sent.shipments[0].ewbn, "123456789012");
  }));

// ---- tracking and emails -------------------------------------------------------------------------------------------

test("tracking: pickup marks the order shipped and emails once; delivery completes it and emails once; scans are stored once", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const { orderId, buyer } = await shop.order();
    await shop.ship(admin.headers, orderId);
    const awb = [...fake.shipments.keys()][0];
    const sync = () => app.inject({ method: "POST", url: `/api/v1/admin/orders/${orderId}/shipment/sync`, headers: admin.headers });

    // Still only manifested: nothing changes, nothing is sent.
    assert.equal((await sync()).statusCode, 200);
    assert.equal((await emailsFor(app, orderId)).length, 0);
    assert.equal((await app.prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId } })).status, "PROCESSING");

    fake.scan(awb, "UD", "In Transit", "2026-10-20T18:30:00");
    await sync();
    await sync();
    const shipped = await app.prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(shipped.status, "SHIPPED");
    assert.equal(shipped.shippedAt!.toISOString(), "2026-10-20T13:00:00.000Z", "the courier's pickup scan time (IST)");
    let rows = await emailsFor(app, orderId);
    assert.deepEqual(rows.map((row) => [row.kind, row.eventKey, row.status]), [["ORDER_SHIPPED", `order:${orderId}:shipped`, "SENT"]]);
    const shippedMail = outbox.find((message) => message.subject.includes("has shipped"))!;
    assert.equal(shippedMail.to, buyer.user.email);
    assert.ok(shippedMail.html.includes(awb) && shippedMail.text.includes(`/account/orders/${orderId}/`));

    fake.scan(awb, "UD", "Dispatched", "2026-10-22T08:00:00");
    fake.scan(awb, "DL", "Delivered", "2026-10-22T13:45:00");
    await sync();
    await sync();
    const delivered = await app.prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(delivered.status, "COMPLETED");
    const shipment = await shipmentOf(app, orderId);
    assert.deepEqual([shipment.status, shipment.providerStatus, shipment.deliveredAt!.toISOString()], ["DELIVERED", "Delivered", "2026-10-22T08:15:00.000Z"]);
    assert.equal(shipment.events.length, 4, "each scan once, however often it is read");
    rows = await emailsFor(app, orderId);
    assert.deepEqual(rows.map((row) => [row.kind, row.status]), [["ORDER_SHIPPED", "SENT"], ["ORDER_DELIVERED", "SENT"]]);
    assert.equal(outbox.filter((message) => message.subject.includes("delivered")).length, 1);

    // After delivery nothing Delhivery reports changes the shipment back.
    fake.scan(awb, "UD", "In Transit", "2026-10-23T08:00:00");
    await sync();
    assert.equal((await shipmentOf(app, orderId)).status, "DELIVERED");
    assert.equal((await emailsFor(app, orderId)).length, 2);

    // The tracking worker's pass picks up nothing more for a delivered shipment.
    const { createShipmentService } = await import("../../src/services/shipment.service.js");
    const before = fake.calls.length;
    await createShipmentService(app.prisma).syncDue();
    assert.ok(!fake.calls.slice(before).some((call) => call.params.get("waybill")?.split(",").includes(awb)), "final shipments are not polled");
  }));

test("webhook: refused without the secret; with it, the body is only a hint and Delhivery's own tracking decides", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const { orderId } = await shop.order();
    await shop.ship(admin.headers, orderId);
    const awb = [...fake.shipments.keys()][0];
    const forged = { Shipment: { AWB: awb, Status: { Status: "Delivered", StatusType: "DL", StatusDateTime: "2026-10-20T12:00:00" } } };

    for (const authorization of [null, "", "Bearer wrong-secret-wrong-secret-wrong-secret", `Token ${WEBHOOK_SECRET}`, WEBHOOK_SECRET]) {
      const refused = await shop.webhook(forged, authorization);
      assert.equal(refused.statusCode, 401, String(authorization));
    }
    assert.equal(fake.calls.filter((call) => call.path === "/api/v1/packages/json/").length, 0, "a refused push reads nothing");

    // Authenticated, but Delhivery says the package is only manifested: the forged "Delivered" changes nothing.
    const accepted = await shop.webhook(forged);
    assert.equal(accepted.statusCode, 200, accepted.body);
    let shipment = await shipmentOf(app, orderId);
    assert.deepEqual([shipment.status, shipment.deliveredAt], ["MANIFESTED", null]);
    assert.equal((await app.prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId } })).status, "PROCESSING");
    assert.equal((await emailsFor(app, orderId)).length, 0);

    // A real scan, pushed several times (Delhivery retries): one state change, one email.
    fake.scan(awb, "UD", "In Transit", "2026-10-20T18:30:00");
    for (let push = 0; push < 3; push++) {
      await app.prisma.shipment.update({ where: { orderId }, data: { lastSyncedAt: null } });
      assert.equal((await shop.webhook({ Shipment: { AWB: awb, Status: { Status: "In Transit", StatusType: "UD" } } })).statusCode, 200);
    }
    shipment = await shipmentOf(app, orderId);
    assert.equal(shipment.status, "IN_TRANSIT");
    assert.equal((await emailsFor(app, orderId)).length, 1);
    assert.equal(outbox.filter((message) => message.subject.includes("has shipped")).length, 1);

    // Pushes in quick succession are not each re-read; unknown or malformed AWBs are ignored.
    const reads = fake.calls.length;
    await shop.webhook({ Shipment: { AWB: awb } });
    assert.equal(fake.calls.length, reads, "read less than 10 seconds ago");
    for (const body of [{ Shipment: { AWB: "0000000000000" } }, { Shipment: {} }, { nonsense: true }]) assert.equal((await shop.webhook(body)).statusCode, 200);
    assert.equal(fake.calls.length, reads);
  }));

// ---- what customers see --------------------------------------------------------------------------------------------

test("customers see their own shipment's courier, AWB and timeline, nothing internal, and nobody else's", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const { orderId, buyer } = await shop.order({ label: "owner" });
    const intruder = await shop.customer("intruder");

    const before = (await app.inject({ method: "GET", url: `/api/v1/orders/${orderId}`, headers: buyer.headers })).json().data;
    assert.equal(before.shipment, null, "no shipment yet");

    fake.createMode = "reject";
    await shop.ship(admin.headers, orderId);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${orderId}`, headers: buyer.headers })).json().data.shipment, null, "a failed attempt is not shown");
    fake.createMode = "ok";
    await shop.ship(admin.headers, orderId);
    const awb = [...fake.shipments.keys()][0];
    fake.scan(awb, "UD", "In Transit", "2026-10-20T18:30:00");
    await app.inject({ method: "POST", url: `/api/v1/admin/orders/${orderId}/shipment/sync`, headers: admin.headers });

    const mine = (await app.inject({ method: "GET", url: `/api/v1/orders/${orderId}`, headers: buyer.headers })).json().data;
    assert.deepEqual(Object.keys(mine.shipment).sort(), ["cancelledAt", "courier", "courierStatus", "courierStatusAt", "courierStatusLocation", "deliveredAt", "events", "lastCheckedAt", "pickedUpAt", "status", "trackingNumber", "trackingUrl"]);
    assert.deepEqual([mine.shipment.courier, mine.shipment.trackingNumber, mine.shipment.status, mine.shipment.trackingUrl], ["Delhivery", awb, "IN_TRANSIT", null]);
    assert.deepEqual(mine.shipment.events.map((event: any) => event.status), ["In Transit", "Manifested"], "newest first");
    const list = (await app.inject({ method: "GET", url: "/api/v1/orders", headers: buyer.headers })).json().data;
    assert.equal(list[0].shipment.trackingNumber, awb);

    assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${orderId}`, headers: intruder.headers })).statusCode, 404);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/v1/orders", headers: intruder.headers })).json().data, []);
    for (const url of [`/api/v1/admin/orders/${orderId}/shipment/sync`, `/api/v1/admin/orders/${orderId}/shipment/cancel`]) {
      assert.equal((await app.inject({ method: "POST", url, headers: buyer.headers })).statusCode, 403, url);
    }
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/shipping/serviceability?pin=560001", headers: buyer.headers })).statusCode, 403);
    // No customer route can set a shipment status.
    for (const [method, url] of [["PATCH", `/api/v1/orders/${orderId}`], ["POST", `/api/v1/orders/${orderId}/delivered`], ["POST", `/api/v1/orders/${orderId}/shipment`]] as const) {
      assert.equal((await app.inject({ method, url, headers: buyer.headers, payload: { status: "DELIVERED" } })).statusCode, 404, url);
    }
    assert.equal((await shipmentOf(app, orderId)).status, "IN_TRANSIT");

    // Admins see the internals.
    const adminView = (await app.inject({ method: "GET", url: `/api/v1/admin/orders/${orderId}`, headers: admin.headers })).json().data;
    assert.equal(adminView.shipment.attempts, 2);
  }));

test("a courier-managed order cannot be marked shipped by hand, and a manually shipped one cannot get a courier shipment", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const courier = await shop.order({ label: "courier" });
    await shop.ship(admin.headers, courier.orderId);
    const manual = await app.inject({ method: "POST", url: `/api/v1/admin/orders/${courier.orderId}/ship`, headers: admin.headers, payload: { carrier: "Blue Dart", trackingNumber: "BD1" } });
    assert.equal(manual.statusCode, 409);
    assert.equal(manual.json().error.code, "SHIPMENT_MANAGED_BY_COURIER");

    const byHand = await shop.order({ label: "byhand" });
    assert.equal((await app.inject({ method: "POST", url: `/api/v1/admin/orders/${byHand.orderId}/ship`, headers: admin.headers, payload: { carrier: "Blue Dart", trackingNumber: "BD2" } })).statusCode, 200);
    const refused = await shop.ship(admin.headers, byHand.orderId);
    assert.equal(refused.statusCode, 409);
    assert.equal(fake.creates(), 1);
  }));

test("cancelling before pickup calls Delhivery's cancel API and sends nothing; after pickup it is refused", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const { orderId } = await shop.order();
    await shop.ship(admin.headers, orderId);
    const awb = [...fake.shipments.keys()][0];
    const cancel = () => app.inject({ method: "POST", url: `/api/v1/admin/orders/${orderId}/shipment/cancel`, headers: admin.headers });
    assert.equal((await cancel()).statusCode, 200);
    assert.equal((await shipmentOf(app, orderId)).status, "CANCELLED");
    assert.deepEqual(JSON.parse(fake.calls.find((call) => call.path === "/api/p/edit")!.body!), { waybill: awb, cancellation: "true" });
    assert.equal((await cancel()).statusCode, 200, "repeat is a no-op");
    assert.equal(fake.calls.filter((call) => call.path === "/api/p/edit").length, 1);
    assert.equal((await emailsFor(app, orderId)).length, 0);

    const other = await shop.order({ label: "picked" });
    await shop.ship(admin.headers, other.orderId);
    const otherAwb = [...fake.shipments.keys()][1];
    fake.scan(otherAwb, "UD", "In Transit", "2026-10-20T18:30:00");
    await app.inject({ method: "POST", url: `/api/v1/admin/orders/${other.orderId}/shipment/sync`, headers: admin.headers });
    const refused = await app.inject({ method: "POST", url: `/api/v1/admin/orders/${other.orderId}/shipment/cancel`, headers: admin.headers });
    assert.equal(refused.json().error.code, "SHIPMENT_NOT_CANCELLABLE");
  }));
