import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { deliverEmail, type EmailMessage, type EmailProviderFailure } from "./email.service.js";

// The email outbox (model EmailNotification). A notification is written in the same transaction as the change it
// reports, then sent after that transaction commits: right away by the request that made the change, and again by
// the outbox worker (src/scripts/email-outbox-worker.ts) if that first attempt failed or never finished.
//
// Guarantees:
//  - one row per event: eventKey is unique, so a repeated or concurrent request records the event once;
//  - one sender at a time: an attempt first claims the row (PENDING -> SENDING, with a lease) by a conditional
//    update, so of two senders only one ever holds it;
//  - no double delivery when a send succeeded but was not recorded (a crash, a lost database write): the retry
//    sends the same stored message with the same idempotency key (the eventKey), and the provider answers it with
//    the first result instead of sending again. The provider keeps keys for 24 hours, so nothing older than
//    RETRY_WINDOW_MS is retried;
//  - bounded retries: at most MAX_ATTEMPTS, with growing delays; errors that retrying cannot fix fail at once;
//  - only the email row changes: a failed send never touches the order, the payment or the account;
//  - nothing secret: only the provider's error name and HTTP status are stored or logged, never its message, and
//    log lines carry ids, never the recipient's address.

export type NotificationKind = "ORDER_PLACED" | "ORDER_SHIPPED" | "ORDER_CANCELLED" | "PASSWORD_CHANGED" | "OUTBOX_SELF_TEST";

export const OUTBOX_SETTINGS = {
  MAX_ATTEMPTS: 5,
  // Wait before attempt 2, 3, 4 and 5.
  RETRY_DELAYS_MINUTES: [1, 5, 15, 60],
  // How long a claimed attempt may take before another sender may take the row over.
  LEASE_MS: 2 * 60_000,
  RETRY_WINDOW_MS: 23 * 60 * 60_000,
};

// Provider errors that mean this message can never be accepted as it is, so retrying would only repeat them.
const PERMANENT_ERRORS = new Set(["validation_error", "invalid_parameter", "missing_required_field", "invalid_idempotency_key", "invalid_idempotent_request", "invalid_attachment"]);

type Db = PrismaClient | Prisma.TransactionClient;
type OutboxLog = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; error(obj: object, msg: string): void };

// `verified` is false for an address its owner never proved they read (User.emailVerifiedAt is NULL): such a
// notification is recorded as SKIPPED and never sent.
export type NotificationRecipient = { userId: string | null; email: string; verified: boolean };

export type QueuedNotification = { id: string; status: string };

// Records a notification inside the caller's transaction (pass the transaction client). If the event was recorded
// before, returns that row unchanged. Never sends anything: call dispatch() once the transaction has committed.
export async function enqueueNotification(
  tx: Db,
  input: { eventKey: string; kind: NotificationKind; recipient: NotificationRecipient; orderId?: string; message: EmailMessage },
): Promise<QueuedNotification> {
  const { recipient, message } = input;
  return tx.emailNotification.upsert({
    where: { eventKey: input.eventKey },
    create: {
      eventKey: input.eventKey,
      kind: input.kind,
      toEmail: recipient.email,
      userId: recipient.userId,
      orderId: input.orderId ?? null,
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(recipient.verified ? { status: "PENDING" as const } : { status: "SKIPPED" as const, skipReason: "UNVERIFIED_RECIPIENT" }),
    },
    update: {},
    select: { id: true, status: true },
  });
}

export type AttemptResult = "SENT" | "RETRY" | "FAILED" | "NOT_CLAIMED";

export function createEmailOutbox(prisma: PrismaClient, options: { log?: OutboxLog } = {}) {
  const { MAX_ATTEMPTS, RETRY_DELAYS_MINUTES, LEASE_MS, RETRY_WINDOW_MS } = OUTBOX_SETTINGS;

  // A row can be attempted when it is due (PENDING and nextAttemptAt reached) or its previous attempt's lease ran
  // out (SENDING, lockedUntil passed), it has attempts left, and it is young enough that its idempotency key holds.
  function attemptable(now: Date): Prisma.EmailNotificationWhereInput {
    return {
      attempts: { lt: MAX_ATTEMPTS },
      createdAt: { gt: new Date(now.getTime() - RETRY_WINDOW_MS) },
      OR: [{ status: "PENDING", nextAttemptAt: { lte: now } }, { status: "SENDING", lockedUntil: { lt: now } }],
    };
  }

  async function attempt(id: string): Promise<AttemptResult> {
    const now = new Date();
    const claimed = await prisma.emailNotification.updateMany({
      where: { id, ...attemptable(now) },
      data: { status: "SENDING", lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return "NOT_CLAIMED";
    const row = await prisma.emailNotification.findUniqueOrThrow({ where: { id } });
    // Every later write is fenced on this attempt number: if the lease ran out and another sender took the row
    // over, this attempt's outcome is not recorded over that one.
    const mine = { id, status: "SENDING" as const, attempts: row.attempts };

    let failure: EmailProviderFailure;
    try {
      const { providerMessageId } = await deliverEmail(row.toEmail, row, { idempotencyKey: row.eventKey });
      await prisma.emailNotification.updateMany({ where: mine, data: { status: "SENT", sentAt: new Date(), providerMessageId, lockedUntil: null, lastErrorName: null, lastErrorStatus: null } });
      options.log?.info({ notificationId: id, kind: row.kind, attempt: row.attempts }, "Email notification sent");
      return "SENT";
    } catch (error) {
      failure = (error as { provider?: EmailProviderFailure }).provider ?? { name: "unknown_error", statusCode: null };
    }

    const giveUp = PERMANENT_ERRORS.has(failure.name) || row.attempts >= MAX_ATTEMPTS;
    const delayMinutes = RETRY_DELAYS_MINUTES[Math.min(row.attempts, RETRY_DELAYS_MINUTES.length) - 1];
    await prisma.emailNotification.updateMany({
      where: mine,
      data: {
        lockedUntil: null,
        lastErrorName: failure.name,
        lastErrorStatus: failure.statusCode,
        ...(giveUp ? { status: "FAILED" as const } : { status: "PENDING" as const, nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000) }),
      },
    });
    options.log?.[giveUp ? "error" : "warn"]({ notificationId: id, kind: row.kind, attempt: row.attempts, provider: failure }, giveUp ? "Email notification failed; giving up" : "Email notification failed; will retry");
    return giveUp ? "FAILED" : "RETRY";
  }

  return {
    attempt,

    // For a request that just committed a notification: one attempt, never throws, never changes anything but the
    // email row. A failure is left for the worker to retry.
    async dispatch(notification: QueuedNotification | null | undefined): Promise<void> {
      if (!notification || notification.status !== "PENDING") return;
      try {
        await attempt(notification.id);
      } catch (error) {
        options.log?.error({ notificationId: notification.id, err: { code: (error as { code?: unknown }).code } }, "Email notification attempt could not be recorded");
      }
    },

    // Rows that can never be attempted again are marked FAILED: an attempt whose lease ran out with no attempts
    // left (its outcome is unknown, and retrying could deliver twice), and anything too old for its idempotency key.
    async expireStale(): Promise<number> {
      const now = new Date();
      const windowStart = new Date(now.getTime() - RETRY_WINDOW_MS);
      const leaseOver = { status: "SENDING" as const, lockedUntil: { lt: now } };
      const outcomeUnknown = await prisma.emailNotification.updateMany({
        where: { ...leaseOver, attempts: { gte: MAX_ATTEMPTS }, createdAt: { gt: windowStart } },
        data: { status: "FAILED", lockedUntil: null, lastErrorName: "outcome_unknown", lastErrorStatus: null },
      });
      const tooOld = await prisma.emailNotification.updateMany({
        where: { createdAt: { lte: windowStart }, OR: [{ status: "PENDING" }, leaseOver] },
        data: { status: "FAILED", lockedUntil: null, lastErrorName: "retry_window_expired", lastErrorStatus: null },
      });
      return outcomeUnknown.count + tooOld.count;
    },

    // One worker pass: expire what can't be retried, then attempt up to `limit` due rows, oldest due first.
    async drain(limit = 25) {
      const expired = await this.expireStale();
      const due = await prisma.emailNotification.findMany({ where: attemptable(new Date()), orderBy: { nextAttemptAt: "asc" }, take: limit, select: { id: true } });
      const results: Record<AttemptResult, number> = { SENT: 0, RETRY: 0, FAILED: 0, NOT_CLAIMED: 0 };
      for (const { id } of due) results[await attempt(id)]++;
      return { expired, due: due.length, ...results };
    },
  };
}

export type EmailOutbox = ReturnType<typeof createEmailOutbox>;
