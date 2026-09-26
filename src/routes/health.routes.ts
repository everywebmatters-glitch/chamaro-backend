import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", { schema: { tags: ["Health"], summary: "Service health check", response: { 200: { type: "object", required: ["success", "data"], properties: { success: { type: "boolean" }, data: { type: "object", required: ["status"], properties: { status: { type: "string" } } } } } } } }, async () => ({ success: true, data: { status: "ok" } }));
};
