import type { FastifyBaseLogger } from "fastify";
import { createHash } from "node:crypto";
import type { PaymentStatus, Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import { readRazorpayConfig, readWebhookSecret } from "../config/razorpay.js";
import {
  ORDER_ID,
  PAYMENT_ID,
  RazorpayError,
  checkoutSignatureValid,
  razorpayClientFor,
  webhookSignatureValid,
  type RazorpayClient,
  type RemotePayment,
} from "../providers/razorpay.provider.js";
import { httpError } from "../shared/http.js";
import { toMinor } from "../shared/order-pricing.js";
import { createCheckoutService } from "./checkout.service.js";
import { orderCancelledEmail, orderConfirmedEmail } from "./email.service.js";
import { createEmailOutbox, type QueuedNotification } from "./email-outbox.service.js";
import { queueCourierBooking } from "./fulfillment.js";
import { emailParts, enqueueOrderEmail, orderInclude, presentOrder, releaseReservation, retryOnConflict } from "./order.service.js";

// Razorpay payments for retail orders. Rules that protect the money and the data:
//  - the amount is always the order's stored total (computed on the server when the order was placed); a gateway
//    order is created only here, never by a browser;
//  - nothing a browser or a webhook body says is taken as payment state. The checkout callback's signature and the
//    webhook's signature are checked, and then the payment is read back from Razorpay's API; only that answer is
//    applied, and only if its gateway order, amount and currency match what was recorded here;
//  - every change locks the order row first (the same order as checkout and cancellation), and a payment's status only
//    moves forward (CREATED/FAILED -> AUTHORIZED -> CAPTURED -> PARTIALLY_REFUNDED -> REFUNDED), so duplicate,
//    late or out-of-order callbacks and webhooks cannot undo a payment or confirm an order twice;
//  - an order becomes PAID (and CONFIRMED) once, from PENDING/UNPAID, by the first captured payment for its full total.
//    Money that arrives any other way (a second payment, a payment for a cancelled order, a wrong amount) never
//    changes the order: the payment is flagged needsReview for a person to refund;
//  - an authorized payment is captured only while its order can still be confirmed; otherwise it is left uncaptured,
//    and Razorpay returns uncaptured money to the customer by itself;
//  - the confirmation email is recorded in the email outbox in the same transaction that marks the order paid, keyed
//    per order, so it is sent once;
//  - a refund counts only once Razorpay reports it "processed" (read from the payment's refund list): a requested,
//    pending or failed refund never marks a payment or an order refunded;
//  - every payment records the key mode ("test"/"live") it was created with. Only gateway orders of the current mode are
//    reused, confirmed or read back, and an order paid in test mode is never shipped (orderPaidLive);
//  - an order can be paid for ORDER_PAYMENT_TTL_MINUTES after it is placed (Checkout is told how long is left), and is
//    expired only EXPIRY_GRACE_MS after that, once Razorpay has been asked again, so a payment finishing late is seen first.

const OPEN_STATUSES: PaymentStatus[] = ["CREATED", "FAILED"];
const RANK: Record<PaymentStatus, number> = { CREATED: 0, FAILED: 0, AUTHORIZED: 1, CAPTURED: 2, PARTIALLY_REFUNDED: 3, REFUNDED: 4 };
const NOT_DISPATCHED = new Set(["PENDING", "CONFIRMED", "PROCESSING"]);
const EVENT_NAME = /^[a-z_.]{1,64}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Extra time past the payment deadline before an unpaid order is expired: Checkout's own timeout can run late when the
// browser pauses timers in a background tab.
export const EXPIRY_GRACE_MS = 15 * 60_000;

export type PaymentOutcome = "paid" | "already_paid" | "pending" | "failed" | "review" | "refunded" | "ignored";
type Applied = { outcome: PaymentOutcome; orderId: string | null; capture: { paymentId: string; amountMinor: number } | null; notification: QueuedNotification | null };

const orderWithItems = { ...orderInclude, customer: { select: { userId: true } } } satisfies Prisma.RetailOrderInclude;

// The status a payment moves to from Razorpay's answer, never backwards.
function nextStatus(current: PaymentStatus, remote: RemotePayment): PaymentStatus {
  let target: PaymentStatus;
  if (remote.status === "failed") target = "FAILED";
  else if (remote.status === "authorized") target = "AUTHORIZED";
  else if (remote.status === "refunded") target = "REFUNDED";
  else if (remote.status === "captured") target = remote.amountRefundedMinor > 0 ? "PARTIALLY_REFUNDED" : "CAPTURED";
  else target = current;
  if (current === "CREATED" && target === "FAILED") return "FAILED";
  return RANK[target] > RANK[current] ? target : current;
}

// Whether an order's payment is real money: PAID by a non-flagged, captured LIVE payment. Every dispatch path (manual
// shipping, Delhivery) must check this as well as paymentStatus, so a sandbox test order is never shipped.
export async function orderPaidLive(db: PrismaClient | Prisma.TransactionClient, orderId: string): Promise<boolean> {
  const order = await db.retailOrder.findUnique({ where: { id: orderId }, select: { paymentStatus: true } });
  if (order?.paymentStatus !== "PAID") return false;
  const live = await db.payment.count({ where: { orderId, mode: "live", needsReview: false, status: { in: ["CAPTURED", "PARTIALLY_REFUNDED"] } } });
  return live > 0;
}

export function createPaymentService(prisma: PrismaClient, options: { log?: FastifyBaseLogger } = {}) {
  const outbox = createEmailOutbox(prisma, { log: options.log });
  const checkout = createCheckoutService(prisma);
  const client = (): RazorpayClient => razorpayClientFor(readRazorpayConfig());
  // The key mode payments are created and read back with now; only payments of this mode are touched.
  const currentMode = () => readRazorpayConfig().mode;

  const ttlMs = () => env.ORDER_PAYMENT_TTL_MINUTES * 60_000;

  function gatewayError(error: unknown): never {
    if (error instanceof RazorpayError) {
      options.log?.warn({ err: { code: error.code, status: error.status, providerCode: error.providerCode } }, "Razorpay request failed");
      throw httpError(502, "PAYMENT_GATEWAY_UNAVAILABLE", "The payment service could not be reached; please try again");
    }
    throw error;
  }

  async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM RetailOrder WHERE id = ${orderId} FOR UPDATE`;
    return locked.length > 0;
  }

  // ---- applying Razorpay's answer -------------------------------------------------------------------------------

  async function apply(remote: RemotePayment): Promise<Applied> {
    if (!remote.orderId) return { outcome: "ignored", orderId: null, capture: null, notification: null };
    const known = await prisma.payment.findFirst({ where: { providerOrderId: remote.orderId, mode: currentMode() }, select: { orderId: true } });
    if (!known) {
      // Not a gateway order this system created (another integration, or a test event).
      options.log?.warn({ providerOrderId: remote.orderId, providerPaymentId: remote.id }, "Payment for an unknown gateway order ignored");
      return { outcome: "ignored", orderId: null, capture: null, notification: null };
    }

    return retryOnConflict(() => prisma.$transaction(async (tx): Promise<Applied> => {
      await lockOrder(tx, known.orderId);
      const payment = await tx.payment.findUniqueOrThrow({ where: { providerOrderId: remote.orderId! } });
      const order = await tx.retailOrder.findUniqueOrThrow({ where: { id: payment.orderId }, include: orderWithItems });
      const now = new Date();
      const result: Applied = { outcome: "pending", orderId: order.id, capture: null, notification: null };
      const data: Prisma.PaymentUpdateInput = { lastSyncedAt: now };
      const flag = (reason: string) => {
        data.needsReview = true;
        data.reviewReason = reason;
        result.outcome = "review";
        options.log?.error({ paymentId: payment.id, orderId: order.id, reason }, "Payment needs review");
      };

      // A gateway order should only ever have one successful payment; a second one is never taken as this payment.
      const holdsMoney = remote.status === "authorized" || remote.status === "captured" || remote.status === "refunded";
      if (holdsMoney && payment.providerPaymentId && payment.providerPaymentId !== remote.id) {
        if (!payment.needsReview) flag("SECOND_PAYMENT_ON_GATEWAY_ORDER");
        await tx.payment.update({ where: { id: payment.id }, data });
        return result;
      }

      const amountOk = remote.amountMinor === payment.amountMinor && remote.currency === payment.currency && payment.amountMinor === toMinor(order.total);
      const status = nextStatus(payment.status, remote);
      data.status = status;
      if (remote.status === "failed" && RANK[payment.status] === 0) {
        data.lastErrorCode = remote.errorCode;
        data.lastErrorReason = remote.errorReason;
        result.outcome = "failed";
      }
      if (holdsMoney) {
        data.providerPaymentId = remote.id;
        data.method = remote.method;
        if (!payment.authorizedAt) data.authorizedAt = now;
        if (!amountOk && !payment.needsReview) flag("AMOUNT_MISMATCH");
      }
      if (remote.status === "captured" || remote.status === "refunded") {
        if (!payment.capturedAt) data.capturedAt = now;
        data.amountRefundedMinor = Math.max(payment.amountRefundedMinor, remote.amountRefundedMinor);
        if (status === "REFUNDED" && !payment.refundedAt) data.refundedAt = now;
      }

      const otherPaying = await tx.payment.findFirst({ where: { orderId: order.id, id: { not: payment.id }, capturedAt: { not: null }, needsReview: false }, select: { id: true } });
      const reviewed = payment.needsReview || data.needsReview === true;

      if (remote.status === "authorized" && status === "AUTHORIZED" && amountOk && !reviewed) {
        // Capture only while the order can still be confirmed by it; otherwise leave it for Razorpay to return.
        if (order.status === "PENDING" && order.paymentStatus === "UNPAID" && !otherPaying) result.capture = { paymentId: remote.id, amountMinor: payment.amountMinor };
        else options.log?.warn({ paymentId: payment.id, orderId: order.id }, "Authorized payment left uncaptured: the order can no longer be confirmed");
      }

      const captured = status === "CAPTURED" || status === "PARTIALLY_REFUNDED";
      if (captured && amountOk && !reviewed) {
        if (order.paymentStatus === "UNPAID" && order.status === "PENDING" && !otherPaying) {
          await tx.retailOrder.update({ where: { id: order.id }, data: { paymentStatus: "PAID", status: "CONFIRMED" } });
          // Real money only: a test-mode payment never books a courier. In this same transaction, so the booking is
          // recorded exactly when the order becomes paid; the worker calls Delhivery after this commits.
          if (payment.mode === "live") await queueCourierBooking(tx, order.id);
          const presented = presentOrder(order);
          result.notification = await enqueueOrderEmail(tx, order.customer.userId, order.id, "confirmed", (customerName) =>
            orderConfirmedEmail({ id: presented.id, createdAt: presented.createdAt, customerName, subtotal: presented.subtotal, shippingTotal: presented.shippingTotal, total: presented.total, shippingMethod: presented.shippingMethod, paidAt: now, ...emailParts(presented) }),
          );
          result.outcome = "paid";
          options.log?.info({ paymentId: payment.id, orderId: order.id }, "Order paid");
        } else if (otherPaying || order.paymentStatus !== "UNPAID") {
          if (otherPaying) flag("DUPLICATE_PAYMENT");
          else result.outcome = "already_paid";
        } else {
          flag("PAYMENT_FOR_CLOSED_ORDER");
        }
      }

      // A full refund of the payment that paid the order: the order is refunded, and if nothing has been dispatched,
      // cancelled with its stock released. A partial refund leaves the order paid.
      if (status === "REFUNDED" && payment.status !== "REFUNDED" && !reviewed && order.paymentStatus === "PAID" && !otherPaying) {
        const dispatched = Boolean(order.trackingNumber) || !NOT_DISPATCHED.has(order.status);
        await tx.retailOrder.update({ where: { id: order.id }, data: { paymentStatus: "REFUNDED", ...(dispatched ? {} : { status: "CANCELLED" }) } });
        if (dispatched) flag("REFUNDED_AFTER_DISPATCH");
        else await releaseReservation(tx, order.items);
        if (result.outcome !== "review") result.outcome = "refunded";
      }

      await tx.payment.update({ where: { id: payment.id }, data });
      return result;
    }));
  }

  // Razorpay's payment entity may count a refund (amount_refunded, status "refunded") before the money is returned, and a
  // refund can still fail. Only refunds Razorpay reports as "processed" count; a failed one is recorded for a person.
  async function withConfirmedRefunds(gateway: RazorpayClient, remote: RemotePayment): Promise<RemotePayment> {
    if (remote.status !== "captured" && remote.status !== "refunded") return remote;
    if (remote.status === "captured" && remote.amountRefundedMinor === 0) return remote;
    const refunds = (await gateway.fetchRefunds(remote.id)).filter((refund) => refund.paymentId === remote.id);
    const processedMinor = refunds.filter((refund) => refund.status === "processed").reduce((sum, refund) => sum + refund.amountMinor, 0);
    if (refunds.some((refund) => refund.status === "failed")) {
      await prisma.payment.updateMany({ where: { providerPaymentId: remote.id }, data: { lastErrorCode: "REFUND_FAILED", lastErrorReason: "refund_failed" } });
      options.log?.error({ providerPaymentId: remote.id }, "A refund for this payment failed at Razorpay; it needs a person");
    }
    return { ...remote, amountRefundedMinor: processedMinor, status: processedMinor >= remote.amountMinor && remote.amountMinor > 0 ? "refunded" : "captured" };
  }

  // Applies Razorpay's answer, captures it if it is authorized and the order can take it, then applies the result.
  async function settle(gateway: RazorpayClient, reported: RemotePayment): Promise<Applied> {
    const remote = await withConfirmedRefunds(gateway, reported);
    const first = await apply(remote);
    await outbox.dispatch(first.notification);
    if (!first.capture) return first;
    let captured: RemotePayment;
    try {
      captured = await gateway.capturePayment(first.capture.paymentId, first.capture.amountMinor, "INR");
    } catch (error) {
      if (!(error instanceof RazorpayError)) throw error;
      // Already captured by someone else, or the outcome is unknown: read the payment back and apply that.
      captured = await gateway.fetchPayment(first.capture.paymentId);
    }
    const second = await apply(await withConfirmedRefunds(gateway, captured));
    await outbox.dispatch(second.notification);
    return second;
  }

  async function syncGatewayOrder(gateway: RazorpayClient, providerOrderId: string): Promise<PaymentOutcome[]> {
    const payments = await gateway.fetchOrderPayments(providerOrderId);
    if (payments.length === 0) {
      await prisma.payment.update({ where: { providerOrderId }, data: { lastSyncedAt: new Date() } });
      return [];
    }
    // Successful payments first, so a later failed try never hides them.
    const order: Record<string, number> = { captured: 0, refunded: 0, authorized: 1, failed: 2, created: 3 };
    const outcomes: PaymentOutcome[] = [];
    for (const remote of [...payments].sort((a, b) => order[a.status] - order[b.status])) outcomes.push((await settle(gateway, remote)).outcome);
    return outcomes;
  }

  // `timeoutSeconds` closes Razorpay Checkout when the time to pay runs out (computed here, so the browser's clock and
  // its idea of the deadline never matter).
  function checkoutResponse(config: { keyId: string; mode: string }, payment: { providerOrderId: string; amountMinor: number; currency: string }, orderId: string, payableUntil: Date) {
    const timeoutSeconds = Math.max(60, Math.floor((payableUntil.getTime() - Date.now()) / 1000));
    return { orderId, keyId: config.keyId, mode: config.mode, razorpayOrderId: payment.providerOrderId, amount: payment.amountMinor, currency: payment.currency, timeoutSeconds };
  }

  return {
    // ---- customer ---------------------------------------------------------------------------------------------

    // Opens (or reopens) payment for one of the customer's unpaid orders: returns what Razorpay Checkout needs.
    // An open gateway order for the same amount is reused, so retries and double clicks never create a second one.
    // Creating a new one needs a fresh checkout verification (the emailed checkout code), which it uses up.
    async startPayment(userId: string, orderId: string) {
      const config = readRazorpayConfig();
      const payable = async (tx: Prisma.TransactionClient) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT o.id FROM RetailOrder o JOIN Customer c ON c.id = o.customerId WHERE o.id = ${orderId} AND c.userId = ${userId} FOR UPDATE`;
        if (locked.length === 0) throw httpError(404, "NOT_FOUND", "Order not found");
        const order = await tx.retailOrder.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } });
        if (order.paymentStatus !== "UNPAID" || order.status !== "PENDING") throw httpError(409, "ORDER_NOT_PAYABLE", "This order can't be paid");
        if (order.createdAt.getTime() + ttlMs() <= Date.now()) throw httpError(409, "ORDER_PAYMENT_EXPIRED", "The time to pay for this order has run out; please place it again");
        if (order.payments.some((payment) => RANK[payment.status] > 0)) throw httpError(409, "PAYMENT_IN_PROGRESS", "A payment for this order has been received and is being confirmed");
        const totalMinor = toMinor(order.total);
        const open = order.payments.find((payment) => payment.mode === config.mode && OPEN_STATUSES.includes(payment.status) && payment.amountMinor === totalMinor && !payment.needsReview) ?? null;
        return { totalMinor, open, payableUntil: new Date(order.createdAt.getTime() + ttlMs()) };
      };

      const first = await prisma.$transaction(payable);
      if (first.open) return checkoutResponse(config, first.open, orderId, first.payableUntil);

      await checkout.requireVerifiedCheckout(userId);
      const remote = await client().createOrder({ amountMinor: first.totalMinor, currency: "INR", receipt: orderId, notes: { orderId } }).catch(gatewayError);
      if (remote.amountMinor !== first.totalMinor || remote.currency !== "INR") throw httpError(502, "PAYMENT_GATEWAY_UNAVAILABLE", "The payment service returned an unexpected order");

      const payment = await retryOnConflict(() => prisma.$transaction(async (tx) => {
        const again = await payable(tx);
        // Another request opened one meanwhile: use it (the gateway order just created is never shown, so never paid).
        if (again.open) return again.open;
        return tx.payment.create({ data: { orderId, mode: config.mode, providerOrderId: remote.id, amountMinor: again.totalMinor, currency: "INR" } });
      }));
      options.log?.info({ paymentId: payment.id, orderId }, "Payment opened");
      return checkoutResponse(config, payment, orderId, first.payableUntil);
    },

    // Razorpay Checkout's success callback, forwarded by the storefront. The signature only proves the ids came from
    // Razorpay Checkout; the payment's state is read from Razorpay's API before anything changes.
    async confirmFromCheckout(userId: string, orderId: string, body: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) {
      const config = readRazorpayConfig();
      if (!ORDER_ID.test(body.razorpayOrderId) || !PAYMENT_ID.test(body.razorpayPaymentId)) throw httpError(400, "PAYMENT_SIGNATURE_INVALID", "This payment could not be verified");
      const payment = await prisma.payment.findFirst({ where: { providerOrderId: body.razorpayOrderId, orderId, mode: config.mode, order: { customer: { userId } } }, select: { id: true, providerOrderId: true } });
      if (!payment) throw httpError(404, "NOT_FOUND", "Payment not found");
      // As Razorpay documents: the signature is checked against the gateway order id this server created and stored.
      if (!checkoutSignatureValid(payment.providerOrderId, body.razorpayPaymentId, body.razorpaySignature, config.keySecret)) {
        options.log?.warn({ paymentId: payment.id, orderId }, "Checkout payment signature rejected");
        throw httpError(400, "PAYMENT_SIGNATURE_INVALID", "This payment could not be verified");
      }
      const gateway = client();
      const remote = await gateway.fetchPayment(body.razorpayPaymentId).catch(gatewayError);
      if (remote.orderId !== body.razorpayOrderId) throw httpError(400, "PAYMENT_SIGNATURE_INVALID", "This payment could not be verified");
      const result = await settle(gateway, remote).catch(gatewayError);
      const order = await prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
      return { outcome: result.outcome, order: presentOrder(order) };
    },

    // ---- webhook ----------------------------------------------------------------------------------------------

    // Razorpay webhook. Authenticated by X-Razorpay-Signature over the raw body; each event id is processed once
    // (a redelivery of an event that failed part-way is processed again). The body only says which payment to read:
    // its state comes from Razorpay's API, so events may arrive late, twice or out of order.
    async handleWebhook(rawBody: Buffer, headers: Record<string, unknown>): Promise<{ duplicate: boolean; outcomes: PaymentOutcome[] }> {
      const secret = readWebhookSecret();
      if (!webhookSignatureValid(rawBody, headers["x-razorpay-signature"], secret)) {
        options.log?.warn({}, "Payment webhook signature rejected");
        throw httpError(401, "WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature");
      }
      let body: { event?: unknown; payload?: Record<string, { entity?: Record<string, unknown> } | undefined> };
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw httpError(400, "WEBHOOK_BODY_INVALID", "Invalid webhook body");
      }
      const event = typeof body.event === "string" && EVENT_NAME.test(body.event) ? body.event : "unknown";
      const headerId = headers["x-razorpay-event-id"];
      const eventId = typeof headerId === "string" && EVENT_ID.test(headerId) ? headerId : `sha256_${createHash("sha256").update(rawBody).digest("hex").slice(0, 48)}`;
      const paymentEntity = body.payload?.payment?.entity;
      const refundEntity = body.payload?.refund?.entity;
      const orderEntity = body.payload?.order?.entity;
      const paymentId = [paymentEntity?.id, refundEntity?.payment_id].find((id): id is string => typeof id === "string" && PAYMENT_ID.test(id)) ?? null;
      const providerOrderId = typeof orderEntity?.id === "string" && ORDER_ID.test(orderEntity.id) ? orderEntity.id : null;

      const row = await prisma.paymentWebhookEvent.upsert({ where: { eventId }, create: { eventId, event, providerPaymentId: paymentId }, update: { attempts: { increment: 1 } }, select: { id: true, processedAt: true } });
      if (event === "refund.failed" && paymentId) {
        // The refund list read below also records this; this keeps the record even if Razorpay can't be reached now.
        await prisma.payment.updateMany({ where: { providerPaymentId: paymentId }, data: { lastErrorCode: "REFUND_FAILED", lastErrorReason: "refund_failed" } });
      }
      if (row.processedAt) return { duplicate: true, outcomes: [] };

      let outcomes: PaymentOutcome[] = [];
      const relevant = event.startsWith("payment.") || event.startsWith("refund.") || event === "order.paid";
      if (relevant && (paymentId || providerOrderId)) {
        const gateway = client();
        if (paymentId) outcomes = [(await settle(gateway, await gateway.fetchPayment(paymentId))).outcome];
        else if (providerOrderId && (await prisma.payment.count({ where: { providerOrderId, mode: currentMode() } })) > 0) outcomes = await syncGatewayOrder(gateway, providerOrderId);
      }
      await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { processedAt: new Date() } });
      options.log?.info({ eventId, event, outcomes }, "Payment webhook processed");
      return { duplicate: false, outcomes };
    },

    // ---- background work (scripts/payment-worker.ts) ----------------------------------------------------------

    // Reads back gateway orders whose outcome this system has not seen yet (a closed tab, a lost callback, a missed
    // webhook), and recent captured payments for refunds made in the Razorpay dashboard.
    async reconcile(limit = 25) {
      const now = Date.now();
      const mode = currentMode();
      const rows = await prisma.payment.findMany({
        where: {
          mode,
          OR: [
            { status: { in: ["CREATED", "FAILED", "AUTHORIZED"] }, createdAt: { lt: new Date(now - 2 * 60_000), gt: new Date(now - 3 * 24 * 60 * 60_000) }, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now - 5 * 60_000) } }] },
            { status: { in: ["CAPTURED", "PARTIALLY_REFUNDED"] }, capturedAt: { gt: new Date(now - 30 * 24 * 60 * 60_000) }, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now - 6 * 60 * 60_000) } }] },
          ],
        },
        // Never-synced rows first (MySQL sorts NULL before any date in ascending order).
        orderBy: { lastSyncedAt: "asc" },
        take: limit,
        select: { id: true, providerOrderId: true },
      });
      const gateway = client();
      const tally: { synced: number; errors: number; [outcome: string]: number } = { synced: 0, errors: 0 };
      for (const row of rows) {
        try {
          for (const outcome of await syncGatewayOrder(gateway, row.providerOrderId)) tally[outcome] = (tally[outcome] ?? 0) + 1;
          tally.synced++;
        } catch (error) {
          tally.errors++;
          options.log?.warn({ paymentId: row.id, err: { code: (error as { code?: unknown }).code } }, "Payment reconcile failed");
        }
      }
      return { checked: rows.length, ...tally };
    },

    // Cancels orders left unpaid past ORDER_PAYMENT_TTL_MINUTES plus EXPIRY_GRACE_MS and releases their stock. Each
    // order's gateway orders are read back first: an order with money received (or a gateway that can't be reached) is
    // never cancelled here.
    async expireUnpaidOrders(limit = 25) {
      const cutoff = new Date(Date.now() - ttlMs() - EXPIRY_GRACE_MS);
      const mode = currentMode();
      const due = await prisma.retailOrder.findMany({ where: { status: "PENDING", paymentStatus: "UNPAID", createdAt: { lt: cutoff } }, orderBy: { createdAt: "asc" }, take: limit, select: { id: true, payments: { select: { providerOrderId: true, mode: true } } } });
      const tally = { due: due.length, expired: 0, kept: 0, errors: 0 };
      let gateway: RazorpayClient | null = null;
      for (const candidate of due) {
        try {
          if (candidate.payments.length > 0) {
            gateway ??= client();
            for (const payment of candidate.payments) {
              // Created under the other key mode: it can't be read back with these keys. A test-mode gateway order
              // moves no real money, so it doesn't block expiry; an unreadable live one does (left for a person).
              if (payment.mode !== mode) {
                if (payment.mode === "live") throw Object.assign(new Error("Live gateway order can't be checked with test keys"), { code: "PAYMENT_MODE_MISMATCH" });
                continue;
              }
              await syncGatewayOrder(gateway, payment.providerOrderId);
            }
          }
          const notification = await retryOnConflict(() => prisma.$transaction(async (tx) => {
            if (!(await lockOrder(tx, candidate.id))) return null;
            const order = await tx.retailOrder.findUniqueOrThrow({ where: { id: candidate.id }, include: { ...orderWithItems, payments: { select: { status: true, mode: true } } } });
            if (order.status !== "PENDING" || order.paymentStatus !== "UNPAID" || order.createdAt >= cutoff) return null;
            if (order.payments.some((payment) => RANK[payment.status] > 0 && payment.mode === "live")) return null; // money moved: leave it to reconcile/review
            if (order.payments.some((payment) => RANK[payment.status] > 0 && payment.mode === mode)) return null;
            await releaseReservation(tx, order.items);
            const cancelled = presentOrder(await tx.retailOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" }, include: orderInclude }));
            return enqueueOrderEmail(tx, order.customer.userId, order.id, "cancelled", (customerName) =>
              orderCancelledEmail({ id: cancelled.id, customerName, items: emailParts(cancelled).items, total: cancelled.total, cancelledAt: cancelled.updatedAt, reason: "payment_expired" }),
            );
          }));
          if (notification) {
            tally.expired++;
            await outbox.dispatch(notification);
          } else tally.kept++;
        } catch (error) {
          tally.errors++;
          options.log?.warn({ orderId: candidate.id, err: { code: (error as { code?: unknown }).code } }, "Unpaid order expiry skipped");
        }
      }
      return tally;
    },

    // Before a customer cancels an order that has gateway orders, read them back from Razorpay and apply what happened,
    // so money that reached Razorpay but not yet this system blocks the cancellation (PAYMENT_IN_PROGRESS) instead of
    // landing on a cancelled order. If Razorpay can't be reached, the cancellation is refused rather than guessed.
    async syncBeforeCustomerCancel(userId: string, orderId: string) {
      const payments = await prisma.payment.findMany({ where: { orderId, order: { customer: { userId } } }, select: { providerOrderId: true, mode: true } });
      if (payments.length === 0) return;
      // A live gateway order can't be checked with test keys: refuse rather than guess (test ones move no real money).
      const mode = currentMode();
      if (payments.some((payment) => payment.mode === "live" && mode !== "live")) throw httpError(409, "PAYMENT_STATUS_UNKNOWN", "This order's payment can't be checked right now; please contact us");
      const gateway = client();
      for (const payment of payments) if (payment.mode === mode) await syncGatewayOrder(gateway, payment.providerOrderId).catch(gatewayError);
    },

    // ---- admin ------------------------------------------------------------------------------------------------

    // `attention`: payments a person must act on (money flagged for review, or a refund Razorpay reported failed).
    async adminListPayments(query: { needsReview?: boolean; attention?: boolean; status?: PaymentStatus; page: number; limit: number }) {
      const where: Prisma.PaymentWhereInput = {
        ...(query.needsReview !== undefined ? { needsReview: query.needsReview } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.attention ? { OR: [{ needsReview: true }, { lastErrorCode: "REFUND_FAILED" }] } : {}),
      };
      const [data, total] = await prisma.$transaction([
        prisma.payment.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
        prisma.payment.count({ where }),
      ]);
      return { data, total };
    },

    // Reads one gateway order back from Razorpay now (e.g. after a refund in the dashboard).
    async adminSyncPayment(paymentId: string) {
      const payment = await prisma.payment.findUnique({ where: { id: paymentId }, select: { providerOrderId: true, mode: true } });
      if (!payment) throw httpError(404, "NOT_FOUND", "Payment not found");
      if (payment.mode !== currentMode()) throw httpError(409, "PAYMENT_MODE_MISMATCH", `This payment was made with ${payment.mode} keys and can't be read with the current ones`);
      await syncGatewayOrder(client(), payment.providerOrderId).catch(gatewayError);
      return prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
