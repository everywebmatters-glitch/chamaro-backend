import "dotenv/config";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const skipReason = await isolatedDatabaseSkipReason();
// One test signs in many times within a minute; the exchange route is rate limited (10 per minute) in normal use.
process.env.AUTH_RATE_LIMIT_MAX = "1000";
const configured = Boolean(
  process.env.DATABASE_URL &&
  process.env.JWT_SECRET &&
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  process.env.GOOGLE_REDIRECT_URI &&
  process.env.GOOGLE_FRONTEND_CALLBACK_URL,
);

type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// GET /api/v1/auth/google -> { state from Google URL, state cookie as sent back by the browser }
async function startFlow(app: App, challenge: string) {
  const response = await app.inject({ method: "GET", url: `/api/v1/auth/google?code_challenge=${challenge}` });
  assert.equal(response.statusCode, 302);
  const setCookie = String(response.headers["set-cookie"]);
  const state = new URL(response.headers.location as string).searchParams.get("state");
  assert.ok(state);
  return { response, state, setCookie, cookie: setCookie.split(";")[0] };
}

// Frontend callback redirect -> parsed fragment parameters
function fragment(location: unknown) {
  const url = new URL(String(location));
  assert.equal(`${url.origin}${url.pathname}`, new URL(process.env.GOOGLE_FRONTEND_CALLBACK_URL as string).href.replace(/#.*$/, ""));
  return new URLSearchParams(url.hash.slice(1));
}

test("Google OAuth browser flow: state, callback redirects, PKCE code exchange, and role/linking rules", { skip: skipReason ?? (!configured ? "database, JWT, and Google configuration (incl. GOOGLE_FRONTEND_CALLBACK_URL) are required" : undefined) }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const { googleProvider } = await import("../../src/providers/google.provider.js");
  const app = await buildApp();
  const suffix = randomBytes(6).toString("hex");
  const createdUserIds: string[] = [];
  const originalVerifyGoogleCallback = googleProvider.verifyGoogleCallback;
  let identity = { googleId: `google-${suffix}`, email: `google-customer-${suffix}@example.test`, name: "Google Customer" };
  googleProvider.verifyGoogleCallback = async () => identity;

  const callback = (query: string, cookie?: string) =>
    app.inject({ method: "GET", url: `/api/v1/auth/google/callback?${query}`, headers: cookie ? { cookie } : {} });
  const exchange = (code: string, codeVerifier: string) =>
    app.inject({ method: "POST", url: "/api/v1/auth/google/exchange", payload: { code, codeVerifier } });

  try {
    // --- Authorization start ---
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/google" })).statusCode, 400, "code_challenge is required");
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/google?code_challenge=short" })).statusCode, 400);

    const pkce = pkcePair();
    const flow = await startFlow(app, pkce.challenge);
    const googleUrl = new URL(flow.response.headers.location as string);
    assert.equal(googleUrl.origin, "https://accounts.google.com");
    assert.equal(googleUrl.searchParams.get("redirect_uri"), process.env.GOOGLE_REDIRECT_URI);
    assert.match(flow.setCookie, /^chamaro_google_oauth=[A-Za-z0-9_-]{43};/);
    assert.match(flow.setCookie, /HttpOnly/);
    assert.match(flow.setCookie, /SameSite=Lax/);
    assert.match(flow.setCookie, /Path=\/api\/v1\/auth\/google/);
    assert.equal(flow.state.includes(flow.cookie.split("=")[1]), false, "raw nonce must not appear in state");

    // --- State validation (login CSRF) ---
    const stateError = async (query: string, cookie?: string) => {
      const response = await callback(query, cookie);
      assert.equal(response.statusCode, 302);
      assert.match(String(response.headers["set-cookie"]), /chamaro_google_oauth=;.*Max-Age=0/, "state cookie is always cleared");
      return fragment(response.headers.location).get("error");
    };
    assert.equal(await stateError(`code=c&state=${flow.state}`), "OAUTH_STATE_INVALID", "missing cookie");
    const otherFlow = await startFlow(app, pkcePair().challenge);
    assert.equal(await stateError(`code=c&state=${flow.state}`, otherFlow.cookie), "OAUTH_STATE_INVALID", "cookie from another flow");
    assert.equal(await stateError(`code=c&state=invalid-state`, flow.cookie), "OAUTH_STATE_INVALID", "forged state");
    assert.equal(await stateError(`code=c&state=${flow.state.slice(0, -2)}xx`, flow.cookie), "OAUTH_STATE_INVALID", "tampered state");
    assert.equal(await stateError(`code=c`, flow.cookie), "OAUTH_STATE_INVALID", "missing state");

    // --- User cancelled at Google ---
    const cancelled = await startFlow(app, pkcePair().challenge);
    assert.equal(await stateError(`error=access_denied&state=${cancelled.state}`, cancelled.cookie), "GOOGLE_AUTH_DENIED");

    // --- Google/provider failure is reported generically ---
    googleProvider.verifyGoogleCallback = async () => { throw new Error("invalid_grant"); };
    const failed = await startFlow(app, pkcePair().challenge);
    assert.equal(await stateError(`code=c&state=${failed.state}`, failed.cookie), "GOOGLE_AUTH_FAILED");
    googleProvider.verifyGoogleCallback = async () => identity;

    // --- Success: new Google customer; Google's extra query parameters are accepted ---
    const success = await callback(`code=mock-code&state=${flow.state}&scope=openid%20email&authuser=0&prompt=consent`, flow.cookie);
    assert.equal(success.statusCode, 302);
    const params = fragment(success.headers.location);
    assert.equal(params.get("error"), null);
    const code = params.get("code");
    assert.ok(code);
    assert.equal(new URL(String(success.headers.location)).search, "", "code travels in the fragment, not the query");
    assert.ok((await app.prisma.user.findUniqueOrThrow({ where: { googleId: identity.googleId } })).emailVerifiedAt, "Google verified the address, so the new account starts verified");

    // Exchange code is not an access token
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${code}` } })).statusCode, 401);
    // State token is not an exchange code
    assert.equal((await exchange(flow.state, pkce.verifier)).json().error.code, "OAUTH_CODE_INVALID");
    // Wrong verifier (e.g. a code stolen from the URL) is rejected
    const wrongVerifier = await exchange(code, pkcePair().verifier);
    assert.equal(wrongVerifier.statusCode, 401);
    assert.equal(wrongVerifier.json().error.code, "OAUTH_CODE_INVALID");
    assert.equal((await exchange("not-a-code", pkce.verifier)).statusCode, 401);
    assert.equal((await exchange(code, "short")).statusCode, 400);

    const exchanged = await exchange(code, pkce.verifier);
    assert.equal(exchanged.statusCode, 200);
    const { token, user } = exchanged.json().data;
    assert.equal(user.role, "CUSTOMER");
    assert.equal(user.email, identity.email);
    createdUserIds.push(user.id);
    const tokenPayload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    assert.equal(tokenPayload.role, "CUSTOMER");
    for (const key of ["access_token", "id_token", "refresh_token", "purpose", "cc"]) assert.equal(key in tokenPayload, false);
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().data.id, user.id);

    // Returning Google customer signs in to the same account
    const again = pkcePair(); const againFlow = await startFlow(app, again.challenge);
    const againCode = fragment((await callback(`code=c&state=${againFlow.state}`, againFlow.cookie)).headers.location).get("code") as string;
    assert.equal((await exchange(againCode, again.verifier)).json().data.user.id, user.id);

    // --- A customer who registered with a password and now uses Google: Google verified the address, so it is linked ---
    const googleSignIn = async () => {
      const pair = pkcePair();
      const started = await startFlow(app, pair.challenge);
      const params = fragment((await callback(`code=c&state=${started.state}`, started.cookie)).headers.location);
      return { error: params.get("error"), exchanged: params.get("code") ? await exchange(params.get("code") as string, pair.verifier) : null };
    };
    const passwordUser = await app.prisma.user.create({ data: { name: "Password User", email: `google-password-${suffix}@example.test`, passwordHash: "existing-password", emailVerifiedAt: new Date(), role: "CUSTOMER" } });
    createdUserIds.push(passwordUser.id);
    identity = { googleId: `linked-${suffix}`, email: passwordUser.email, name: "Someone" };
    const linkedSignIn = await googleSignIn();
    assert.equal(linkedSignIn.error, null);
    assert.equal(linkedSignIn.exchanged?.statusCode, 200);
    assert.equal(linkedSignIn.exchanged?.json().data.user.id, passwordUser.id, "signed in to the existing account, not a new one");
    const linkedRow = await app.prisma.user.findUniqueOrThrow({ where: { id: passwordUser.id } });
    assert.equal(linkedRow.googleId, `linked-${suffix}`);
    assert.equal(linkedRow.passwordHash, "existing-password", "a verified account keeps its password: both ways of signing in work");
    assert.equal((await googleSignIn()).exchanged?.json().data.user.id, passwordUser.id, "and the next Google sign-in finds it directly");

    // --- Same, but the account's own address was never verified: someone may have registered it with a password they
    //     know, so the password is disabled and its sessions end with the link ---
    const hijackable = await app.prisma.user.create({ data: { name: "Unverified", email: `google-unverified-${suffix}@example.test`, passwordHash: "attacker-knows-this", role: "CUSTOMER" } });
    createdUserIds.push(hijackable.id);
    const oldSession = await app.prisma.authSession.create({ data: { userId: hijackable.id, familyId: `fam-${suffix}`, tokenHash: "f".repeat(64), expiresAt: new Date(Date.now() + 3_600_000) } });
    identity = { googleId: `unverified-${suffix}`, email: hijackable.email, name: "Real Owner" };
    const takeover = await googleSignIn();
    assert.equal(takeover.exchanged?.json().data.user.id, hijackable.id);
    const neutralised = await app.prisma.user.findUniqueOrThrow({ where: { id: hijackable.id } });
    assert.notEqual(neutralised.passwordHash, "attacker-knows-this", "the pre-registered password no longer works");
    assert.ok(neutralised.emailVerifiedAt, "Google proved the address");
    assert.ok((await app.prisma.authSession.findUniqueOrThrow({ where: { id: oldSession.id } })).revokedAt, "its sessions ended");

    // --- Never linked automatically: an administrator account, or one tied to a different Google identity ---
    const adminByEmail = await app.prisma.user.create({ data: { name: "Admin", email: `google-admin-email-${suffix}@example.test`, passwordHash: "existing-password", emailVerifiedAt: new Date(), role: "ADMIN" } });
    createdUserIds.push(adminByEmail.id);
    identity = { googleId: `attacker-admin-${suffix}`, email: adminByEmail.email, name: "Someone" };
    assert.equal((await googleSignIn()).error, "GOOGLE_ACCOUNT_NOT_LINKED");
    assert.equal((await app.prisma.user.findUniqueOrThrow({ where: { id: adminByEmail.id } })).googleId, null);
    const otherGoogle = await app.prisma.user.create({ data: { name: "Other", email: `google-other-${suffix}@example.test`, googleId: `first-google-${suffix}`, passwordHash: "existing-password", emailVerifiedAt: new Date(), role: "CUSTOMER" } });
    createdUserIds.push(otherGoogle.id);
    identity = { googleId: `second-google-${suffix}`, email: otherGoogle.email, name: "Someone" };
    assert.equal((await googleSignIn()).error, "GOOGLE_ACCOUNT_NOT_LINKED");
    assert.equal((await app.prisma.user.findUniqueOrThrow({ where: { id: otherGoogle.id } })).googleId, `first-google-${suffix}`);
    // An inactive account is not linked either
    const inactivePassword = await app.prisma.user.create({ data: { name: "Inactive Pw", email: `google-inactive-pw-${suffix}@example.test`, passwordHash: "existing-password", emailVerifiedAt: new Date(), role: "CUSTOMER", isActive: false } });
    createdUserIds.push(inactivePassword.id);
    identity = { googleId: `inactive-pw-${suffix}`, email: inactivePassword.email, name: "Someone" };
    assert.equal((await googleSignIn()).error, "ACCOUNT_INACTIVE");
    assert.equal((await app.prisma.user.findUniqueOrThrow({ where: { id: inactivePassword.id } })).googleId, null);

    // --- Inactive linked account ---
    const inactiveUser = await app.prisma.user.create({ data: { name: "Inactive", email: `google-inactive-${suffix}@example.test`, googleId: `inactive-${suffix}`, passwordHash: "existing-password", role: "CUSTOMER", isActive: false } });
    createdUserIds.push(inactiveUser.id);
    identity = { googleId: `inactive-${suffix}`, email: inactiveUser.email, name: inactiveUser.name };
    const inactive = await startFlow(app, pkcePair().challenge);
    assert.equal(await stateError(`code=c&state=${inactive.state}`, inactive.cookie), "ACCOUNT_INACTIVE");

    // Account deactivated between callback and exchange
    const laterInactive = await app.prisma.user.create({ data: { name: "Later Inactive", email: `google-later-${suffix}@example.test`, googleId: `later-${suffix}`, passwordHash: "existing-password", role: "CUSTOMER" } });
    createdUserIds.push(laterInactive.id);
    identity = { googleId: `later-${suffix}`, email: laterInactive.email, name: laterInactive.name };
    const later = pkcePair(); const laterFlow = await startFlow(app, later.challenge);
    const laterCode = fragment((await callback(`code=c&state=${laterFlow.state}`, laterFlow.cookie)).headers.location).get("code") as string;
    await app.prisma.user.update({ where: { id: laterInactive.id }, data: { isActive: false } });
    const laterExchange = await exchange(laterCode, later.verifier);
    assert.equal(laterExchange.statusCode, 403);
    assert.equal(laterExchange.json().error.code, "ACCOUNT_INACTIVE");

    // --- Existing behaviour preserved: a Google-linked ADMIN receives an ADMIN token ---
    const admin = await app.prisma.user.create({ data: { name: "Google Admin", email: `google-admin-${suffix}@example.test`, googleId: `admin-${suffix}`, passwordHash: "existing-password", role: "ADMIN" } });
    createdUserIds.push(admin.id);
    identity = { googleId: `admin-${suffix}`, email: admin.email, name: admin.name };
    const adminPkce = pkcePair(); const adminFlow = await startFlow(app, adminPkce.challenge);
    const adminCode = fragment((await callback(`code=c&state=${adminFlow.state}`, adminFlow.cookie)).headers.location).get("code") as string;
    const adminExchange = await exchange(adminCode, adminPkce.verifier);
    assert.equal(adminExchange.statusCode, 200);
    assert.equal(adminExchange.json().data.user.role, "ADMIN");
    const adminToken = adminExchange.json().data.token;
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${adminToken}` } })).statusCode, 403);
  } finally {
    googleProvider.verifyGoogleCallback = originalVerifyGoogleCallback;
    for (const id of createdUserIds) await app.prisma.user.delete({ where: { id } }).catch(() => undefined);
    await app.close();
  }
});
