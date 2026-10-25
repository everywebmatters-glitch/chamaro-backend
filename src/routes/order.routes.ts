import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { idParams, routeSchema } from "../shared/http.js";
import { MAX_LINE_QUANTITY, SHIPPING_METHODS } from "../shared/order-pricing.js";
import { createOrderService } from "../services/order.service.js";

const customerQuery = { type: "object", additionalProperties: false, properties: { page: { type: "integer", minimum: 1, default: 1 }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } } };
const adminQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    status: { type: "string", enum: ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "COMPLETED", "CANCELLED"] },
    paymentStatus: { type: "string", enum: ["UNPAID", "PAID", "REFUNDED"] },
    // An order id, or part of the customer's name or email.
    search: { type: "string", minLength: 1, maxLength: 100 },
  },
};

const cartBody = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "quantity"],
        properties: { productId: { type: "string", minLength: 1 }, variantId: { type: "string", minLength: 1 }, quantity: { type: "integer", minimum: 1, maximum: MAX_LINE_QUANTITY } },
      },
    },
  },
};

// Only the keys below are accepted: prices, totals and line items are never read from the request.
const createOrderBody = {
  type: "object",
  additionalProperties: false,
  required: ["addressId", "shippingMethod"],
  properties: {
    addressId: { type: "string", minLength: 1 },
    shippingMethod: { type: "string", enum: SHIPPING_METHODS },
    note: { type: "string", maxLength: 500 },
    couponCode: { type: "string", enum: ["WELCOME10", "WELCOME5"] },
  },
};
const couponValidationBody = {
  type: "object",
  additionalProperties: false,
  required: ["code", "items"],
  properties: {
    code: { type: "string", enum: ["WELCOME10", "WELCOME5"] },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "quantity"],
        properties: {
          productId: { type: "string", minLength: 1 },
          variantId: { type: "string", minLength: 1 },
          quantity: { type: "integer", minimum: 1, maximum: MAX_LINE_QUANTITY },
        },
      },
    },
  },
};
const idempotencyHeaders = {
  type: "object",
  required: ["idempotency-key"],
  properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 64, pattern: "^[A-Za-z0-9_:.-]+$" } },
};

// Entered by hand from the courier's receipt; no shipping-provider API is involved.
const shipOrderBody = {
  type: "object",
  additionalProperties: false,
  required: ["carrier", "trackingNumber"],
  properties: {
    carrier: { type: "string", minLength: 1, maxLength: 64, pattern: "\\S" },
    trackingNumber: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9 _./-]*$" },
  },
};

const bearer = [{ bearerAuth: [] }];

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const service = createOrderService(app.prisma, { log: app.log });
  const userId = (request: FastifyRequest) => (request.user as { sub: string }).sub;

  // ---- customer cart -----------------------------------------------------------------------------------------
  app.get("/api/v1/cart", { schema: routeSchema(["Cart"], "Get the signed-in customer's cart", { security: bearer }) }, async (request) => {
    await request.requireCustomer();
    return { success: true, data: await service.getCart(userId(request)) };
  });

  app.put("/api/v1/cart", { schema: routeSchema(["Cart"], "Replace the signed-in customer's cart", { security: bearer, body: cartBody }) }, async (request) => {
    await request.requireCustomer();
    const { items } = request.body as { items: { productId: string; variantId?: string; quantity: number }[] };
    return { success: true, data: await service.replaceCart(userId(request), items) };
  });

  app.post("/api/v1/coupons/validate", { schema: routeSchema(["Coupons"], "Validate a coupon against the signed-in customer's cart", { security: bearer, body: couponValidationBody }) }, async (request) => {
    await request.requireCustomer();
    const body = request.body as { code: string; items: { productId: string; variantId?: string; quantity: number }[] };
    return { success: true, data: await service.validateCoupon(userId(request), { code: body.code, items: body.items }) };
  });

  app.delete("/api/v1/cart", { schema: routeSchema(["Cart"], "Empty the signed-in customer's cart", { security: bearer }) }, async (request, reply) => {
    await request.requireCustomer();
    await service.clearCart(userId(request));
    reply.code(204).send();
  });

  // ---- customer orders ---------------------------------------------------------------------------------------
  app.post(
    "/api/v1/orders",
    { schema: routeSchema(["Orders"], "Place an order from the server cart (send an Idempotency-Key header; a retry returns the same order)", { security: bearer, headers: idempotencyHeaders, body: createOrderBody }) },
    async (request, reply) => {
      await request.requireCustomer();
      const body = request.body as { addressId: string; shippingMethod: "standard" | "express"; note?: string; couponCode?: string };
      const key = request.headers["idempotency-key"] as string;
      const { order, replay } = await service.createOrder(userId(request), { idempotencyKey: key, addressId: body.addressId, shippingMethod: body.shippingMethod, note: body.note?.trim() || undefined, couponCode: body.couponCode });
      reply.code(replay ? 200 : 201);
      return { success: true, data: order };
    },
  );

  app.get("/api/v1/orders", { schema: routeSchema(["Orders"], "List the signed-in customer's orders", { security: bearer, querystring: customerQuery }) }, async (request) => {
    await request.requireCustomer();
    const q = request.query as { page?: number; limit?: number };
    const { data, meta } = await service.listOrders(userId(request), q.page ?? 1, q.limit ?? 10);
    return { success: true, data, meta };
  });

  app.get("/api/v1/orders/:id", { schema: routeSchema(["Orders"], "Get one of the signed-in customer's orders", { security: bearer, params: idParams }) }, async (request) => {
    await request.requireCustomer();
    return { success: true, data: await service.getOrder(userId(request), (request.params as { id: string }).id) };
  });

  app.post("/api/v1/orders/:id/cancel", { schema: routeSchema(["Orders"], "Cancel an unpaid, pending order and release its stock", { security: bearer, params: idParams }) }, async (request) => {
    await request.requireCustomer();
    return { success: true, data: await service.cancelOrder(userId(request), (request.params as { id: string }).id) };
  });

  // ---- admin -------------------------------------------------------------------------------------------------
  app.get("/api/v1/admin/orders", { schema: routeSchema(["Admin", "Orders"], "List orders", { security: bearer, querystring: adminQuery }) }, async (request) => {
    await request.requireAdmin();
    const q = request.query as { page?: number; limit?: number; status?: string; paymentStatus?: string; search?: string };
    const { data, meta } = await service.adminListOrders({ page: q.page ?? 1, limit: q.limit ?? 20, status: q.status, paymentStatus: q.paymentStatus, search: q.search });
    return { success: true, data, meta };
  });

  app.get("/api/v1/admin/orders/:id", { schema: routeSchema(["Admin", "Orders"], "Get an order", { security: bearer, params: idParams }) }, async (request) => {
    await request.requireAdmin();
    return { success: true, data: await service.adminGetOrder((request.params as { id: string }).id) };
  });

  app.post(
    "/api/v1/admin/orders/:id/ship",
    { schema: routeSchema(["Admin", "Orders"], "Mark an order as shipped with its carrier and tracking number, and email the customer", { security: bearer, params: idParams, body: shipOrderBody }) },
    async (request) => {
      await request.requireAdmin();
      const body = request.body as { carrier: string; trackingNumber: string };
      return { success: true, data: await service.adminShipOrder((request.params as { id: string }).id, { carrier: body.carrier.trim(), trackingNumber: body.trackingNumber.trim() }) };
    },
  );
};
