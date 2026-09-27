import fp from "fastify-plugin";

// Baseline response headers for a JSON API (the essentials of @fastify/helmet without adding a
// dependency). A header a route already set wins, so GET /api/v1/media/:id keeps its own
// image-specific CSP and Cross-Origin-Resource-Policy.
const API_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // Nothing an API returns needs to run or load anything, or be framed.
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

// Swagger UI (registered outside production only) is an HTML app that needs scripts and styles.
const DOCS_PREFIX = "/docs";

export default fp(async (app) => {
  app.addHook("onSend", async (request, reply, payload) => {
    const isDocs = request.url === DOCS_PREFIX || request.url.startsWith(`${DOCS_PREFIX}/`);
    for (const [name, value] of Object.entries(API_HEADERS)) {
      if (isDocs && name === "Content-Security-Policy") continue;
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    // Only over HTTPS (request.protocol honours X-Forwarded-Proto from the trusted proxy):
    // browsers ignore HSTS on plain HTTP, and local development stays on http://localhost.
    if (request.protocol === "https") reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    return payload;
  });
});
