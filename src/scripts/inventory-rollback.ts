// Inventory rollback to the legacy numbers. DRY RUN (pure read) unless --apply is given.
//   node dist/src/scripts/inventory-rollback.js [--apply --report=reports/rollback-<when>] [--only=<ids>]
// For every product with a migration snapshot or dispatch (COMMIT) movements: quantity and reservedQuantity get back
// the units of orders dispatched before the migration (0 without a snapshot) plus those committed since, which is
// exactly what the legacy model shows. Then the remaining ledger rows and order stock states are cleared.
// --apply requires --report: each product's ledger rows and snapshot are first appended and flushed to the archive
// <report>.ledger-archive.jsonl (created new; an existing archive is never overwritten or deleted), then deleted by id
// in the same database transaction. A failure stops the run; the report says what was committed, what failed and what
// was not started, and the archive keeps everything that was prepared. Refused while variant-level stock exists.
// Run it with the previous API revision serving and the schedulers paused (see deploy/cloudrun/README.md).
import { createScriptPrisma } from "./prisma.js";
import { committedScopes, rollbackMigration, type RollbackReport } from "../services/inventory-migration.js";
import { openArchive, verifyArchive, type ArchiveSummary, type ArchiveVerification } from "./inventory-archive.js";
import { parseArgs, writeReport } from "./inventory-report.js";

const log = (severity: string, message: string, fields: object = {}) => console.log(JSON.stringify({ severity, message, ...fields }));

async function main() {
  const { apply, report, only } = parseArgs(process.argv.slice(2));
  if (apply && !report) {
    log("ERROR", "Inventory rollback refused: --apply needs --report=<path> (the ledger archive is written next to the report)");
    process.exitCode = 2;
    return;
  }
  const archivePath = apply ? `${report}.ledger-archive.jsonl` : null;
  let archive: ReturnType<typeof openArchive> | null = null;
  try {
    archive = archivePath ? openArchive(archivePath) : null;
  } catch (error) {
    log("ERROR", "Inventory rollback refused: the archive could not be created (an existing archive is never overwritten)", { archive: archivePath, errorCode: (error as { code?: string }).code });
    process.exitCode = 2;
    return;
  }
  const prisma = createScriptPrisma();
  let result: RollbackReport | { kind: "rollback"; status: "error"; error: string } ;
  let summary: ArchiveSummary | null = null;
  let verification: ArchiveVerification | null = null;
  try {
    result = await rollbackMigration(prisma, { apply, only, ...(archive ? { archive } : {}) });
  } catch (error) {
    result = { kind: "rollback", status: "error", error: String((error as Error)?.message ?? error).slice(0, 300) };
  } finally {
    await prisma.$disconnect();
    if (archive) summary = archive.close();
  }
  if (summary && "products" in result) verification = verifyArchive(summary.path, { sha256: summary.sha256, committed: committedScopes(result) });
  if ("products" in result) writeReport(report, { ...result, archive: summary, verification } as never);
  else if (report) writeReport(report, { kind: "rollback", apply, generatedAt: new Date().toISOString(), status: "partial", refused: null, products: [], failed: { scope: "run", error: result.error }, notStarted: [], cleared: { status: "not run", movements: 0, orders: 0, movementIds: [] }, archive: summary, verification } as never);
  const status = "products" in result ? result.status : "error";
  log(status === "complete" || status === "planned" ? "INFO" : "ERROR", `Inventory rollback ${apply ? "applied" : "dry run"}: ${status}`, { products: "products" in result ? result.products.length : 0, archive: summary, verification: verification && { ok: verification.ok, problems: verification.problems } });
  if (status !== "complete" && status !== "planned") process.exitCode = 1;
  if (verification && !verification.ok) process.exitCode = 1;
}

main().catch((error) => {
  log("ERROR", "Inventory rollback failed", { errorName: error?.name, errorCode: error?.code });
  process.exitCode = 1;
});
