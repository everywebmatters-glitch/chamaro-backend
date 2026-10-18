import type { FastifyPluginAsync } from "fastify";
import { env } from "../config/env.js";
import {
  adminLoginRouteSchema,
  customerMeRouteSchema,
  googleAuthorizeRouteSchema,
  googleCallbackRouteSchema,
  googleExchangeRouteSchema,
  loginRouteSchema,
  meRouteSchema,
  registerRouteSchema,
} from "../schemas/auth.schema.js";
import {
  forgotPasswordResetRouteSchema,
  forgotPasswordSendOtpRouteSchema,
  forgotPasswordVerifyOtpRouteSchema,
  sendLoginOtpRouteSchema,
  verifyLoginOtpRouteSchema,
} from "../schemas/otp.schema.js";
import { createAuthService } from "../services/auth.service.js";
import { createAuthController } from "../controllers/auth.controller.js";

const authRateLimit = { config: { rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: env.AUTH_RATE_LIMIT_WINDOW } } };
// Account creation is far rarer than login: 5 per hour per client IP limits scripted sign-ups
// and email probing. Counted before validation, so malformed attempts count too.
const registerRateLimit = { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } };
// Tighter than authRateLimit: each send costs an email and each verify is a guess against a
// 6-digit code.
const otpRateLimit = { config: { rateLimit: { max: env.OTP_RATE_LIMIT_MAX, timeWindow: env.OTP_RATE_LIMIT_WINDOW } } };

export const authRoutes: FastifyPluginAsync = async (app) => {
  const controller = createAuthController(createAuthService(app.prisma));

  app.get("/api/v1/auth/google", { schema: googleAuthorizeRouteSchema }, (request, reply) => controller.googleAuthorize(request, reply));
  app.get("/api/v1/auth/google/callback", { schema: googleCallbackRouteSchema }, (request, reply) => controller.googleCallback(request, reply));
  app.post("/api/v1/auth/google/exchange", { ...authRateLimit, schema: googleExchangeRouteSchema }, (request, reply) => controller.googleExchange(request, reply));

  app.post("/api/v1/auth/register", { ...registerRateLimit, schema: registerRouteSchema }, (request, reply) => controller.register(request, reply));
  app.post("/api/v1/auth/login", { ...authRateLimit, schema: loginRouteSchema }, (request, reply) => controller.login(request, reply));
  app.post("/api/v1/auth/admin/login", { ...authRateLimit, schema: adminLoginRouteSchema }, (request, reply) => controller.adminLogin(request, reply));

  app.get("/api/v1/auth/me", { schema: customerMeRouteSchema }, (request) => controller.customerMe(request));
  app.get("/api/v1/admin/me", { schema: meRouteSchema }, (request) => controller.me(request));

  app.post("/api/v1/auth/send-login-otp", { ...otpRateLimit, schema: sendLoginOtpRouteSchema }, (request) => controller.sendLoginOtp(request));
  app.post("/api/v1/auth/verify-login-otp", { ...otpRateLimit, schema: verifyLoginOtpRouteSchema }, (request, reply) => controller.verifyLoginOtp(request, reply));

  app.post("/api/v1/auth/forgot-password/send-otp", { ...otpRateLimit, schema: forgotPasswordSendOtpRouteSchema }, (request) => controller.forgotPasswordSendOtp(request));
  app.post("/api/v1/auth/forgot-password/verify-otp", { ...otpRateLimit, schema: forgotPasswordVerifyOtpRouteSchema }, (request) => controller.forgotPasswordVerifyOtp(request));
  app.post("/api/v1/auth/forgot-password/reset", { ...otpRateLimit, schema: forgotPasswordResetRouteSchema }, (request) => controller.forgotPasswordReset(request));
};
