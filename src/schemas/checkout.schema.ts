import { routeSchema } from "../shared/http.js";

const otpProperty = { type: "string", pattern: "^[0-9]{6}$" } as const;

export const checkoutVerifyOtpBody = {
  type: "object",
  additionalProperties: false,
  required: ["otp"],
  properties: { otp: otpProperty },
};

const checkoutSendOtpResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: { type: "object", additionalProperties: false, required: ["message"], properties: { message: { type: "string" } } },
  },
};

const checkoutVerifyOtpResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: {
      type: "object",
      additionalProperties: false,
      required: ["verified", "expiresAt"],
      properties: { verified: { type: "boolean", const: true }, expiresAt: { type: "string", format: "date-time" } },
    },
  },
};

export const checkoutSendOtpRouteSchema = routeSchema(["Checkout"], "Send a checkout/payment verification code to the authenticated customer", {
  security: [{ bearerAuth: [] }],
  response: { 200: checkoutSendOtpResponseSchema },
});

export const checkoutVerifyOtpRouteSchema = routeSchema(["Checkout"], "Verify the checkout/payment code and authorize payment initiation", {
  security: [{ bearerAuth: [] }],
  body: checkoutVerifyOtpBody,
  response: { 200: checkoutVerifyOtpResponseSchema },
});
