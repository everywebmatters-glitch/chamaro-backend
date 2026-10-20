import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

const APP_ENV = process.env.APP_ENV ?? "development";
const isProduction = APP_ENV === "production";

// Placeholder values from .env.example (or similar) must never sign production tokens.
const PLACEHOLDER_SECRET = /replace|change[-_ ]?me|example|placeholder|your[-_ ]?secret/i;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

// Production has no default: every allowed browser origin must be listed explicitly, and none
// may point at a local development server. Messages name the variable, never its value.
function productionCorsOrigin(): string {
  const value = process.env.CORS_ORIGIN?.trim();
  if (!value) throw new Error("CORS_ORIGIN must be set explicitly when APP_ENV=production");
  for (const origin of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      throw new Error("CORS_ORIGIN contains an entry that is not a valid origin URL");
    }
    if (LOCAL_HOSTNAMES.has(hostname)) throw new Error("CORS_ORIGIN must not include localhost origins when APP_ENV=production");
  }
  return value;
}

// A site that email links (e.g. password reset) point at. Production must be a public https URL.
function siteBaseUrl(name: string, productionDefault: string, developmentDefault: string): string {
  const value = (process.env[name]?.trim() || (isProduction ? productionDefault : developmentDefault)).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (isProduction && (url.protocol !== "https:" || LOCAL_HOSTNAMES.has(url.hostname))) throw new Error(`${name} must be a public https URL when APP_ENV=production`);
  return value;
}

// A whole number of minutes within [min, max]; unset means the default. Anything else stops startup, so a typo can
// never produce a reset link that never expires (NaN) or one that has already expired (0 or negative).
function minutesSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number of minutes from ${min} to ${max}`);
  return value;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  HOST: process.env.HOST ?? "0.0.0.0",
  APP_ENV,
  isProduction,
  CORS_ORIGIN: isProduction ? productionCorsOrigin() : process.env.CORS_ORIGIN ?? "http://localhost:3000",
  SWAGGER_SERVER_URL: process.env.SWAGGER_SERVER_URL,
  DATABASE_CA_CERT_PATH: process.env.DATABASE_CA_CERT_PATH,
  // PEM contents of the database server CA, for hosts where no certificate file is deployed.
  DATABASE_CA_CERT: process.env.DATABASE_CA_CERT,
  // Name the database server certificate is issued to, when it differs from the DATABASE_URL host
  // (e.g. Cloud SQL by public IP: <id>.<region>.sql.goog). Used for TLS verification and SNI only.
  DATABASE_TLS_SERVERNAME: process.env.DATABASE_TLS_SERVERNAME,
  AUTH_RATE_LIMIT_MAX: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
  AUTH_RATE_LIMIT_WINDOW: process.env.AUTH_RATE_LIMIT_WINDOW ?? "1 minute",
  // Tighter than AUTH_RATE_LIMIT_*: OTP send/verify is more abuse-prone (each send costs an
  // email, each verify is a guess against a 6-digit code) than a plain login attempt.
  OTP_RATE_LIMIT_MAX: Number(process.env.OTP_RATE_LIMIT_MAX ?? 5),
  OTP_RATE_LIMIT_WINDOW: process.env.OTP_RATE_LIMIT_WINDOW ?? "10 minutes",
  OTP_EXPIRY_MINUTES: Number(process.env.OTP_EXPIRY_MINUTES ?? 5),
  OTP_MAX_ATTEMPTS: Number(process.env.OTP_MAX_ATTEMPTS ?? 5),
  OTP_RESEND_COOLDOWN_SECONDS: Number(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? 60),
  // How long a completed checkout/payment OTP verification authorizes a payment attempt for.
  CHECKOUT_VERIFICATION_TTL_MINUTES: Number(process.env.CHECKOUT_VERIFICATION_TTL_MINUTES ?? 15),
  // The customer-facing storefront; customer email links point here, never at the admin app.
  get APP_BASE_URL() { return siteBaseUrl("APP_BASE_URL", "https://chamaro.com", "http://localhost:3000"); },
  // The admin app; only admin accounts' password-reset links point here.
  get ADMIN_BASE_URL() { return siteBaseUrl("ADMIN_BASE_URL", "https://admin.chamaro.com", "http://localhost:3001"); },
  // How long a password-reset link works for. Each link also works only once.
  PASSWORD_RESET_TOKEN_TTL_MINUTES: minutesSetting("PASSWORD_RESET_TOKEN_TTL_MINUTES", 30, 5, 120),
  get GOOGLE_CLIENT_ID() { return required("GOOGLE_CLIENT_ID"); },
  get GOOGLE_CLIENT_SECRET() { return required("GOOGLE_CLIENT_SECRET"); },
  // Backend callback registered with Google, e.g. http://localhost:4000/api/v1/auth/google/callback
  get GOOGLE_REDIRECT_URI() { return required("GOOGLE_REDIRECT_URI"); },
  // Frontend page the backend callback sends the browser to with a one-time exchange code (or an
  // error), e.g. http://localhost:3000/account/google/callback/
  get GOOGLE_FRONTEND_CALLBACK_URL() { return required("GOOGLE_FRONTEND_CALLBACK_URL"); },
  get DATABASE_URL() { return required("DATABASE_URL"); },
  get RESEND_API_KEY() { return required("RESEND_API_KEY"); },
  get RESEND_FROM_EMAIL() { return required("RESEND_FROM_EMAIL"); },
  get JWT_SECRET() {
    const secret = required("JWT_SECRET");
    if (secret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
    if (isProduction && PLACEHOLDER_SECRET.test(secret)) throw new Error("JWT_SECRET looks like a placeholder; generate a random secret for production");
    return secret;
  },
};
