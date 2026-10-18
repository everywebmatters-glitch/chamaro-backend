import type { FastifyRequest } from "fastify";
import type { CheckoutService } from "../services/checkout.service.js";

async function requireCustomerEmail(request: FastifyRequest): Promise<{ userId: string; email: string }> {
  await request.requireCustomer();
  const userId = (request.user as { sub: string }).sub;
  const user = await request.server.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  return { userId, email: user.email };
}

export function createCheckoutController(service: CheckoutService) {
  return {
    async sendOtp(request: FastifyRequest) {
      const { userId, email } = await requireCustomerEmail(request);
      await service.sendCheckoutOtp(userId, email);
      return { success: true, data: { message: "A verification code has been sent to your email." } };
    },

    async verifyOtp(request: FastifyRequest) {
      const { userId, email } = await requireCustomerEmail(request);
      const { otp } = request.body as { otp: string };
      const expiresAt = await service.verifyCheckoutOtp(userId, email, otp);
      return { success: true, data: { verified: true, expiresAt: expiresAt.toISOString() } };
    },
  };
}
