// The Google authorization URL and the code exchange must both use GOOGLE_REDIRECT_URI from the runtime environment.
import test from "node:test";
import assert from "node:assert/strict";
import { OAuth2Client } from "google-auth-library";

const CUSTOM = "https://api.chamaro.com/api/v1/auth/google/callback";
process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_REDIRECT_URI = CUSTOM;
const { googleAuthorizationUrl, verifyGoogleCallback } = await import("../../src/providers/google.provider.js");

test("authorization URL uses the configured custom-domain callback, not run.app", () => {
  const url = new URL(googleAuthorizationUrl("state-value"));
  assert.equal(url.searchParams.get("redirect_uri"), CUSTOM);
  assert.ok(!url.href.includes("run.app"));
  assert.equal(url.searchParams.get("state"), "state-value");
});

test("code exchange sends the same redirect URI as the authorization request", async () => {
  const original = OAuth2Client.prototype.getToken;
  let exchanged: string | undefined;
  (OAuth2Client.prototype as any).getToken = async function (this: any) { exchanged = this.redirectUri; return { tokens: {} }; };
  try {
    await assert.rejects(() => verifyGoogleCallback("code"), (e: any) => e.code === "GOOGLE_ID_TOKEN_MISSING");
  } finally { OAuth2Client.prototype.getToken = original; }
  assert.equal(exchanged, new URL(googleAuthorizationUrl("s")).searchParams.get("redirect_uri"));
  assert.equal(exchanged, CUSTOM);
});
