import { isIP } from "node:net";
import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";
import { env } from "../config/env.js";

// The client address each rate limit counts against: request.ip (resolved through TRUSTED_PROXIES in app.ts). If that
// is not a valid IP address (a malformed forwarded entry), fall back to the connecting peer, so a client can never mint
// fresh buckets by writing junk into X-Forwarded-For; the fallback is one shared, stricter bucket.
export function rateLimitKey(request: Pick<FastifyRequest, "ip" | "socket">): string {
  return isIP(request.ip) ? request.ip : request.socket.remoteAddress ?? "unknown";
}

export default fp(async (app) => {
  // HS256 only: tokens signed with any other algorithm (none, HS384/512, RS*) are rejected.
  // Calls that pass their own options (google-oauth.tokens.ts) must pin it themselves, because
  // per-call options replace these defaults rather than merging with them.
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { algorithm: "HS256", expiresIn: "8h" }, verify: { algorithms: ["HS256"] } });
  await app.register(rateLimit, { global: false, keyGenerator: rateLimitKey });
});
