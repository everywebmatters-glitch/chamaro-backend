// M2: an unknown email must cost the same scrypt work as a wrong password for a real account.
// Uses the real auth service with a stub Prisma client (no database).
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthService } from "../../src/services/auth.service.js";
import { GOOGLE_OAUTH_NO_PASSWORD, hashPassword } from "../../src/utils/password.js";

const users = new Map<string, any>();
const prisma: any = {
  user: { findUnique: async ({ where }: { where: { email?: string } }) => (where.email ? users.get(where.email) ?? null : null) },
  adminUser: { upsert: async () => ({}) },
};
const service = createAuthService(prisma);

async function failureTime(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await assert.rejects(fn, (error: any) => error.code === "INVALID_CREDENTIALS");
  return performance.now() - start;
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test("unknown email, wrong password and Google-only accounts all take scrypt time", async () => {
  users.set("admin@example.test", { id: "a", email: "admin@example.test", role: "ADMIN", isActive: true, passwordHash: await hashPassword("correct-password-123") });
  users.set("google@example.test", { id: "g", email: "google@example.test", role: "CUSTOMER", isActive: true, passwordHash: GOOGLE_OAUTH_NO_PASSWORD });

  const unknown: number[] = [], wrong: number[] = [], google: number[] = [];
  for (let i = 0; i < 5; i++) {
    unknown.push(await failureTime(() => service.adminLogin({ email: `nobody-${i}@example.test`, password: "wrong-password-123" })));
    wrong.push(await failureTime(() => service.adminLogin({ email: "admin@example.test", password: "wrong-password-123" })));
    google.push(await failureTime(() => service.login({ email: "google@example.test", password: "wrong-password-123" })));
  }
  const [u, w, g] = [median(unknown), median(wrong), median(google)];
  // Before the fix, unknown emails skipped scrypt entirely (~0 ms here, no database).
  assert.ok(u > w * 0.5 && u < w * 2, `unknown ${u.toFixed(1)} ms vs wrong password ${w.toFixed(1)} ms`);
  assert.ok(g > w * 0.5 && g < w * 2, `google-only ${g.toFixed(1)} ms vs wrong password ${w.toFixed(1)} ms`);
});

test("the correct password still logs in; wrong role/inactive still fail generically", async () => {
  const user = await service.adminLogin({ email: "admin@example.test", password: "correct-password-123" });
  assert.equal(user.id, "a");
  await assert.rejects(() => service.login({ email: "admin@example.test", password: "correct-password-123" }), (e: any) => e.code === "INVALID_CREDENTIALS");
  users.set("off@example.test", { ...users.get("admin@example.test"), id: "o", email: "off@example.test", isActive: false });
  await assert.rejects(() => service.adminLogin({ email: "off@example.test", password: "correct-password-123" }), (e: any) => e.code === "INVALID_CREDENTIALS");
});
