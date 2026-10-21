import type { DelhiveryConfig } from "../config/delhivery.js";

// Delhivery last-mile ("Express") API client: the five operations Chamaro uses, as documented at
// https://delhivery-express-api-doc.readme.io (staging https://staging-express.delhivery.com, production
// https://track.delhivery.com; every call authenticates with the header "Authorization: Token <token>").
//
//   pincode serviceability  GET  /c/api/pin-codes/json/?filter_codes=<pin>
//   create shipment         POST /api/cmu/create.json          body format=json&data=<JSON>
//   track                   GET  /api/v1/packages/json/?waybill=<awb,...>  or  ?ref_ids=<order id>   (max 30)
//   pickup request          POST /fm/request/new/              JSON
//   cancel                  POST /api/p/edit                   JSON {"waybill", "cancellation": "true"}
//
// Errors are DelhiveryError: a fixed code, the HTTP status, and whether Delhivery may have acted on the request
// (`outcome`). Neither the token nor a response body is ever put in an error or a log line; at most Delhivery's
// short remark (e.g. "Duplicate order id") is kept, cleaned and truncated, for the admin.

export type DelhiveryErrorCode =
  | "DELHIVERY_AUTH_FAILED"
  | "DELHIVERY_REJECTED"
  | "DELHIVERY_DUPLICATE_ORDER"
  | "DELHIVERY_UNAVAILABLE"
  | "DELHIVERY_BAD_RESPONSE";

// not_created: Delhivery certainly did not act (auth failure, validation). unknown: it may have (timeout, 5xx, a reply
// that could not be read), so a retry must first look the order up instead of creating again.
export type DelhiveryOutcome = "not_created" | "unknown";

const MESSAGES: Record<DelhiveryErrorCode, string> = {
  DELHIVERY_AUTH_FAILED: "Delhivery refused the API credentials",
  DELHIVERY_REJECTED: "Delhivery rejected the request",
  DELHIVERY_DUPLICATE_ORDER: "Delhivery already has a shipment for this order",
  DELHIVERY_UNAVAILABLE: "Delhivery could not be reached or did not answer in time",
  DELHIVERY_BAD_RESPONSE: "Delhivery returned a response that could not be read",
};

export class DelhiveryError extends Error {
  readonly statusCode = 502;
  readonly expose = true;
  constructor(
    readonly code: DelhiveryErrorCode,
    readonly httpStatus: number | null,
    readonly outcome: DelhiveryOutcome,
    readonly remark: string | null = null,
  ) {
    super(MESSAGES[code]);
    this.name = "DelhiveryError";
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: "error" }) => Promise<{ status: number; text(): Promise<string> }>;

let fetchForTests: FetchLike | undefined;
// Tests only: every Delhivery request goes to this function instead of the network (undefined restores fetch).
export function setDelhiveryFetchForTests(fake: FetchLike | undefined): void {
  fetchForTests = fake;
}

// Free text from Delhivery, reduced to something safe to store and show to an admin.
export function cleanRemark(value: unknown): string | null {
  const text = Array.isArray(value) ? value.filter((part) => typeof part === "string").join("; ") : typeof value === "string" ? value : "";
  const cleaned = text.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 250) : null;
}

const MAX_RESPONSE_CHARS = 2_000_000;

// ---- request and response shapes -----------------------------------------------------------------------------------

export type ShipmentRequest = {
  orderRef: string;
  orderDate: Date;
  consignee: { name: string; phone: string; address: string; city: string; state: string; pin: string };
  productsDescription: string;
  quantity: number;
  totalAmount: string;
  shippingMode: "Surface" | "Express";
  weightGrams?: number;
  dimensionsCm?: { length: number; width: number; height: number };
  ewaybill?: string;
};

export type CreatedShipment = { waybill: string; refnum: string | null; uploadWbn: string | null };

export type TrackedScan = { at: string; type: string | null; status: string; location: string | null; instructions: string | null };
export type TrackedShipment = {
  waybill: string;
  referenceNo: string | null;
  status: { status: string; type: string | null; at: string | null; location: string | null; instructions: string | null } | null;
  scans: TrackedScan[];
};

export type Serviceability = { pin: string; serviceable: boolean; prepaid: boolean; cod: boolean; pickup: boolean; oda: boolean | null; district: string | null; stateCode: string | null };

export type PickupConfirmation = { pickupId: string; pickupDate: string | null; pickupTime: string | null; incomingCenter: string | null; expectedPackageCount: number | null };

// ---- helpers -------------------------------------------------------------------------------------------------------

const str = (value: unknown, max = 256): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : typeof value === "number" ? String(value) : null);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Indian mobile/landline digits as Delhivery expects them (no +91, no spaces).
export function delhiveryPhone(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
}

// "YYYY-MM-DD HH:mm:ss" in Indian time, the format of Delhivery's order_date examples.
function istTimestamp(date: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}:${parts.second}`;
}

// Delhivery documents 256 as the maximum length of every text field.
const field = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 256);

export function buildCreatePayload(config: Pick<DelhiveryConfig, "pickupLocation" | "sellerGstTin" | "hsnCode">, input: ShipmentRequest) {
  const shipment: Record<string, unknown> = {
    name: field(input.consignee.name),
    add: field(input.consignee.address),
    pin: input.consignee.pin,
    city: field(input.consignee.city),
    state: field(input.consignee.state),
    country: "India",
    phone: delhiveryPhone(input.consignee.phone),
    order: input.orderRef,
    payment_mode: "Prepaid",
    products_desc: field(input.productsDescription),
    quantity: String(input.quantity),
    total_amount: input.totalAmount,
    order_date: istTimestamp(input.orderDate),
    shipping_mode: input.shippingMode,
  };
  if (input.weightGrams) shipment.weight = String(input.weightGrams);
  if (input.dimensionsCm) {
    shipment.shipment_length = input.dimensionsCm.length;
    shipment.shipment_width = input.dimensionsCm.width;
    shipment.shipment_height = input.dimensionsCm.height;
  }
  if (input.ewaybill) shipment.ewbn = input.ewaybill;
  if (config.sellerGstTin) shipment.seller_gst_tin = config.sellerGstTin;
  if (config.hsnCode) shipment.hsn_code = config.hsnCode;
  return { shipments: [shipment], pickup_location: { name: config.pickupLocation } };
}

function parseTracked(entry: unknown): TrackedShipment | null {
  const shipment = isObject(entry) && isObject(entry.Shipment) ? entry.Shipment : null;
  const waybill = shipment ? str(shipment.AWB, 64) : null;
  if (!shipment || !waybill) return null;
  const status = isObject(shipment.Status) ? shipment.Status : null;
  const scans: TrackedScan[] = [];
  for (const item of Array.isArray(shipment.Scans) ? shipment.Scans : []) {
    const detail = isObject(item) && isObject(item.ScanDetail) ? item.ScanDetail : null;
    const scanStatus = detail ? str(detail.Scan, 64) : null;
    const at = detail ? str(detail.ScanDateTime, 40) ?? str(detail.StatusDateTime, 40) : null;
    if (!detail || !scanStatus || !at) continue;
    scans.push({ at, type: str(detail.ScanType, 16), status: scanStatus, location: str(detail.ScannedLocation, 191), instructions: str(detail.Instructions, 500) });
  }
  const statusText = status ? str(status.Status, 64) : null;
  return {
    waybill,
    referenceNo: str(shipment.ReferenceNo, 64),
    status: status && statusText ? { status: statusText, type: str(status.StatusType, 16), at: str(status.StatusDateTime, 40), location: str(status.StatusLocation, 191), instructions: str(status.Instructions, 500) } : null,
    scans,
  };
}

// ---- client --------------------------------------------------------------------------------------------------------

export function createDelhiveryClient(config: DelhiveryConfig) {
  async function call(method: "GET" | "POST", path: string, options: { query?: Record<string, string>; json?: unknown; form?: Record<string, string> } = {}) {
    const url = new URL(path, `${config.baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Authorization: `Token ${config.token}`, Accept: "application/json" };
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(options.form).toString();
    }

    let status: number;
    let text: string;
    try {
      const response = await (fetchForTests ?? (fetch as unknown as FetchLike))(url.toString(), { method, headers, body, signal: AbortSignal.timeout(config.timeoutMs), redirect: "error" });
      status = response.status;
      text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    } catch {
      // A timeout, a refused connection or a redirect: the request may or may not have reached Delhivery.
      throw new DelhiveryError("DELHIVERY_UNAVAILABLE", null, method === "GET" ? "not_created" : "unknown");
    }
    if (status === 401 || status === 403) throw new DelhiveryError("DELHIVERY_AUTH_FAILED", status, "not_created");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = undefined;
    }
    if (status >= 500) throw new DelhiveryError("DELHIVERY_UNAVAILABLE", status, method === "GET" ? "not_created" : "unknown");
    if (status >= 400) {
      const remark = isObject(parsed) ? cleanRemark(parsed.error ?? parsed.detail ?? parsed.rmk ?? parsed.pickup_location ?? parsed.Error) : null;
      throw new DelhiveryError("DELHIVERY_REJECTED", status, "not_created", remark);
    }
    if (parsed === undefined || parsed === null) throw new DelhiveryError("DELHIVERY_BAD_RESPONSE", status, method === "GET" ? "not_created" : "unknown");
    return { status, body: parsed };
  }

  return {
    environment: config.environment,

    async checkPincode(pin: string): Promise<Serviceability> {
      const { body } = await call("GET", "/c/api/pin-codes/json/", { query: { filter_codes: pin } });
      if (!isObject(body) || !Array.isArray(body.delivery_codes)) throw new DelhiveryError("DELHIVERY_BAD_RESPONSE", 200, "not_created");
      const match = body.delivery_codes
        .map((entry) => (isObject(entry) && isObject(entry.postal_code) ? entry.postal_code : null))
        .find((code) => code !== null && String(code.pin) === pin);
      if (!match) return { pin, serviceable: false, prepaid: false, cod: false, pickup: false, oda: null, district: null, stateCode: null };
      const yes = (value: unknown) => value === "Y";
      return { pin, serviceable: true, prepaid: yes(match.pre_paid), cod: yes(match.cod), pickup: yes(match.pickup), oda: match.is_oda === "Y" ? true : match.is_oda === "N" ? false : null, district: str(match.district, 120), stateCode: str(match.state_code, 8) };
    },

    // Manifests one single-piece prepaid shipment. Delhivery assigns the waybill (none is sent).
    async createShipment(input: ShipmentRequest): Promise<CreatedShipment> {
      const payload = buildCreatePayload(config, input);
      const { status, body } = await call("POST", "/api/cmu/create.json", { form: { format: "json", data: JSON.stringify(payload) } });
      if (!isObject(body)) throw new DelhiveryError("DELHIVERY_BAD_RESPONSE", status, "unknown");
      const packages = Array.isArray(body.packages) ? body.packages.filter(isObject) : [];
      const pkg = packages.find((candidate) => str(candidate.refnum, 64) === input.orderRef) ?? (packages.length === 1 ? packages[0] : undefined);
      const remark = cleanRemark(pkg?.remarks ?? body.rmk);
      if (pkg && /duplicate/i.test(remark ?? "")) throw new DelhiveryError("DELHIVERY_DUPLICATE_ORDER", status, "not_created", remark);
      const waybill = pkg ? str(pkg.waybill, 64) : null;
      if (pkg && /^success$/i.test(String(pkg.status ?? "")) && waybill) {
        return { waybill, refnum: str(pkg.refnum, 64), uploadWbn: str(body.upload_wbn, 64) };
      }
      // An explicit failure (success:false, a failed package, an error remark) means nothing was created.
      if (body.success === false || body.error === true || (pkg && /^fail/i.test(String(pkg.status ?? "")))) throw new DelhiveryError("DELHIVERY_REJECTED", status, "not_created", remark);
      throw new DelhiveryError("DELHIVERY_BAD_RESPONSE", status, "unknown", remark);
    },

    // Up to 30 waybills per call (Delhivery's limit), or one order reference.
    async track(query: { waybills: string[] } | { orderRef: string }): Promise<TrackedShipment[]> {
      const params: Record<string, string> = "waybills" in query ? { waybill: query.waybills.slice(0, 30).join(",") } : { ref_ids: query.orderRef };
      const { body } = await call("GET", "/api/v1/packages/json/", { query: params });
      if (!isObject(body)) throw new DelhiveryError("DELHIVERY_BAD_RESPONSE", 200, "not_created");
      // {"Error": "..."} (e.g. no such waybill) or no ShipmentData: nothing is known about it.
      if (!Array.isArray(body.ShipmentData)) return [];
      return body.ShipmentData.map(parseTracked).filter((entry): entry is TrackedShipment => entry !== null);
    },

    async requestPickup(input: { pickupDate: string; pickupTime: string; expectedPackageCount: number }): Promise<PickupConfirmation> {
      const { status, body } = await call("POST", "/fm/request/new/", { json: { pickup_time: input.pickupTime, pickup_date: input.pickupDate, pickup_location: config.pickupLocation, expected_package_count: input.expectedPackageCount } });
      const pickupId = isObject(body) ? str(body.pickup_id, 64) : null;
      if (!isObject(body) || !pickupId) throw new DelhiveryError(isObject(body) && (body.error || body.pickup_location) ? "DELHIVERY_REJECTED" : "DELHIVERY_BAD_RESPONSE", status, isObject(body) && (body.error || body.pickup_location) ? "not_created" : "unknown", isObject(body) ? cleanRemark(body.error ?? body.pickup_location) : null);
      return { pickupId, pickupDate: str(body.pickup_date, 10), pickupTime: str(body.pickup_time, 8), incomingCenter: str(body.incoming_center_name, 191), expectedPackageCount: typeof body.expected_package_count === "number" ? body.expected_package_count : null };
    },

    async cancelShipment(waybill: string): Promise<{ remark: string | null }> {
      const { status, body } = await call("POST", "/api/p/edit", { json: { waybill, cancellation: "true" } });
      if (!isObject(body)) throw new DelhiveryError("DELHIVERY_BAD_RESPONSE", status, "unknown");
      if (body.status !== true) throw new DelhiveryError("DELHIVERY_REJECTED", status, "not_created", cleanRemark(body.remark ?? body.error));
      return { remark: cleanRemark(body.remark) };
    },
  };
}

export type DelhiveryClient = ReturnType<typeof createDelhiveryClient>;
