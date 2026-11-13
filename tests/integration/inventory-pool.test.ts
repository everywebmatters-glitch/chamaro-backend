// The 503 TRY_AGAIN mapping against REAL connection-pool acquisition failures (Prisma 7 + MariaDB adapter), produced
// on the isolated local test database with a one-connection pool; unrelated database errors must stay 500.
import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();
const fx = await import("../helpers/inventory-fixtures.js");
const { errorResponse } = await import("../../src/middleware/error.middleware.js");

const tiny = skipReason ? (undefined as never) : fx.testPrisma(1, 800);
after(async () => { if (!skipReason) await tiny.$disconnect(); });

test("real pool exhaustion → 503 TRY_AGAIN; a real unrelated SQL error → 500", { skip: skipReason }, async () => {
  // Hold the only connection for 3 s.
  const holder = tiny.$transaction(async (tx) => { await tx.$queryRaw`SELECT SLEEP(3)`; }, { timeout: 15_000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const queryError = await tiny.$queryRaw`SELECT 1`.then(() => null, (error) => error);
  const transactionError = await tiny.$transaction(async (tx) => { await tx.$queryRaw`SELECT 1`; }, { maxWait: 500 }).then(() => null, (error) => error);
  await holder;
  const unrelated = await tiny.$queryRaw`SELECT * FROM no_such_table_for_this_test`.then(() => null, (error) => error);

  assert.ok(queryError, "the query could not get a connection");
  assert.ok(transactionError, "the transaction could not start");
  assert.deepEqual([errorResponse(queryError).statusCode, errorResponse(queryError).code], [503, "TRY_AGAIN"]);
  assert.deepEqual([errorResponse(transactionError).statusCode, errorResponse(transactionError).code], [503, "TRY_AGAIN"]);
  assert.ok(unrelated, "the unrelated query failed");
  assert.equal(errorResponse(unrelated).statusCode, 500);
  assert.equal(errorResponse(unrelated).message, "An unexpected error occurred");
});
