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
  forgotPasswordRequestLinkRouteSchema,
  forgotPasswordResetRouteSchema,
  forgotPasswordSendOtpRouteSchema,
  forgotPasswordVerifyOtpRouteSchema,
  registerSendOtpRouteSchema,
  resetPasswordWithTokenRouteSchema,
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
  const controller = createAuthController(createAuthService(app.prisma, { log: app.log }));

  app.get("/api/v1/auth/google", { schema: googleAuthorizeRouteSchema }, (request, reply) => controller.googleAuthorize(request, reply));
  app.get("/api/v1/auth/google/callback", { schema: googleCallbackRouteSchema }, (request, reply) => controller.googleCallback(request, reply));
  app.post("/api/v1/auth/google/exchange", { ...authRateLimit, schema: googleExchangeRouteSchema }, (request, reply) => controller.googleExchange(request, reply));

  // Sign-up is two steps: send-otp emails a code, register creates the account only with that code.
  app.post("/api/v1/auth/register/send-otp", { ...otpRateLimit, schema: registerSendOtpRouteSchema }, (request) => controller.registerSendOtp(request));
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

  // Link-based reset, alongside the code flow above. Same rate limit: each request can cost an email.
  app.post("/api/v1/auth/forgot-password/request-link", { ...otpRateLimit, schema: forgotPasswordRequestLinkRouteSchema }, (request) => controller.forgotPasswordRequestLink(request));
  app.post("/api/v1/auth/reset-password", { ...otpRateLimit, schema: resetPasswordWithTokenRouteSchema }, (request) => controller.resetPasswordWithToken(request));
};
