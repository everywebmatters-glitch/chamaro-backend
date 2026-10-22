// What the Google provider accepts. Google's library is stubbed (no network): the test controls the ID-token claims and
// checks that the provider asks for this app's client id as the audience and refuses anything but a verified address.
import test from "node:test";
import assert from "node:assert/strict";
import { OAuth2Client } from "google-auth-library";

Object.assign(process.env, {
  GOOGLE_CLIENT_ID: "unit-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "unit-google-secret-not-real",
  GOOGLE_REDIRECT_URI: "http://localhost:8080/api/v1/auth/google/callback",
  JWT_SECRET: "unit-test-secret-at-least-32-characters-long",
});
const { verifyGoogleCallback } = await import("../../src/providers/google.provider.js");

type Claims = Record<string, unknown> | undefined;
const proto = OAuth2Client.prototype as unknown as { getToken: unknown; verifyIdToken: unknown };
const original = { getToken: proto.getToken, verifyIdToken: proto.verifyIdToken };
const audiences: unknown[] = [];

function stubGoogle(options: { idToken?: string | null; claims: Claims; rejectVerify?: boolean }) {
  audiences.length = 0;
  proto.getToken = async () => ({ tokens: options.idToken === null ? {} : { id_token: options.idToken ?? "signed.id.token" } });
  proto.verifyIdToken = async (request: { audience?: unknown }) => {
    audiences.push(request.audience);
    if (options.rejectVerify) throw new Error("Wrong recipient, payload audience != requiredAudience");
    return { getPayload: () => options.claims };
  };
}

test.after(() => {
  proto.getToken = original.getToken;
  proto.verifyIdToken = original.verifyIdToken;
});

test("a verified Google identity is accepted; the id token is checked against this app's client id; the email is lower-cased", async () => {
  stubGoogle({ claims: { sub: "1234567890", email: "Shopper@Example.TEST", email_verified: true, name: "  Asha Rao " } });
  assert.deepEqual(await verifyGoogleCallback("code"), { googleId: "1234567890", email: "shopper@example.test", name: "Asha Rao" });
  assert.deepEqual(audiences, ["unit-client.apps.googleusercontent.com"]);
});

test("an unverified Google email is refused", async () => {
  for (const email_verified of [false, undefined, "true", 1]) {
    stubGoogle({ claims: { sub: "1", email: "a@example.test", email_verified } });
    await assert.rejects(verifyGoogleCallback("code"), { code: "GOOGLE_EMAIL_UNVERIFIED" }, String(email_verified));
  }
});

test("an identity without a subject or an email is refused", async () => {
  stubGoogle({ claims: { email: "a@example.test", email_verified: true } });
  await assert.rejects(verifyGoogleCallback("code"), { code: "GOOGLE_EMAIL_UNVERIFIED" });
  stubGoogle({ claims: { sub: "1", email_verified: true } });
  await assert.rejects(verifyGoogleCallback("code"), { code: "GOOGLE_EMAIL_UNVERIFIED" });
  stubGoogle({ claims: undefined });
  await assert.rejects(verifyGoogleCallback("code"), { code: "GOOGLE_EMAIL_UNVERIFIED" });
});

test("no id token from Google, or a token the library rejects (wrong audience, bad signature, expired), is refused", async () => {
  stubGoogle({ idToken: null, claims: {} });
  await assert.rejects(verifyGoogleCallback("code"), { code: "GOOGLE_ID_TOKEN_MISSING" });
  stubGoogle({ claims: { sub: "1", email: "a@example.test", email_verified: true }, rejectVerify: true });
  await assert.rejects(verifyGoogleCallback("code"), /audience/);
});
