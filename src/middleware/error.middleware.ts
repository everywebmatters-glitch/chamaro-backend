import type { FastifyInstance } from "fastify";

type RawError = {
  statusCode?: number;
  code?: string;
  message: string;
  validation?: { instancePath?: string; keyword?: string }[];
  validationContext?: string;
  expose?: boolean;
  name?: string;
  stack?: string;
  meta?: unknown;
  cause?: unknown;
};

export type ErrorResponse = { statusCode: number; code: string; message: string };
export type ErrorLogLevel = "error" | "warn" | "info";

// The status, code and message the client gets. Unchanged by how the error is logged.
export function errorResponse(error: RawError): ErrorResponse {
  // A 502/503 the code raised on purpose with a fixed, safe message (`expose: true`, e.g. a courier that is down or
  // not configured) keeps its status and message; any other 5xx is reported generically.
  const deliberateUpstream = error.expose === true && (error.statusCode === 502 || error.statusCode === 503);
  let statusCode = deliberateUpstream ? error.statusCode! : error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
  let code = error.code ?? "INTERNAL_ERROR";
  let message = statusCode === 500 ? "An unexpected error occurred" : error.message;
  if (code === "P2002") { statusCode = 409; code = "DUPLICATE_RECORD"; message = "A record with that value already exists"; }
  // Foreign-key RESTRICT, e.g. deleting a product that appears on a retail order or quotation.
  if (code === "P2003") { statusCode = 409; code = "RECORD_IN_USE"; message = "This record is referenced by other records and cannot be deleted"; }
  // Two overlapping transactions collided (e.g. a deadlock) and retries were exhausted.
  if (code === "P2034") { statusCode = 409; code = "CONFLICT_RETRY"; message = "The request conflicted with another one; please try again"; }
  if (code === "P2025") { statusCode = 404; code = "NOT_FOUND"; message = "Requested record was not found"; }
  if (error.validation) { statusCode = 400; code = "VALIDATION_ERROR"; message = "Request validation failed"; }
  return { statusCode, code, message };
}

// Refusals (4xx) an operator should notice: a possible attack, contention that exhausted its retries, or a courier
// answer that needs someone to act. Every other 4xx is the API working as intended and is logged at info.
const NOTABLE_REFUSALS = new Set(["WEBHOOK_UNAUTHORIZED", "CONFLICT_RETRY", "PINCODE_NOT_SERVICEABLE", "PICKUP_OUTCOME_UNKNOWN"]);
// A 5xx that reports a state someone chose (shipping switched off), not a failure.
const EXPECTED_UNAVAILABLE = new Set(["SHIPPING_DISABLED"]);

// error: the request failed because something is broken or an upstream (e.g. Delhivery) failed or refused us.
// warn:  a refusal worth noticing (see NOTABLE_REFUSALS, rate limiting) or an intentionally disabled feature.
// info:  an ordinary refusal: validation, authentication, not found, business rules.
export function errorLogLevel(response: ErrorResponse): ErrorLogLevel {
  if (response.statusCode >= 500) return EXPECTED_UNAVAILABLE.has(response.code) ? "warn" : "error";
  if (response.statusCode === 429 || NOTABLE_REFUSALS.has(response.code)) return "warn";
  return "info";
}

// Stack frames without the leading message line(s): a Prisma or driver message can quote the values in the query.
function stackFrames(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const start = stack.indexOf("\n    at ");
  return start === -1 ? undefined : stack.slice(start + 1);
}

// Prisma's meta without the driver's message text, which quotes the offending value (e.g. a duplicate email).
function safePrismaMeta(meta: unknown) {
  if (typeof meta !== "object" || meta === null) return undefined;
  const fields = meta as { modelName?: unknown; target?: unknown; field_name?: unknown; driverAdapterError?: { cause?: { kind?: unknown; originalCode?: unknown; constraint?: unknown } } };
  const cause = fields.driverAdapterError?.cause;
  return { modelName: fields.modelName, target: fields.target, fieldName: fields.field_name, driverKind: cause?.kind, driverCode: cause?.originalCode, constraint: cause?.constraint };
}

const isPrisma = (name: string | undefined) => Boolean(name?.startsWith("PrismaClient"));

// What may be logged about a failed request: names, codes, statuses and stack frames. Never the request headers or
// body (so never a token, password, OTP or Authorization header), and never a database message that could quote
// customer data. Ordinary refusals get only the fields needed to count and recognise them.
export function errorLogFields(error: RawError, response: ErrorResponse, level: ErrorLogLevel) {
  const prisma = isPrisma(error.name);
  const fields: Record<string, unknown> = {
    statusCode: response.statusCode,
    errorCode: response.code,
    errorName: error.name ?? "Error",
    ...(prisma ? { prismaCode: error.code ?? "none" } : {}),
  };
  if (error.validation) {
    fields.validation = { context: error.validationContext, failures: error.validation.slice(0, 10).map((item) => ({ path: item.instancePath, keyword: item.keyword })) };
  }
  // A courier error carries only fixed codes and Delhivery's short, cleaned remark (see delhivery.provider.ts).
  if (error.name === "DelhiveryError") {
    const upstream = error as RawError & { httpStatus?: unknown; outcome?: unknown; remark?: unknown };
    fields.upstream = { provider: "delhivery", httpStatus: upstream.httpStatus, outcome: upstream.outcome, remark: upstream.remark };
  }
  if (level === "error") {
    // Our own messages and runtime errors are safe and useful; a Prisma message can quote query values.
    if (!prisma) fields.errorMessage = error.message;
    fields.errorStack = stackFrames(error.stack);
    if (prisma) fields.prismaMeta = safePrismaMeta(error.meta);
    if (error.cause instanceof Error) {
      fields.errorCause = { name: error.cause.name, code: (error.cause as { code?: unknown }).code, stack: stackFrames(error.cause.stack) };
    }
  }
  return fields;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as RawError;
    const response = errorResponse(error);
    const level = errorLogLevel(response);
    const fields = errorLogFields(error, response, level);
    // Repeats name, code and (for errors) the message in the line itself, for viewers that show only the message.
    const summary = level === "error" && fields.errorMessage ? `: ${fields.errorMessage}` : "";
    request.log[level](fields, `${level === "error" ? "Request failed" : "Request refused"}: ${response.statusCode} ${response.code} (${fields.errorName})${summary}`);
    reply.status(response.statusCode).send({ success: false, error: { code: response.code, message: response.message } });
  });
}
