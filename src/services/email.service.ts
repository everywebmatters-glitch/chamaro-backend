import { Resend } from "resend";
import { env } from "../config/env.js";
import type { OtpPurpose } from "../../generated/prisma/client.js";

const resend = new Resend(env.RESEND_API_KEY);

const OTP_EMAIL_COPY: Record<OtpPurpose, { subject: string; heading: string }> = {
  LOGIN: { subject: "Your Chamaro Login OTP", heading: "Your Chamaro verification code is" },
  FORGOT_PASSWORD: { subject: "Reset your Chamaro password", heading: "Your Chamaro password reset code is" },
  CHECKOUT_PAYMENT: { subject: "Confirm your Chamaro order", heading: "Your Chamaro checkout verification code is" },
  EMAIL_VERIFICATION: { subject: "Verify your Chamaro email", heading: "Your Chamaro email verification code is" },
};

function otpEmailHtml(heading: string, otp: string, expiryMinutes: number): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f3ef;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <h1 style="color:#1f1b16;font-size:20px;margin:0 0 24px;">Chamaro</h1>
      <p style="color:#44403c;font-size:15px;margin:0 0 16px;">${heading}:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:6px;color:#1f1b16;background:#ffffff;border:1px solid #e7e2da;border-radius:8px;padding:16px 24px;text-align:center;margin:0 0 16px;">${otp}</div>
      <p style="color:#78716c;font-size:13px;margin:0 0 8px;">This code is valid for ${expiryMinutes} minutes.</p>
      <p style="color:#78716c;font-size:13px;margin:0 0 8px;">If you did not request this code, you can safely ignore this email.</p>
      <p style="color:#78716c;font-size:13px;margin:0;">Do not share this code with anyone.</p>
    </div>
  </body>
</html>`;
}

// Sends an OTP email via Resend. Never logs the OTP or the raw provider error (Resend error
// payloads can echo the request body, which contains the code) -- only a generic failure
// surfaces to callers and logs.
export async function sendOtpEmail(to: string, otp: string, purpose: OtpPurpose): Promise<void> {
  const { subject, heading } = OTP_EMAIL_COPY[purpose];
  const { error } = await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to,
    subject,
    html: otpEmailHtml(heading, otp, env.OTP_EXPIRY_MINUTES),
  });
  if (error) throw Object.assign(new Error("Failed to send verification email"), { statusCode: 502, code: "EMAIL_SEND_FAILED" });
}
