import Fastify from "fastify";
import { registerCors } from "./plugins/cors.js";
import { registerSwagger } from "./plugins/swagger.js";
import prismaPlugin from "./plugins/prisma.js";
import authPlugin from "./plugins/auth.js";
import { requireAdmin, requireCustomer } from "./middleware/auth.middleware.js";
import { registerErrorHandler } from "./middleware/error.middleware.js";
import { healthRoutes } from "./health/health.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";
import { productRoutes } from "./modules/products/product.routes.js";
import { categoryRoutes } from "./modules/categories/category.routes.js";
import { cmsRoutes } from "./modules/cms/cms.routes.js";
import { mediaRoutes } from "./modules/media/media.routes.js";

export async function buildApp() {
  // Fastify's AJV defaults to removeAdditional: true, which silently strips properties that
  // fail `additionalProperties: false` instead of rejecting the request. That would let a
  // client-supplied "role" field pass through silently on register/admin-creation instead of
  // failing validation (role must always come from the server, never the client), so it's
  // disabled here.
  const app = Fastify({ logger: true, ajv: { customOptions: { removeAdditional: false } } });
  registerErrorHandler(app);
  await registerCors(app);
  await registerSwagger(app);
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
