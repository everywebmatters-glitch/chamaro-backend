import type { PrismaClient } from "../../generated/prisma/client.js";

export function createPasswordResetRepository(prisma: PrismaClient) {
  return {
    findLatestForUser: (userId: string) =>
      prisma.passwordResetToken.findFirst({ where: { userId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),

    // A new link supersedes every earlier unused one, so only the most recent email works.
    issue: (data: { userId: string; tokenHash: string; expiresAt: Date }) =>
      prisma.$transaction([
        prisma.passwordResetToken.updateMany({ where: { userId: data.userId, usedAt: null }, data: { usedAt: new Date() } }),
        prisma.passwordResetToken.create({ data }),
      ]),

    // Redeems a token and sets the new password in one transaction. The conditional update is the single-use
    // guarantee: of two concurrent requests with the same token, InnoDB lets exactly one change the row
    // (usedAt NULL -> now); the other then matches nothing. Returns false for an unknown, expired, already-used
    // or superseded token, and for an inactive or non-customer account, without changing anything.
    redeem: (tokenHash: string, passwordHash: string) =>
      prisma.$transaction(async (tx) => {
        const now = new Date();
        const record = await tx.passwordResetToken.findUnique({ where: { tokenHash }, include: { user: { select: { id: true, email: true, isActive: true, role: true } } } });
        // Links are only issued to customers; one issued before the account became an admin must not reset it.
        if (!record || !record.user.isActive || record.user.role !== "CUSTOMER") return false;
        const claimed = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
        if (claimed.count !== 1) return false;
        await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
        // The password changed: no other reset link or reset code issued before now may change it again.
        await tx.passwordResetToken.updateMany({ where: { userId: record.userId, usedAt: null }, data: { usedAt: now } });
        await tx.emailOtp.updateMany({ where: { email: record.user.email, purpose: "FORGOT_PASSWORD", consumedAt: null }, data: { consumedAt: now } });
        return true;
      }),

    invalidateForUser: (userId: string) =>
      prisma.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } }),
  };
}

export type PasswordResetRepository = ReturnType<typeof createPasswordResetRepository>;
