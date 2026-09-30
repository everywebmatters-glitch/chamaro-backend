// TEMPORARY startup diagnostics (Hostinger 503 investigation). They report only presence
// booleans and non-secret values; never add secret values here. Remove once resolved.
// dotenv loads first (as config/env.ts does) so the report matches what the app will read.
import "dotenv/config";

function diagnostic(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ startupDiagnostic: event, ...details }));
}

const isSet = (name: string): boolean => Boolean(process.env[name]);

diagnostic("environment", {
  PORT_set: process.env.PORT !== undefined,
  PORT_numeric: process.env.PORT === undefined ? null : Number(process.env.PORT),
  HOST_set: process.env.HOST !== undefined,
  HOST: process.env.HOST ?? null,
  APP_ENV: process.env.APP_ENV ?? null,
  DATABASE_URL_set: isSet("DATABASE_URL"),
  JWT_SECRET_set: isSet("JWT_SECRET"),
  CORS_ORIGIN_set: isSet("CORS_ORIGIN"),
  GOOGLE_CLIENT_ID_set: isSet("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET_set: isSet("GOOGLE_CLIENT_SECRET"),
  GOOGLE_REDIRECT_URI_set: isSet("GOOGLE_REDIRECT_URI"),
  GOOGLE_FRONTEND_CALLBACK_URL_set: isSet("GOOGLE_FRONTEND_CALLBACK_URL"),
});

// Startup runs inside main() because Hostinger's launcher loads this entry with require(), which
// rejects ES modules that use top-level await (ERR_REQUIRE_ASYNC_MODULE).
// Dynamic imports so config validation that throws while config/env.ts loads (e.g. CORS_ORIGIN
// in production) is caught and reported below instead of crashing before any output.
async function main(): Promise<void> {
  let stage = "load config";
  try {
    const { env } = await import("./config/env.js");
    stage = "build app";
    const { buildApp } = await import("./app.js");
    const app = await buildApp();
    stage = "listen";
    diagnostic("listen attempt", { host: env.HOST, port: env.PORT });
    try {
      const address = await app.listen({ port: env.PORT, host: env.HOST });
      diagnostic("listen succeeded", { address });
    } catch (error) {
      app.log.error(error);
      throw error;
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error(JSON.stringify({ startupDiagnostic: "startup failed", stage, message: failure.message, stack: failure.stack }));
    process.exit(1);
  }
}

void main();
