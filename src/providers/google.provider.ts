import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";
import type { GoogleIdentity } from "../types/auth.types.js";

// OAuth state is created and verified statelessly by google-oauth.tokens.ts (no in-memory map),
// so this provider only talks to Google.
function client() { return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI); }

export function googleAuthorizationUrl(state: string): string {
  return client().generateAuthUrl({ access_type: "online", scope: ["openid", "email", "profile"], state, prompt: "select_account" });
}
export async function verifyGoogleCallback(code: string): Promise<GoogleIdentity> {
  const oauth = client(); const { tokens } = await oauth.getToken(code);
  if (!tokens.id_token) throw Object.assign(new Error("Google did not return an ID token"), { statusCode: 401, code: "GOOGLE_ID_TOKEN_MISSING" });
  const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
  const claims = ticket.getPayload();
  if (!claims?.sub || !claims.email || claims.email_verified !== true) throw Object.assign(new Error("Google account must provide a verified email"), { statusCode: 401, code: "GOOGLE_EMAIL_UNVERIFIED" });
  return { googleId: claims.sub, email: claims.email.toLowerCase(), name: claims.name?.trim() || claims.email };
}

export const googleProvider = { googleAuthorizationUrl, verifyGoogleCallback };
