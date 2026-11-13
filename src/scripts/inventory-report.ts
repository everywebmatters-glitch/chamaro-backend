import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renderMarkdown } from "../services/inventory-migration.js";

// Shared by the inventory scripts: parses --apply, --report=<path> and --only=<ids> and writes the report as
// <path>.json and <path>.md. Reports hold product ids and names, stock numbers and order ids only: no customer data.
export function parseArgs(argv: string[]): { apply: boolean; report: string | null; only?: string[] } {
  const apply = argv.includes("--apply");
  const reportArg = argv.find((arg) => arg.startsWith("--report="));
  // --only=<productId>[,<productId>...]: limit the run to these products (default: all).
  const onlyArg = argv.find((arg) => arg.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length).split(",").map((id) => id.trim()).filter(Boolean) : undefined;
  return { apply, report: reportArg ? reportArg.slice("--report=".length) : null, ...(only?.length ? { only } : {}) };
}

// Reports are evidence: an existing report is never overwritten (choose a new path per run).
export function writeReport(path: string | null, report: Parameters<typeof renderMarkdown>[0]): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.json`, JSON.stringify(report, null, 2), { flag: "wx" });
  writeFileSync(`${path}.md`, renderMarkdown(report), { flag: "wx" });
}
