import type { FastifyPluginAsync } from "fastify";
import { idParams, routeSchema } from "../shared/http.js";
import { ORPHAN_REASON_MAX, orphanReleaseView, releaseOrphanedReservation } from "../services/inventory.service.js";
import { retryOnConflict } from "../services/order.service.js";

// Admin inventory corrections. Every stock write goes through src/services/inventory.service.ts.
//
// Release orphaned reservation: reserved units of a product that no order holds (for example a reservation whose
// order no longer exists) are given back to available stock. On hand never changes. The admin states the reason, the
// numbers they saw (the release is refused if stock changed since), and a reference key that is used once, ever; the
// release is recorded as an append-only ORPHAN_RELEASE ledger movement with the admin's identity.
const releaseBody = {
  type: "object",
  additionalProperties: false,
  required: ["quantity", "expectedOnHand", "expectedReserved", "reason", "reference"],
  properties: {
    quantity: { type: "integer", minimum: 1 },
    expectedOnHand: { type: "integer", minimum: 0 },
    expectedReserved: { type: "integer", minimum: 0 },
    reason: { type: "string", minLength: 1, maxLength: ORPHAN_REASON_MAX },
    reference: { type: "string", minLength: 8, maxLength: 80 },
  },
};

export const inventoryRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/api/v1/admin/inventory/products/:id/orphan-release",
    { schema: routeSchema(["Admin", "Inventory"], "Stock, units held by orders, releasable reserved units and previous orphan releases of a product", { security: [{ bearerAuth: [] }], params: idParams }) },
    async (request) => {
      await request.requireAdmin();
      return { success: true, data: await orphanReleaseView(app.prisma, (request.params as { id: string }).id) };
    },
  );

  app.post(
    "/api/v1/admin/inventory/products/:id/orphan-releases",
    { schema: routeSchema(["Admin", "Inventory"], "Release reserved units of a product that no order holds", { security: [{ bearerAuth: [] }], params: idParams, body: releaseBody }) },
    async (request, reply) => {
      await request.requireAdmin();
      const actorUserId = (request.user as { sub: string }).sub;
      const body = request.body as { quantity: number; expectedOnHand: number; expectedReserved: number; reason: string; reference: string };
      const result = await retryOnConflict(() => app.prisma.$transaction(
        (tx) => releaseOrphanedReservation(tx, { productId: (request.params as { id: string }).id, ...body, actorUserId }),
        { maxWait: 5_000, timeout: 20_000 },
      ));
      request.log.info({ event: "inventory.orphan_release", productId: result.movement.productId, quantity: result.movement.quantity, reservedBefore: result.movement.reservedBefore, reservedAfter: result.movement.reservedAfter, movementId: result.movement.id, actorUserId }, "orphaned reservation released");
      reply.code(201);
      return { success: true, data: result };
    },
  );
};
