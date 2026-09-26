import type { FastifyPluginAsync } from "fastify";
import { createAdminRouteSchema } from "../schemas/admin.schema.js";
import { createAdminService } from "../services/admin.service.js";
import { createAdminController } from "../controllers/admin.controller.js";

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const controller = createAdminController(createAdminService(app.prisma));

  app.post("/api/v1/admin/admins", { schema: createAdminRouteSchema }, async (request, reply) => {
    // Auth hook lives in the route, per architecture: any authenticated, active ADMIN may
    // provision another ADMIN. There are exactly two roles (CUSTOMER, ADMIN) and no higher
    // tier to restrict this to.
    await request.requireAdmin();
    return controller.createAdmin(request, reply);
  });
};
