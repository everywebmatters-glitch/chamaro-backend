// The email outbox: one row per event, transactional recording, one sender at a time, bounded retries, safe error
// tracking, and no second delivery when a send succeeded but was not recorded. The fake provider below behaves
// like Resend's idempotency keys: a repeated key gets the first answer back and delivers nothing new.
// Runs only against the isolated local test database; nothing reaches the network.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;

const { setEmailClientForTests } = await import("../../src/services/email.service.js");
const { createEmailOutbox, enqueueNotification, OUTBOX_SETTINGS } = await import("../../src/services/email-outbox.service.js");

// A provider that delivers once per idempotency key, like Resend. `fail` makes the next sends return an error.
class FakeProvider {
  delivered: { to: string; subject: string; text: string; key?: string }[] = [];
  requests = 0;
  private byKey = new Map<string, string>();
  fail: { name: string; statusCode: number; message: string } | null = null;
  constructor() {
    setEmailClientForTests({
      emails: {
        send: async (message, options) => {
          this.requests++;
          if (this.fail) return { error: this.fail };
          const key = options?.idempotencyKey;
          const known = key ? this.byKey.get(key) : undefined;
          if (known) return { data: { id: known }, error: null };
          const id = `re_${this.delivered.length + 1}`;
          if (key) this.byKey.set(key, id);
          this.delivered.push({ to: message.to, subject: message.subject, text: message.text, key });
          return { data: { id }, error: null };
        },
      },
    });
  }
}

async function withOutbox(run: (ctx: { app: App; provider: FakeProvider; key: (name: string) => string; queue: (name: string, options?: { verified?: boolean }) => Promise<{ id: string; status: string }> }) => Promise<void>) {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const provider = new FakeProvider();
  const unique = randomBytes(5).toString("hex");
  const key = (name: string) => `test:${unique}:${name}`;
  const queue = (name: string, options: { verified?: boolean } = {}) =>
    enqueueNotification(app.prisma, { eventKey: key(name), kind: "OUTBOX_SELF_TEST", recipient: { userId: null, email: `${name}@example.test`, verified: options.verified ?? true }, message: { subject: `Subject ${name}`, html: `<p>${name}</p>`, text: `Text ${name}` } });
  try {
    await run({ app, provider, key, queue });
  } finally {
    await app.prisma.emailNotification.deleteMany({ where: { eventKey: { startsWith: `test:${unique}:` } } });
    await app.close();
    setEmailClientForTests(undefined);
  }
}

const row = (app: App, id: string) => app.prisma.emailNotification.findUniqueOrThrow({ where: { id } });
const makeDue = (app: App, id: string) => app.prisma.emailNotification.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });

test("a successful send is recorded once, with the event key as the idempotency key and a text part", { skip: skipReason }, () =>
  withOutbox(async ({ app, provider, key, queue }) => {
    const outbox = createEmailOutbox(app.prisma);
    const queued = await queue("ok");
    assert.equal(queued.status, "PENDING");
    assert.equal(await outbox.attempt(queued.id), "SENT");
    assert.deepEqual(provider.delivered, [{ to: "ok@example.test", subject: "Subject ok", text: "Text ok", key: key("ok") }]);
    const sent = await row(app, queued.id);
    assert.deepEqual([sent.status, sent.attempts, sent.providerMessageId, sent.lockedUntil, sent.lastErrorName], ["SENT", 1, "re_1", null, null]);
    assert.ok(sent.sentAt);
    assert.equal(await outbox.attempt(queued.id), "NOT_CLAIMED", "a sent row is never attempted again");
    assert.equal(provider.requests, 1);
  }));

test("recording the same event twice keeps one row and sends once", { skip: skipReason }, () =>
  withOutbox(async ({ app, provider, key, queue }) => {
    const outbox = createEmailOutbox(app.prisma);
    const first = await queue("dup");
    const second = await queue("dup");
    assert.equal(second.id, first.id);
    await outbox.dispatch(first);
    await outbox.dispatch(second);
    await outbox.drain();
    assert.equal(await app.prisma.emailNotification.count({ where: { eventKey: key("dup") } }), 1);
    assert.equal(provider.delivered.length, 1);
  }));

test("a notification recorded in a transaction that rolls back does not exist", { skip: skipReason }, () =>
  withOutbox(async ({ app, provider, key }) => {
    await assert.rejects(app.prisma.$transaction(async (tx) => {
      await enqueueNotification(tx, { eventKey: key("rolled-back"), kind: "OUTBOX_SELF_TEST", recipient: { userId: null, email: "x@example.test", verified: true }, message: { subject: "s", html: "h", text: "t" } });
      throw new Error("the change failed");
    }), /the change failed/);
    assert.equal(await app.prisma.emailNotification.count({ where: { eventKey: key("rolled-back") } }), 0);
    await createEmailOutbox(app.prisma).drain();
    assert.equal(provider.requests, 0);
  }));

test("concurrent senders: exactly one claims the row and the provider is asked once", { skip: skipReason }, () =>
  withOutbox(async ({ app, provider, queue }) => {
    const outbox = createEmailOutbox(app.prisma);
    const queued = await queue("race");
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => outbox.attempt(queued.id)));
    assert.deepEqual(results.sort(), ["NOT_CLAIMED", "NOT_CLAIMED", "NOT_CLAIMED", "NOT_CLAIMED", "SENT"]);
    assert.equal(provider.requests, 1);
    assert.equal((await row(app, queued.id)).attempts, 1);
  }));

test("a temporary provider failure is retried after a growing delay, then gives up after the last attempt", { skip: skipReason }, () =>
  withOutbox(async ({ app, provider, queue }) => {
    const outbox = createEmailOutbox(app.prisma);
    const queued = await queue("flaky");
    provider.fail = { name: "rate_limit_exceeded", statusCode: 429, message: "slow down; to=flaky@example.test token=secret" };

    for (let attempt = 1; attempt < OUTBOX_SETTINGS.MAX_ATTEMPTS; attempt++) {
      const before = Date.now();
      assert.equal(await outbox.attempt(queued.id), "RETRY", `attempt ${attempt}`);
      const after = await row(app, queued.id);
      assert.deepEqual([after.status, after.attempts, after.lastErrorName, after.lastErrorStatus, after.lockedUntil], ["PENDING", attempt, "rate_limit_exceeded", 429, null]);
      const waitMinutes = (after.nextAttemptAt.getTime() - before) / 60_000;
      const expected = OUTBOX_SETTINGS.RETRY_DELAYS_MINUTES[attempt - 1];
      assert.ok(waitMinutes > expected - 0.1 && waitMinutes < expected + 0.1, `attempt ${attempt}: waits ${expected} min (got ${waitMinutes.toFixed(2)})`);
      assert.equal(await outbox.attempt(queued.id), "NOT_CLAIMED", "not attempted again before it is due");
      await makeDue(app, queued.id);
    }
    assert.equal(await outbox.attempt(queued.id), "FAILED", "the last attempt gives up");
    const failed = await row(app, queued.id);
    assert.deepEqual([failed.status, failed.attempts], ["FAILED", OUTBOX_SETTINGS.MAX_ATTEMPTS]);
    assert.equal(provider.requests, OUTBOX_SETTINGS.MAX_ATTEMPTS);
    await makeDue(app, queued.id);
    await outbox.drain();
    assert.equal(provider.requests, OUTBOX_SETTINGS.MAX_ATTEMPTS, "a failed row is never retried");
    // Only the provider's error name and status are kept, never its message.
    assert.doesNotMatch(JSON.stringify(failed), /secret|slow down|flaky@example\.test.*token/);
  }));

test("an error retrying cannot fix fails at once", { skip: skipReason }, () =>
  withOutbox(async ({ app, provider, queue }) => {
    const queued = await queue("invalid");
    provider.fail = { name: "validation_error", statusCode: 422, message: "bad to" };
    assert.equal(await createEmailOutbox(app.prisma).attempt(queued.id), "FAILED");
    const failed = await row(app, queued.id);
    assert.deepEqual([failed.status, failed.attempts, failed.lastErrorName, failed.lastErrorStatus], ["FAILED", 1, "validation_error", 422]);
  }));

test("a send the provider accepted but that was never recorded is retried with the same key and not delivered twice", { skip: skipReason }, () =>
  withOutbox(async ({ app, provider, key, queue }) => {
    const outbox = createEmailOutbox(app.prisma);
    const queued = await queue("unrecorded");
    // The provider accepts the first attempt...
    assert.equal(await outbox.attempt(queued.id), "SENT");
    // ...but suppose the process died before recording it: the row is still SENDING, under a lease.
    await app.prisma.emailNotification.update({ where: { id: queued.id }, data: { status: "SENDING", sentAt: null, providerMessageId: null, lockedUntil: new Date(Date.now() + 60_000) } });
    assert.equal(await outbox.attempt(queued.id), "NOT_CLAIMED", "nobody takes it over while the lease holds");
    await app.prisma.emailNotification.update({ where: { id: queued.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await outbox.drain();
    assert.equal(provider.requests, 2, "retried once the lease ran out");
    assert.equal(provider.delivered.length, 1, "the provider recognised the key: still one email");
    assert.equal(provider.delivered[0].key, key("unrecorded"));
    const done = await row(app, queued.id);
    assert.deepEqual([done.status, done.attempts, done.providerMessageId], ["SENT", 2, "re_1"]);
  }));

test("an attempt whose outcome is unknown with no attempts left, or anything too old for its key, is given up, never resent", { skip: skipReason }, () =>
  withOutbox(async ({ app, provider, queue }) => {
    const outbox = createEmailOutbox(app.prisma);
    const unknown = await queue("unknown");
    await app.prisma.emailNotification.update({ where: { id: unknown.id }, data: { status: "SENDING", attempts: OUTBOX_SETTINGS.MAX_ATTEMPTS, lockedUntil: new Date(Date.now() - 1000) } });
    const old = await queue("old");
    await app.prisma.emailNotification.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - OUTBOX_SETTINGS.RETRY_WINDOW_MS - 60_000) } });
    const young = await queue("young");

    const result = await outbox.drain();
    assert.equal(result.expired, 2);
    assert.deepEqual([(await row(app, unknown.id)).status, (await row(app, unknown.id)).lastErrorName], ["FAILED", "outcome_unknown"]);
    assert.deepEqual([(await row(app, old.id)).status, (await row(app, old.id)).lastErrorName], ["FAILED", "retry_window_expired"]);
    assert.equal((await row(app, young.id)).status, "SENT");
    assert.deepEqual(provider.delivered.map((message) => message.to), ["young@example.test"]);
  }));

test("an unverified recipient is recorded as skipped and never sent", { skip: skipReason }, () =>
  withOutbox(async ({ app, provider, queue }) => {
    const outbox = createEmailOutbox(app.prisma);
    const queued = await queue("unverified", { verified: false });
    assert.equal(queued.status, "SKIPPED");
    await outbox.dispatch(queued);
    assert.equal(await outbox.attempt(queued.id), "NOT_CLAIMED");
    await outbox.drain();
    const skipped = await row(app, queued.id);
    assert.deepEqual([skipped.status, skipped.skipReason, skipped.attempts], ["SKIPPED", "UNVERIFIED_RECIPIENT", 0]);
    assert.equal(provider.requests, 0);
  }));

test("dispatch never throws, even when the attempt cannot be recorded", { skip: skipReason }, () =>
  withOutbox(async ({ app, provider }) => {
    const errors: object[] = [];
    const outbox = createEmailOutbox(app.prisma, { log: { info: () => {}, warn: () => {}, error: (obj) => errors.push(obj) } });
    await outbox.dispatch({ id: "no-such-notification", status: "PENDING" });
    await outbox.dispatch(null);
    assert.equal(provider.requests, 0);
    assert.deepEqual(errors, []);
  }));
