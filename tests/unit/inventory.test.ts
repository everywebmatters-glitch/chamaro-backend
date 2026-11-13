// Inventory expand stage: pure rules (no database). Order classification for the backfill, availability, and the
// 503 TRY_AGAIN mapping for connection-pool acquisition failures (error shapes copied from Prisma 7 + MariaDB adapter
// output observed on 2026-11-13) next to the answers that must not change.
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { classifyOrder } from "../../src/services/inventory-migration.js";
import { availableUnits } from "../../src/services/inventory.service.js";
import { errorResponse, isPoolAcquisitionFailure, registerErrorHandler } from "../../src/middleware/error.middleware.js";
import { httpError } from "../../src/shared/http.js";

const facts = (status: string, trackingNumber: string | null = null, pickedUpAt: Date | null = null) => ({ status, trackingNumber, pickedUpAt });

test("backfill classification: dispatched → COMMITTED, cancelled → RELEASED, everything else RESERVED", () => {
  assert.equal(classifyOrder(facts("SHIPPED")), "COMMITTED");
  assert.equal(classifyOrder(facts("COMPLETED")), "COMMITTED");
  assert.equal(classifyOrder(facts("CONFIRMED", "AWB123")), "COMMITTED", "a tracking number means it left");
  assert.equal(classifyOrder(facts("PROCESSING", null, new Date())), "COMMITTED", "a courier pick-up scan means it left");
  assert.equal(classifyOrder(facts("CANCELLED")), "RELEASED");
  for (const status of ["PENDING", "CONFIRMED", "PROCESSING"]) assert.equal(classifyOrder(facts(status)), "RESERVED", status);
});

test("available units are never negative; no stock row means not stock-checked", () => {
  assert.equal(availableUnits({ onHand: 5, reserved: 2 }), 3);
  assert.equal(availableUnits({ onHand: 2, reserved: 5 }), 0);
  assert.equal(availableUnits(null), null);
});

// Observed shapes.
const poolQueryTimeout = { name: "PrismaClientKnownRequestError", code: "P2010", message: "Raw query failed. Code: `45028`. Message: `pool timeout: failed to retrieve a connection from pool after 809ms`", meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: "45028", originalMessage: "pool timeout: failed to retrieve a connection from pool after 809ms", kind: "mysql", code: 45028, state: "HY000" } } } };
const transactionNotStarted = { name: "PrismaClientKnownRequestError", code: "P2028", message: "Transaction API error: Unable to start a transaction in the given time.", meta: {} };
const unrelatedQueryError = { name: "PrismaClientKnownRequestError", code: "P2010", message: "Raw query failed. Code: `1146`. Message: `Table 'chamaro_test.no_such_table' doesn't exist`", meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: "1146", kind: "TableDoesNotExist" } } } };
const transactionExpired = { name: "PrismaClientKnownRequestError", code: "P2028", message: "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.", meta: {} };

test("only identifiable pool-acquisition failures become 503 TRY_AGAIN", () => {
  assert.equal(isPoolAcquisitionFailure(poolQueryTimeout), true);
  assert.equal(isPoolAcquisitionFailure(transactionNotStarted), true);
  assert.equal(isPoolAcquisitionFailure({ name: "PrismaClientKnownRequestError", code: "P2024", message: "Timed out fetching a new connection from the connection pool." }), true);
  assert.deepEqual(errorResponse(poolQueryTimeout), { statusCode: 503, code: "TRY_AGAIN", message: "The service is busy right now; please try again in a moment" });
  assert.equal(errorResponse(transactionNotStarted).statusCode, 503);
  // Everything else keeps its existing answer.
  assert.equal(isPoolAcquisitionFailure(unrelatedQueryError), false);
  assert.equal(errorResponse(unrelatedQueryError).statusCode, 500, "other SQL errors stay 500");
  assert.equal(isPoolAcquisitionFailure(transactionExpired), false);
  assert.equal(errorResponse(transactionExpired).statusCode, 500, "a transaction that expired part-way is not a pool failure");
  assert.equal(isPoolAcquisitionFailure({ name: "Error", message: "pool timeout" }), false, "the message alone is not enough");
});

test("existing answers are unchanged: 409 stock, 409 conflict, 400 validation, 401, 403, 404", () => {
  assert.deepEqual(errorResponse(httpError(409, "INSUFFICIENT_STOCK", "Not enough stock for Chair") as never), { statusCode: 409, code: "INSUFFICIENT_STOCK", message: "Not enough stock for Chair" });
  assert.equal(errorResponse({ name: "PrismaClientKnownRequestError", code: "P2034", message: "deadlock" }).code, "CONFLICT_RETRY");
  assert.equal(errorResponse({ message: "bad", validation: [{ instancePath: "/x", keyword: "type" }] }).statusCode, 400);
  assert.equal(errorResponse(Object.assign(new Error("Authentication required"), { statusCode: 401, code: "UNAUTHENTICATED" })).statusCode, 401);
  assert.equal(errorResponse(Object.assign(new Error("Insufficient permissions"), { statusCode: 403, code: "FORBIDDEN" })).statusCode, 403);
  assert.equal(errorResponse({ name: "PrismaClientKnownRequestError", code: "P2025", message: "x" }).statusCode, 404);
});

test("HTTP: a pool failure is answered 503 TRY_AGAIN with Retry-After; other failures are not", async () => {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.get("/pool", async () => { throw Object.assign(new Error(poolQueryTimeout.message), poolQueryTimeout); });
  app.get("/stock", async () => { throw httpError(409, "INSUFFICIENT_STOCK", "Not enough stock for Chair"); });
  app.get("/other", async () => { throw Object.assign(new Error(unrelatedQueryError.message), unrelatedQueryError); });
  const pool = await app.inject({ method: "GET", url: "/pool" });
  assert.equal(pool.statusCode, 503);
  assert.equal(pool.headers["retry-after"], "2");
  assert.equal(pool.json().error.code, "TRY_AGAIN");
  const stock = await app.inject({ method: "GET", url: "/stock" });
  assert.equal(stock.statusCode, 409);
  assert.equal(stock.headers["retry-after"], undefined);
  const other = await app.inject({ method: "GET", url: "/other" });
  assert.equal(other.statusCode, 500);
  assert.equal(other.json().error.message, "An unexpected error occurred", "no SQL details leak");
  await app.close();
});
