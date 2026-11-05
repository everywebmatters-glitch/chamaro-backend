import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { httpError } from "../shared/http.js";

const TOKEN_TTL = "10m";
const PURPOSE = "delhivery_shipping_quote";

export type ShippingQuoteClaims = {
  purpose: typeof PURPOSE;
  sub: string;
  pin: string;
  shippingMinor: number;
  cartFingerprint: string;
};

function signingKey(): Buffer {
  return createHmac("sha256", env.JWT_SECRET).update(`chamaro:${PURPOSE}`).digest();
}

function invalidQuote(): Error {
  return httpError(409, "SHIPPING_QUOTE_EXPIRED", "Your delivery estimate expired or changed. Refresh the estimate and try again.");
}

export function createShippingQuoteToken(
  app: FastifyInstance,
  userId: string,
  quote: Omit<ShippingQuoteClaims, "purpose" | "sub">,
): string {
  return app.jwt.sign(
    { purpose: PURPOSE, pin: quote.pin, shippingMinor: quote.shippingMinor, cartFingerprint: quote.cartFingerprint },
    { key: signingKey(), algorithm: "HS256", sub: userId, expiresIn: TOKEN_TTL },
  );
}

export function verifyShippingQuoteToken(app: FastifyInstance, token: string, userId: string): ShippingQuoteClaims {
  let claims: ShippingQuoteClaims;
  try {
    claims = app.jwt.verify<ShippingQuoteClaims>(token, { key: signingKey(), algorithms: ["HS256"] });
  } catch {
    throw invalidQuote();
  }
  if (
    claims.purpose !== PURPOSE ||
    claims.sub !== userId ||
    !/^[1-9][0-9]{5}$/.test(claims.pin) ||
    !Number.isSafeInteger(claims.shippingMinor) ||
    claims.shippingMinor < 0 ||
    !/^[a-f0-9]{64}$/.test(claims.cartFingerprint)
  ) {
    throw invalidQuote();
  }
  return claims;
}
