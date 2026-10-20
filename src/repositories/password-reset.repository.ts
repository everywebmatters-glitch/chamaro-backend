import type { Prisma, PrismaClient, Role } from "../../generated/prisma/client.js";

// The account whose password a redeemed link just changed, as the transaction left it.
export type PasswordChangedUser = { id: string; name: string; email: string; role: Role; emailVerifiedAt: Date | null };

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
    // or superseded token, for an inactive account, and for one whose role is no longer the one the link was issued
    // for, without changing anything. `candidates` are the token's hash under each role's scope (see hashResetToken).
    // Using the emailed link proves the holder reads mail at the account's address, so it also marks that address
    // verified. `onChanged` runs inside the same transaction once the password has changed (e.g. to record the
    // password-changed email), and its result is returned; if it throws, the whole reset is rolled back.
    redeem: <T>(candidates: { tokenHash: string; role: Role }[], passwordHash: string, onChanged: (tx: Prisma.TransactionClient, user: PasswordChangedUser, changedAt: Date, tokenId: string) => Promise<T>) =>
      prisma.$transaction(async (tx): Promise<T | false> => {
        const now = new Date();
        const records = await tx.passwordResetToken.findMany({ where: { tokenHash: { in: candidates.map((candidate) => candidate.tokenHash) } }, include: { user: { select: { id: true, email: true, isActive: true, role: true, emailVerifiedAt: true } } } });
        const record = records.find((row) => candidates.some((candidate) => candidate.tokenHash === row.tokenHash && candidate.role === row.user.role));
        if (!record || !record.user.isActive) return false;
        const claimed = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
        if (claimed.count !== 1) return false;
        const user = await tx.user.update({ where: { id: record.userId }, data: { passwordHash, emailVerifiedAt: record.user.emailVerifiedAt ?? now }, select: { id: true, name: true, email: true, role: true, emailVerifiedAt: true } });
        // The password changed: no other reset link or reset code issued before now may change it again.
        await tx.passwordResetToken.updateMany({ where: { userId: record.userId, usedAt: null }, data: { usedAt: now } });
        await tx.emailOtp.updateMany({ where: { email: record.user.email, purpose: "FORGOT_PASSWORD", consumedAt: null }, data: { consumedAt: now } });
        return onChanged(tx, user, now, record.id);
      }),
  };
}

export type PasswordResetRepository = ReturnType<typeof createPasswordResetRepository>;
