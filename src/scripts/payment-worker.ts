// Payment worker: one pass, then exit. Meant to run as a Cloud Run job every few minutes (Cloud Scheduler), like the
// email outbox worker.
//
//   node dist/src/scripts/payment-worker.js
//       1. Reads back from Razorpay the gateway orders whose outcome this system hasn't seen (lost checkout callback,
//          missed webhook) and recent captured payments (refunds made in the Razorpay dashboard), and applies them.
//       2. Cancels orders still unpaid after ORDER_PAYMENT_TTL_MINUTES and releases their stock, after reading their
//          payments back first: an order with money received is never cancelled here.
//
// Runs that overlap are safe: every change locks the order row and payment states only move forward.
import { createScriptPrisma } from "./prisma.js";
import { createPaymentService } from "../services/payment.service.js";

// Structured lines for Cloud Logging. Callers pass ids and fixed codes only, never customer details or secrets.
const line = (severity: string) => (fields: object, message: string) => console.log(JSON.stringify({ severity, message, ...fields }));
const log = { info: line("INFO"), warn: line("WARNING"), error: line("ERROR"), debug: line("DEBUG") };

async function run() {
  const prisma = createScriptPrisma();
  try {
    const payments = createPaymentService(prisma, { log: log as never });
    const reconciled = await payments.reconcile();
    log.info(reconciled, "Payment reconcile pass finished");
    const expired = await payments.expireUnpaidOrders();
    log.info(expired, "Unpaid order expiry pass finished");
    if (reconciled.errors > 0 || expired.errors > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Only the error's name and code: a database or HTTP error message can quote connection details or row values.
run().catch((error) => {
  log.error({ err: { name: error instanceof Error ? error.name : "unknown", code: (error as { code?: unknown }).code } }, "Payment worker failed");
  process.exitCode = 1;
});
