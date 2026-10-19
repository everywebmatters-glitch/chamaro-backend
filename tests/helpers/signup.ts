// Sign-up through the real two-step flow (send-otp, then register with the emailed code), for integration tests
// that need a freshly registered customer. Emails go to a fake Resend client; nothing is sent.
import assert from "node:assert/strict";
import type { buildApp } from "../../src/app.js";
import { setEmailClientForTests } from "../../src/services/email.service.js";

type App = Awaited<ReturnType<typeof buildApp>>;
export type SentEmail = { to: string; subject: string; html: string };

// Collects every email "sent" until the returned stop() restores the real client.
export function captureEmails(): { sent: SentEmail[]; stop: () => void } {
  const sent: SentEmail[] = [];
  setEmailClientForTests({ emails: { send: async (message) => { sent.push(message); return { error: null }; } } });
  return { sent, stop: () => setEmailClientForTests(undefined) };
}

// The 6-digit code in a sign-up verification email, or null when the email holds none.
export function codeFrom(email: SentEmail | undefined): string | null {
  return email?.html.match(/>(\d{6})<\/div>/)?.[1] ?? null;
}

export async function requestSignupCode(app: App, sent: SentEmail[], email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/register/send-otp", payload: { email } });
  assert.equal(res.statusCode, 200, res.body);
  const code = codeFrom(sent.filter((message) => message.to === email.toLowerCase()).at(-1));
  assert.ok(code, "a sign-up code was emailed");
  return code;
}

export async function registerWithCode(app: App, input: { name: string; email: string; password: string }) {
  const { sent, stop } = captureEmails();
  try {
    const otp = await requestSignupCode(app, sent, input.email);
    return await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { ...input, otp } });
  } finally {
    stop();
  }
}
