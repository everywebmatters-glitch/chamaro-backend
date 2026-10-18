import { randomInt } from "node:crypto";
import type { OtpPurpose, PrismaClient } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { createOtpRepository } from "../repositories/otp.repository.js";
import { sendOtpEmail } from "./email.service.js";

function otpInvalid(): Error {
  return Object.assign(new Error("Invalid or expired code"), { statusCode: 400, code: "OTP_INVALID" });
}
function otpExpired(): Error {
  return Object.assign(new Error("This code has expired; request a new one"), { statusCode: 400, code: "OTP_EXPIRED" });
}
function otpMaxAttempts(): Error {
  return Object.assign(new Error("Too many incorrect attempts; request a new code"), { statusCode: 429, code: "OTP_MAX_ATTEMPTS" });
}
function otpResendCooldown(retryAfterSeconds: number): Error {
  return Object.assign(new Error("Please wait before requesting another code"), { statusCode: 429, code: "OTP_RESEND_COOLDOWN", retryAfterSeconds });
}

function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// Reusable email-OTP engine shared by login, forgot-password, and checkout/payment flows.
// Keep this purpose-agnostic: callers decide what sendOtp()/verifyOtp() being called for a
// given email+purpose means for their own domain (e.g. whether the account must already exist).
export function createOtpService(prisma: PrismaClient) {
  const repository = createOtpRepository(prisma);

  return {
    // Generates, hashes, stores, and emails a new OTP, invalidating any previously active code
    // for the same email+purpose first. Enforces the resend cooldown against the most recently
    // issued code (consumed or not). Never returns or logs the plaintext code.
    async sendOtp(params: { email: string; purpose: OtpPurpose; userId?: string }): Promise<void> {
      const email = params.email.trim().toLowerCase();
      const latest = await repository.findLatest(email, params.purpose);
      if (latest) {
        const elapsedSeconds = (Date.now() - latest.createdAt.getTime()) / 1000;
        if (elapsedSeconds < env.OTP_RESEND_COOLDOWN_SECONDS) {
          throw otpResendCooldown(Math.ceil(env.OTP_RESEND_COOLDOWN_SECONDS - elapsedSeconds));
        }
      }
      const otp = generateOtp();
      const otpHash = await hashPassword(otp);
      const expiresAt = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60_000);
      await repository.invalidateActive(email, params.purpose);
      await repository.create({ email, purpose: params.purpose, otpHash, expiresAt, userId: params.userId });
      await sendOtpEmail(email, otp, params.purpose);
    },

    // Validates `otp` against the latest active (unconsumed) code for email+purpose. On
    // mismatch, increments the shared attempt counter and throws OTP_INVALID. On match, marks
    // the code consumed only when `consume` is true (default) -- pass false for a non-final
    // "check" step (e.g. forgot-password's verify-otp) whose later step (reset) re-validates
    // and performs the actual consumption.
    async verifyOtp(params: { email: string; purpose: OtpPurpose; otp: string; consume?: boolean }): Promise<void> {
      const email = params.email.trim().toLowerCase();
      const record = await repository.findActive(email, params.purpose);
      if (!record) throw otpInvalid();
      if (record.expiresAt.getTime() < Date.now()) throw otpExpired();
      if (record.attempts >= env.OTP_MAX_ATTEMPTS) throw otpMaxAttempts();
      const matches = await verifyPassword(params.otp, record.otpHash);
      if (!matches) {
        await repository.incrementAttempts(record.id);
        throw otpInvalid();
      }
      if (params.consume ?? true) await repository.markConsumed(record.id);
    },
  };
}

export type OtpService = ReturnType<typeof createOtpService>;
