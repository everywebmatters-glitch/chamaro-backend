import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import type { AuthService } from "../services/auth.service.js";
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

async function issueToken(reply: FastifyReply, user: { id: string; name: string; email: string; role: Role }) {
  const token = await reply.jwtSign({ role: user.role }, { sign: { sub: user.id } });
  const authenticatedUser: AuthenticatedUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  return { token, user: authenticatedUser };
}

// Error codes the frontend callback page may receive; anything else is reported as GOOGLE_AUTH_FAILED.
const GOOGLE_CALLBACK_ERRORS = new Set([
  "OAUTH_STATE_INVALID",
  "GOOGLE_AUTH_DENIED",
  "GOOGLE_ID_TOKEN_MISSING",
  "GOOGLE_EMAIL_UNVERIFIED",
  "GOOGLE_ACCOUNT_NOT_LINKED",
  "ACCOUNT_INACTIVE",
]);

// Parameters go in the URL fragment so the one-time code is never sent to a server or leaked via Referer.
function frontendCallbackUrl(params: Record<string, string>): string {
  const url = new URL(env.GOOGLE_FRONTEND_CALLBACK_URL);
  url.hash = new URLSearchParams(params).toString();
  return url.toString();
}

export function createAuthController(service: AuthService) {
  return {
    async register(request: FastifyRequest, reply: FastifyReply) {
      const user: SafeUser = await service.register(request.body as RegisterInput);
      reply.code(201);
      return { success: true, data: user };
    },

    async login(request: FastifyRequest, reply: FastifyReply) {
      const user = await service.login(request.body as LoginInput);
      return { success: true, data: await issueToken(reply, user) };
    },

    async adminLogin(request: FastifyRequest, reply: FastifyReply) {
      const user = await service.adminLogin(request.body as AdminLoginInput);
      return { success: true, data: await issueToken(reply, user) };
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
        request.log.warn({ err: failure }, "Google sign-in failed");
        const safeCode = typeof failureCode === "string" && GOOGLE_CALLBACK_ERRORS.has(failureCode) ? failureCode : "GOOGLE_AUTH_FAILED";
        return reply.redirect(frontendCallbackUrl({ error: safeCode }));
      }
    },

    async googleExchange(request: FastifyRequest, reply: FastifyReply) {
      const { code, codeVerifier } = request.body as { code: string; codeVerifier: string };
      const userId = verifyExchangeCode(request.server, code, codeVerifier);
      const user = await service.getActiveUserForGoogleExchange(userId);
      return { success: true, data: await issueToken(reply, user) };
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
  };
}
