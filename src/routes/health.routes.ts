import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", { schema: { tags: ["Health"], summary: "Service health check", response: { 200: { type: "object", required: ["success", "data"], properties: { success: { type: "boolean" }, data: { type: "object", required: ["status"], properties: { status: { type: "string" } } } } } } } }, async () => ({ success: true, data: { status: "ok" } }));
  // Readiness: proves the process can reach its database. Unlike /health this does touch the database, so it is for
  // manual checks and uptime probes, not the Cloud Build smoke test. Failures answer 503 with a generic message; the
  // underlying error (which could name hosts or accounts) is logged, never returned.
  app.get("/health/ready", { schema: { tags: ["Health"], summary: "Readiness check (database reachable)", response: { 200: { type: "object", required: ["success", "data"], properties: { success: { type: "boolean" }, data: { type: "object", required: ["status", "database"], properties: { status: { type: "string" }, database: { type: "string" } } } } }, 503: { type: "object", required: ["success", "error"], properties: { success: { type: "boolean" }, error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } } } } } } }, async (request, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      return { success: true, data: { status: "ok", database: "ok" } };
    } catch (error) {
      request.log.error({ err: error }, "readiness check: database unreachable");
      return reply.code(503).send({ success: false, error: { code: "DATABASE_UNAVAILABLE", message: "Database is not reachable" } });
    }
  });
};
