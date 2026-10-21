import type { FastifyBaseLogger } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient, ShipmentStatus } from "../../generated/prisma/client.js";
import { readDelhiveryConfig, readWebhookSecret } from "../config/delhivery.js";
import { createDelhiveryClient, DelhiveryError, type DelhiveryClient, type TrackedShipment } from "../providers/delhivery.provider.js";
import { FINAL_STATES, PICKED_UP_STATES, mapDelhiveryStatus, parseDelhiveryTime, scanEventKey, type TrackedState } from "../shared/delhivery-status.js";
import { httpError } from "../shared/http.js";
import { fromMinor, toMinor } from "../shared/order-pricing.js";
import { deliveryEmail, orderPageUrl, shipmentEmail } from "./email.service.js";
import { createEmailOutbox, type QueuedNotification } from "./email-outbox.service.js";
import { createOrderService, emailParts, enqueueOrderEmail, presentOrder, retryOnConflict } from "./order.service.js";
import { orderPaidLive } from "./payment.service.js";

// Delhivery shipments for paid retail orders. Rules that protect the data:
//  - only an order paid with real money can get a shipment, and only one: PAID (payment confirmed by a verified
//    provider, never by this code) AND orderPaidLive (a captured, unflagged LIVE-mode Razorpay payment, so a test-mode
//    payment can never trigger a courier shipment). Shipment.orderId is unique and the order row is locked while a
//    create is claimed;
//  - a create is claimed for a lease before Delhivery is called, so concurrent or repeated admin requests make one
//    call. If an attempt's outcome is unknown (timeout, 5xx, crash), the next attempt first asks Delhivery whether the
//    order already exists (tracking by ref_ids) and adopts that AWB instead of creating again. Delhivery itself also
//    refuses a second shipment with the same order id;
//  - every status, scan, pickup time and delivery time is copied from Delhivery's authenticated tracking API. A webhook
//    only triggers that read; its body is never stored as a status. Nothing a customer sends changes a shipment;
//  - the shipped and delivered emails are recorded in the email outbox in the same transaction as the change they
//    report, keyed per order and event, so a repeated scan, sync or webhook never sends them twice.

const CREATE_LEASE_MS = 60_000;
// Automatic booking: attempts allowed (each one first asks Delhivery whether the shipment already exists when the
// previous outcome was unknown), and the wait before attempt 2, 3, 4 and 5.
export const AUTO_BOOKING_MAX_ATTEMPTS = 5;
const AUTO_RETRY_MINUTES = [2, 10, 30, 120];
// Refusals that mean the order should not be booked at all any more (refunded, cancelled, shipped by hand meanwhile):
// the queued booking is withdrawn. Any other refusal is left for an admin.
const NOT_TO_BE_BOOKED = new Set(["ORDER_NOT_PAID", "ORDER_NOT_PAID_LIVE", "ORDER_NOT_SHIPPABLE", "ORDER_ALREADY_SHIPPED"]);
const PICKUP_LEASE_MS = 2 * 60_000;
// Delhivery: an e-waybill is mandatory when the shipment value is Rs. 50,000 or more.
const EWAYBILL_THRESHOLD_MINOR = 50_000 * 100;
const SHIPPABLE_ORDER_STATUSES = new Set(["PENDING", "CONFIRMED", "PROCESSING"]);
const TRACKED_STATUSES: ShipmentStatus[] = ["MANIFESTED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "RETURN_IN_TRANSIT"];
// A webhook for a shipment read this recently is not read again (Delhivery allows 750 tracking calls per 5 minutes).
const WEBHOOK_MIN_RESYNC_MS = 10_000;
const BATCH = 30;

export type ShipmentInput = { weightGrams?: number; lengthCm?: number; widthCm?: number; heightCm?: number; ewaybill?: string };
type AddressSnapshot = { name?: string; phone?: string; addressLine1?: string; addressLine2?: string | null; city?: string; state?: string; postalCode?: string };

// "Authorization: Bearer <secret>", compared in constant time (digests are equal length whatever was sent).
export function webhookAuthorized(header: unknown, secret: string): boolean {
  const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  if (!match) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(secret));
}

// The AWB a scan push names; everything else in the body is ignored.
export function webhookWaybill(body: unknown): string | null {
  const shipment = typeof body === "object" && body !== null ? (body as { Shipment?: unknown }).Shipment : undefined;
  const awb = typeof shipment === "object" && shipment !== null ? (shipment as { AWB?: unknown }).AWB : undefined;
  return typeof awb === "string" && /^[A-Za-z0-9-]{4,64}$/.test(awb.trim()) ? awb.trim() : null;
}

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function createShipmentService(prisma: PrismaClient, options: { log?: FastifyBaseLogger } = {}) {
  const outbox = createEmailOutbox(prisma, { log: options.log });
  const orders = createOrderService(prisma, { log: options.log });
  const delhivery = (): DelhiveryClient => createDelhiveryClient(readDelhiveryConfig());

  // Delhivery's own record of this order, if it has one: only a shipment whose ReferenceNo is exactly our order id.
  async function findAtDelhivery(client: DelhiveryClient, orderId: string) {
    const found = (await client.track({ orderRef: orderId })).filter((shipment) => shipment.referenceNo === orderId);
    return found.length === 1 ? { waybill: found[0].waybill, uploadWbn: null } : null;
  }

  // ---- tracking ----------------------------------------------------------------------------------------------------

  // Applies one tracking answer from Delhivery to one shipment, in one transaction, and records the emails it causes.
  async function applyTracking(shipmentId: string, tracked: TrackedShipment) {
    const now = new Date();
    const notifications = await retryOnConflict(() => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Shipment WHERE id = ${shipmentId} FOR UPDATE`;
      const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      if (!shipment.waybill || shipment.waybill !== tracked.waybill) return [];
      const waybill = shipment.waybill;

      const events = tracked.scans.flatMap((scan) => {
        const occurredAt = parseDelhiveryTime(scan.at);
        return occurredAt ? [{ shipmentId, eventKey: scanEventKey(waybill, scan), status: scan.status, statusType: scan.type, location: scan.location, instructions: scan.instructions, occurredAt }] : [];
      });
      if (events.length > 0) await tx.shipmentEvent.createMany({ data: events, skipDuplicates: true });

      const statusAt = parseDelhiveryTime(tracked.status?.at);
      const mapped = tracked.status ? mapDelhiveryStatus(tracked.status.type, tracked.status.status) : null;
      const next: ShipmentStatus = !FINAL_STATES.has(shipment.status) && mapped ? mapped : shipment.status;

      let pickedUpAt = shipment.pickedUpAt;
      if (!pickedUpAt && PICKED_UP_STATES.has(next as TrackedState)) {
        const pickedScans = events.filter((event) => PICKED_UP_STATES.has(mapDelhiveryStatus(event.statusType, event.status) as TrackedState)).map((event) => event.occurredAt.getTime());
        pickedUpAt = pickedScans.length > 0 ? new Date(Math.min(...pickedScans)) : (statusAt ?? now);
      }
      const deliveredAt = shipment.deliveredAt ?? (next === "DELIVERED" ? (statusAt ?? now) : null);
      const cancelledAt = shipment.cancelledAt ?? (next === "CANCELLED" ? (statusAt ?? now) : null);

      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: next,
          ...(tracked.status ? { providerStatus: tracked.status.status, providerStatusType: tracked.status.type, providerStatusLocation: tracked.status.location } : {}),
          ...(statusAt ? { providerStatusAt: statusAt } : {}),
          pickedUpAt,
          deliveredAt,
          cancelledAt,
          lastSyncedAt: now,
        },
      });

      const queued: QueuedNotification[] = [];
      const newlyPickedUp = pickedUpAt !== null && shipment.pickedUpAt === null;
      const newlyDelivered = deliveredAt !== null && shipment.deliveredAt === null;
      if (!newlyPickedUp && !newlyDelivered) return queued;

      const order = await tx.retailOrder.findUniqueOrThrow({ where: { id: shipment.orderId }, include: { items: { orderBy: { id: "asc" } }, shipment: { include: { events: true } }, customer: { select: { userId: true } } } });
      const parts = emailParts(presentOrder(order));
      if (newlyPickedUp && SHIPPABLE_ORDER_STATUSES.has(order.status)) {
        await tx.retailOrder.update({ where: { id: order.id }, data: { status: newlyDelivered ? "COMPLETED" : "SHIPPED", shippedAt: pickedUpAt, carrier: "Delhivery", trackingNumber: waybill } });
        // A package that is already delivered when first seen gets only the delivery email.
        if (!newlyDelivered) {
          queued.push(await enqueueOrderEmail(tx, order.customer.userId, order.id, "shipped", (customerName) =>
            shipmentEmail({ id: order.id, customerName, carrier: "Delhivery", trackingNumber: waybill, shippedAt: pickedUpAt!, orderUrl: orderPageUrl(order.id), ...parts }),
          ));
        }
      }
      if (newlyDelivered) {
        await tx.retailOrder.updateMany({ where: { id: order.id, status: { in: ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED"] } }, data: { status: "COMPLETED" } });
        queued.push(await enqueueOrderEmail(tx, order.customer.userId, order.id, "delivered", (customerName) =>
          deliveryEmail({ id: order.id, customerName, carrier: "Delhivery", trackingNumber: waybill, deliveredAt: deliveredAt!, orderUrl: orderPageUrl(order.id), ...parts }),
        ));
      }
      return queued;
    }));
    for (const notification of notifications) await outbox.dispatch(notification);
  }

  // Reads Delhivery's tracking for these shipments (30 per call) and applies it. A shipment Delhivery returns nothing
  // for keeps its state; only lastSyncedAt moves, so the worker gets round to the others.
  async function syncShipments(rows: { id: string; waybill: string }[]) {
    const client = delhivery();
    let applied = 0;
    for (let start = 0; start < rows.length; start += BATCH) {
      const chunk = rows.slice(start, start + BATCH);
      const byWaybill = new Map(chunk.map((row) => [row.waybill, row.id]));
      const tracked = await client.track({ waybills: chunk.map((row) => row.waybill) });
      const seen = new Set<string>();
      for (const entry of tracked) {
        const id = byWaybill.get(entry.waybill);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        await applyTracking(id, entry);
        applied++;
      }
      const missing = chunk.filter((row) => !seen.has(row.id)).map((row) => row.id);
      if (missing.length > 0) await prisma.shipment.updateMany({ where: { id: { in: missing } }, data: { lastSyncedAt: new Date() } });
    }
    return { requested: rows.length, applied };
  }

  return {
    // ---- create ----------------------------------------------------------------------------------------------------

    async createForOrder(orderId: string, input: ShipmentInput) {
      const client = delhivery(); // SHIPPING_DISABLED / DELHIVERY_NOT_CONFIGURED before anything is touched

      const claim = await retryOnConflict(() => prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM RetailOrder WHERE id = ${orderId} FOR UPDATE`;
        if (locked.length === 0) throw httpError(404, "NOT_FOUND", "Order not found");
        const order = await tx.retailOrder.findUniqueOrThrow({ where: { id: orderId }, include: { items: { orderBy: { id: "asc" } }, shipment: true } });
        const existing = order.shipment;
        if (existing?.waybill) return null; // already created: a retry returns it

        if (order.paymentStatus !== "PAID") throw httpError(409, "ORDER_NOT_PAID", "Only orders with a verified online payment can be shipped");
        // Checked on every attempt, including a retry of an earlier failed create, with the order row locked.
        if (!(await orderPaidLive(tx, orderId))) throw httpError(409, "ORDER_NOT_PAID_LIVE", "Only orders paid with a verified live Razorpay payment can be shipped");
        if (!SHIPPABLE_ORDER_STATUSES.has(order.status)) throw httpError(409, "ORDER_NOT_SHIPPABLE", `A ${order.status.toLowerCase()} order can't be shipped`);
        if (order.trackingNumber) throw httpError(409, "ORDER_ALREADY_SHIPPED", "This order was already marked as shipped by hand");
        if (toMinor(order.total) >= EWAYBILL_THRESHOLD_MINOR && !input.ewaybill) throw httpError(400, "EWAYBILL_REQUIRED", "Orders of Rs. 50,000 or more need an e-waybill number");
        const address = (order.shippingAddressSnapshot ?? {}) as AddressSnapshot;
        if (!address.name || !address.phone || !address.addressLine1 || !address.city || !address.state || !/^[1-9][0-9]{5}$/.test(address.postalCode ?? "")) {
          throw httpError(409, "ADDRESS_INCOMPLETE", "The order's delivery address is incomplete");
        }

        const now = new Date();
        const lockedUntil = new Date(now.getTime() + CREATE_LEASE_MS);
        // What the admin entered now wins; otherwise the parcel already recorded (an automatic booking's packed unit).
        const parcel = {
          weightGrams: input.weightGrams ?? existing?.weightGrams ?? null,
          lengthCm: input.lengthCm ?? existing?.lengthCm ?? null,
          widthCm: input.widthCm ?? existing?.widthCm ?? null,
          heightCm: input.heightCm ?? existing?.heightCm ?? null,
        };
        if (existing) {
          if (existing.status === "CREATING" && existing.lockedUntil && existing.lockedUntil > now) throw httpError(409, "SHIPMENT_IN_PROGRESS", "A shipment for this order is being created; try again in a minute");
          if (existing.status !== "CREATING" && existing.status !== "CREATE_FAILED" && existing.status !== "QUEUED") throw httpError(409, "ORDER_NOT_SHIPPABLE", "This order's shipment can't be created again");
          // A CREATING row whose lease ran out: that attempt may have reached Delhivery.
          const reconcile = existing.needsReconcile || existing.status === "CREATING";
          const claimed = await tx.shipment.update({ where: { id: existing.id }, data: { status: "CREATING", lockedUntil, nextAttemptAt: null, needsReconcile: reconcile, attempts: { increment: 1 }, ...parcel } });
          return { shipmentId: claimed.id, attempt: claimed.attempts, reconcile, order, address, parcel };
        }
        const created = await tx.shipment.create({ data: { orderId, providerOrderRef: orderId, status: "CREATING", attempts: 1, lockedUntil, ...parcel } });
        return { shipmentId: created.id, attempt: 1, reconcile: false, order, address, parcel };
      }));
      if (!claim) return orders.adminGetOrder(orderId);

      // Every later write is fenced on this attempt: if its lease ran out and another attempt took over, this one's
      // outcome is not recorded over that one.
      const mine = { id: claim.shipmentId, status: "CREATING" as const, attempts: claim.attempt };
      const release = (data: { needsReconcile: boolean; lastErrorCode: string; lastErrorRemark?: string | null }) =>
        prisma.shipment.updateMany({ where: mine, data: { status: "CREATE_FAILED", lockedUntil: null, lastErrorRemark: null, ...data } });

      let result: { waybill: string; uploadWbn: string | null } | null = null;
      try {
        if (claim.reconcile) result = await findAtDelhivery(client, orderId);
        if (!result) {
          const { order, address } = claim;
          const serviceability = await client.checkPincode(address.postalCode!);
          if (!serviceability.serviceable || !serviceability.prepaid) {
            await release({ needsReconcile: false, lastErrorCode: "PINCODE_NOT_SERVICEABLE" });
            throw httpError(409, "PINCODE_NOT_SERVICEABLE", "Delhivery does not deliver prepaid orders to this PIN code");
          }
          const quantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
          try {
            const created = await client.createShipment({
              orderRef: orderId,
              orderDate: order.createdAt,
              consignee: { name: address.name!, phone: address.phone!, address: [address.addressLine1, address.addressLine2].filter(Boolean).join(", "), city: address.city!, state: address.state!, pin: address.postalCode! },
              productsDescription: order.items.map((item) => `${item.productName ?? "Item"}${item.variantName ? ` (${item.variantName})` : ""} x ${item.quantity}`).join(", "),
              quantity,
              totalAmount: fromMinor(toMinor(order.total)),
              shippingMode: order.shippingMethod === "express" ? "Express" : "Surface",
              weightGrams: claim.parcel.weightGrams ?? undefined,
              dimensionsCm: claim.parcel.lengthCm && claim.parcel.widthCm && claim.parcel.heightCm ? { length: claim.parcel.lengthCm, width: claim.parcel.widthCm, height: claim.parcel.heightCm } : undefined,
              ewaybill: input.ewaybill,
            });
            result = { waybill: created.waybill, uploadWbn: created.uploadWbn };
          } catch (error) {
            if (!(error instanceof DelhiveryError) || error.code !== "DELHIVERY_DUPLICATE_ORDER") throw error;
            result = await findAtDelhivery(client, orderId);
            if (!result) throw error;
          }
        }
      } catch (error) {
        if (error instanceof DelhiveryError) {
          // Duplicate without a match, or an outcome Delhivery left unknown: the next attempt must look it up first.
          const reconcile = error.outcome === "unknown" || error.code === "DELHIVERY_DUPLICATE_ORDER";
          await release({ needsReconcile: reconcile, lastErrorCode: error.code, lastErrorRemark: error.remark });
          options.log?.warn({ orderId, shipmentId: claim.shipmentId, delhivery: { code: error.code, httpStatus: error.httpStatus, outcome: error.outcome } }, "Delhivery shipment was not created");
        }
        throw error;
      }

      const { waybill, uploadWbn } = result;
      await retryOnConflict(() => prisma.$transaction(async (tx) => {
        const finalized = await tx.shipment.updateMany({ where: mine, data: { status: "MANIFESTED", waybill, uploadWbn, lockedUntil: null, needsReconcile: false, lastErrorCode: null, lastErrorRemark: null, manifestedAt: new Date() } });
        if (finalized.count !== 1) throw httpError(409, "SHIPMENT_IN_PROGRESS", "Another attempt took over this shipment; reload the order");
        await tx.retailOrder.update({ where: { id: orderId }, data: { carrier: "Delhivery", trackingNumber: waybill } });
        await tx.retailOrder.updateMany({ where: { id: orderId, status: { in: ["PENDING", "CONFIRMED"] } }, data: { status: "PROCESSING" } });
      }));
      options.log?.info({ orderId, shipmentId: claim.shipmentId, environment: client.environment }, "Delhivery shipment created");
      return orders.adminGetOrder(orderId);
    },

    // ---- tracking ----------------------------------------------------------------------------------------------------

    applyTracking,
    syncShipments,

    // Automatic booking, step 2 (shipment worker): books queued shipments, and retries those whose last attempt left
    // Delhivery's outcome unknown (createForOrder then looks the order up at Delhivery before creating again). Each
    // booking goes through createForOrder, which locks the order, re-checks the verified live payment, claims the row
    // for a lease and fences its result, so concurrent workers or an admin pressing Retry book at most one shipment.
    // A refusal that a retry can't fix is left CREATE_FAILED for an admin; an order that should no longer ship
    // (refunded, cancelled, shipped by hand) has its queued booking withdrawn.
    async bookDue(limit = BATCH) {
      const now = new Date();
      const due = await prisma.shipment.findMany({
        where: {
          autoBooked: true,
          waybill: null,
          attempts: { lt: AUTO_BOOKING_MAX_ATTEMPTS },
          OR: [
            { status: "QUEUED" },
            { status: "CREATE_FAILED", needsReconcile: true, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true, orderId: true },
      });
      const tally = { due: due.length, booked: 0, retryLater: 0, needsAdmin: 0, withdrawn: 0, busy: 0 };
      for (const row of due) {
        try {
          await this.createForOrder(row.orderId, {});
          tally.booked++;
        } catch (error) {
          const code = (error as { code?: string }).code ?? "UNKNOWN";
          if (code === "SHIPMENT_IN_PROGRESS") {
            tally.busy++;
            continue;
          }
          const current = await prisma.shipment.findUnique({ where: { id: row.id }, select: { status: true, attempts: true, needsReconcile: true } });
          if (!current || current.status === "CREATING") continue;
          if (current.status === "QUEUED" && NOT_TO_BE_BOOKED.has(code)) {
            await prisma.shipment.updateMany({ where: { id: row.id, status: "QUEUED" }, data: { status: "CANCELLED", cancelledAt: new Date(), lastErrorCode: code, lastErrorRemark: "Automatic booking withdrawn: the order is no longer to be shipped" } });
            tally.withdrawn++;
          } else if (current.status === "QUEUED") {
            // Refused before anything was sent (e.g. ADDRESS_INCOMPLETE, EWAYBILL_REQUIRED): an admin must fix it.
            await prisma.shipment.updateMany({ where: { id: row.id, status: "QUEUED" }, data: { status: "CREATE_FAILED", needsReconcile: false, lastErrorCode: code.slice(0, 64), lastErrorRemark: error instanceof Error ? error.message.slice(0, 250) : null } });
            tally.needsAdmin++;
          } else if (current.needsReconcile && current.attempts < AUTO_BOOKING_MAX_ATTEMPTS) {
            const waitMinutes = AUTO_RETRY_MINUTES[Math.min(current.attempts, AUTO_RETRY_MINUTES.length) - 1];
            await prisma.shipment.updateMany({ where: { id: row.id, status: "CREATE_FAILED" }, data: { nextAttemptAt: new Date(Date.now() + waitMinutes * 60_000) } });
            tally.retryLater++;
          } else {
            tally.needsAdmin++;
          }
          options.log?.warn({ shipmentId: row.id, orderId: row.orderId, err: { code } }, "Automatic courier booking did not complete");
        }
      }
      return tally;
    },

    async syncOrder(orderId: string) {
      const shipment = await prisma.shipment.findUnique({ where: { orderId } });
      if (!shipment?.waybill) throw httpError(404, "NOT_FOUND", "This order has no Delhivery shipment");
      await syncShipments([{ id: shipment.id, waybill: shipment.waybill }]);
      return orders.adminGetOrder(orderId);
    },

    // Shipments still moving, least recently read first.
    async syncDue(limit = BATCH) {
      const rows = await prisma.shipment.findMany({ where: { status: { in: TRACKED_STATUSES }, waybill: { not: null } }, orderBy: [{ lastSyncedAt: "asc" }, { id: "asc" }], take: limit, select: { id: true, waybill: true } });
      return syncShipments(rows.map((row) => ({ id: row.id, waybill: row.waybill! })));
    },

    // Scan push from Delhivery. Authenticated by the shared bearer secret; even then the body is only a hint: the
    // shipment it names is re-read from Delhivery's tracking API, and only that answer is applied.
    async handleWebhook(authorization: unknown, body: unknown): Promise<{ result: "SYNCED" | "SKIPPED" | "IGNORED" | "SYNC_FAILED" }> {
      const secret = readWebhookSecret();
      if (!webhookAuthorized(authorization, secret)) throw httpError(401, "WEBHOOK_UNAUTHORIZED", "Webhook authentication failed");
      const waybill = webhookWaybill(body);
      const shipment = waybill ? await prisma.shipment.findUnique({ where: { waybill }, select: { id: true, waybill: true, status: true, lastSyncedAt: true } }) : null;
      if (!shipment?.waybill) return { result: "IGNORED" };
      if (FINAL_STATES.has(shipment.status) || (shipment.lastSyncedAt && Date.now() - shipment.lastSyncedAt.getTime() < WEBHOOK_MIN_RESYNC_MS)) return { result: "SKIPPED" };
      try {
        await syncShipments([{ id: shipment.id, waybill: shipment.waybill }]);
        return { result: "SYNCED" };
      } catch (error) {
        // The tracking worker will read it later; Delhivery is told the push was received either way.
        options.log?.warn({ shipmentId: shipment.id, err: { code: (error as { code?: unknown }).code } }, "Delhivery webhook: tracking read failed");
        return { result: "SYNC_FAILED" };
      }
    },

    // ---- pickup, cancel, serviceability --------------------------------------------------------------------------------

    async checkServiceability(pin: string) {
      return delhivery().checkPincode(pin);
    },

    // One pickup request per warehouse and day. `confirmNotCreated` re-sends a request whose earlier outcome was
    // unknown, after the admin checked in Delhivery's panel that it was not booked.
    async requestPickup(input: { pickupDate: string; pickupTime: string; expectedPackageCount?: number; confirmNotCreated?: boolean }) {
      const config = readDelhiveryConfig();
      const client = createDelhiveryClient(config);
      if (input.pickupDate < istToday()) throw httpError(400, "PICKUP_DATE_PAST", "The pickup date has passed");
      const expectedPackageCount = input.expectedPackageCount ?? (await prisma.shipment.count({ where: { status: "MANIFESTED", pickedUpAt: null } }));
      if (expectedPackageCount < 1) throw httpError(409, "NOTHING_TO_PICK_UP", "There are no manifested shipments waiting for pickup");
      const key = { pickupLocation_pickupDate: { pickupLocation: config.pickupLocation, pickupDate: input.pickupDate } };
      const data = { pickupTime: input.pickupTime, expectedPackageCount, lastErrorCode: null, lastErrorRemark: null };

      let claimed = false;
      try {
        await prisma.shipmentPickupRequest.create({ data: { pickupLocation: config.pickupLocation, pickupDate: input.pickupDate, status: "REQUESTING", ...data } });
        claimed = true;
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
      }
      if (!claimed) {
        const existing = await prisma.shipmentPickupRequest.findUniqueOrThrow({ where: key });
        if (existing.status === "REQUESTED") return existing;
        const stale = existing.status === "REQUESTING" && Date.now() - existing.updatedAt.getTime() > PICKUP_LEASE_MS;
        if (existing.status === "REQUESTING" && !stale) throw httpError(409, "PICKUP_IN_PROGRESS", "A pickup request for this day is being sent");
        if ((existing.status === "OUTCOME_UNKNOWN" || stale) && !input.confirmNotCreated) throw httpError(409, "PICKUP_OUTCOME_UNKNOWN", "An earlier pickup request for this day may have been booked; check Delhivery's panel, then retry with confirmNotCreated");
        const taken = await prisma.shipmentPickupRequest.updateMany({ where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt }, data: { status: "REQUESTING", ...data } });
        if (taken.count !== 1) throw httpError(409, "PICKUP_IN_PROGRESS", "A pickup request for this day is being sent");
      }

      try {
        const confirmation = await client.requestPickup({ pickupDate: input.pickupDate, pickupTime: input.pickupTime, expectedPackageCount });
        return prisma.shipmentPickupRequest.update({ where: key, data: { status: "REQUESTED", providerPickupId: confirmation.pickupId } });
      } catch (error) {
        if (error instanceof DelhiveryError) await prisma.shipmentPickupRequest.update({ where: key, data: { status: error.outcome === "unknown" ? "OUTCOME_UNKNOWN" : "FAILED", lastErrorCode: error.code, lastErrorRemark: error.remark } });
        throw error;
      }
    },

    // Cancels a shipment Delhivery has not picked up yet. Nothing is emailed; the order is left for an admin to settle.
    async cancelForOrder(orderId: string) {
      const shipment = await prisma.shipment.findUnique({ where: { orderId } });
      if (!shipment?.waybill) throw httpError(404, "NOT_FOUND", "This order has no Delhivery shipment");
      if (shipment.status === "CANCELLED") return orders.adminGetOrder(orderId);
      if (shipment.status !== "MANIFESTED" || shipment.pickedUpAt) throw httpError(409, "SHIPMENT_NOT_CANCELLABLE", "Only a shipment Delhivery has not picked up can be cancelled here");
      await delhivery().cancelShipment(shipment.waybill);
      await prisma.shipment.updateMany({ where: { id: shipment.id, status: "MANIFESTED" }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      return orders.adminGetOrder(orderId);
    },
  };
}

export type ShipmentService = ReturnType<typeof createShipmentService>;
