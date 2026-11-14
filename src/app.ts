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
import { checkoutRoutes } from "./routes/checkout.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { productRoutes } from "./routes/product.routes.js";
import { categoryRoutes } from "./routes/category.routes.js";
import { cmsRoutes } from "./routes/cms.routes.js";
import { reviewRoutes } from "./routes/review.routes.js";
import { mediaRoutes } from "./routes/media.routes.js";
import { addressRoutes } from "./routes/address.routes.js";
import { orderRoutes } from "./routes/order.routes.js";
import { paymentRoutes } from "./routes/payment.routes.js";
import { shipmentRoutes } from "./routes/shipment.routes.js";
import { b2bEnquiryRoutes } from "./routes/b2b-enquiry.routes.js";
import { inventoryRoutes } from "./routes/inventory.routes.js";

// Proxies whose X-Forwarded-For entries are trusted, walking the header from the right (nearest hop first).
// request.ip is the first address that is NOT one of these, so entries a client writes itself (further left) are never used.
//  - loopback, linklocal, uniquelocal: the platform hop that connects to the container (Cloud Run's front end, or a
//    reverse proxy on a private network).
//  - 8.233.190.129: the production external Application Load Balancer (static IP `chamaro-lb-ip`). Google's load balancer
//    appends "<client-ip>,<load-balancer-ip>" to X-Forwarded-For, so without this entry every visitor resolved to the
//    load balancer and shared one rate-limit bucket (2026-11-13 security audit, H1). Only this exact address is trusted,
//    not Google's ranges: a request sent straight to the run.app URL gets the real client appended by Cloud Run instead.
// `true` or a numeric hop count is never used: either would let a client pick its own address.
export const TRUSTED_PROXIES = ["loopback", "linklocal", "uniquelocal", "8.233.190.129/32"];

export async function buildApp() {
  // Fastify's AJV defaults to removeAdditional: true, which silently strips properties that
  // fail `additionalProperties: false` instead of rejecting the request. That would let a
  // client-supplied "role" field pass through silently on register/admin-creation instead of
  // failing validation (role must always come from the server, never the client), so it's
  // disabled here.
  const app = Fastify({ logger: loggerOptions, trustProxy: TRUSTED_PROXIES, ajv: { customOptions: { removeAdditional: false } } });
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
  await app.register(checkoutRoutes);
  await app.register(adminRoutes);
  await app.register(productRoutes);
  await app.register(categoryRoutes);
  await app.register(cmsRoutes);
  await app.register(reviewRoutes);
  await app.register(mediaRoutes);
  await app.register(addressRoutes);
  await app.register(orderRoutes);
  await app.register(paymentRoutes);
  await app.register(shipmentRoutes);
  await app.register(b2bEnquiryRoutes);
  await app.register(inventoryRoutes);
  return app;
}
