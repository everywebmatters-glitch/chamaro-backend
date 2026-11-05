import type { FastifyPluginAsync } from "fastify";
import { createAdminRouteSchema } from "../schemas/admin.schema.js";
import { createAdminService } from "../services/admin.service.js";
import { createAdminController } from "../controllers/admin.controller.js";
import { httpError, notFound, pageMeta, routeSchema } from "../shared/http.js";

const adminListQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    search: { type: "string", maxLength: 100 },
  },
};

const customerListQuery = {
  ...adminListQuery,
  properties: {
    ...adminListQuery.properties,
    customerType: { type: "string", enum: ["RETAIL", "B2B"] },
  },
};

const adminStatusBody = {
  type: "object",
  additionalProperties: false,
  required: ["isActive"],
  properties: { isActive: { type: "boolean" } },
};

const storeSettingsBody = {
  type: "object",
  additionalProperties: false,
  required: ["storeName", "supportEmail", "supportPhone", "currency", "timezone"],
  properties: {
    storeName: { type: "string", minLength: 1, maxLength: 191, pattern: "\\S" },
    supportEmail: { type: "string", maxLength: 191, pattern: "^$|^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
    supportPhone: { type: "string", maxLength: 32 },
    currency: { type: "string", minLength: 3, maxLength: 3, pattern: "^[A-Za-z]{3}$" },
    timezone: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
  },
};

const safeAdminSelect = { id: true, name: true, email: true, role: true, isActive: true, createdAt: true } as const;
const defaultStoreSettings = {
  storeName: "",
  supportEmail: "",
  supportPhone: "",
  currency: "",
  timezone: "",
};

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const controller = createAdminController(createAdminService(app.prisma));

  app.get("/api/v1/admin/customers", { schema: routeSchema(["Admin", "Customers"], "List customer accounts", { security: [{ bearerAuth: [] }], querystring: customerListQuery }) }, async (request) => {
    await request.requireAdmin();
    const query = request.query as { page?: number; limit?: number; search?: string; customerType?: "RETAIL" | "B2B" };
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const search = query.search?.trim();
    const where = {
      role: "CUSTOMER" as const,
      customer: query.customerType ? { is: { customerType: query.customerType } } : { isNot: null },
      ...(search
        ? {
            OR: [
              { name: { contains: search } },
              { email: { contains: search } },
              { customer: { is: { phone: { contains: search } } } },
              { customer: { is: { companyName: { contains: search } } } },
            ],
          }
        : {}),
    };
    const [customers, total] = await app.prisma.$transaction([
      app.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          isActive: true,
          createdAt: true,
          customer: {
            select: {
              customerType: true,
              phone: true,
              companyName: true,
              _count: { select: { retailOrders: true } },
            },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      app.prisma.user.count({ where }),
    ]);
    return { success: true, data: customers, meta: pageMeta(page, limit, total) };
  });

  app.get("/api/v1/admin/admins", { schema: routeSchema(["Admin"], "List administrator accounts", { security: [{ bearerAuth: [] }], querystring: adminListQuery }) }, async (request) => {
    await request.requireAdmin();
    const query = request.query as { page?: number; limit?: number; search?: string };
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const search = query.search?.trim();
    const where = {
      role: "ADMIN" as const,
      ...(search
        ? { OR: [{ name: { contains: search } }, { email: { contains: search } }] }
        : {}),
    };
    const [admins, total] = await app.prisma.$transaction([
      app.prisma.user.findMany({
        where,
        select: safeAdminSelect,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      app.prisma.user.count({ where }),
    ]);
    return { success: true, data: admins, meta: pageMeta(page, limit, total) };
  });

  app.post("/api/v1/admin/admins", { schema: createAdminRouteSchema }, async (request, reply) => {
    // Auth hook lives in the route, per architecture: any authenticated, active ADMIN may
    // provision another ADMIN. There are exactly two roles (CUSTOMER, ADMIN) and no higher
    // tier to restrict this to.
    await request.requireAdmin();
    return controller.createAdmin(request, reply);
  });

  app.patch("/api/v1/admin/admins/:id/status", { schema: routeSchema(["Admin"], "Activate or deactivate an administrator", { security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } }, body: adminStatusBody }) }, async (request) => {
    await request.requireAdmin();
    const { id } = request.params as { id: string };
    const { isActive } = request.body as { isActive: boolean };
    const currentAdminId = (request.user as { sub: string }).sub;
    if (!isActive && id === currentAdminId) throw httpError(400, "INVALID_OPERATION", "You cannot deactivate your own account.");
    const target = await app.prisma.user.findFirst({ where: { id, role: "ADMIN" }, select: { id: true, isActive: true } });
    if (!target) throw notFound("Administrator not found.");
    if (!isActive && target.isActive) {
      const activeAdmins = await app.prisma.user.count({ where: { role: "ADMIN", isActive: true } });
      if (activeAdmins <= 1) throw httpError(409, "LAST_ACTIVE_ADMIN", "The last active administrator cannot be deactivated.");
    }
    const updated = await app.prisma.user.updateMany({ where: { id, role: "ADMIN" }, data: { isActive } });
    if (!updated.count) throw notFound("Administrator not found.");
    return { success: true, data: await app.prisma.user.findUniqueOrThrow({ where: { id }, select: safeAdminSelect }) };
  });

  app.get("/api/v1/admin/store-settings", { schema: routeSchema(["Admin", "Store Settings"], "Get store settings", { security: [{ bearerAuth: [] }] }) }, async (request) => {
    await request.requireAdmin();
    const settings = await app.prisma.storeSettings.findUnique({ where: { id: "store" } });
    return { success: true, data: settings ?? defaultStoreSettings };
  });

  app.put("/api/v1/admin/store-settings", { schema: routeSchema(["Admin", "Store Settings"], "Update store settings", { security: [{ bearerAuth: [] }], body: storeSettingsBody }) }, async (request) => {
    await request.requireAdmin();
    const input = request.body as { storeName: string; supportEmail: string; supportPhone: string; currency: string; timezone: string };
    const settings = {
      storeName: input.storeName.trim(),
      supportEmail: input.supportEmail.trim().toLowerCase(),
      supportPhone: input.supportPhone.trim(),
      currency: input.currency.trim().toUpperCase(),
      timezone: input.timezone.trim(),
    };
    if (!settings.storeName || !settings.timezone) throw httpError(400, "VALIDATION_ERROR", "Store name and timezone are required.");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: settings.timezone });
    } catch {
      throw httpError(400, "VALIDATION_ERROR", "Timezone must be a valid IANA timezone.");
    }
    const saved = await app.prisma.storeSettings.upsert({
      where: { id: "store" },
      create: { id: "store", ...settings },
      update: settings,
    });
    return { success: true, data: saved };
  });
};
