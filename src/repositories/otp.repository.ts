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

    findById: (id: string) => prisma.emailOtp.findUnique({ where: { id } }),

    // Takes one guess from the code's allowance in a single conditional write: only while the code is unused and has
    // guesses left. Concurrent requests can therefore never compare more than `maxAttempts` guesses against one code.
    // Returns how many rows changed (1 = reserved, 0 = no guesses left, or the code was used or replaced meanwhile).
    reserveAttempt: async (id: string, maxAttempts: number) =>
      (await prisma.emailOtp.updateMany({ where: { id, consumedAt: null, attempts: { lt: maxAttempts } }, data: { attempts: { increment: 1 } } })).count,

    // Gives back a reserved guess when the code matched, so a correct code never counts as a wrong guess.
    releaseAttempt: (id: string) => prisma.emailOtp.updateMany({ where: { id, attempts: { gt: 0 } }, data: { attempts: { decrement: 1 } } }),

    // Marks the code used only while it is still unused, in one conditional write, so of two concurrent requests with
    // the same correct code exactly one succeeds. Returns how many rows changed (1 = this request used it).
    consumeIfActive: async (id: string) =>
      (await prisma.emailOtp.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } })).count,
  };
}

export type OtpRepository = ReturnType<typeof createOtpRepository>;
