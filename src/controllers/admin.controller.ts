import type { FastifyReply, FastifyRequest } from "fastify";
import type { AdminService } from "../services/admin.service.js";
import type { CreateAdminInput } from "../types/admin.types.js";

export function createAdminController(service: AdminService) {
  return {
    async createAdmin(request: FastifyRequest, reply: FastifyReply) {
      const admin = await service.createAdmin(request.body as CreateAdminInput);
      reply.code(201);
      return { success: true, data: admin };
    },
  };
}
