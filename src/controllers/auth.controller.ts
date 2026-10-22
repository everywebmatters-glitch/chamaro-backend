import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import type { AuthService } from "../services/auth.service.js";
import type { SessionService } from "../services/session.service.js";
import { clearedSessionCookie, originAllowed, readSessionCookie, sessionCookie } from "../utils/session-cookie.js";
import type { AdminLoginInput, AuthenticatedUser, LoginInput, RegisterInput, Role, SafeUser } from "../types/auth.types.js";
import {
  clearedStateCookie,
  createExchangeCode,
  createOAuthState,
  readStateCookie,
  stateCookie,
  verifyExchangeCode,
  verifyOAuthState,
} from "../utils/google-oauth.tokens.js";

// Access tokens are short. An administrator's lasts 2 hours (a stolen admin token is useful for far less time; deactivating
// the account ends it at once, requireAdmin reads isActive from the database). A customer's lasts 30 minutes and is
// renewed silently from the persistent session cookie (POST /auth/refresh), so the shopper stays signed in without a
// long-lived token ever sitting in the page.
export const CUSTOMER_TOKEN_TTL = "30m";

async function signAccessToken(reply: FastifyReply, user: { id: string; role: Role }) {
  return reply.jwtSign({ role: user.role }, { sign: { sub: user.id, expiresIn: user.role === "ADMIN" ? "2h" : CUSTOMER_TOKEN_TTL } });
}

async function issueToken(sessions: SessionService, request: FastifyRequest, reply: FastifyReply, user: { id: string; name: string; email: string; role: Role }) {
  const token = await signAccessToken(reply, user);
  // Customers also get a persistent session (an HttpOnly cookie); administrators never do.
  if (user.role === "CUSTOMER") {
    const session = await sessions.start(user.id, request.headers["user-agent"] ?? null);
    reply.header("set-cookie", sessionCookie(session.token, session.expiresAt));
  }
  const authenticatedUser: AuthenticatedUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  return { token, user: authenticatedUser };
}

const sessionInvalid = () => Object.assign(new Error("Your session has ended; please sign in again"), { statusCode: 401, code: "SESSION_INVALID" });
const originRefused = () => Object.assign(new Error("Request not allowed from this origin"), { statusCode: 403, code: "ORIGIN_NOT_ALLOWED" });

// Error codes the frontend callback page may receive; anything else is reported as GOOGLE_AUTH_FAILED.
const GOOGLE_CALLBACK_ERRORS = new Set([
  "OAUTH_STATE_INVALID",
  "GOOGLE_AUTH_DENIED",
  "GOOGLE_ID_TOKEN_MISSING",
  "GOOGLE_EMAIL_UNVERIFIED",
  "GOOGLE_ACCOUNT_NOT_LINKED",
  "GOOGLE_ACCOUNT_CONFLICT",
  "GOOGLE_ACCOUNT_ADMIN",
  "GOOGLE_EMAIL_NEEDS_VERIFICATION",
  "ACCOUNT_INACTIVE",
]);

// Parameters go in the URL fragment so the one-time code is never sent to a server or leaked via Referer.
function frontendCallbackUrl(params: Record<string, string>): string {
  const url = new URL(env.GOOGLE_FRONTEND_CALLBACK_URL);
  url.hash = new URLSearchParams(params).toString();
  return url.toString();
}

export function createAuthController(service: AuthService, sessions: SessionService) {
  return {
    async register(request: FastifyRequest, reply: FastifyReply) {
      const user: SafeUser = await service.register(request.body as RegisterInput);
      reply.code(201);
      return { success: true, data: user };
    },

    async login(request: FastifyRequest, reply: FastifyReply) {
      const user = await service.login(request.body as LoginInput);
      return { success: true, data: await issueToken(sessions, request, reply, user) };
    },

    async adminLogin(request: FastifyRequest, reply: FastifyReply) {
      const user = await service.adminLogin(request.body as AdminLoginInput);
      return { success: true, data: await issueToken(sessions, request, reply, user) };
    },

    googleAuthorize(request: FastifyRequest, reply: FastifyReply) {
      const { code_challenge: codeChallenge } = request.query as { code_challenge: string };
      const { state, nonce } = createOAuthState(request.server, codeChallenge);
      reply.header("set-cookie", stateCookie(nonce));
      return reply.redirect(service.googleAuthorizationUrl(state));
    },

    // Browser-facing: never returns JSON or a token. Success and failure both redirect to the
    // frontend callback page; the access token is only released by googleExchange().
    async googleCallback(request: FastifyRequest, reply: FastifyReply) {
      const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
      reply.header("set-cookie", clearedStateCookie());
      try {
        const codeChallenge = verifyOAuthState(request.server, state, readStateCookie(request.headers.cookie));
        if (error || !code) throw Object.assign(new Error(`Google sign-in was not completed: ${error ?? "no code"}`), { statusCode: 401, code: "GOOGLE_AUTH_DENIED" });
        const user = await service.completeGoogleLogin(code);
        return reply.redirect(frontendCallbackUrl({ code: createExchangeCode(request.server, user.id, codeChallenge) }));
      } catch (failure) {
        const failureCode = (failure as { code?: unknown }).code;
        // Log only what identifies the failure: errors from google-auth-library carry the token
        // request (client secret, authorization code) in their `config`, which must not reach logs.
        const { name, message } = failure instanceof Error ? failure : { name: "Error", message: String(failure) };
        request.log.warn({ err: { name, message, code: failureCode } }, "Google sign-in failed");
        const safeCode = typeof failureCode === "string" && GOOGLE_CALLBACK_ERRORS.has(failureCode) ? failureCode : "GOOGLE_AUTH_FAILED";
        return reply.redirect(frontendCallbackUrl({ error: safeCode }));
      }
    },

    async googleExchange(request: FastifyRequest, reply: FastifyReply) {
      const { code, codeVerifier } = request.body as { code: string; codeVerifier: string };
      const redeemed = verifyExchangeCode(request.server, code, codeVerifier);
      // One redemption per code: a replay (a code copied from a URL, history or log) is refused even inside its 60 seconds.
      if (!(await sessions.useExchangeCodeOnce(redeemed.userId, redeemed.jti, redeemed.expiresAt))) {
        throw Object.assign(new Error("Invalid or expired sign-in code"), { statusCode: 401, code: "OAUTH_CODE_INVALID" });
      }
      const user = await service.getActiveUserForGoogleExchange(redeemed.userId);
      return { success: true, data: await issueToken(sessions, request, reply, user) };
    },

    async customerMe(request: FastifyRequest) {
      await request.requireCustomer();
      const user = await service.getSafeUser((request.user as { sub: string }).sub);
      return { success: true, data: user };
    },

    async me(request: FastifyRequest) {
      await request.requireAdmin();
      const user = await service.getSafeUser((request.user as { sub: string }).sub);
      return { success: true, data: user };
    },

    async sendLoginOtp(request: FastifyRequest) {
      await service.sendLoginOtp((request.body as { email: string }).email);
      return { success: true, data: { message: "If an account exists for this email, a verification code has been sent." } };
    },

    async verifyLoginOtp(request: FastifyRequest, reply: FastifyReply) {
      const { email, otp } = request.body as { email: string; otp: string };
      const user = await service.verifyLoginOtp(email, otp);
      return { success: true, data: await issueToken(sessions, request, reply, user) };
    },

    // Silent sign-in for a returning shopper: the persistent-session cookie is exchanged for a fresh access token (and a
    // rotated cookie). Only our own sites may call it; an invalid, expired or replayed session clears the cookie.
    async refresh(request: FastifyRequest, reply: FastifyReply) {
      if (!originAllowed(request.headers.origin)) throw originRefused();
      const rotated = await sessions.rotate(readSessionCookie(request.headers.cookie), request.headers["user-agent"] ?? null);
      const user = rotated ? await request.server.prisma.user.findUnique({ where: { id: rotated.userId }, select: { id: true, name: true, email: true, role: true, isActive: true } }) : null;
      if (!rotated || !user || !user.isActive || user.role !== "CUSTOMER") {
        if (rotated) await sessions.revokeFamilyOf(rotated.session.token);
        reply.header("set-cookie", clearedSessionCookie());
        throw sessionInvalid();
      }
      reply.header("set-cookie", sessionCookie(rotated.session.token, rotated.session.expiresAt));
      reply.header("cache-control", "no-store");
      const authenticatedUser: AuthenticatedUser = { id: user.id, name: user.name, email: user.email, role: user.role };
      return { success: true, data: { token: await signAccessToken(reply, user), user: authenticatedUser } };
    },

    // Signs the shopper out everywhere this session runs: the cookie's family is revoked and the cookie cleared.
    async logout(request: FastifyRequest, reply: FastifyReply) {
      if (!originAllowed(request.headers.origin)) throw originRefused();
      await sessions.revokeFamilyOf(readSessionCookie(request.headers.cookie));
      reply.header("set-cookie", clearedSessionCookie());
      return { success: true, data: { loggedOut: true } };
    },

    async forgotPasswordSendOtp(request: FastifyRequest) {
      await service.forgotPasswordSendOtp((request.body as { email: string }).email);
      return { success: true, data: { message: "If an account exists for this email, a verification code has been sent." } };
    },

    async forgotPasswordVerifyOtp(request: FastifyRequest) {
      const { email, otp } = request.body as { email: string; otp: string };
      await service.forgotPasswordVerifyOtp(email, otp);
      return { success: true, data: { verified: true } };
    },

    async forgotPasswordReset(request: FastifyRequest) {
      const { email, otp, newPassword } = request.body as { email: string; otp: string; newPassword: string };
      await service.resetPasswordWithOtp(email, otp, newPassword);
      return { success: true, data: { message: "Password has been reset successfully." } };
    },

    async forgotPasswordRequestLink(request: FastifyRequest) {
      await service.requestPasswordResetLink((request.body as { email: string }).email);
      return { success: true, data: { message: "If an account exists for this email, a password reset link has been sent." } };
    },

    async resetPasswordWithToken(request: FastifyRequest) {
      const { token, newPassword } = request.body as { token: string; newPassword: string };
      await service.resetPasswordWithToken(token, newPassword);
      return { success: true, data: { message: "Password has been reset successfully." } };
    },
  };
}
