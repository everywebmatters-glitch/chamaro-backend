# Chamaro backend

Fastify + Prisma 7/MySQL API for Chamaro administration, catalogue, CMS, and media metadata.

## Local setup

1. Copy `.env.example` to `.env` and set a real MySQL `DATABASE_URL` and 32+ character `JWT_SECRET`.
2. Run `npm run prisma:generate`, then apply the existing migrations with `npx prisma migrate deploy`.
3. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12+ characters), then run `npm run prisma:seed`.
4. Run `npm run dev`; Swagger is at `http://localhost:4000/docs`.

Useful checks: `npm run prisma:validate` and `npm run build`.

The API uses `Authorization: Bearer <token>` for administrator routes. Login at `POST /api/v1/auth/admin/login`, copy `data.token`, and use Swagger's **Authorize** control.

Customers log in at `POST /api/v1/auth/login` and read their profile at `GET /api/v1/auth/me` (active `CUSTOMER` tokens only). Tokens last 8 hours; there is no refresh or server-side logout.

### Google sign-in (browser flow)

1. The frontend creates a PKCE `code_verifier` (43–128 chars, kept in the browser) and navigates to `GET /api/v1/auth/google?code_challenge=<base64url(SHA-256(verifier))>`.
2. The backend sets a 10-minute HttpOnly `chamaro_google_oauth` cookie (path `/api/v1/auth/google`) and redirects to Google with a signed `state`.
3. Google returns to `GOOGLE_REDIRECT_URI`. The backend checks `state` against the cookie, signs the user in (an existing password account with the same email is never linked automatically), and redirects to `GOOGLE_FRONTEND_CALLBACK_URL#code=<code>` — or `#error=<CODE>` (`OAUTH_STATE_INVALID`, `GOOGLE_AUTH_DENIED`, `GOOGLE_EMAIL_UNVERIFIED`, `GOOGLE_ACCOUNT_NOT_LINKED`, `ACCOUNT_INACTIVE`, `GOOGLE_ID_TOKEN_MISSING`, `GOOGLE_AUTH_FAILED`).
4. The frontend calls `POST /api/v1/auth/google/exchange` with `{ code, codeVerifier }` within 60 seconds and receives `{ token, user }` like a normal login.

State and exchange codes are stateless signed tokens (keys derived from `JWT_SECRET`), so this works across multiple backend instances. Exchange codes are not strictly single-use without shared storage; they expire after 60 seconds and are useless without the verifier.
