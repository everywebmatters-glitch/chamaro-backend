import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { MAX_IMAGE_BYTES } from "./shared/media.js";
import { registerCors } from "./plugins/cors.js";
import { registerSwagger } from "./plugins/swagger.js";
import securityHeaders from "./plugins/security-headers.js";
import { env } from "./config/env.js";
import { loggerOptions } from "./config/logger.js";
import prismaPlugin from "./plugins/prisma.js";
import authPlugin from "./plugins/auth.js";
import { requireAdmin, requireCustomer } from "./middleware/auth.middleware.js";
import { registerErrorHandler } from "./middleware/error.middleware.js";
import { healthRoutes } from "./routes/health.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { productRoutes } from "./routes/product.routes.js";
import { categoryRoutes } from "./routes/category.routes.js";
import { cmsRoutes } from "./routes/cms.routes.js";
import { mediaRoutes } from "./routes/media.routes.js";

export async function buildApp() {
  // Fastify's AJV defaults to removeAdditional: true, which silently strips properties that
  // fail `additionalProperties: false` instead of rejecting the request. That would let a
  // client-supplied "role" field pass through silently on register/admin-creation instead of
  // failing validation (role must always come from the server, never the client), so it's
  // disabled here.
  // Behind Hostinger's reverse proxy every request arrives from the proxy, so the login rate limit
  // would treat all visitors as one IP. Trust X-Forwarded-For only from proxies on loopback or
  // private networks: request.ip becomes the first public address the proxy saw, and values a
  // client adds to X-Forwarded-For itself can't spoof it (unlike `true`; numeric hop counts are
  // treated as "trust nothing" by this Fastify version).
  const app = Fastify({ logger: loggerOptions, trustProxy: "loopback,linklocal,uniquelocal", ajv: { customOptions: { removeAdditional: false } } });
  registerErrorHandler(app);
  await app.register(securityHeaders);
  await registerCors(app);
  // Only the media upload route reads multipart bodies: one image, at most MAX_IMAGE_BYTES.
  await app.register(multipart, { limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5, fieldSize: 1000, parts: 6 } });
  // API docs (/docs, /docs/json) list every route, including admin ones: development and staging only.
  if (!env.isProduction) await registerSwagger(app);
  await app.register(authPlugin);
  await app.register(prismaPlugin);
  app.decorateRequest("requireAdmin", function () { return requireAdmin(this); });
  app.decorateRequest("requireCustomer", function () { return requireCustomer(this); });
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(productRoutes);
  await app.register(categoryRoutes);
  await app.register(cmsRoutes);
  await app.register(mediaRoutes);
  return app;
}
