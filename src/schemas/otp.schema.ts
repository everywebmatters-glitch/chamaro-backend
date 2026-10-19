import { routeSchema } from "../shared/http.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../utils/password.js";
import { loginResponseSchema } from "./auth.schema.js";

const emailProperty = { type: "string", format: "email" } as const;
const otpProperty = { type: "string", pattern: "^[0-9]{6}$" } as const;
const newPasswordProperty = { type: "string", minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH } as const;

export const sendOtpBody = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: { email: emailProperty },
};

export const emailOtpBody = {
  type: "object",
  additionalProperties: false,
  required: ["email", "otp"],
  properties: { email: emailProperty, otp: otpProperty },
};

export const forgotPasswordResetBody = {
  type: "object",
  additionalProperties: false,
  required: ["email", "otp", "newPassword"],
  properties: { email: emailProperty, otp: otpProperty, newPassword: newPasswordProperty },
};

// Deliberately generic: the same message is returned whether or not an account exists for the
// email, so these endpoints never disclose account existence (same stance as login()).
const genericMessageResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: { type: "object", additionalProperties: false, required: ["message"], properties: { message: { type: "string" } } },
  },
};

const verifiedResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: { type: "object", additionalProperties: false, required: ["verified"], properties: { verified: { type: "boolean", const: true } } },
  },
};

export const registerSendOtpRouteSchema = routeSchema(["Authentication"], "Email a sign-up verification code (required by POST /auth/register)", {
  body: sendOtpBody,
  response: { 200: genericMessageResponseSchema },
});

export const sendLoginOtpRouteSchema = routeSchema(["Authentication"], "Send a one-time login code by email", {
  body: sendOtpBody,
  response: { 200: genericMessageResponseSchema },
});

export const verifyLoginOtpRouteSchema = routeSchema(["Authentication"], "Verify a login one-time code and issue an access token", {
  body: emailOtpBody,
  response: { 200: loginResponseSchema },
});

export const forgotPasswordSendOtpRouteSchema = routeSchema(["Authentication"], "Send a password-reset one-time code by email", {
  body: sendOtpBody,
  response: { 200: genericMessageResponseSchema },
});

export const forgotPasswordVerifyOtpRouteSchema = routeSchema(["Authentication"], "Verify a password-reset one-time code", {
  body: emailOtpBody,
  response: { 200: verifiedResponseSchema },
});

export const forgotPasswordResetRouteSchema = routeSchema(["Authentication"], "Reset the account password using a verified one-time code", {
  body: forgotPasswordResetBody,
  response: { 200: genericMessageResponseSchema },
});

// ---- password reset by emailed link (alongside the code flow above) ----------------------------------------------

export const resetTokenPattern = "^[A-Za-z0-9_-]{43}$";

export const forgotPasswordRequestLinkRouteSchema = routeSchema(["Authentication"], "Email a single-use password-reset link (customer accounts)", {
  body: sendOtpBody,
  response: { 200: genericMessageResponseSchema },
});

export const resetPasswordWithTokenRouteSchema = routeSchema(["Authentication"], "Set a new password using the token from a password-reset link", {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["token", "newPassword"],
    properties: { token: { type: "string", pattern: resetTokenPattern }, newPassword: newPasswordProperty },
  },
  response: { 200: genericMessageResponseSchema },
});
