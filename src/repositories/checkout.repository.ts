import type { PrismaClient } from "../../generated/prisma/client.js";

export function createCheckoutRepository(prisma: PrismaClient) {
  return {
    // One active verification per user: a new one replaces whatever was there before.
    upsertVerification: (userId: string, expiresAt: Date) =>
      prisma.checkoutVerification.upsert({ where: { userId }, update: { expiresAt }, create: { userId, expiresAt } }),

    findActive: (userId: string) =>
      prisma.checkoutVerification.findFirst({ where: { userId, expiresAt: { gt: new Date() } } }),

    clear: (userId: string) => prisma.checkoutVerification.deleteMany({ where: { userId } }),
  };
}

export type CheckoutRepository = ReturnType<typeof createCheckoutRepository>;
