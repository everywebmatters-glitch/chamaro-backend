import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { RollbackArchive } from "../services/inventory-migration.js";

// Durable, append-only archive for the inventory rollback (JSON Lines). Every record is written and flushed to disk
// (fsync) before record() returns, so the rows a transaction is about to delete are on disk first. The file is created
// exclusively: an existing archive is never overwritten or truncated, and nothing here ever deletes it.
export type ArchiveSummary = { path: string; entries: number; bytes: number; sha256: string };

export function openArchive(path: string): RollbackArchive & { close(): ArchiveSummary } {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx"); // fails if the file exists
  const hash = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  let closed = false;
  return {
    record(entry: object) {
      if (closed) throw new Error("Archive is closed");
      const line = `${JSON.stringify(entry)}\n`;
      const buffer = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
      fsyncSync(fd);
      hash.update(buffer);
      entries++;
      bytes += buffer.length;
    },
    close() {
      if (!closed) { fsyncSync(fd); closeSync(fd); closed = true; }
      return { path, entries, bytes, sha256: hash.digest("hex") };
    },
  };
}

export type ArchiveVerification = { ok: boolean; sha256: string; entries: number; problems: string[] };

// Re-reads the archive from disk and checks it against what the rollback reports as committed: the checksum matches,
// every committed product (and the clear step, if committed) has a prepared record before its commit marker, and the
// archived ledger row ids are exactly the ids the database transaction deleted.
export function verifyArchive(path: string, expected: { sha256: string; committed: { scope: string; movementIds: string[] }[] }): ArchiveVerification {
  const content = readFileSync(path);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const problems: string[] = [];
  if (sha256 !== expected.sha256) problems.push(`checksum ${sha256} ≠ ${expected.sha256} recorded while writing`);
  const records = content.toString("utf8").split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as { type: string; phase: string; scope: string; movements?: { id: string }[] }; } catch { problems.push(`line ${index + 1} is not valid JSON`); return null; }
  }).filter((record): record is NonNullable<typeof record> => record !== null);
  for (const item of expected.committed) {
    const committedAt = records.findIndex((record) => record.phase === "committed" && record.scope === item.scope);
    if (committedAt === -1) { problems.push(`${item.scope}: no commit marker in the archive`); continue; }
    const prepared = records.slice(0, committedAt).reverse().find((record) => record.phase === "prepared" && record.scope === item.scope);
    if (!prepared) { problems.push(`${item.scope}: committed without a prepared record before it`); continue; }
    const archivedIds = (prepared.movements ?? []).map((movement) => movement.id).sort();
    const deletedIds = [...item.movementIds].sort();
    if (archivedIds.length !== deletedIds.length || archivedIds.some((id, index) => id !== deletedIds[index])) problems.push(`${item.scope}: archived ids (${archivedIds.length}) ≠ deleted ids (${deletedIds.length})`);
  }
  return { ok: problems.length === 0, sha256, entries: records.length, problems };
}
