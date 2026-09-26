import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { FastifyInstance } from "fastify";

export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Chamaro API",
        description: "Chamaro Ecommerce API",
        version: "1.0.0",
      },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
      servers: [
        {
          url: process.env.SWAGGER_SERVER_URL ?? "http://localhost:4000",
          description: "Configured API server",
        },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });
}
