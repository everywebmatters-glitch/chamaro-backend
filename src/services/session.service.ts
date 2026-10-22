import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";

// Persistent ("stay signed in") customer sessions. The browser keeps only an opaque random token in an HttpOnly cookie
// (see utils/session-cookie.ts); this stores its SHA-256, never the token. Rules that protect the account:
//  - every use rotates the token: the presented row is marked used and a new row, in the same family, replaces it, so a
//    copied token can be replayed at most once;
//  - a used token presented again is a replay, unless it arrives within REUSE_GRACE_MS of its use (two tabs refreshing at
//    the same moment); then it is served again with a fresh token. After the grace the whole family is revoked;
//  - a session ends at its absolute lifetime, on logout, when the account is deactivated or is no longer a customer, and
//    when the password changes (auth.service revokes every session of the account);
//  - the caller (the refresh route) gets back only the user id; the access token is signed by the controller.

export const SESSION_DAYS = 30;
export const REUSE_GRACE_MS = 60_000;
const MAX_ACTIVE_PER_USER = 20;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type StartedSession = { token: string; expiresAt: Date };
export type RefreshResult = { userId: string; session: StartedSession };

export function createSessionService(prisma: PrismaClient) {
  async function insert(db: Prisma.TransactionClient | PrismaClient, userId: string, familyId: string, userAgent: string | null, expiresAt: Date): Promise<StartedSession> {
    const token = newToken();
    await db.authSession.create({ data: { userId, familyId, tokenHash: hash(token), expiresAt, userAgent: userAgent?.slice(0, 191) ?? null } });
    return { token, expiresAt };
  }

  return {
    // A new session (a new family) for a user who has just proved who they are.
    async start(userId: string, userAgent: string | null): Promise<StartedSession> {
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60_000);
      const session = await insert(prisma, userId, randomBytes(12).toString("hex"), userAgent, expiresAt);
      // Housekeeping at the one place rows are added: drop this user's expired rows, and the oldest beyond the cap.
      await prisma.authSession.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } });
      const live = await prisma.authSession.findMany({ where: { userId, usedAt: null, revokedAt: null }, orderBy: { createdAt: "desc" }, skip: MAX_ACTIVE_PER_USER, select: { id: true } });
      if (live.length > 0) await prisma.authSession.updateMany({ where: { id: { in: live.map((row) => row.id) } }, data: { revokedAt: new Date() } });
      return session;
    },

    // Exchanges a presented token for a new one. Returns null for anything that is not a live session (unknown, expired,
    // revoked, malformed, replayed); a replay also revokes the family.
    async rotate(presented: string | undefined, userAgent: string | null): Promise<RefreshResult | null> {
      if (!presented || !TOKEN_SHAPE.test(presented)) return null;
      const now = new Date();
      const row = await prisma.authSession.findUnique({ where: { tokenHash: hash(presented) } });
      if (!row || row.revokedAt || row.expiresAt <= now) return null;

      if (row.usedAt) {
        if (now.getTime() - row.usedAt.getTime() > REUSE_GRACE_MS) {
          await prisma.authSession.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: now } });
          return null;
        }
        // Two tabs, one refresh: the other tab already rotated it a moment ago. Serve this one too, in the same family.
        return { userId: row.userId, session: await insert(prisma, row.userId, row.familyId, userAgent, row.expiresAt) };
      }

      // Mark it used (a simultaneous request that also got this far does the same; both are served, as in the grace case).
      await prisma.authSession.updateMany({ where: { id: row.id, usedAt: null, revokedAt: null }, data: { usedAt: now } });
      return { userId: row.userId, session: await insert(prisma, row.userId, row.familyId, userAgent, row.expiresAt) };
    },

    // A Google exchange code may be redeemed once. The first redemption records a marker (an already-revoked row whose
    // hash can't be a real session token, unique per code); a second redemption hits the unique index and is refused.
    // The markers are deleted with the rest of the user's expired rows (see start).
    async useExchangeCodeOnce(userId: string, jti: string, expiresAt: Date): Promise<boolean> {
      const now = new Date();
      try {
        await prisma.authSession.create({ data: { userId, familyId: "oauth-exchange-code", tokenHash: hash(`oauth-exchange-code:${jti}`), expiresAt, usedAt: now, revokedAt: now } });
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") return false;
        throw error;
      }
    },

    // Ends the session the cookie belongs to (its whole family), whatever its state.
    async revokeFamilyOf(presented: string | undefined): Promise<void> {
      if (!presented || !TOKEN_SHAPE.test(presented)) return;
      const row = await prisma.authSession.findUnique({ where: { tokenHash: hash(presented) }, select: { familyId: true } });
      if (row) await prisma.authSession.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    },
  };
}

// Used inside the transaction that changes a password: every session of the account ends with it.
export async function revokeAllSessions(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export type SessionService = ReturnType<typeof createSessionService>;
