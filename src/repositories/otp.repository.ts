import type { OtpPurpose, PrismaClient } from "../../generated/prisma/client.js";

export function createOtpRepository(prisma: PrismaClient) {
  return {
    findLatest: (email: string, purpose: OtpPurpose) =>
      prisma.emailOtp.findFirst({ where: { email, purpose }, orderBy: { createdAt: "desc" } }),

    findActive: (email: string, purpose: OtpPurpose) =>
      prisma.emailOtp.findFirst({ where: { email, purpose, consumedAt: null }, orderBy: { createdAt: "desc" } }),

    create: (data: { email: string; purpose: OtpPurpose; otpHash: string; expiresAt: Date; userId?: string }) =>
      prisma.emailOtp.create({ data }),

    // A new send always supersedes whatever code was previously active for this email+purpose.
    invalidateActive: (email: string, purpose: OtpPurpose) =>
      prisma.emailOtp.updateMany({ where: { email, purpose, consumedAt: null }, data: { consumedAt: new Date() } }),

    incrementAttempts: (id: string) => prisma.emailOtp.update({ where: { id }, data: { attempts: { increment: 1 } } }),

    markConsumed: (id: string) => prisma.emailOtp.update({ where: { id }, data: { consumedAt: new Date() } }),
  };
}

export type OtpRepository = ReturnType<typeof createOtpRepository>;
