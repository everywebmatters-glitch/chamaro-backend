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
import { createAuthService } from "../services/auth.service.js";
import { createAuthController } from "../controllers/auth.controller.js";

const authRateLimit = { config: { rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: env.AUTH_RATE_LIMIT_WINDOW } } };

export const authRoutes: FastifyPluginAsync = async (app) => {
  const controller = createAuthController(createAuthService(app.prisma));

  app.get("/api/v1/auth/google", { schema: googleAuthorizeRouteSchema }, (request, reply) => controller.googleAuthorize(request, reply));
  app.get("/api/v1/auth/google/callback", { schema: googleCallbackRouteSchema }, (request, reply) => controller.googleCallback(request, reply));
  app.post("/api/v1/auth/google/exchange", { ...authRateLimit, schema: googleExchangeRouteSchema }, (request, reply) => controller.googleExchange(request, reply));

  app.post("/api/v1/auth/register", { schema: registerRouteSchema }, (request, reply) => controller.register(request, reply));
  app.post("/api/v1/auth/login", { ...authRateLimit, schema: loginRouteSchema }, (request, reply) => controller.login(request, reply));
  app.post("/api/v1/auth/admin/login", { ...authRateLimit, schema: adminLoginRouteSchema }, (request, reply) => controller.adminLogin(request, reply));

  app.get("/api/v1/auth/me", { schema: customerMeRouteSchema }, (request) => controller.customerMe(request));
  app.get("/api/v1/admin/me", { schema: meRouteSchema }, (request) => controller.me(request));
};
