import type { FastifyPluginAsync } from "fastify";
import { pageMeta, routeSchema } from "../shared/http.js";

const createEnquiryBody = {
  type: "object",
  additionalProperties: false,
  required: ["name", "companyName", "email", "phone", "productType", "quantity", "message"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 191, pattern: "\\S" },
    companyName: { type: "string", minLength: 1, maxLength: 191, pattern: "\\S" },
    email: { type: "string", minLength: 3, maxLength: 191, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
    phone: { type: "string", minLength: 10, maxLength: 16, pattern: "^(\\+91[\\s-]?)?[6-9][0-9]{9}$" },
    productType: { type: "string", minLength: 1, maxLength: 191, pattern: "\\S" },
    quantity: { type: "integer", minimum: 1, maximum: 1000000 },
    message: { type: "string", minLength: 10, maxLength: 10000, pattern: "\\S" },
  },
};

const adminQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
};

export const b2bEnquiryRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/v1/enquiries",
    { schema: routeSchema(["B2B Enquiries"], "Submit a B2B enquiry", { body: createEnquiryBody }) },
    async (request, reply) => {
      const input = request.body as {
        name: string;
        companyName: string;
        email: string;
        phone: string;
        productType: string;
        quantity: number;
        message: string;
      };

      const enquiry = await app.prisma.b2BEnquiry.create({
        data: {
          companyName: input.companyName.trim(),
          contactName: input.name.trim(),
          email: input.email.trim(),
          phone: input.phone.trim(),
          message: input.message.trim(),
          items: {
            create: {
              quantity: input.quantity,
              requirements: input.productType.trim(),
            },
          },
        },
        select: { id: true, status: true },
      });

      reply.code(201);
      return { success: true, data: enquiry };
    },
  );

  app.get(
    "/api/v1/admin/b2b-enquiries",
    {
      schema: routeSchema(["Admin", "B2B Enquiries"], "List B2B enquiries", {
        security: [{ bearerAuth: [] }],
        querystring: adminQuery,
      }),
    },
    async (request) => {
      await request.requireAdmin();
      const query = request.query as { page?: number; limit?: number };
      const page = query.page ?? 1;
      const limit = query.limit ?? 20;
      const [rows, total] = await app.prisma.$transaction([
        app.prisma.b2BEnquiry.findMany({
          select: {
            id: true,
            companyName: true,
            contactName: true,
            email: true,
            phone: true,
            message: true,
            status: true,
            createdAt: true,
            items: { select: { id: true, productId: true, quantity: true, requirements: true } },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        app.prisma.b2BEnquiry.count(),
      ]);

      const data = rows.map(({ contactName, ...enquiry }) => ({ ...enquiry, name: contactName }));
      return { success: true, data, meta: pageMeta(page, limit, total) };
    },
  );
};
