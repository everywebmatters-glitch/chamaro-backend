// Inventory backfill (expand stage tooling). DRY RUN unless --apply is given.
//   node dist/src/scripts/inventory-backfill.js [--apply] [--report=reports/backfill-<when>]
// Converts each product with a stock row from the legacy numbers to on-hand/reserved, keeps available stock identical,
// classifies orders and opens the ledger. Products that don't reconcile are skipped and reported, never repaired.
// Safe to run again: migrated products are only converged (orders the previous code placed, shipped or cancelled since).
// Exit code 1 when any product was skipped with a problem or available stock would change.
import { createScriptPrisma } from "./prisma.js";
import { runBackfill } from "../services/inventory-migration.js";
import { parseArgs, writeReport } from "./inventory-report.js";

async function main() {
  const { apply, report, only } = parseArgs(process.argv.slice(2));
  const prisma = createScriptPrisma();
  try {
    const result = await runBackfill(prisma, { apply, only });
    writeReport(report, result);
    console.log(JSON.stringify({ severity: "INFO", message: `Inventory backfill ${apply ? "applied" : "dry run"}`, ...result.summary, ordersSettled: result.ordersSettled.length, productsWithoutInventory: result.productsWithoutInventory.length, ordersMarkedNone: result.ordersMarkedNone }));
    if (result.summary.skipped > 0 || result.summary.availableChanged > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ severity: "ERROR", message: "Inventory backfill failed", errorName: error?.name, errorCode: error?.code }));
  process.exitCode = 1;
});
