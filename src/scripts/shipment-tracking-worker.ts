// Shipment tracking worker: one pass over Delhivery shipments that are still moving, then exit. Meant to run as a
// Cloud Run job started by Cloud Scheduler (see deploy/cloudrun/shipment-tracking-job.yaml); it is not deployed yet.
//
//   node dist/src/scripts/shipment-tracking-worker.js
//
// Reads each active shipment's status from Delhivery's tracking API (30 waybills per call, at most MAX_PASSES calls,
// well inside Delhivery's 750 calls per 5 minutes) and applies it, recording the shipped/delivered emails exactly once.
// With DELHIVERY_ENABLED unset it does nothing and exits successfully.
import { createScriptPrisma } from "./prisma.js";
import { shippingEnabled } from "../config/delhivery.js";
import { createShipmentService } from "../services/shipment.service.js";

// Structured lines for Cloud Logging: ids and error codes only, never addresses, tokens or response bodies.
const line = (severity: string) => (fields: object, message: string) => console.log(JSON.stringify({ severity, message, ...fields }));
const log = { info: line("INFO"), warn: line("WARNING"), error: line("ERROR") };

const MAX_PASSES = 10;

async function run() {
  if (!shippingEnabled()) {
    log.info({}, "Shipment tracking worker: shipping is not enabled; nothing to do");
    return;
  }
  const prisma = createScriptPrisma();
  try {
    const service = createShipmentService(prisma, { log: log as never });
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const result = await service.syncDue();
      log.info({ pass, ...result }, "Shipment tracking pass finished");
      if (result.requested < 30) break;
    }
  } finally {
    await prisma.$disconnect();
  }
}

run().catch((error) => {
  log.error({ err: { name: error instanceof Error ? error.name : "unknown", code: (error as { code?: unknown }).code } }, "Shipment tracking worker failed");
  process.exitCode = 1;
});
