import { Resend } from "resend";
import { env } from "../config/env.js";
import type { OtpPurpose } from "../../generated/prisma/client.js";

// The subset of the Resend client this module uses, so tests can substitute a fake.
export type EmailClient = {
  emails: { send(message: { from: string; to: string; subject: string; html: string }): Promise<{ error: unknown }> };
};

// Created on first send, not at import: importing this module (directly or through the auth and order
// services) must not require RESEND_API_KEY, so a missing key fails one email instead of the whole server.
let client: EmailClient | undefined;
function emailClient(): EmailClient {
  client ??= new Resend(env.RESEND_API_KEY);
  return client;
}

// Tests only: route every send through a fake client (pass undefined to go back to the real one).
export function setEmailClientForTests(fake: EmailClient | undefined): void {
  client = fake;
}

// Never logs or rethrows the raw provider error: Resend error payloads can echo the request body, which may
// contain a code, a reset link or a customer's address. Callers only ever see EMAIL_SEND_FAILED.
async function send(to: string, subject: string, html: string, failureMessage = "Failed to send email"): Promise<void> {
  let failed: boolean;
  try {
    const { error } = await emailClient().emails.send({ from: env.RESEND_FROM_EMAIL, to, subject, html });
    failed = Boolean(error);
  } catch {
    failed = true;
  }
  if (failed) throw Object.assign(new Error(failureMessage), { statusCode: 502, code: "EMAIL_SEND_FAILED" });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

const TEXT = "color:#44403c;font-size:15px;margin:0 0 16px;";
const MUTED = "color:#78716c;font-size:13px;margin:0 0 8px;";
const LAST = "color:#78716c;font-size:13px;margin:0;";
const CELL = "padding:8px 0;border-bottom:1px solid #e7e2da;color:#44403c;font-size:14px;";
const TOTAL_CELL = "padding:8px 0;color:#1f1b16;font-size:15px;font-weight:700;";

// The branded wrapper every Chamaro email shares. `body` is trusted HTML: escape every value that came from a user.
function layout(body: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f3ef;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <h1 style="color:#1f1b16;font-size:20px;margin:0 0 24px;">Chamaro</h1>
      ${body}
    </div>
  </body>
</html>`;
}

// ---- OTP ---------------------------------------------------------------------------------------------------------

const OTP_EMAIL_COPY: Record<OtpPurpose, { subject: string; heading: string }> = {
  LOGIN: { subject: "Your Chamaro Login OTP", heading: "Your Chamaro verification code is" },
  FORGOT_PASSWORD: { subject: "Reset your Chamaro password", heading: "Your Chamaro password reset code is" },
  CHECKOUT_PAYMENT: { subject: "Confirm your Chamaro order", heading: "Your Chamaro checkout verification code is" },
  EMAIL_VERIFICATION: { subject: "Verify your Chamaro email", heading: "Your Chamaro email verification code is" },
};

function otpEmailHtml(heading: string, otp: string, expiryMinutes: number): string {
  return layout(`<p style="${TEXT}">${heading}:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:6px;color:#1f1b16;background:#ffffff;border:1px solid #e7e2da;border-radius:8px;padding:16px 24px;text-align:center;margin:0 0 16px;">${otp}</div>
      <p style="${MUTED}">This code is valid for ${expiryMinutes} minutes.</p>
      <p style="${MUTED}">If you did not request this code, you can safely ignore this email.</p>
      <p style="${LAST}">Do not share this code with anyone.</p>`);
}

export async function sendOtpEmail(to: string, otp: string, purpose: OtpPurpose): Promise<void> {
  const { subject, heading } = OTP_EMAIL_COPY[purpose];
  await send(to, subject, otpEmailHtml(heading, otp, env.OTP_EXPIRY_MINUTES), "Failed to send verification email");
}

// ---- password reset link -----------------------------------------------------------------------------------------

export function passwordResetEmailHtml(resetUrl: string, expiryMinutes: number): string {
  const href = escapeHtml(resetUrl);
  return layout(`<p style="${TEXT}">We received a request to reset the password for your Chamaro account.</p>
      <a href="${href}" style="display:inline-block;background:#1f1b16;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;border-radius:8px;padding:12px 24px;margin:0 0 16px;">Reset password</a>
      <p style="${MUTED}">This link is valid for ${expiryMinutes} minutes and works once.</p>
      <p style="${MUTED}">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all;">${href}</span></p>
      <p style="${LAST}">If you did not ask to reset your password, ignore this email; your password will not change.</p>`);
}

export async function sendPasswordResetLinkEmail(to: string, resetUrl: string, expiryMinutes: number): Promise<void> {
  await send(to, "Reset your Chamaro password", passwordResetEmailHtml(resetUrl, expiryMinutes));
}

// ---- orders ------------------------------------------------------------------------------------------------------

export type OrderEmailItem = { productName: string | null; variantName: string | null; quantity: number; lineTotal: string };
export type OrderEmailAddress = { name?: string; phone?: string; addressLine1?: string; addressLine2?: string | null; city?: string; state?: string; postalCode?: string; country?: string };
// RetailOrder has no separate order number: its id is the reference the customer and the admin both see.
export type OrderEmail = {
  id: string;
  createdAt: Date;
  customerName: string;
  items: OrderEmailItem[];
  subtotal: string;
  shippingTotal: string;
  total: string;
  shippingMethod: string | null;
  shippingAddress: OrderEmailAddress | null;
};
export type ShipmentEmail = Pick<OrderEmail, "id" | "customerName" | "items" | "shippingAddress"> & { carrier: string; trackingNumber: string; shippedAt: Date };

const rupees = (amount: string) => `&#8377;${escapeHtml(amount)}`;
const row = (label: string, value: string, style = CELL) => `<tr><td style="${style}">${label}</td><td style="${style}text-align:right;">${value}</td></tr>`;

function itemRows(items: OrderEmailItem[]): string {
  return items
    .map((item) => {
      const variant = item.variantName ? ` <span style="color:#78716c;">(${escapeHtml(item.variantName)})</span>` : "";
      return row(`${escapeHtml(item.productName ?? "Item")}${variant} &times; ${item.quantity}`, rupees(item.lineTotal));
    })
    .join("");
}

function addressBlock(address: OrderEmailAddress | null): string {
  if (!address) return "";
  const lines = [address.name, address.addressLine1, address.addressLine2, [address.city, address.state, address.postalCode].filter(Boolean).join(", "), address.country, address.phone]
    .filter((line): line is string => Boolean(line))
    .map(escapeHtml);
  return `<p style="${TEXT}"><strong>Delivering to</strong><br>${lines.join("<br>")}</p>`;
}

export function orderConfirmationEmailHtml(order: OrderEmail): string {
  const shippingLabel = `Shipping${order.shippingMethod ? ` (${escapeHtml(order.shippingMethod)})` : ""}`;
  return layout(`<p style="${TEXT}">Hi ${escapeHtml(order.customerName)}, thank you for your order. We have received it and will email you again when it ships.</p>
      <p style="${TEXT}"><strong>Order ${escapeHtml(order.id)}</strong><br><span style="color:#78716c;font-size:13px;">Placed ${order.createdAt.toUTCString()}</span></p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px;">
        ${itemRows(order.items)}
        ${row("Subtotal", rupees(order.subtotal))}
        ${row(shippingLabel, rupees(order.shippingTotal))}
        ${row("Total", rupees(order.total), TOTAL_CELL)}
      </table>
      ${addressBlock(order.shippingAddress)}
      <p style="${LAST}">Questions about your order? Reply to this email and quote your order reference.</p>`);
}

export async function sendOrderConfirmationEmail(to: string, order: OrderEmail): Promise<void> {
  await send(to, `Your Chamaro order ${order.id}`, orderConfirmationEmailHtml(order));
}

export function shipmentEmailHtml(shipment: ShipmentEmail): string {
  return layout(`<p style="${TEXT}">Hi ${escapeHtml(shipment.customerName)}, your order ${escapeHtml(shipment.id)} is on its way.</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px;">
        ${row("Carrier", escapeHtml(shipment.carrier))}
        ${row("Tracking number", `<strong>${escapeHtml(shipment.trackingNumber)}</strong>`)}
        ${row("Shipped", shipment.shippedAt.toUTCString())}
      </table>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px;">${itemRows(shipment.items)}</table>
      ${addressBlock(shipment.shippingAddress)}
      <p style="${LAST}">Use the tracking number on the carrier's website to follow your delivery.</p>`);
}

export async function sendShipmentEmail(to: string, shipment: ShipmentEmail): Promise<void> {
  await send(to, `Your Chamaro order ${shipment.id} has shipped`, shipmentEmailHtml(shipment));
}
