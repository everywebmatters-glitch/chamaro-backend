import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createOrderService } from "../services/order.service.js";
import { httpError, idParams, routeSchema } from "../shared/http.js";

const MAX_ADDRESSES = 20;

const text = (max: number) => ({ type: "string", minLength: 1, maxLength: max, pattern: "\\S" });
const properties = {
  name: text(191),
  phone: { type: "string", minLength: 5, maxLength: 32, pattern: "^[0-9+()\\-\\s]+$" },
  addressLine1: text(255),
  addressLine2: { type: "string", maxLength: 255 },
  city: text(120),
  state: text(120),
  // India PIN codes are six digits and never start with 0.
  postalCode: { type: "string", pattern: "^[1-9][0-9]{5}$" },
  country: { type: "string", pattern: "^[A-Z]{2}$", default: "IN" },
  type: { type: "string", enum: ["SHIPPING", "BILLING"], default: "SHIPPING" },
};
const createBody = { type: "object", additionalProperties: false, required: ["name", "phone", "addressLine1", "city", "state", "postalCode"], properties };
const updateBody = { type: "object", additionalProperties: false, minProperties: 1, properties: { ...properties, country: { type: "string", pattern: "^[A-Z]{2}$" }, type: { type: "string", enum: ["SHIPPING", "BILLING"] } } };
const bearer = [{ bearerAuth: [] }];

// The customer's saved delivery addresses. Every query is scoped to the signed-in customer, and another
// customer's address is reported as not found.
export const addressRoutes: FastifyPluginAsync = async (app) => {
  const service = createOrderService(app.prisma);
  const customerId = async (request: FastifyRequest) => {
    await request.requireCustomer();
    return (await service.customerFor((request.user as { sub: string }).sub)).id;
  };
  const clean = (input: Record<string, unknown>) => ({ ...input, ...(typeof input.addressLine2 === "string" ? { addressLine2: input.addressLine2.trim() || null } : {}) });

  app.get("/api/v1/addresses", { schema: routeSchema(["Addresses"], "List the signed-in customer's addresses", { security: bearer }) }, async (request) => {
    const owner = await customerId(request);
    return { success: true, data: await app.prisma.retailAddress.findMany({ where: { customerId: owner }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }) };
  });

  app.post("/api/v1/addresses", { schema: routeSchema(["Addresses"], "Add an address", { security: bearer, body: createBody }) }, async (request, reply) => {
    const owner = await customerId(request);
    if ((await app.prisma.retailAddress.count({ where: { customerId: owner } })) >= MAX_ADDRESSES) throw httpError(409, "ADDRESS_LIMIT", `You can save up to ${MAX_ADDRESSES} addresses`);
    const address = await app.prisma.retailAddress.create({ data: { ...clean(request.body as Record<string, unknown>), customerId: owner } as never });
    reply.code(201);
    return { success: true, data: address };
  });

  app.put("/api/v1/addresses/:id", { schema: routeSchema(["Addresses"], "Update an address", { security: bearer, params: idParams, body: updateBody }) }, async (request) => {
    const owner = await customerId(request);
    const id = (request.params as { id: string }).id;
    // Orders keep their own copy of the address, so editing one never changes a past order.
    const result = await app.prisma.retailAddress.updateMany({ where: { id, customerId: owner }, data: clean(request.body as Record<string, unknown>) as never });
    if (result.count === 0) throw httpError(404, "NOT_FOUND", "Address not found");
    return { success: true, data: await app.prisma.retailAddress.findUniqueOrThrow({ where: { id } }) };
  });

  // An address an order was delivered to can't be deleted (409 RECORD_IN_USE, from the foreign key).
  app.delete("/api/v1/addresses/:id", { schema: routeSchema(["Addresses"], "Delete an address", { security: bearer, params: idParams }) }, async (request, reply) => {
    const owner = await customerId(request);
    const id = (request.params as { id: string }).id;
    if (!(await app.prisma.retailAddress.findFirst({ where: { id, customerId: owner }, select: { id: true } }))) throw httpError(404, "NOT_FOUND", "Address not found");
    await app.prisma.retailAddress.delete({ where: { id } });
    reply.code(204).send();
  });
};
