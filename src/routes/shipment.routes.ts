import type { FastifyPluginAsync } from "fastify";
import { idParams, routeSchema } from "../shared/http.js";
import { createShipmentService } from "../services/shipment.service.js";

// Delhivery shipments. Every route here is admin-only, except the scan-push webhook, which Delhivery calls with the
// shared bearer secret. Customers read their shipment through GET /api/v1/orders/:id (their own orders only).

const bearer = [{ bearerAuth: [] }];

// Parcel details the admin measures at packing time; Delhivery fills in account defaults for anything left out.
const createShipmentBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    weightGrams: { type: "integer", minimum: 1, maximum: 100_000 },
    lengthCm: { type: "integer", minimum: 1, maximum: 500 },
    widthCm: { type: "integer", minimum: 1, maximum: 500 },
    heightCm: { type: "integer", minimum: 1, maximum: 500 },
    // Mandatory (Delhivery, government rule) for shipments worth Rs. 50,000 or more.
    ewaybill: { type: "string", pattern: "^[0-9]{12}$" },
  },
};

const pickupBody = {
  type: "object",
  additionalProperties: false,
  required: ["pickupDate", "pickupTime"],
  properties: {
    pickupDate: { type: "string", pattern: "^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$" },
    pickupTime: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$" },
    expectedPackageCount: { type: "integer", minimum: 1, maximum: 1000 },
    confirmNotCreated: { type: "boolean" },
  },
};

const pinQuery = { type: "object", additionalProperties: false, required: ["pin"], properties: { pin: { type: "string", pattern: "^[1-9][0-9]{5}$" } } };

export const shipmentRoutes: FastifyPluginAsync = async (app) => {
  const service = createShipmentService(app.prisma, { log: app.log });
  const orderId = (params: unknown) => (params as { id: string }).id;

  app.post(
    "/api/v1/admin/orders/:id/shipment",
    { schema: routeSchema(["Admin", "Shipping"], "Create the Delhivery shipment for a paid order (repeating it returns the same shipment)", { security: bearer, params: idParams, body: createShipmentBody }) },
    async (request) => {
      await request.requireAdmin();
      return { success: true, data: await service.createForOrder(orderId(request.params), (request.body ?? {}) as object) };
    },
  );

  app.post("/api/v1/admin/orders/:id/shipment/sync", { schema: routeSchema(["Admin", "Shipping"], "Read the order's shipment status from Delhivery now", { security: bearer, params: idParams }) }, async (request) => {
    await request.requireAdmin();
    return { success: true, data: await service.syncOrder(orderId(request.params)) };
  });

  app.post("/api/v1/admin/orders/:id/shipment/cancel", { schema: routeSchema(["Admin", "Shipping"], "Cancel a Delhivery shipment that has not been picked up", { security: bearer, params: idParams }) }, async (request) => {
    await request.requireAdmin();
    return { success: true, data: await service.cancelForOrder(orderId(request.params)) };
  });

  app.post("/api/v1/admin/shipping/pickup-requests", { schema: routeSchema(["Admin", "Shipping"], "Book a Delhivery pickup at the warehouse (one per day)", { security: bearer, body: pickupBody }) }, async (request) => {
    await request.requireAdmin();
    return { success: true, data: await service.requestPickup(request.body as { pickupDate: string; pickupTime: string; expectedPackageCount?: number; confirmNotCreated?: boolean }) };
  });

  app.get("/api/v1/admin/shipping/serviceability", { schema: routeSchema(["Admin", "Shipping"], "Check whether Delhivery serves a PIN code", { security: bearer, querystring: pinQuery }) }, async (request) => {
    await request.requireAdmin();
    return { success: true, data: await service.checkServiceability((request.query as { pin: string }).pin) };
  });

  // Delhivery scan push. Small bodies only, rate limited, and the body is never trusted (see handleWebhook).
  app.post(
    "/api/v1/webhooks/delhivery/scans",
    { bodyLimit: 64 * 1024, config: { rateLimit: { max: 600, timeWindow: "1 minute" } }, schema: routeSchema(["Webhooks"], "Delhivery scan push (Authorization: Bearer <DELHIVERY_WEBHOOK_SECRET>)") },
    async (request) => {
      await service.handleWebhook(request.headers.authorization, request.body);
      return { success: true, data: { received: true } };
    },
  );
};
