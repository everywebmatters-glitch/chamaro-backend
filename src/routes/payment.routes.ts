import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { idParams, pageMeta, routeSchema } from "../shared/http.js";
import { createPaymentService } from "../services/payment.service.js";

const bearer = [{ bearerAuth: [] }];
const userId = (request: FastifyRequest) => (request.user as { sub: string }).sub;

// Exactly what Razorpay Checkout's success handler returns; nothing else (no amount, no status) is accepted.
const verifyBody = {
  type: "object",
  additionalProperties: false,
  required: ["razorpayOrderId", "razorpayPaymentId", "razorpaySignature"],
  properties: {
    razorpayOrderId: { type: "string", pattern: "^order_[A-Za-z0-9]{6,40}$" },
    razorpayPaymentId: { type: "string", pattern: "^pay_[A-Za-z0-9]{6,40}$" },
    razorpaySignature: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
  },
};
const adminQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    needsReview: { type: "boolean" },
    attention: { type: "boolean" },
    status: { type: "string", enum: ["CREATED", "FAILED", "AUTHORIZED", "CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"] },
  },
};
const paymentRateLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  const service = createPaymentService(app.prisma, { log: app.log });

  app.post(
    "/api/v1/orders/:id/payment",
    { ...paymentRateLimit, schema: routeSchema(["Payments"], "Open (or reopen) online payment for an unpaid order: returns what Razorpay Checkout needs", { security: bearer, params: idParams }) },
    async (request) => {
      await request.requireCustomer();
      return { success: true, data: await service.startPayment(userId(request), (request.params as { id: string }).id) };
    },
  );

  app.post(
    "/api/v1/orders/:id/payment/verify",
    { ...paymentRateLimit, schema: routeSchema(["Payments"], "Forward Razorpay Checkout's success callback; the payment is read back from Razorpay before the order changes", { security: bearer, params: idParams, body: verifyBody }) },
    async (request) => {
      await request.requireCustomer();
      const body = request.body as { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string };
      return { success: true, data: await service.confirmFromCheckout(userId(request), (request.params as { id: string }).id, body) };
    },
  );

  app.get("/api/v1/admin/payments", { schema: routeSchema(["Admin", "Payments"], "List payments (e.g. ?needsReview=true for money that needs a person)", { security: bearer, querystring: adminQuery }) }, async (request) => {
    await request.requireAdmin();
    const q = request.query as { page: number; limit: number; needsReview?: boolean; attention?: boolean; status?: never };
    const { data, total } = await service.adminListPayments(q);
    return { success: true, data, meta: pageMeta(q.page, q.limit, total) };
  });

  app.post("/api/v1/admin/payments/:id/sync", { schema: routeSchema(["Admin", "Payments"], "Read one payment back from Razorpay now", { security: bearer, params: idParams }) }, async (request) => {
    await request.requireAdmin();
    return { success: true, data: await service.adminSyncPayment((request.params as { id: string }).id) };
  });

  // The webhook needs the exact bytes Razorpay signed, so JSON is kept as a Buffer in this scope only.
  await app.register(async (webhook) => {
    webhook.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 256 * 1024 }, (_request, body, done) => done(null, body));
    webhook.post("/api/v1/payments/razorpay/webhook", { schema: routeSchema(["Payments"], "Razorpay webhook (authenticated by X-Razorpay-Signature)") }, async (request) => {
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const result = await service.handleWebhook(raw, request.headers);
      return { success: true, data: { received: true, duplicate: result.duplicate } };
    });
  });
};
