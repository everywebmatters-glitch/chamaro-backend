import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { env } from "../config/env.js";

export default fp(async (app) => {
  // HS256 only: tokens signed with any other algorithm (none, HS384/512, RS*) are rejected.
  // Calls that pass their own options (google-oauth.tokens.ts) must pin it themselves, because
  // per-call options replace these defaults rather than merging with them.
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { algorithm: "HS256", expiresIn: "8h" }, verify: { algorithms: ["HS256"] } });
  await app.register(rateLimit, { global: false });
});
