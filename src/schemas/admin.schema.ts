import { routeSchema } from "../shared/http.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../utils/password.js";

// `additionalProperties: false` means any unexpected field in the body (e.g. a client-supplied
// "role") fails Fastify schema validation (400 VALIDATION_ERROR via error.middleware.ts) instead
// of being silently dropped. Role is never accepted from the client; admin.service.ts always
// creates role: "ADMIN" regardless of what the request contains.
export const createAdminBody = {
  type: "object",
  additionalProperties: false,
  required: ["name", "email", "password"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 191 },
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH },
  },
};

// `additionalProperties: false` on the data object also makes Fastify's response serializer
// strip any field not listed here -- passwordHash can never leave through this response shape.
export const createAdminResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "email", "role", "isActive", "createdAt"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        role: { type: "string", enum: ["ADMIN"] },
        isActive: { type: "boolean" },
        createdAt: { type: "string", format: "date-time" },
      },
    },
  },
};

export const createAdminRouteSchema = routeSchema(["Admin"], "Create another administrator account", {
  security: [{ bearerAuth: [] }],
  body: createAdminBody,
  response: { 201: createAdminResponseSchema },
});
