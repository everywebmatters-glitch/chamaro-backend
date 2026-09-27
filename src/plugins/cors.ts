import cors from "@fastify/cors";
import { FastifyInstance } from "fastify";
import { env } from "../config/env.js";

export async function registerCors(app: FastifyInstance): Promise<void> {
  const origins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (origins.includes("*")) throw new Error("CORS_ORIGIN cannot contain '*' when credentials are enabled");
  await app.register(cors, {
    origin: origins,
    credentials: true,
    // @fastify/cors v11 only allows GET, HEAD and POST by default, which made browsers block
    // every admin PUT/DELETE (products, categories, media) at the preflight.
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE"],
  });
}
