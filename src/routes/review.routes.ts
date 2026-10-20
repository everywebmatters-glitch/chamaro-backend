import type { FastifyPluginAsync } from "fastify";
import { httpError, idParams, notFound, pageMeta, routeSchema } from "../shared/http.js";

// Customer reviews. A signed-in customer writes one review per product; it is held as PENDING until an admin
// approves it, and only APPROVED reviews are public. Only the reviewer's first name and last initial are shown.
const STATUSES = ["PENDING", "APPROVED", "HIDDEN"] as const;
const slugParams = { type: "object", required: ["slug"], properties: { slug: { type: "string", minLength: 1 } } };
const reviewBody = { type: "object", additionalProperties: false, required: ["rating", "body"], properties: { rating: { type: "integer", minimum: 1, maximum: 5 }, body: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" } } };
const PUBLIC_LIMIT = 50;
const bearer = [{ bearerAuth: [] }];

export function displayName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Customer";
  const first = parts[0].slice(0, 40);
  return parts.length > 1 ? `${first} ${[...parts[parts.length - 1]][0].toUpperCase()}.` : first;
}

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  const activeProduct = async (slug: string) => {
    const product = await app.prisma.product.findFirst({ where: { slug, status: "ACTIVE" }, select: { id: true } });
    if (!product) throw notFound("Product not found");
    return product;
  };

  app.get("/api/v1/products/:slug/reviews", { schema: routeSchema(["Reviews"], "List a product's approved reviews", { params: slugParams }) }, async (request) => {
    const product = await activeProduct((request.params as { slug: string }).slug);
    const where = { productId: product.id, status: "APPROVED" as const };
    const [reviews, summary] = await Promise.all([
      app.prisma.review.findMany({ where, orderBy: { createdAt: "desc" }, take: PUBLIC_LIMIT, select: { id: true, authorName: true, rating: true, body: true, createdAt: true } }),
      app.prisma.review.aggregate({ where, _avg: { rating: true }, _count: { _all: true } }),
    ]);
    return { success: true, data: { summary: { average: summary._avg.rating === null ? 0 : Math.round(summary._avg.rating * 10) / 10, count: summary._count._all }, reviews } };
  });

  app.post("/api/v1/products/:slug/reviews", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } }, schema: routeSchema(["Reviews"], "Write a review (held until an admin approves it)", { security: bearer, params: slugParams, body: reviewBody }) }, async (request, reply) => {
    await request.requireCustomer();
    const userId = (request.user as { sub: string }).sub;
    const product = await activeProduct((request.params as { slug: string }).slug);
    const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    if (await app.prisma.review.findUnique({ where: { productId_userId: { productId: product.id, userId } }, select: { id: true } })) throw httpError(409, "ALREADY_REVIEWED", "You have already reviewed this product");
    const input = request.body as { rating: number; body: string };
    const review = await app.prisma.review.create({ data: { productId: product.id, userId, authorName: displayName(user?.name ?? ""), rating: input.rating, body: input.body.trim() }, select: { id: true, status: true } });
    reply.code(201);
    return { success: true, data: review };
  });

  const adminQuery = { type: "object", properties: { page: { type: "integer", minimum: 1, default: 1 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }, status: { type: "string", enum: [...STATUSES] } } };
  app.get("/api/v1/admin/reviews", { schema: routeSchema(["Admin", "Reviews"], "List reviews for moderation", { security: bearer, querystring: adminQuery }) }, async (request) => {
    await request.requireAdmin();
    const q = request.query as { page?: number; limit?: number; status?: (typeof STATUSES)[number] };
    const page = q.page ?? 1, limit = q.limit ?? 20;
    const where = q.status ? { status: q.status } : {};
    const [data, total] = await app.prisma.$transaction([
      app.prisma.review.findMany({ where, include: { product: { select: { id: true, name: true, slug: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
      app.prisma.review.count({ where }),
    ]);
    return { success: true, data, meta: pageMeta(page, limit, total) };
  });

  app.put("/api/v1/admin/reviews/:id", { schema: routeSchema(["Admin", "Reviews"], "Approve or hide a review", { security: bearer, params: idParams, body: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: [...STATUSES] } } } }) }, async (request) => {
    await request.requireAdmin();
    const id = (request.params as { id: string }).id;
    if (!(await app.prisma.review.findUnique({ where: { id }, select: { id: true } }))) throw notFound("Review not found");
    return { success: true, data: await app.prisma.review.update({ where: { id }, data: { status: (request.body as { status: (typeof STATUSES)[number] }).status }, include: { product: { select: { id: true, name: true, slug: true } } } }) };
  });

  app.delete("/api/v1/admin/reviews/:id", { schema: routeSchema(["Admin", "Reviews"], "Delete a review", { security: bearer, params: idParams }) }, async (request, reply) => {
    await request.requireAdmin();
    const id = (request.params as { id: string }).id;
    if (!(await app.prisma.review.findUnique({ where: { id }, select: { id: true } }))) throw notFound("Review not found");
    await app.prisma.review.delete({ where: { id } });
    reply.code(204).send();
  });
};
