import type { FastifySchema } from "fastify";

export const idParams = { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } };
export const paginationQuery = { type: "object", properties: { page: { type: "integer", minimum: 1, default: 1 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }, search: { type: "string", maxLength: 100 }, categoryId: { type: "string", minLength: 1 }, status: { type: "string", enum: ["DRAFT", "ACTIVE", "ARCHIVED"] } } };
// `additionalProperties: true` is deliberate here: it preserves resource data until
// each module's explicit resource response schemas are introduced.
export const successResponse = { type: "object", required: ["success", "data"], properties: { success: { type: "boolean" }, data: { anyOf: [{ type: "object", additionalProperties: true }, { type: "array", items: { type: "object", additionalProperties: true } }] } } };
export const errorResponse = { type: "object", required: ["success", "error"], properties: { success: { type: "boolean", const: false }, error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } } } };
export function routeSchema(tags: string[], summary: string, extras: FastifySchema = {}): FastifySchema {
  // Per-status overrides in `extras.response` are merged over the defaults (rather than
  // replacing the whole map) so a route can supply an explicit schema for one status code
  // while keeping the shared error-response defaults for the rest.
  const { response, ...rest } = extras;
  return { tags, summary, description: summary, response: { 200: successResponse, 201: successResponse, 204: { type: "null" }, 400: errorResponse, 401: errorResponse, 403: errorResponse, 404: errorResponse, 409: errorResponse, ...(response as object | undefined) }, ...rest };
}
export function pageMeta(page: number, limit: number, total: number) { return { page, limit, total, totalPages: Math.ceil(total / limit) }; }
export function notFound(message: string): Error { return Object.assign(new Error(message), { statusCode: 404, code: "NOT_FOUND" }); }
