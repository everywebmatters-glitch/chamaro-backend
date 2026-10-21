import { createHash } from "node:crypto";

// Delhivery's forward-flow statuses, from its "Pre-paid and COD shipments" table (StatusType + Status):
//   UD Manifested | Not Picked | In Transit | Pending | Dispatched     DL Delivered | RTO
//   RT In Transit | Pending | Dispatched (return to origin)
// plus the documented cancel-API states (Open, Scheduled before pickup; "Cancelled"/"Canceled").
// Delhivery asks clients not to hard-code the flow, so anything not listed maps to null: the raw text is kept for
// display and the shipment's state is left unchanged, rather than guessed.

export type TrackedState = "MANIFESTED" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "RETURN_IN_TRANSIT" | "RETURNED" | "CANCELLED";

const normalize = (value: string | null | undefined) => (value ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();

export function mapDelhiveryStatus(statusType: string | null | undefined, status: string | null | undefined): TrackedState | null {
  const type = normalize(statusType).toUpperCase();
  const text = normalize(status);
  if (type === "CN" || text === "cancelled" || text === "canceled") return "CANCELLED";
  if (type === "UD") {
    if (["manifested", "not picked", "open", "scheduled"].includes(text)) return "MANIFESTED";
    if (["in transit", "pending"].includes(text)) return "IN_TRANSIT";
    if (text === "dispatched") return "OUT_FOR_DELIVERY";
    return null;
  }
  if (type === "DL") {
    if (text === "delivered") return "DELIVERED";
    if (text === "rto") return "RETURNED";
    return null;
  }
  if (type === "RT") return "RETURN_IN_TRANSIT";
  return null;
}

// States that can only be reached after Delhivery physically picked the package up (Delhivery: "In Transit ... after
// physical pick up"). Manifested / Not Picked are only soft data.
export const PICKED_UP_STATES: ReadonlySet<TrackedState> = new Set(["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "RETURN_IN_TRANSIT", "RETURNED"]);
// Nothing changes a shipment after one of these.
export const FINAL_STATES: ReadonlySet<string> = new Set(["DELIVERED", "RETURNED", "CANCELLED"]);

// Delhivery timestamps carry no zone ("2019-01-09T17:10:42.767"); they are Indian local time. Returns null for
// anything that is not such a timestamp, so a malformed value is never stored as a date.
export function parseDelhiveryTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ? match[3].slice(0, 4).padEnd(4, "0") : "";
  const zone = match[4] ?? "+05:30";
  const date = new Date(`${match[1]}T${match[2]}${fraction}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// The same scan read twice (two syncs, a sync and a webhook-triggered sync) gets the same key.
export function scanEventKey(waybill: string, scan: { at: string; type: string | null; status: string; location: string | null; instructions: string | null }): string {
  return createHash("sha256").update([waybill, scan.at, scan.type ?? "", scan.status, scan.location ?? "", scan.instructions ?? ""].join("\u0000")).digest("hex");
}
