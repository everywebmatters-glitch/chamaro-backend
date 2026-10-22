// Delhivery configuration, API client, status mapping and webhook authentication. Every request goes to a fake
// fetch: nothing here reaches Delhivery, and no token used here is real.
import test from "node:test";
import assert from "node:assert/strict";
import { readDelhiveryConfig, readWebhookSecret, type DelhiveryConfig } from "../../src/config/delhivery.js";
import { buildCreatePayload, createDelhiveryClient, delhiveryPhone, DelhiveryError, setDelhiveryFetchForTests, type FetchLike, type ShipmentRequest } from "../../src/providers/delhivery.provider.js";
import { mapDelhiveryStatus, parseDelhiveryTime, scanEventKey } from "../../src/shared/delhivery-status.js";
import { webhookAuthorized, webhookWaybill } from "../../src/services/shipment.service.js";

const TOKEN = "testtoken0123456789abcdef";
const STAGING = "https://staging-express.delhivery.com";
const validEnv = { DELHIVERY_ENABLED: "true", DELHIVERY_API_TOKEN: TOKEN, DELHIVERY_API_BASE_URL: STAGING, DELHIVERY_PICKUP_LOCATION: "Chamaro Warehouse", APP_ENV: "development" };
const env = (over: Record<string, string | undefined> = {}) => ({ ...validEnv, ...over }) as NodeJS.ProcessEnv;

// ---- configuration -------------------------------------------------------------------------------------------------

test("config: shipping is off unless DELHIVERY_ENABLED=true", () => {
  for (const value of [undefined, "", "false", "1", "TRUE "]) {
    assert.throws(() => readDelhiveryConfig(env({ DELHIVERY_ENABLED: value })), (error: any) => error.code === "SHIPPING_DISABLED" && error.statusCode === 503, String(value));
  }
});

test("config: a complete staging setup is accepted", () => {
  const config = readDelhiveryConfig(env({ DELHIVERY_API_BASE_URL: `${STAGING}/`, DELHIVERY_SELLER_GST_TIN: "29ABCDE1234F1Z5", DELHIVERY_HSN_CODE: "9401" }));
  assert.deepEqual(config, { environment: "staging", baseUrl: STAGING, token: TOKEN, pickupLocation: "Chamaro Warehouse", sellerGstTin: "29ABCDE1234F1Z5", hsnCode: "9401", timeoutMs: 15_000 });
});

test("config: missing or invalid values are refused, naming the variable and never echoing a value", () => {
  const cases: [Record<string, string | undefined>, RegExp][] = [
    [{ DELHIVERY_API_TOKEN: undefined }, /DELHIVERY_API_TOKEN is not set/],
    [{ DELHIVERY_API_TOKEN: "short" }, /DELHIVERY_API_TOKEN is not a valid/],
    [{ DELHIVERY_API_TOKEN: "replace-with-your-token" }, /DELHIVERY_API_TOKEN is not a valid/],
    [{ DELHIVERY_API_TOKEN: "abc def ghi jkl mno" }, /DELHIVERY_API_TOKEN is not a valid/],
    [{ DELHIVERY_API_BASE_URL: undefined }, /DELHIVERY_API_BASE_URL is not set/],
    [{ DELHIVERY_API_BASE_URL: "https://evil.example.com" }, /DELHIVERY_API_BASE_URL must be/],
    [{ DELHIVERY_API_BASE_URL: "http://staging-express.delhivery.com" }, /DELHIVERY_API_BASE_URL must be/],
    [{ DELHIVERY_PICKUP_LOCATION: "  " }, /DELHIVERY_PICKUP_LOCATION is not set/],
    [{ DELHIVERY_SELLER_GST_TIN: "123" }, /DELHIVERY_SELLER_GST_TIN/],
    [{ DELHIVERY_HSN_CODE: "chairs" }, /DELHIVERY_HSN_CODE/],
    [{ DELHIVERY_TIMEOUT_MS: "100" }, /DELHIVERY_TIMEOUT_MS/],
  ];
  for (const [over, message] of cases) {
    assert.throws(() => readDelhiveryConfig(env(over)), (error: any) => error.code === "DELHIVERY_NOT_CONFIGURED" && message.test(error.message) && !error.message.includes(TOKEN), JSON.stringify(over));
  }
});

test("config: Delhivery production is refused outside APP_ENV=production, and staging inside it", () => {
  assert.throws(() => readDelhiveryConfig(env({ DELHIVERY_API_BASE_URL: "https://track.delhivery.com" })), /only APP_ENV=production may use it/);
  assert.throws(() => readDelhiveryConfig(env({ DELHIVERY_API_BASE_URL: "https://track.delhivery.com", APP_ENV: "staging" })), /only APP_ENV=production may use it/);
  assert.throws(() => readDelhiveryConfig(env({ APP_ENV: "production" })), /staging while APP_ENV=production/);
  // Delhivery's order-creation reference lists seller_gst_tin and hsn_code as mandatory: production needs both.
  const prod = { DELHIVERY_API_BASE_URL: "https://track.delhivery.com", APP_ENV: "production" };
  assert.throws(() => readDelhiveryConfig(env(prod)), /DELHIVERY_SELLER_GST_TIN and DELHIVERY_HSN_CODE are required/);
  assert.throws(() => readDelhiveryConfig(env({ ...prod, DELHIVERY_SELLER_GST_TIN: "29ABCDE1234F1Z5" })), /are required/);
  assert.throws(() => readDelhiveryConfig(env({ ...prod, DELHIVERY_HSN_CODE: "9401" })), /are required/);
  assert.equal(readDelhiveryConfig(env({ ...prod, DELHIVERY_SELLER_GST_TIN: "29ABCDE1234F1Z5", DELHIVERY_HSN_CODE: "9401" })).environment, "production");
});

test("config: the webhook secret must be set, long and not a placeholder", () => {
  assert.throws(() => readWebhookSecret(env({ DELHIVERY_WEBHOOK_SECRET: "Q8v2LmZr4TnW7pXy1sDfH6jK9bNc3VgA" })), { code: "SCAN_PUSH_DISABLED" }, "off unless DELHIVERY_SCAN_PUSH_ENABLED=true");
  assert.throws(() => readWebhookSecret(env({ DELHIVERY_SCAN_PUSH_ENABLED: "true" })), /DELHIVERY_WEBHOOK_SECRET is not set/);
  assert.throws(() => readWebhookSecret(env({ DELHIVERY_SCAN_PUSH_ENABLED: "true", DELHIVERY_WEBHOOK_SECRET: "too-short" })), /at least 32/);
  assert.throws(() => readWebhookSecret(env({ DELHIVERY_SCAN_PUSH_ENABLED: "true", DELHIVERY_WEBHOOK_SECRET: "replace-with-a-long-random-webhook-secret" })), /at least 32/);
  assert.throws(() => readWebhookSecret(env({ DELHIVERY_ENABLED: "false", DELHIVERY_WEBHOOK_SECRET: "k".repeat(10) + "Q8v2LmZr4TnW7pXy1sDf" })), { code: "SHIPPING_DISABLED" });
  assert.equal(readWebhookSecret(env({ DELHIVERY_SCAN_PUSH_ENABLED: "true", DELHIVERY_WEBHOOK_SECRET: "Q8v2LmZr4TnW7pXy1sDfH6jK9bNc3VgA" })).length, 32);
});

// ---- client --------------------------------------------------------------------------------------------------------

type Call = { url: URL; method: string; headers: Record<string, string>; body?: string };
function fakeDelhivery(reply: (call: Call) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }> | "throw") {
  const calls: Call[] = [];
  const fake: FetchLike = async (url, init) => {
    const call = { url: new URL(url), method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const answer = await reply(call);
    if (answer === "throw") throw new TypeError("fetch failed");
    return { status: answer.status, text: async () => (typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)) };
  };
  setDelhiveryFetchForTests(fake);
  return calls;
}

const config: DelhiveryConfig = { environment: "staging", baseUrl: STAGING, token: TOKEN, pickupLocation: "Chamaro Warehouse", sellerGstTin: null, hsnCode: null, timeoutMs: 5_000 };
const client = createDelhiveryClient(config);
const request: ShipmentRequest = {
  orderRef: "cmorder0001",
  orderDate: new Date("2026-10-18T10:00:00Z"),
  consignee: { name: "Asha Rao", phone: "+91 98765 43210", address: "12 MG Road #4, Lane & Co; Block %B", city: "Bengaluru", state: "Karnataka", pin: "560001" },
  productsDescription: "Lounge Chair (Walnut) x 1",
  quantity: 1,
  totalAmount: "24000.00",
  shippingMode: "Surface",
  weightGrams: 12000,
  dimensionsCm: { length: 80, width: 70, height: 90 },
};

test("create: sends format=json&data=<JSON> with the token header to the configured host only, and returns the AWB", async () => {
  const calls = fakeDelhivery(() => ({ status: 200, body: { success: true, upload_wbn: "UPL123", packages: [{ status: "Success", waybill: "1234567890123", refnum: "cmorder0001", remarks: [] }] } }));
  const created = await client.createShipment(request);
  assert.deepEqual(created, { waybill: "1234567890123", refnum: "cmorder0001", uploadWbn: "UPL123" });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url.origin, STAGING);
  assert.equal(call.url.pathname, "/api/cmu/create.json");
  assert.equal(call.url.search, "", "nothing secret in the URL");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.Authorization, `Token ${TOKEN}`);
  assert.equal(call.headers["Content-Type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(call.body);
  assert.equal(form.get("format"), "json");
  const data = JSON.parse(form.get("data")!);
  assert.deepEqual(data.pickup_location, { name: "Chamaro Warehouse" });
  const [shipment] = data.shipments;
  assert.equal(shipment.order, "cmorder0001");
  assert.equal(shipment.payment_mode, "Prepaid");
  assert.equal(shipment.phone, "9876543210");
  assert.equal(shipment.pin, "560001");
  assert.equal(shipment.add, "12 MG Road #4, Lane & Co; Block %B", "special characters survive (the form encoding carries them)");
  assert.equal(shipment.order_date, "2026-10-18 15:30:00", "Indian time");
  assert.deepEqual([shipment.weight, shipment.shipment_length, shipment.shipment_width, shipment.shipment_height], ["12000", 80, 70, 90]);
  assert.equal("waybill" in shipment, false, "Delhivery assigns the AWB");
  assert.equal("cod_amount" in shipment, false, "prepaid only");
  setDelhiveryFetchForTests(undefined);
});

test("create: failures are classified and never carry the token or the response body", async () => {
  const cases: [{ status: number; body: unknown } | "throw", string, string][] = [
    [{ status: 401, body: "You couldn't be authenticated" }, "DELHIVERY_AUTH_FAILED", "not_created"],
    [{ status: 403, body: { detail: "forbidden" } }, "DELHIVERY_AUTH_FAILED", "not_created"],
    [{ status: 200, body: { success: false, error: true, rmk: "ClientWarehouse matching query does not exist.", packages: [] } }, "DELHIVERY_REJECTED", "not_created"],
    [{ status: 200, body: { success: false, packages: [{ status: "Fail", waybill: "", refnum: "cmorder0001", remarks: ["COD amount missing for COD/Cash package"] }] } }, "DELHIVERY_REJECTED", "not_created"],
    [{ status: 200, body: { success: false, packages: [{ status: "Fail", waybill: "", refnum: "cmorder0001", remarks: "Duplicate order id" }] } }, "DELHIVERY_DUPLICATE_ORDER", "not_created"],
    [{ status: 400, body: { error: "format key missing in the post" } }, "DELHIVERY_REJECTED", "not_created"],
    [{ status: 500, body: "<html>oops</html>" }, "DELHIVERY_UNAVAILABLE", "unknown"],
    [{ status: 502, body: "" }, "DELHIVERY_UNAVAILABLE", "unknown"],
    [{ status: 200, body: "not json" }, "DELHIVERY_BAD_RESPONSE", "unknown"],
    [{ status: 200, body: { success: true, packages: [] } }, "DELHIVERY_BAD_RESPONSE", "unknown"],
    ["throw", "DELHIVERY_UNAVAILABLE", "unknown"],
  ];
  for (const [answer, code, outcome] of cases) {
    fakeDelhivery(() => answer);
    await assert.rejects(client.createShipment(request), (error: unknown) => {
      assert.ok(error instanceof DelhiveryError, code);
      assert.deepEqual([error.code, error.outcome, error.statusCode], [code, outcome, 502], JSON.stringify(answer));
      const exposed = `${error.message} ${error.remark ?? ""} ${JSON.stringify(error)}`;
      assert.ok(!exposed.includes(TOKEN), "no token");
      assert.ok(!exposed.includes("<html>"), "no raw body");
      return true;
    });
  }
  setDelhiveryFetchForTests(undefined);
});

test("create: remarks are kept short and free of markup", async () => {
  fakeDelhivery(() => ({ status: 200, body: { success: false, rmk: `<script>x</script>${"a".repeat(400)}`, packages: [] } }));
  await assert.rejects(client.createShipment(request), (error: DelhiveryError) => error.remark !== null && error.remark.length <= 250 && !/[<>]/.test(error.remark));
  setDelhiveryFetchForTests(undefined);
});

test("create payload: optional GST/HSN/e-waybill are sent only when configured", () => {
  const payload = buildCreatePayload({ pickupLocation: "W", sellerGstTin: "29ABCDE1234F1Z5", hsnCode: "9401" }, { ...request, ewaybill: "123456789012", weightGrams: undefined, dimensionsCm: undefined });
  const [shipment] = payload.shipments as Record<string, unknown>[];
  assert.deepEqual([shipment.seller_gst_tin, shipment.hsn_code, shipment.ewbn, "weight" in shipment, "shipment_length" in shipment], ["29ABCDE1234F1Z5", "9401", "123456789012", false, false]);
  assert.equal(delhiveryPhone("098765 43210"), "9876543210");
  assert.equal(delhiveryPhone("9876543210"), "9876543210");
});

test("track: parses the documented response, by waybill (max 30) or by order reference", async () => {
  const calls = fakeDelhivery(() => ({
    status: 200,
    body: {
      ShipmentData: [
        {
          Shipment: {
            AWB: "1234567890123",
            ReferenceNo: "cmorder0001",
            Status: { Status: "In Transit", StatusType: "UD", StatusDateTime: "2026-10-19T09:15:00", StatusLocation: "Bengaluru_Hub (Karnataka)", Instructions: "Shipment picked up" },
            Scans: [
              { ScanDetail: { Scan: "Manifested", ScanType: "UD", ScanDateTime: "2026-10-18T16:00:00.123", ScannedLocation: "Bengaluru_Hub (Karnataka)", Instructions: "Manifest uploaded" } },
              { ScanDetail: { Scan: "In Transit", ScanType: "UD", ScanDateTime: "2026-10-19T09:15:00", ScannedLocation: "Bengaluru_Hub (Karnataka)", Instructions: "Shipment picked up" } },
              { ScanDetail: { ScanType: "UD" } },
              "junk",
            ],
          },
        },
        { Shipment: { Status: { Status: "Delivered" } } },
      ],
    },
  }));
  const tracked = await client.track({ waybills: Array.from({ length: 35 }, (_, i) => `AWB${i}`) });
  assert.equal(calls[0].url.pathname, "/api/v1/packages/json/");
  assert.equal(calls[0].url.searchParams.get("waybill")!.split(",").length, 30);
  assert.equal(calls[0].url.searchParams.has("token"), false, "the token is a header, not a query parameter");
  assert.equal(calls[0].headers.Authorization, `Token ${TOKEN}`);
  assert.equal(tracked.length, 1, "an entry without an AWB is dropped");
  assert.deepEqual(tracked[0].status, { status: "In Transit", type: "UD", at: "2026-10-19T09:15:00", location: "Bengaluru_Hub (Karnataka)", instructions: "Shipment picked up" });
  assert.equal(tracked[0].scans.length, 2, "malformed scans are dropped");

  await client.track({ orderRef: "cmorder0001" });
  assert.equal(calls[1].url.searchParams.get("ref_ids"), "cmorder0001");

  fakeDelhivery(() => ({ status: 200, body: { Error: "parameter ref_ids/ref_nos or waybill is required" } }));
  assert.deepEqual(await client.track({ waybills: ["X"] }), [], "an Error answer means nothing is known");
  fakeDelhivery(() => "throw");
  await assert.rejects(client.track({ waybills: ["X"] }), { code: "DELHIVERY_UNAVAILABLE", outcome: "not_created" });
  setDelhiveryFetchForTests(undefined);
});

test("pincode, pickup and cancel calls", async () => {
  const calls = fakeDelhivery((call) => {
    if (call.url.pathname === "/c/api/pin-codes/json/") return { status: 200, body: call.url.searchParams.get("filter_codes") === "560001" ? { delivery_codes: [{ postal_code: { pin: 560001, pre_paid: "Y", cod: "Y", pickup: "Y", is_oda: "N", district: "Bangalore", state_code: "KA" } }] } : { delivery_codes: [] } };
    if (call.url.pathname === "/fm/request/new/") return JSON.parse(call.body!).pickup_date === "2026-10-21" ? { status: 201, body: { pickup_id: 4323300, pickup_date: "2026-10-21", pickup_time: "11:00:00", incoming_center_name: "Bengaluru_DC", expected_package_count: 2 } } : { status: 401, body: { pickup_location: "Invalid Pickup Location ClientWarehouse matching query does not exist." } };
    if (call.url.pathname === "/api/p/edit") return { status: 200, body: JSON.parse(call.body!).waybill === "OK1" ? { status: true, waybill: "OK1", remark: "Shipment has been cancelled" } : { status: false, remark: "Not allowed" } };
    return { status: 404, body: {} };
  });
  assert.deepEqual(await client.checkPincode("560001"), { pin: "560001", serviceable: true, prepaid: true, cod: true, pickup: true, oda: false, district: "Bangalore", stateCode: "KA" });
  assert.equal((await client.checkPincode("999999")).serviceable, false);

  const pickup = await client.requestPickup({ pickupDate: "2026-10-21", pickupTime: "11:00:00", expectedPackageCount: 2 });
  assert.equal(pickup.pickupId, "4323300");
  const pickupCall = calls.find((call) => call.url.pathname === "/fm/request/new/")!;
  assert.deepEqual(JSON.parse(pickupCall.body!), { pickup_time: "11:00:00", pickup_date: "2026-10-21", pickup_location: "Chamaro Warehouse", expected_package_count: 2 });
  assert.equal(pickupCall.headers["Content-Type"], "application/json");
  await assert.rejects(client.requestPickup({ pickupDate: "2026-10-22", pickupTime: "11:00:00", expectedPackageCount: 1 }), { code: "DELHIVERY_AUTH_FAILED" });

  assert.deepEqual(await client.cancelShipment("OK1"), { remark: "Shipment has been cancelled" });
  assert.deepEqual(JSON.parse(calls.at(-1)!.body!), { waybill: "OK1", cancellation: "true" });
  await assert.rejects(client.cancelShipment("NO"), { code: "DELHIVERY_REJECTED", remark: "Not allowed" });
  setDelhiveryFetchForTests(undefined);
});

// ---- status mapping ------------------------------------------------------------------------------------------------

test("status mapping follows Delhivery's documented forward/return table; anything else is left unmapped", () => {
  const cases: [string | null, string | null, string | null][] = [
    ["UD", "Manifested", "MANIFESTED"],
    ["UD", "Not Picked", "MANIFESTED"],
    ["UD", "In Transit", "IN_TRANSIT"],
    ["UD", "In Transit", "IN_TRANSIT"],
    ["UD", "Pending", "IN_TRANSIT"],
    ["UD", "Dispatched", "OUT_FOR_DELIVERY"],
    ["DL", "Delivered", "DELIVERED"],
    ["DL", "RTO", "RETURNED"],
    ["RT", "In Transit", "RETURN_IN_TRANSIT"],
    ["RT", "Dispatched", "RETURN_IN_TRANSIT"],
    ["CN", "Canceled", "CANCELLED"],
    [null, "Cancelled", "CANCELLED"],
    ["UD", "Lost", null],
    ["XX", "Delivered", null],
    [null, "Delivered", null],
    ["", "", null],
  ];
  for (const [type, status, expected] of cases) assert.equal(mapDelhiveryStatus(type, status), expected, `${type}/${status}`);
});

test("Delhivery times are read as Indian time; malformed times are refused", () => {
  assert.equal(parseDelhiveryTime("2019-01-09T17:10:42.767")!.toISOString(), "2019-01-09T11:40:42.767Z");
  assert.equal(parseDelhiveryTime("2013-11-11T17:13:31")!.toISOString(), "2013-11-11T11:43:31.000Z");
  assert.equal(parseDelhiveryTime("2018-10-18T10:44:25.328000")!.toISOString(), "2018-10-18T05:14:25.328Z");
  assert.equal(parseDelhiveryTime("2026-10-19T09:15:00Z")!.toISOString(), "2026-10-19T09:15:00.000Z");
  for (const bad of [null, "", "yesterday", "2026-13-45T99:00:00", 1700000000]) assert.equal(parseDelhiveryTime(bad), null, String(bad));
});

test("scan keys are stable for the same scan and differ for different scans", () => {
  const scan = { at: "2026-10-19T09:15:00", type: "UD", status: "In Transit", location: "Hub", instructions: "Picked" };
  assert.equal(scanEventKey("AWB1", scan), scanEventKey("AWB1", { ...scan }));
  assert.notEqual(scanEventKey("AWB1", scan), scanEventKey("AWB2", scan));
  assert.notEqual(scanEventKey("AWB1", scan), scanEventKey("AWB1", { ...scan, at: "2026-10-19T09:16:00" }));
  assert.match(scanEventKey("AWB1", scan), /^[0-9a-f]{64}$/);
});

// ---- webhook -------------------------------------------------------------------------------------------------------

test("webhook: only the exact bearer secret is accepted; the AWB is the only field read", () => {
  const secret = "Q8v2LmZr4TnW7pXy1sDfH6jK9bNc3VgA";
  assert.equal(webhookAuthorized(`Bearer ${secret}`, secret), true);
  assert.equal(webhookAuthorized(`bearer  ${secret}`, secret), true);
  for (const header of [undefined, "", secret, `Token ${secret}`, `Bearer ${secret}x`, `Bearer ${secret.slice(1)}`, `Bearer ${secret} extra`, ["Bearer", secret]]) {
    assert.equal(webhookAuthorized(header, secret), false, String(header));
  }
  assert.equal(webhookWaybill({ Shipment: { AWB: "1234567890123", Status: { Status: "Delivered" } } }), "1234567890123");
  for (const body of [null, {}, { Shipment: {} }, { Shipment: { AWB: 123 } }, { Shipment: { AWB: "a'; DROP TABLE" } }, { AWB: "1234567890123" }]) assert.equal(webhookWaybill(body), null, JSON.stringify(body));
});
