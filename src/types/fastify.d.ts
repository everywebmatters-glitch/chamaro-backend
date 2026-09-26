import "fastify";
import type { PrismaClient } from "../../generated/prisma/client.js";

declare module "fastify" {
  interface FastifyInstance { prisma: PrismaClient; }
  interface FastifyRequest { requireAdmin(): Promise<void>; requireCustomer(): Promise<void>; }
}
