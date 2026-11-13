// Inventory reconciliation (read-only; never writes).
//   node dist/src/scripts/inventory-reconcile.js [--report=reports/reconcile-<when>]
// Checks every stock row: non-negative, reserved within on hand, reserved equal to what open orders hold, and (once
// migrated) the row equal to its ledger. Lists products without a stock row. Exit code 1 on any violation.
import { createScriptPrisma } from "./prisma.js";
import { reconcile } from "../services/inventory-migration.js";
import { parseArgs, writeReport } from "./inventory-report.js";

async function main() {
  const { report, only } = parseArgs(process.argv.slice(2));
  const prisma = createScriptPrisma();
  try {
    const result = await reconcile(prisma, { only });
    writeReport(report, result);
    console.log(JSON.stringify({ severity: result.summary.violations ? "WARNING" : "INFO", message: "Inventory reconciliation", ...result.summary, productsWithoutInventory: result.productsWithoutInventory.length }));
    if (result.summary.violations > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ severity: "ERROR", message: "Inventory reconciliation failed", errorName: error?.name, errorCode: error?.code }));
  process.exitCode = 1;
});
