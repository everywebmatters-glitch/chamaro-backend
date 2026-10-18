import type { PrismaClient } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import { createOtpService } from "./otp.service.js";
import { createCheckoutRepository } from "../repositories/checkout.repository.js";

function checkoutNotVerified(): Error {
  return Object.assign(new Error("Checkout verification is required before payment can be initiated"), { statusCode: 403, code: "CHECKOUT_NOT_VERIFIED" });
}

export function createCheckoutService(prisma: PrismaClient) {
  const otpService = createOtpService(prisma);
  const repository = createCheckoutRepository(prisma);

  return {
    async sendCheckoutOtp(userId: string, email: string): Promise<void> {
      await otpService.sendOtp({ email, purpose: "CHECKOUT_PAYMENT", userId });
    },

    // Verifies the OTP and records a short-lived, user-bound checkout verification. Returns
    // its expiry so the caller can tell the frontend how long the window stays open.
    async verifyCheckoutOtp(userId: string, email: string, otp: string): Promise<Date> {
      await otpService.verifyOtp({ email, purpose: "CHECKOUT_PAYMENT", otp });
      const expiresAt = new Date(Date.now() + env.CHECKOUT_VERIFICATION_TTL_MINUTES * 60_000);
      await repository.upsertVerification(userId, expiresAt);
      return expiresAt;
    },

    // Payment-initiation code must call this before creating/confirming any payment -- a
    // frontend-supplied "otpVerified: true" flag must never be trusted on its own. Throws
    // CHECKOUT_NOT_VERIFIED (403) when there is no current, unexpired verification for this
    // user, and consumes the verification on success so it authorizes exactly one attempt.
    async requireVerifiedCheckout(userId: string): Promise<void> {
      const verification = await repository.findActive(userId);
      if (!verification) throw checkoutNotVerified();
      await repository.clear(userId);
    },
  };
}

export type CheckoutService = ReturnType<typeof createCheckoutService>;
