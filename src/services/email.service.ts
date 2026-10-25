import { Resend } from "resend";
import { env } from "../config/env.js";
import type { OtpPurpose } from "../../generated/prisma/client.js";

// A rendered email: every message has an HTML part and a plain-text alternative.
export type EmailMessage = { subject: string; html: string; text: string };

// The subset of the Resend client this module uses, so tests can substitute a fake.
export type EmailClient = {
  emails: {
    send(
      message: { from: string; to: string; subject: string; html: string; text: string },
      options?: { idempotencyKey?: string },
    ): Promise<{ data?: { id?: string } | null; error: unknown }>;
  };
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

// What a failed send may record about the provider's answer: Resend's fixed error name (e.g. "validation_error",
// "invalid_from_address", "restricted_api_key") and HTTP status. Never its free-text message.
export type EmailProviderFailure = { name: string; statusCode: number | null };

function providerFailure(error: unknown): EmailProviderFailure {
  const { name, statusCode } = (error ?? {}) as { name?: unknown; statusCode?: unknown };
  return {
    name: typeof name === "string" && /^[a-z_]{1,64}$/.test(name) ? name : "unknown_error",
    statusCode: typeof statusCode === "number" ? statusCode : null,
  };
}

// Sends one message and returns the provider's message id. Never logs or rethrows the raw provider error: Resend
// error payloads can echo the request body, which may contain a code, a reset link or a customer's address.
// Callers only ever see EMAIL_SEND_FAILED, plus `provider` (the error name and status, nothing else) so a
// misconfiguration such as an unverified sender domain can be told apart from an outage in the logs.
// `idempotencyKey` makes the provider answer a repeat of the same key with the first result instead of sending again.
export async function deliverEmail(
  to: string,
  message: EmailMessage,
  options: { idempotencyKey?: string; failureMessage?: string } = {},
): Promise<{ providerMessageId: string | null }> {
  let provider: EmailProviderFailure | undefined;
  let providerMessageId: string | null = null;
  try {
    const { data, error } = await emailClient().emails.send(
      { from: env.RESEND_FROM_EMAIL, to, subject: message.subject, html: message.html, text: message.text },
      options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
    );
    if (error) provider = providerFailure(error);
    else providerMessageId = typeof data?.id === "string" ? data.id.slice(0, 191) : null;
  } catch {
    provider = { name: "request_failed", statusCode: null };
  }
  if (provider) throw Object.assign(new Error(options.failureMessage ?? "Failed to send email"), { statusCode: 502, code: "EMAIL_SEND_FAILED", provider });
  return { providerMessageId };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

// Customers are in India: every date in an email is shown in Asia/Kolkata time, e.g. "18 Oct 2026, 3:30 pm IST".
const IST = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
export function formatIstDate(date: Date): string {
  return `${IST.format(date)} IST`;
}

// The storefront contact page. Emails come from a no-reply address, so they point here instead of asking for a reply.
export function contactUrl(): string {
  return `${env.APP_BASE_URL}/contact`;
}

const TEXT = "color:#44403c;font-size:15px;margin:0 0 16px;";
const MUTED = "color:#78716c;font-size:13px;margin:0 0 8px;";
const LAST = "color:#78716c;font-size:13px;margin:0;";
const CELL = "padding:8px 0;border-bottom:1px solid #e7e2da;color:#44403c;font-size:14px;";
const TOTAL_CELL = "padding:8px 0;color:#1f1b16;font-size:15px;font-weight:700;";
const BUTTON = "display:inline-block;background:#1f1b16;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;border-radius:8px;padding:12px 24px;margin:0 0 16px;";

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

// The plain-text alternative: paragraphs separated by blank lines. Plain text needs no escaping.
function textLayout(paragraphs: (string | false | null | undefined)[]): string {
  return `${["Chamaro", ...paragraphs.filter((part): part is string => Boolean(part))].join("\n\n")}\n`;
}

const contactHtml = () => `<a href="${escapeHtml(contactUrl())}" style="color:#1f1b16;">${escapeHtml(contactUrl())}</a>`;

// ---- OTP ---------------------------------------------------------------------------------------------------------

const OTP_EMAIL_COPY: Record<OtpPurpose, { subject: string; heading: string }> = {
  LOGIN: { subject: "Your Chamaro Login OTP", heading: "Your Chamaro verification code is" },
  FORGOT_PASSWORD: { subject: "Reset your Chamaro password", heading: "Your Chamaro password reset code is" },
  CHECKOUT_PAYMENT: { subject: "Confirm your Chamaro order", heading: "Your Chamaro checkout verification code is" },
  EMAIL_VERIFICATION: { subject: "Verify your Chamaro email", heading: "Your Chamaro email verification code is" },
};

export function otpEmail(otp: string, purpose: OtpPurpose, expiryMinutes: number): EmailMessage {
  const { subject, heading } = OTP_EMAIL_COPY[purpose];
  return {
    subject,
    html: layout(`<p style="${TEXT}">${heading}:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:6px;color:#1f1b16;background:#ffffff;border:1px solid #e7e2da;border-radius:8px;padding:16px 24px;text-align:center;margin:0 0 16px;">${otp}</div>
      <p style="${MUTED}">This code is valid for ${expiryMinutes} minutes.</p>
      <p style="${MUTED}">If you did not request this code, you can safely ignore this email.</p>
      <p style="${LAST}">Do not share this code with anyone.</p>`),
    text: textLayout([`${heading}: ${otp}`, `This code is valid for ${expiryMinutes} minutes.`, "If you did not request this code, you can safely ignore this email.", "Do not share this code with anyone."]),
  };
}

// Sent directly, never through the outbox: the code must not be stored anywhere in plain text.
export async function sendOtpEmail(to: string, otp: string, purpose: OtpPurpose): Promise<void> {
  await deliverEmail(to, otpEmail(otp, purpose, env.OTP_EXPIRY_MINUTES), { failureMessage: "Failed to send verification email" });
}

// ---- password reset link -----------------------------------------------------------------------------------------

export function passwordResetEmail(resetUrl: string, expiryMinutes: number): EmailMessage {
  const href = escapeHtml(resetUrl);
  return {
    subject: "Reset your Chamaro password",
    html: layout(`<p style="${TEXT}">We received a request to reset the password for your Chamaro account.</p>
      <a href="${href}" style="${BUTTON}">Reset password</a>
      <p style="${MUTED}">This link is valid for ${expiryMinutes} minutes and works once.</p>
      <p style="${MUTED}">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all;">${href}</span></p>
      <p style="${LAST}">If you did not ask to reset your password, ignore this email; your password will not change.</p>`),
    text: textLayout([
      "We received a request to reset the password for your Chamaro account.",
      `Reset your password here:\n${resetUrl}`,
      `This link is valid for ${expiryMinutes} minutes and works once.`,
      "If you did not ask to reset your password, ignore this email; your password will not change.",
    ]),
  };
}

// Sent directly, never through the outbox: the link holds a reset token, which must not be stored.
export async function sendPasswordResetLinkEmail(to: string, resetUrl: string, expiryMinutes: number): Promise<void> {
  await deliverEmail(to, passwordResetEmail(resetUrl, expiryMinutes));
}

// ---- password changed --------------------------------------------------------------------------------------------

// `resetUrl` is the storefront's "send a reset link" form; null for admin accounts, which don't reset there.
export function passwordChangedEmail(input: { name: string; changedAt: Date; resetUrl: string | null }): EmailMessage {
  const when = formatIstDate(input.changedAt);
  return {
    subject: "Your Chamaro password was changed",
    html: layout(`<p style="${TEXT}">Hi ${escapeHtml(input.name)}, the password for your Chamaro account was changed on ${when}.</p>
      <p style="${TEXT}">If you made this change, you don't need to do anything.</p>
      <p style="${TEXT}">If you didn't, ${input.resetUrl ? "reset your password now and " : ""}contact us, so we can help secure your account.</p>
      ${input.resetUrl ? `<a href="${escapeHtml(input.resetUrl)}" style="${BUTTON}">Reset password</a>` : ""}
      <p style="${LAST}">Contact us: ${contactHtml()}</p>`),
    text: textLayout([
      `Hi ${input.name}, the password for your Chamaro account was changed on ${when}.`,
      "If you made this change, you don't need to do anything.",
      `If you didn't, ${input.resetUrl ? "reset your password now and " : ""}contact us, so we can help secure your account.${input.resetUrl ? `\nReset password: ${input.resetUrl}` : ""}\nContact us: ${contactUrl()}`,
    ]),
  };
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
  discountTotal?: string;
  discountCode?: string | null;
  shippingTotal: string;
  total: string;
  shippingMethod: string | null;
  shippingAddress: OrderEmailAddress | null;
};
export type ShipmentEmail = Pick<OrderEmail, "id" | "customerName" | "items" | "shippingAddress"> & { carrier: string; trackingNumber: string; shippedAt: Date };
export type CancellationEmail = Pick<OrderEmail, "id" | "customerName" | "items" | "total"> & { cancelledAt: Date };

const rupees = (amount: string) => `&#8377;${escapeHtml(amount)}`;
const rupeesText = (amount: string) => `Rs. ${amount}`;
const row = (label: string, value: string, style = CELL) => `<tr><td style="${style}">${label}</td><td style="${style}text-align:right;">${value}</td></tr>`;
const table = (rows: string) => `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px;">${rows}</table>`;

function itemRows(items: OrderEmailItem[]): string {
  return items
    .map((item) => {
      const variant = item.variantName ? ` <span style="color:#78716c;">(${escapeHtml(item.variantName)})</span>` : "";
      return row(`${escapeHtml(item.productName ?? "Item")}${variant} &times; ${item.quantity}`, rupees(item.lineTotal));
    })
    .join("");
}

function itemLines(items: OrderEmailItem[]): string {
  return items.map((item) => `- ${item.productName ?? "Item"}${item.variantName ? ` (${item.variantName})` : ""} x ${item.quantity}: ${rupeesText(item.lineTotal)}`).join("\n");
}

function addressLines(address: OrderEmailAddress | null): string[] {
  if (!address) return [];
  return [address.name, address.addressLine1, address.addressLine2, [address.city, address.state, address.postalCode].filter(Boolean).join(", "), address.country, address.phone]
    .filter((line): line is string => Boolean(line));
}

function addressBlock(address: OrderEmailAddress | null): string {
  const lines = addressLines(address);
  return lines.length ? `<p style="${TEXT}"><strong>Delivering to</strong><br>${lines.map(escapeHtml).join("<br>")}</p>` : "";
}

function addressText(address: OrderEmailAddress | null): string | null {
  const lines = addressLines(address);
  return lines.length ? `Delivering to:\n${lines.join("\n")}` : null;
}

// Sent when an order is placed. The order is UNPAID at that point, so the email says plainly that payment is
// pending and that nothing is processed or shipped until it is complete.
export function orderPlacedEmail(order: OrderEmail): EmailMessage {
  const shippingLabel = `Shipping${order.shippingMethod ? ` (${order.shippingMethod})` : ""}`;
  const discountLabel = order.discountCode ? `Discount (${order.discountCode})` : "Discount";
  const discountRow = order.discountTotal && Number(order.discountTotal) > 0
    ? row(escapeHtml(discountLabel), `−${rupees(order.discountTotal)}`)
    : "";
  const discountText = order.discountTotal && Number(order.discountTotal) > 0
    ? `\n${discountLabel}: -${rupeesText(order.discountTotal)}`
    : "";
  return {
    subject: `Chamaro order ${order.id}: payment pending`,
    html: layout(`<p style="${TEXT}">Hi ${escapeHtml(order.customerName)}, thank you for placing an order with Chamaro.</p>
      <p style="${TEXT}"><strong>Payment for this order is pending.</strong> Your order is not confirmed yet, and we will not process or ship it until payment is complete.</p>
      <p style="${TEXT}"><strong>Order ${escapeHtml(order.id)}</strong><br><span style="color:#78716c;font-size:13px;">Placed ${formatIstDate(order.createdAt)}</span></p>
      ${table(`${itemRows(order.items)}
        ${row("Subtotal", rupees(order.subtotal))}
        ${discountRow}
        ${row(escapeHtml(shippingLabel), rupees(order.shippingTotal))}
        ${row("Total", rupees(order.total), TOTAL_CELL)}
        ${row("Payment status", "Pending")}`)}
      ${addressBlock(order.shippingAddress)}
      <p style="${LAST}">Questions about your order? Contact us at ${contactHtml()} and quote your order reference.</p>`),
    text: textLayout([
      `Hi ${order.customerName}, thank you for placing an order with Chamaro.`,
      "PAYMENT FOR THIS ORDER IS PENDING. Your order is not confirmed yet, and we will not process or ship it until payment is complete.",
      `Order ${order.id}\nPlaced ${formatIstDate(order.createdAt)}`,
      `${itemLines(order.items)}\nSubtotal: ${rupeesText(order.subtotal)}${discountText}\n${shippingLabel}: ${rupeesText(order.shippingTotal)}\nTotal: ${rupeesText(order.total)}\nPayment status: Pending`,
      addressText(order.shippingAddress),
      `Questions about your order? Contact us at ${contactUrl()} and quote your order reference.`,
    ]),
  };
}

export function shipmentEmail(shipment: ShipmentEmail): EmailMessage {
  return {
    subject: `Your Chamaro order ${shipment.id} has shipped`,
    html: layout(`<p style="${TEXT}">Hi ${escapeHtml(shipment.customerName)}, your order ${escapeHtml(shipment.id)} is on its way.</p>
      ${table(`${row("Carrier", escapeHtml(shipment.carrier))}
        ${row("Tracking number", `<strong>${escapeHtml(shipment.trackingNumber)}</strong>`)}
        ${row("Shipped", formatIstDate(shipment.shippedAt))}`)}
      ${table(itemRows(shipment.items))}
      ${addressBlock(shipment.shippingAddress)}
      <p style="${MUTED}">Use the tracking number on the carrier's website to follow your delivery.</p>
      <p style="${LAST}">Questions about your delivery? Contact us at ${contactHtml()} and quote your order reference.</p>`),
    text: textLayout([
      `Hi ${shipment.customerName}, your order ${shipment.id} is on its way.`,
      `Carrier: ${shipment.carrier}\nTracking number: ${shipment.trackingNumber}\nShipped: ${formatIstDate(shipment.shippedAt)}`,
      itemLines(shipment.items),
      addressText(shipment.shippingAddress),
      "Use the tracking number on the carrier's website to follow your delivery.",
      `Questions about your delivery? Contact us at ${contactUrl()} and quote your order reference.`,
    ]),
  };
}

// Only unpaid orders can be cancelled (see order.service cancelOrder), so no payment was taken for them.
export function orderCancelledEmail(order: CancellationEmail): EmailMessage {
  return {
    subject: `Your Chamaro order ${order.id} has been cancelled`,
    html: layout(`<p style="${TEXT}">Hi ${escapeHtml(order.customerName)}, your order ${escapeHtml(order.id)} was cancelled on ${formatIstDate(order.cancelledAt)}.</p>
      <p style="${TEXT}">No payment was taken for this order.</p>
      ${table(`${itemRows(order.items)}
        ${row("Order total", rupees(order.total), TOTAL_CELL)}`)}
      <p style="${LAST}">Didn't cancel this order? Contact us at ${contactHtml()} and quote your order reference.</p>`),
    text: textLayout([
      `Hi ${order.customerName}, your order ${order.id} was cancelled on ${formatIstDate(order.cancelledAt)}.`,
      "No payment was taken for this order.",
      `${itemLines(order.items)}\nOrder total: ${rupeesText(order.total)}`,
      `Didn't cancel this order? Contact us at ${contactUrl()} and quote your order reference.`,
    ]),
  };
}

// ---- operations --------------------------------------------------------------------------------------------------

// Used only by the outbox worker's self-test, which may send it only to a provider test address.
export function outboxSelfTestEmail(eventKey: string, createdAt: Date): EmailMessage {
  return {
    subject: "Chamaro email outbox self-test",
    html: layout(`<p style="${TEXT}">Outbox self-test ${escapeHtml(eventKey)}, queued ${formatIstDate(createdAt)}.</p>`),
    text: textLayout([`Outbox self-test ${eventKey}, queued ${formatIstDate(createdAt)}.`]),
  };
}
