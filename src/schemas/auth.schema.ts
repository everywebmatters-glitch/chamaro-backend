import { routeSchema } from "../shared/http.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../utils/password.js";

const nameProperty = { type: "string", minLength: 1, maxLength: 191 } as const;
const emailProperty = { type: "string", format: "email" } as const;
const newPasswordProperty = { type: "string", minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH } as const;
// Login accepts any previously-issued password length; strength is enforced at creation time, not at login.
const loginPasswordProperty = { type: "string", minLength: 1, maxLength: MAX_PASSWORD_LENGTH } as const;

// `additionalProperties: false` is what makes an unexpected field (e.g. "role") a 400
// VALIDATION_ERROR instead of being silently ignored -- see error.middleware.ts.
export const registerBody = {
  type: "object",
  additionalProperties: false,
  required: ["name", "email", "password"],
  properties: { name: nameProperty, email: emailProperty, password: newPasswordProperty },
};

export const loginBody = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: { email: emailProperty, password: loginPasswordProperty },
};

export const adminLoginBody = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: { email: emailProperty, password: newPasswordProperty },
};

// Response schemas below use `additionalProperties: false` on the data object, which makes
// Fastify's response serializer strip anything not explicitly listed -- so passwordHash (or
// any other future field) can never leak through this endpoint even if a service accidentally
// returned it.
export const registerResponseSchema = {
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
        role: { type: "string", enum: ["CUSTOMER"] },
        isActive: { type: "boolean" },
        createdAt: { type: "string", format: "date-time" },
      },
    },
  },
};

// Same safe customer shape as registration; used by GET /api/v1/auth/me.
export const customerResponseSchema = registerResponseSchema;

function authTokenResponseSchema(roles: ("CUSTOMER" | "ADMIN")[]) {
  return {
    type: "object",
    required: ["success", "data"],
    properties: {
      success: { type: "boolean" },
      data: {
        type: "object",
        additionalProperties: false,
        required: ["token", "user"],
        properties: {
          token: { type: "string" },
          user: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name", "email", "role"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              email: { type: "string" },
              role: { type: "string", enum: roles },
            },
          },
        },
      },
    },
  };
}

export const loginResponseSchema = authTokenResponseSchema(["CUSTOMER"]);
// Google sign-in has always authenticated both roles (an ADMIN with a linked Google ID gets an
// ADMIN token); that behaviour is preserved.
export const googleExchangeResponseSchema = authTokenResponseSchema(["CUSTOMER", "ADMIN"]);

// PKCE (RFC 7636): the frontend sends S256(code_verifier) when starting the flow and the
// verifier itself when exchanging the code.
const codeChallengeProperty = { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } as const;
const codeVerifierProperty = { type: "string", pattern: "^[A-Za-z0-9._~-]{43,128}$" } as const;

export const googleExchangeBody = {
  type: "object",
  additionalProperties: false,
  required: ["code", "codeVerifier"],
  properties: { code: { type: "string", minLength: 1, maxLength: 2048 }, codeVerifier: codeVerifierProperty },
};

export const registerRouteSchema = routeSchema(["Authentication"], "Register a new customer account", {
  body: registerBody,
  response: { 201: registerResponseSchema },
});

export const loginRouteSchema = routeSchema(["Authentication"], "Log in a customer with email and password", {
  body: loginBody,
  response: { 200: loginResponseSchema },
});

export const adminLoginRouteSchema = routeSchema(["Authentication"], "Log in an active administrator", {
  body: adminLoginBody,
});

export const googleAuthorizeRouteSchema = routeSchema(["Authentication"], "Start Google OAuth sign-in", {
  description: "Browser navigation only. Sets a short-lived HttpOnly state cookie and redirects to Google. `code_challenge` is base64url(SHA-256(code_verifier)); the frontend keeps the verifier for the exchange step.",
  querystring: {
    type: "object",
    additionalProperties: false,
    required: ["code_challenge"],
    properties: { code_challenge: codeChallengeProperty },
  },
});

// Google appends extra parameters (scope, authuser, prompt, hd, ...) and sends `error` instead of
// `code` when the user cancels, so this is deliberately permissive; the controller validates.
export const googleCallbackRouteSchema = routeSchema(["Authentication"], "Complete Google OAuth sign-in", {
  description: "Called by Google. Always redirects the browser to GOOGLE_FRONTEND_CALLBACK_URL with `#code=<one-time code>` on success or `#error=<CODE>` on failure.",
  querystring: {
    type: "object",
    additionalProperties: true,
    properties: { code: { type: "string" }, state: { type: "string" }, error: { type: "string" } },
  },
});

export const googleExchangeRouteSchema = routeSchema(["Authentication"], "Exchange a Google sign-in code for an access token", {
  body: googleExchangeBody,
  response: { 200: googleExchangeResponseSchema },
});

export const customerMeRouteSchema = routeSchema(["Authentication"], "Get the authenticated customer", {
  security: [{ bearerAuth: [] }],
  response: { 200: customerResponseSchema },
});

export const meRouteSchema = routeSchema(["Admin"], "Get the authenticated administrator", {
  security: [{ bearerAuth: [] }],
});
