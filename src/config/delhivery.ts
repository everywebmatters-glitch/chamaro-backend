import "dotenv/config";

// Delhivery (courier) settings. Read on every use, never at import, so the API starts without them and a missing or
// wrong value fails only shipping calls, with a message that names the variable and never its value.
//
//   DELHIVERY_ENABLED          "true" turns shipping on. Anything else (or unset) keeps every Delhivery call off.
//   DELHIVERY_API_TOKEN        secret (Secret Manager). Sent only as the Authorization header to Delhivery.
//   DELHIVERY_API_BASE_URL     https://staging-express.delhivery.com, or https://track.delhivery.com in production only.
//   DELHIVERY_PICKUP_LOCATION  the warehouse name exactly as registered with Delhivery (case sensitive).
//   DELHIVERY_WEBHOOK_SECRET   secret, 32+ characters: the bearer token Delhivery's scan push must send.
//   DELHIVERY_SELLER_GST_TIN, DELHIVERY_HSN_CODE   sent with every shipment. Required with the production host:
//                              Delhivery's order-creation reference lists seller_gst_tin and hsn_code as mandatory.
//   DELHIVERY_TIMEOUT_MS       optional, 2000-60000 (default 15000).
//   DELHIVERY_AUTO_BOOKING     "true" books a Delhivery shipment automatically once a live payment is verified (the
//                              shipment worker does the booking). Needs DELHIVERY_ENABLED too; off = admins book.

export const DELHIVERY_HOSTS = {
  staging: "https://staging-express.delhivery.com",
  production: "https://track.delhivery.com",
} as const;

export type DelhiveryEnvironment = keyof typeof DELHIVERY_HOSTS;

export type DelhiveryConfig = {
  environment: DelhiveryEnvironment;
  baseUrl: string;
  token: string;
  pickupLocation: string;
  sellerGstTin: string | null;
  hsnCode: string | null;
  timeoutMs: number;
};

const PLACEHOLDER = /replace|change[-_ ]?me|example|placeholder|your[-_ ]?(token|secret)|^x+$/i;

// 503 for an operator problem (shipping off or misconfigured): the request was fine, the service is not ready.
function unavailable(code: "SHIPPING_DISABLED" | "DELHIVERY_NOT_CONFIGURED", message: string): Error {
  return Object.assign(new Error(message), { statusCode: 503, code, expose: true });
}

export function shippingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DELHIVERY_ENABLED?.trim() === "true";
}

export function autoBookingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return shippingEnabled(env) && env.DELHIVERY_AUTO_BOOKING?.trim() === "true";
}

function setting(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function requiredSetting(env: NodeJS.ProcessEnv, name: string): string {
  const value = setting(env, name);
  if (!value) throw unavailable("DELHIVERY_NOT_CONFIGURED", `Delhivery shipping is not configured: ${name} is not set`);
  return value;
}

// Throws SHIPPING_DISABLED or DELHIVERY_NOT_CONFIGURED (both 503) unless every required setting is present and valid.
// Outside APP_ENV=production only the staging host is accepted, so a development machine can never create a real
// shipment, whatever its .env says; production accepts only the production host.
export function readDelhiveryConfig(env: NodeJS.ProcessEnv = process.env): DelhiveryConfig {
  if (!shippingEnabled(env)) throw unavailable("SHIPPING_DISABLED", "Courier shipping is not enabled");
  const isProduction = (env.APP_ENV ?? "development") === "production";

  const baseUrl = requiredSetting(env, "DELHIVERY_API_BASE_URL").replace(/\/+$/, "");
  const environment = (Object.keys(DELHIVERY_HOSTS) as DelhiveryEnvironment[]).find((key) => DELHIVERY_HOSTS[key] === baseUrl);
  if (!environment) throw unavailable("DELHIVERY_NOT_CONFIGURED", `DELHIVERY_API_BASE_URL must be ${DELHIVERY_HOSTS.staging} or ${DELHIVERY_HOSTS.production}`);
  if (environment === "production" && !isProduction) throw unavailable("DELHIVERY_NOT_CONFIGURED", "DELHIVERY_API_BASE_URL points at Delhivery production; only APP_ENV=production may use it");
  if (environment === "staging" && isProduction) throw unavailable("DELHIVERY_NOT_CONFIGURED", "DELHIVERY_API_BASE_URL points at Delhivery staging while APP_ENV=production");

  const token = requiredSetting(env, "DELHIVERY_API_TOKEN");
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(token) || PLACEHOLDER.test(token)) throw unavailable("DELHIVERY_NOT_CONFIGURED", "DELHIVERY_API_TOKEN is not a valid Delhivery API token");

  const pickupLocation = requiredSetting(env, "DELHIVERY_PICKUP_LOCATION");
  if (pickupLocation.length > 191) throw unavailable("DELHIVERY_NOT_CONFIGURED", "DELHIVERY_PICKUP_LOCATION is too long");

  const sellerGstTin = setting(env, "DELHIVERY_SELLER_GST_TIN");
  if (sellerGstTin && !/^[0-9A-Z]{15}$/.test(sellerGstTin)) throw unavailable("DELHIVERY_NOT_CONFIGURED", "DELHIVERY_SELLER_GST_TIN must be a 15-character GSTIN");
  const hsnCode = setting(env, "DELHIVERY_HSN_CODE");
  if (hsnCode && !/^[0-9]{4,8}$/.test(hsnCode)) throw unavailable("DELHIVERY_NOT_CONFIGURED", "DELHIVERY_HSN_CODE must be 4 to 8 digits");
  if (environment === "production" && (!sellerGstTin || !hsnCode)) throw unavailable("DELHIVERY_NOT_CONFIGURED", "DELHIVERY_SELLER_GST_TIN and DELHIVERY_HSN_CODE are required for Delhivery production shipments");

  const rawTimeout = setting(env, "DELHIVERY_TIMEOUT_MS");
  const timeoutMs = rawTimeout ? Number(rawTimeout) : 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 2_000 || timeoutMs > 60_000) throw unavailable("DELHIVERY_NOT_CONFIGURED", "DELHIVERY_TIMEOUT_MS must be a whole number from 2000 to 60000");

  return { environment, baseUrl, token, pickupLocation, sellerGstTin, hsnCode, timeoutMs };
}

// The bearer token Delhivery's scan push must present. Separate from readDelhiveryConfig so a webhook can be checked
// (and refused) the same way whether or not the rest is configured.
export function readWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (!shippingEnabled(env)) throw unavailable("SHIPPING_DISABLED", "Courier shipping is not enabled");
  const secret = requiredSetting(env, "DELHIVERY_WEBHOOK_SECRET");
  if (secret.length < 32 || PLACEHOLDER.test(secret)) throw unavailable("DELHIVERY_NOT_CONFIGURED", "DELHIVERY_WEBHOOK_SECRET must be a random value of at least 32 characters");
  return secret;
}
