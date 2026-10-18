import type { FastifyPluginAsync } from "fastify";
import { env } from "../config/env.js";
import { checkoutSendOtpRouteSchema, checkoutVerifyOtpRouteSchema } from "../schemas/checkout.schema.js";
import { createCheckoutService } from "../services/checkout.service.js";
import { createCheckoutController } from "../controllers/checkout.controller.js";

const otpRateLimit = { config: { rateLimit: { max: env.OTP_RATE_LIMIT_MAX, timeWindow: env.OTP_RATE_LIMIT_WINDOW } } };

export const checkoutRoutes: FastifyPluginAsync = async (app) => {
  const controller = createCheckoutController(createCheckoutService(app.prisma));

  app.post("/api/v1/auth/checkout/send-otp", { ...otpRateLimit, schema: checkoutSendOtpRouteSchema }, (request) => controller.sendOtp(request));
  app.post("/api/v1/auth/checkout/verify-otp", { ...otpRateLimit, schema: checkoutVerifyOtpRouteSchema }, (request) => controller.verifyOtp(request));
};
