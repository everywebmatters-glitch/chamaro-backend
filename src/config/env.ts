import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  HOST: process.env.HOST ?? "0.0.0.0",
  APP_ENV: process.env.APP_ENV ?? "development",
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  SWAGGER_SERVER_URL: process.env.SWAGGER_SERVER_URL,
  DATABASE_CA_CERT_PATH: process.env.DATABASE_CA_CERT_PATH,
  AUTH_RATE_LIMIT_MAX: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
  AUTH_RATE_LIMIT_WINDOW: process.env.AUTH_RATE_LIMIT_WINDOW ?? "1 minute",
  get GOOGLE_CLIENT_ID() { return required("GOOGLE_CLIENT_ID"); },
  get GOOGLE_CLIENT_SECRET() { return required("GOOGLE_CLIENT_SECRET"); },
  // Backend callback registered with Google, e.g. http://localhost:4000/api/v1/auth/google/callback
  get GOOGLE_REDIRECT_URI() { return required("GOOGLE_REDIRECT_URI"); },
  // Frontend page the backend callback sends the browser to with a one-time exchange code (or an
  // error), e.g. http://localhost:3000/account/google/callback/
  get GOOGLE_FRONTEND_CALLBACK_URL() { return required("GOOGLE_FRONTEND_CALLBACK_URL"); },
  get DATABASE_URL() { return required("DATABASE_URL"); },
  get JWT_SECRET() {
    const secret = required("JWT_SECRET");
    if (secret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
    return secret;
  },
};
