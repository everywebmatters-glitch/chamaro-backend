// The error handler: unchanged responses, the log level each kind of failure gets, and what may appear in the log.
// A bare Fastify app with fake errors and a captured log stream; no database, no network.
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { errorLogLevel, errorResponse, registerErrorHandler } from "../../src/middleware/error.middleware.js";
import { loggerOptions } from "../../src/config/logger.js";
import { DelhiveryError } from "../../src/providers/delhivery.provider.js";
import { httpError } from "../../src/shared/http.js";

const LEVELS: Record<number, string> = { 30: "info", 40: "warn", 50: "error" };
const SECRET_TOKEN = "delhivery-token-0123456789abcdef";
const CUSTOMER_EMAIL = "asha.rao@example.test";

// A Prisma-shaped error (as the client throws them), with the driver message quoting the offending value.
function prismaError(code: string, name = "PrismaClientKnownRequestError") {
  return Object.assign(new Error(`\nInvalid \`prisma.user.create()\` invocation:\n\nUnique constraint failed on the constraint: \`User_email_key\` value '${CUSTOMER_EMAIL}'`), {
    name,
    code,
    meta: { modelName: "User", driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: "1062", originalMessage: `Duplicate entry '${CUSTOMER_EMAIL}' for key 'User_email_key'`, kind: "UniqueConstraintViolation", constraint: { index: "User_email_key" } } } },
  });
}

const failures: Record<string, () => unknown> = {
  "not-found": () => httpError(404, "NOT_FOUND", "Order not found"),
  forbidden: () => httpError(403, "FORBIDDEN", "Insufficient permissions"),
  "not-paid": () => httpError(409, "ORDER_NOT_PAID", "Only orders with a verified online payment can be shipped"),
  "webhook-forged": () => httpError(401, "WEBHOOK_UNAUTHORIZED", "Webhook authentication failed"),
  "pin-unserviceable": () => httpError(409, "PINCODE_NOT_SERVICEABLE", "Delhivery does not deliver prepaid orders to this PIN code"),
  "rate-limited": () => Object.assign(new Error("Rate limit exceeded"), { statusCode: 429, code: "FST_ERR_RATE_LIMIT" }),
  duplicate: () => prismaError("P2002"),
  deadlock: () => prismaError("P2034"),
  "shipping-disabled": () => Object.assign(new Error("Courier shipping is not enabled"), { statusCode: 503, code: "SHIPPING_DISABLED", expose: true }),
  "delhivery-not-configured": () => Object.assign(new Error("Delhivery shipping is not configured: DELHIVERY_API_TOKEN is not set"), { statusCode: 503, code: "DELHIVERY_NOT_CONFIGURED", expose: true }),
  "delhivery-down": () => new DelhiveryError("DELHIVERY_UNAVAILABLE", null, "unknown"),
  "delhivery-rejected": () => new DelhiveryError("DELHIVERY_REJECTED", 200, "not_created", "ClientWarehouse matching query does not exist."),
  "delhivery-auth": () => new DelhiveryError("DELHIVERY_AUTH_FAILED", 401, "not_created"),
  "db-unreachable": () => prismaError("P1001", "PrismaClientInitializationError"),
  bug: () => new TypeError("Cannot read properties of undefined (reading 'total')"),
  "unexposed-503": () => Object.assign(new Error("internal detail"), { statusCode: 503, code: "SOMETHING" }),
};

async function harness() {
  const lines: Record<string, any>[] = [];
  const raw: string[] = [];
  const app = Fastify({ ...(loggerOptions as object), logger: { ...(loggerOptions as object), level: "info", stream: { write: (line: string) => { raw.push(line); lines.push(JSON.parse(line)); } } }, ajv: { customOptions: { removeAdditional: false } } });
  registerErrorHandler(app);
  app.post("/fail/:kind", async (request) => { throw failures[(request.params as { kind: string }).kind](); });
  app.post("/validated", { schema: { body: { type: "object", additionalProperties: false, required: ["email"], properties: { email: { type: "string", format: "email" } } } } }, async () => ({ ok: true }));
  await app.ready();
  return { app, lines, raw };
}

// The one log line the error handler wrote for the last request.
const handlerLine = (lines: Record<string, any>[]) => lines.filter((line) => /^Request (failed|refused)/.test(line.msg)).at(-1)!;

test("responses are exactly what they were before: status, code and message", () => {
  const cases: [unknown, number, string, string][] = [
    [failures["not-found"](), 404, "NOT_FOUND", "Order not found"],
    [failures.duplicate(), 409, "DUPLICATE_RECORD", "A record with that value already exists"],
    [prismaError("P2003"), 409, "RECORD_IN_USE", "This record is referenced by other records and cannot be deleted"],
    [failures.deadlock(), 409, "CONFLICT_RETRY", "The request conflicted with another one; please try again"],
    [prismaError("P2025"), 404, "NOT_FOUND", "Requested record was not found"],
    [Object.assign(new Error("body/email must match format"), { statusCode: 400, code: "FST_ERR_VALIDATION", validation: [] }), 400, "VALIDATION_ERROR", "Request validation failed"],
    [failures["shipping-disabled"](), 503, "SHIPPING_DISABLED", "Courier shipping is not enabled"],
    [failures["delhivery-down"](), 502, "DELHIVERY_UNAVAILABLE", "Delhivery could not be reached or did not answer in time"],
    [failures["unexposed-503"](), 500, "SOMETHING", "An unexpected error occurred"],
    [failures["db-unreachable"](), 500, "P1001", "An unexpected error occurred"],
    [failures.bug(), 500, "INTERNAL_ERROR", "An unexpected error occurred"],
  ];
  for (const [error, statusCode, code, message] of cases) assert.deepEqual(errorResponse(error as never), { statusCode, code, message }, code);
});

test("log levels: refusals are info, notable refusals warn, failures and upstream problems error", () => {
  const level = (kind: string) => errorLogLevel(errorResponse(failures[kind]() as never));
  const expected: Record<string, string> = {
    "not-found": "info",
    forbidden: "info",
    "not-paid": "info",
    duplicate: "info",
    "webhook-forged": "warn",
    "pin-unserviceable": "warn",
    "rate-limited": "warn",
    deadlock: "warn",
    "shipping-disabled": "warn",
    "delhivery-not-configured": "error",
    "delhivery-down": "error",
    "delhivery-rejected": "error",
    "delhivery-auth": "error",
    "db-unreachable": "error",
    bug: "error",
    "unexposed-503": "error",
  };
  for (const [kind, want] of Object.entries(expected)) assert.equal(level(kind), want, kind);
});

test("through Fastify: each failure is logged once, at its level, and the response body is unchanged", async () => {
  const { app, lines } = await harness();
  const expected: Record<string, [string, number]> = {
    "not-found": ["info", 404],
    "not-paid": ["info", 409],
    duplicate: ["info", 409],
    "webhook-forged": ["warn", 401],
    "shipping-disabled": ["warn", 503],
    "delhivery-down": ["error", 502],
    "delhivery-rejected": ["error", 502],
    bug: ["error", 500],
  };
  for (const [kind, [level, status]] of Object.entries(expected)) {
    const before = lines.length;
    const response = await app.inject({ method: "POST", url: `/fail/${kind}` });
    assert.equal(response.statusCode, status, kind);
    assert.deepEqual(Object.keys(response.json()), ["success", "error"]);
    assert.deepEqual(response.json().error, { code: errorResponse(failures[kind]() as never).code, message: errorResponse(failures[kind]() as never).message });
    const written = lines.slice(before).filter((line) => /^Request (failed|refused)/.test(line.msg));
    assert.equal(written.length, 1, `${kind}: one handler line`);
    assert.equal(LEVELS[written[0].level], level, kind);
    assert.equal(written[0].statusCode, status);
  }
  await app.close();
});

test("an ordinary refusal logs only what identifies it: no stack, no message details", async () => {
  const { app, lines } = await harness();
  await app.inject({ method: "POST", url: "/fail/not-paid" });
  const line = handlerLine(lines);
  assert.equal(line.msg, "Request refused: 409 ORDER_NOT_PAID (Error)");
  assert.deepEqual([line.errorCode, line.errorName, "errorStack" in line, "errorMessage" in line, "err" in line], ["ORDER_NOT_PAID", "Error", false, false, false]);

  await app.inject({ method: "POST", url: "/validated", payload: { email: "not an email", role: "ADMIN" } });
  const validation = handlerLine(lines);
  assert.equal(LEVELS[validation.level], "info");
  assert.equal(validation.errorCode, "VALIDATION_ERROR");
  assert.equal(validation.validation.context, "body");
  assert.ok(validation.validation.failures.every((failure: object) => Object.keys(failure).join() === "path,keyword"), "paths and rules only, never the submitted values");
  await app.close();
});

test("a Delhivery failure is an error with its upstream code, status and outcome, never the token", async () => {
  const { app, lines, raw } = await harness();
  await app.inject({ method: "POST", url: "/fail/delhivery-rejected", headers: { authorization: `Token ${SECRET_TOKEN}` } });
  const line = handlerLine(lines);
  assert.equal(LEVELS[line.level], "error");
  assert.equal(line.msg, "Request failed: 502 DELHIVERY_REJECTED (DelhiveryError): Delhivery rejected the request");
  assert.deepEqual(line.upstream, { provider: "delhivery", httpStatus: 200, outcome: "not_created", remark: "ClientWarehouse matching query does not exist." });
  assert.ok(line.errorStack.startsWith("    at "), "stack frames for debugging");

  await app.inject({ method: "POST", url: "/fail/delhivery-down" });
  assert.deepEqual(handlerLine(lines).upstream, { provider: "delhivery", httpStatus: null, outcome: "unknown", remark: null });
  assert.ok(!raw.join("").includes(SECRET_TOKEN));
  await app.close();
});

test("database errors never put the offending value (customer data) in the log, at any level", async () => {
  const { app, lines, raw } = await harness();
  await app.inject({ method: "POST", url: "/fail/duplicate" });
  const duplicate = handlerLine(lines);
  assert.deepEqual([LEVELS[duplicate.level], duplicate.errorCode, duplicate.prismaCode], ["info", "DUPLICATE_RECORD", "P2002"]);

  await app.inject({ method: "POST", url: "/fail/db-unreachable" });
  const outage = handlerLine(lines);
  assert.equal(LEVELS[outage.level], "error");
  assert.equal(outage.prismaCode, "P1001");
  assert.deepEqual(outage.prismaMeta, { modelName: "User", driverKind: "UniqueConstraintViolation", driverCode: "1062", constraint: { index: "User_email_key" } });
  assert.equal("errorMessage" in outage, false, "a Prisma message can quote query values");
  assert.ok(!outage.errorStack.includes("Invalid"), "the stack is frames only");

  assert.ok(!raw.join("").includes(CUSTOMER_EMAIL), "the duplicate value appears nowhere in the log");
  await app.close();
});

test("request secrets never reach the log: Authorization header, password, OTP, token in the body", async () => {
  const { app, raw } = await harness();
  const secrets = { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.secret-jwt", password: "Correct-Horse-Battery-9", otp: "482913", token: SECRET_TOKEN };
  for (const kind of ["not-found", "bug", "delhivery-down", "webhook-forged"]) {
    await app.inject({ method: "POST", url: `/fail/${kind}`, headers: { authorization: secrets.authorization, cookie: "session=abc" }, payload: { password: secrets.password, otp: secrets.otp, token: secrets.token, email: CUSTOMER_EMAIL } });
  }
  const log = raw.join("");
  for (const [name, value] of Object.entries(secrets)) assert.ok(!log.includes(value), `${name} is not logged`);
  assert.ok(!log.includes(CUSTOMER_EMAIL), "no body field is logged");
  assert.ok(!log.includes("session=abc"), "no cookie is logged");
  await app.close();
});

test("an unexpected bug is an error with its message and stack", async () => {
  const { app, lines } = await harness();
  await app.inject({ method: "POST", url: "/fail/bug" });
  const line = handlerLine(lines);
  assert.equal(LEVELS[line.level], "error");
  assert.equal(line.msg, "Request failed: 500 INTERNAL_ERROR (TypeError): Cannot read properties of undefined (reading 'total')");
  assert.ok(line.errorStack.includes("error-logging.test.ts"));
  await app.close();
});
