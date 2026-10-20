// Email outbox worker: one pass over the outbox, then exit. Production runs it as the Cloud Run job
// chamaro-email-outbox (deploy/cloudrun/email-outbox-job.yaml), started every few minutes by Cloud Scheduler.
//
//   node dist/src/scripts/email-outbox-worker.js
//       Retries notifications whose first attempt failed or never finished (see services/email-outbox.service.ts
//       for the rules). Only email rows change; orders, payments and accounts are never touched.
//
//   node dist/src/scripts/email-outbox-worker.js --self-test delivered@resend.dev
//       Records one self-test notification to a Resend test address (never a real mailbox), sends it, then records
//       and sends the same event again to show it is neither stored nor delivered twice. Prints the outcome.
//
// Runs that overlap are safe: each notification is claimed by one sender at a time.
import { createScriptPrisma } from "./prisma.js";
import { createEmailOutbox, enqueueNotification } from "../services/email-outbox.service.js";
import { outboxSelfTestEmail } from "../services/email.service.js";

// Structured lines for Cloud Logging. Callers pass ids and provider error names only, never addresses or content.
const line = (severity: string) => (fields: object, message: string) => console.log(JSON.stringify({ severity, message, ...fields }));
const log = { info: line("INFO"), warn: line("WARNING"), error: line("ERROR") };

// Resend's test inboxes (delivered@, bounced@, complained@resend.dev ...): accepted by the API, delivered to nobody.
const RESEND_TEST_ADDRESS = /^[a-z0-9._+-]+@resend\.dev$/;
// Passes per run, each of up to BATCH rows, so one run is bounded even with a large backlog.
const BATCH = 25;
const MAX_PASSES = 4;

async function selfTest(address: string) {
  if (!RESEND_TEST_ADDRESS.test(address)) throw new Error("--self-test only sends to a Resend test address (...@resend.dev)");
  const prisma = createScriptPrisma();
  try {
    const outbox = createEmailOutbox(prisma, { log });
    const createdAt = new Date();
    const eventKey = `selftest:${createdAt.toISOString()}`;
    const record = () => enqueueNotification(prisma, { eventKey, kind: "OUTBOX_SELF_TEST", recipient: { userId: null, email: address, verified: true }, message: outboxSelfTestEmail(eventKey, createdAt) });

    const first = await record();
    const firstAttempt = await outbox.attempt(first.id);
    const second = await record();
    const secondAttempt = await outbox.attempt(second.id);
    const row = await prisma.emailNotification.findUniqueOrThrow({ where: { id: first.id }, select: { status: true, attempts: true, providerMessageId: true, lastErrorName: true, lastErrorStatus: true, sentAt: true } });
    const rows = await prisma.emailNotification.count({ where: { eventKey } });
    log.info({
      selfTest: {
        eventKey,
        firstAttempt,
        secondRecordSameRow: second.id === first.id,
        secondAttempt,
        rowsForEvent: rows,
        status: row.status,
        attempts: row.attempts,
        providerAccepted: Boolean(row.providerMessageId),
        lastErrorName: row.lastErrorName,
        lastErrorStatus: row.lastErrorStatus,
      },
    }, "Email outbox self-test finished");
    const passed = firstAttempt === "SENT" && second.id === first.id && secondAttempt === "NOT_CLAIMED" && rows === 1 && row.status === "SENT" && row.attempts === 1;
    if (!passed) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

async function drain() {
  const prisma = createScriptPrisma();
  try {
    const outbox = createEmailOutbox(prisma, { log });
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const result = await outbox.drain(BATCH);
      log.info({ pass, ...result }, "Email outbox pass finished");
      // A full batch that was all claimed elsewhere or retried would only repeat; stop when nothing more is due.
      if (result.due < BATCH || result.SENT + result.FAILED === 0) break;
    }
  } finally {
    await prisma.$disconnect();
  }
}

const args = process.argv.slice(2);
const run = args[0] === "--self-test" ? selfTest(args[1] ?? "") : args.length === 0 ? drain() : Promise.reject(new Error("usage: email-outbox-worker.js [--self-test <address>@resend.dev]"));
// Only the error's name and code: a database error message can quote connection details or row values.
run.catch((error) => {
  const usage = error instanceof Error && /^(usage:|--self-test only)/.test(error.message) ? error.message : undefined;
  log.error({ err: { name: error instanceof Error ? error.name : "unknown", code: (error as { code?: unknown }).code, usage } }, "Email outbox worker failed");
  process.exitCode = 1;
});
