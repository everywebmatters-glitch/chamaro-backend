import type { FastifyInstance } from "fastify";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as { statusCode?: number; code?: string; message: string; validation?: unknown };
    request.log.error({ err: error }, "Request failed");
    let statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    let code = error.code ?? "INTERNAL_ERROR";
    let message = statusCode === 500 ? "An unexpected error occurred" : error.message;
    if (code === "P2002") { statusCode = 409; code = "DUPLICATE_RECORD"; message = "A record with that value already exists"; }
    // Foreign-key RESTRICT, e.g. deleting a product that appears on a retail order or quotation.
    if (code === "P2003") { statusCode = 409; code = "RECORD_IN_USE"; message = "This record is referenced by other records and cannot be deleted"; }
    if (code === "P2025") { statusCode = 404; code = "NOT_FOUND"; message = "Requested record was not found"; }
    if (error.validation) { statusCode = 400; code = "VALIDATION_ERROR"; message = "Request validation failed"; }
    reply.status(statusCode).send({ success: false, error: { code, message } });
  });
}
