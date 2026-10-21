import type { Prisma } from "../../generated/prisma/client.js";
import { autoBookingEnabled } from "../config/delhivery.js";
import { PARCEL_PROBLEM_TEXT, parcelFor } from "../shared/parcel.js";

// Automatic courier booking, step 1: called inside the transaction that marks an order PAID from a verified LIVE
// Razorpay payment. It never calls Delhivery (the shipment worker books it after this commits); it only records what
// to book, durably, in the same transaction, so a paid order is either queued or flagged, never lost:
//  - QUEUED with the parcel, when the order is one unit of a product whose packed weight and size are known;
//  - CREATE_FAILED with PARCEL_DETAILS_MISSING / MULTI_PARCEL_ORDER otherwise, for an admin to enter the parcel.
// Shipment.orderId is unique and an existing row is left alone, so this records at most one booking per order however
// often it is called. With DELHIVERY_AUTO_BOOKING off it does nothing (admins book from Retail Orders).
export async function queueCourierBooking(tx: Prisma.TransactionClient, orderId: string): Promise<"QUEUED" | "NEEDS_PARCEL" | "SKIPPED"> {
  if (!autoBookingEnabled()) return "SKIPPED";
  if (await tx.shipment.findUnique({ where: { orderId }, select: { id: true } })) return "SKIPPED";
  const items = await tx.retailOrderItem.findMany({ where: { orderId }, select: { quantity: true, product: { select: { weightGrams: true, lengthCm: true, widthCm: true, heightCm: true } } } });
  const result = parcelFor(items);
  const base = { orderId, providerOrderRef: orderId, autoBooked: true };
  if ("parcel" in result) {
    await tx.shipment.create({ data: { ...base, status: "QUEUED", ...result.parcel } });
    return "QUEUED";
  }
  await tx.shipment.create({ data: { ...base, status: "CREATE_FAILED", needsReconcile: false, lastErrorCode: result.problem, lastErrorRemark: PARCEL_PROBLEM_TEXT[result.problem] } });
  return "NEEDS_PARCEL";
}
