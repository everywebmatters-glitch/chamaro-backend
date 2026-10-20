// Email templates and delivery, with a fake Resend client: nothing here reaches the network.
import test from "node:test";
import assert from "node:assert/strict";

// An empty key (dotenv never overwrites a variable that is already set) proves the module imports without one.
process.env.RESEND_API_KEY = "";
process.env.RESEND_FROM_EMAIL = "Chamaro <noreply@example.test>";
const email = await import("../../src/services/email.service.js");

type Sent = { from: string; to: string; subject: string; html: string; text: string };
function fakeClient(result: () => Promise<{ error: unknown }> = async () => ({ error: null })) {
  const sent: Sent[] = [];
  email.setEmailClientForTests({ emails: { send: async (message) => { sent.push(message); return result(); } } });
  return sent;
}

const order = {
  id: "cmorder123",
  createdAt: new Date("2026-10-18T10:00:00Z"),
  customerName: "Asha <b>Rao</b>",
  items: [
    { productName: "Lounge Chair", variantName: "Walnut", quantity: 2, lineTotal: "24000.00" },
    { productName: "Footrest <script>alert(1)</script>", variantName: null, quantity: 1, lineTotal: "3000.00" },
  ],
  subtotal: "27000.00",
  shippingTotal: "0.00",
  total: "27000.00",
  shippingMethod: "standard",
  shippingAddress: { name: "Asha Rao", addressLine1: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: "560001", country: "IN", phone: "+91 98765 43210" },
};

test("importing the email service needs no RESEND_API_KEY; sending without one fails cleanly", async () => {
  email.setEmailClientForTests(undefined);
  await assert.rejects(email.sendPasswordResetLinkEmail("a@example.test", "https://chamaro.com/reset-password#token=x", 30), { code: "EMAIL_SEND_FAILED", statusCode: 502 });
});

test("the password reset email links to the given URL and states the expiry", async () => {
  const sent = fakeClient();
  const url = "https://chamaro.com/reset-password#token=abc_DEF-123";
  await email.sendPasswordResetLinkEmail("a@example.test", url, 30);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "a@example.test");
  assert.equal(sent[0].from, "Chamaro <noreply@example.test>");
  assert.equal(sent[0].subject, "Reset your Chamaro password");
  assert.ok(sent[0].html.includes(`href="${url}"`));
  assert.match(sent[0].html, /30 minutes/);
  assert.match(sent[0].html, /<h1[^>]*>Chamaro<\/h1>/, "uses the shared branded layout");
});

test("the order-placed email lists the order, items, totals and address, with user text escaped", () => {
  const { subject, html, text } = email.orderPlacedEmail(order);
  assert.equal(subject, "Chamaro order cmorder123: payment pending");
  for (const part of ["cmorder123", "Lounge Chair", "Walnut", "&times; 2", "24000.00", "27000.00", "Shipping (standard)", "12 MG Road", "Bengaluru, Karnataka, 560001"]) assert.ok(html.includes(part), part);
  assert.ok(!html.includes("<script>"), "product names are escaped");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Asha &lt;b&gt;Rao&lt;/b&gt;"), "customer name is escaped");
  for (const part of ["cmorder123", "Lounge Chair (Walnut) x 2: Rs. 24000.00", "Total: Rs. 27000.00", "Shipping (standard): Rs. 0.00", "12 MG Road"]) assert.ok(text.includes(part), `text: ${part}`);
});

test("the order-placed email says plainly that payment is pending and nothing ships until it is complete", () => {
  const { html, text } = email.orderPlacedEmail(order);
  assert.match(html, /Payment for this order is pending/);
  assert.match(html, /will not process or ship it until payment is complete/);
  assert.match(html, /Payment status<\/td><td[^>]*>Pending/);
  assert.match(text, /PAYMENT FOR THIS ORDER IS PENDING/);
  assert.match(text, /Payment status: Pending/);
  assert.doesNotMatch(html + text, /order is confirmed|order has been confirmed/i, "never calls the order confirmed");
});

test("no email asks for a reply to the no-reply sender; order and account emails point at the contact page", () => {
  const messages = [
    email.orderPlacedEmail(order),
    email.shipmentEmail({ id: "cmorder123", customerName: "Asha", carrier: "Blue Dart", trackingNumber: "BD-12345", shippedAt: new Date("2026-10-19T08:00:00Z"), items: order.items, shippingAddress: order.shippingAddress }),
    email.orderCancelledEmail({ id: "cmorder123", customerName: "Asha", items: order.items, total: order.total, cancelledAt: new Date("2026-10-19T08:00:00Z") }),
    email.passwordChangedEmail({ name: "Asha", changedAt: new Date("2026-10-19T08:00:00Z"), resetUrl: "https://chamaro.com/account/login?reset=1" }),
    email.passwordResetEmail("https://chamaro.com/reset-password#token=x", 30),
    email.otpEmail("123456", "LOGIN", 5),
  ];
  for (const { subject, html, text } of messages) {
    assert.doesNotMatch(html + text, /reply/i, subject);
    assert.ok(text.trim().length > 0, `${subject}: has a plain-text part`);
    // The customer's own text appears as typed (the fixture name contains "<b>"); the template adds no markup.
    assert.doesNotMatch(text, /<(p|a|table|tr|td|div|strong|span|br|h1)\b|&amp;|&#8377;|&times;/i, `${subject}: plain text has no HTML`);
  }
  for (const { subject, html, text } of messages.slice(0, 4)) {
    assert.ok(html.includes(`href="${email.contactUrl()}"`), `${subject}: links the contact page`);
    assert.ok(text.includes(email.contactUrl()), `${subject}: text names the contact page`);
  }
});

test("dates are shown in Asia/Kolkata time", () => {
  // 10:00 UTC is 3:30 pm in India; 20:00 UTC is already the next day there.
  assert.equal(email.formatIstDate(new Date("2026-10-18T10:00:00Z")), "18 Oct 2026, 3:30 pm IST");
  assert.equal(email.formatIstDate(new Date("2026-10-18T20:00:00Z")), "19 Oct 2026, 1:30 am IST");
  const placed = email.orderPlacedEmail(order);
  assert.ok(placed.html.includes("Placed 18 Oct 2026, 3:30 pm IST") && placed.text.includes("Placed 18 Oct 2026, 3:30 pm IST"));
  assert.ok(!placed.html.includes("GMT"), "no UTC date strings");
  const shipped = email.shipmentEmail({ id: "o", customerName: "A", carrier: "c", trackingNumber: "t", shippedAt: new Date("2026-10-19T08:00:00Z"), items: [], shippingAddress: null });
  assert.ok(shipped.html.includes("19 Oct 2026, 1:30 pm IST") && shipped.text.includes("Shipped: 19 Oct 2026, 1:30 pm IST"));
});

test("the shipment email carries the carrier and tracking number", () => {
  const { subject, html, text } = email.shipmentEmail({ id: "cmorder123", customerName: "Asha", carrier: "Blue Dart", trackingNumber: "BD-12345", shippedAt: new Date("2026-10-19T08:00:00Z"), items: order.items, shippingAddress: order.shippingAddress });
  assert.equal(subject, "Your Chamaro order cmorder123 has shipped");
  for (const part of ["Blue Dart", "BD-12345", "Lounge Chair", "12 MG Road"]) assert.ok(html.includes(part) && text.includes(part), part);
});

test("the cancellation email names the order and states that no payment was taken", () => {
  const { subject, html, text } = email.orderCancelledEmail({ id: "cmorder123", customerName: "Asha <b>", items: order.items, total: "27000.00", cancelledAt: new Date("2026-10-19T08:00:00Z") });
  assert.equal(subject, "Your Chamaro order cmorder123 has been cancelled");
  for (const part of ["cmorder123", "No payment was taken for this order.", "27000.00", "19 Oct 2026, 1:30 pm IST"]) assert.ok(html.includes(part) && text.includes(part), part);
  assert.ok(html.includes("Asha &lt;b&gt;"));
});

test("the password-changed email has no secret, gives the time, and links the reset form only for customers", () => {
  const customer = email.passwordChangedEmail({ name: "Asha", changedAt: new Date("2026-10-19T08:00:00Z"), resetUrl: "https://chamaro.com/account/login?reset=1" });
  assert.equal(customer.subject, "Your Chamaro password was changed");
  for (const part of ["19 Oct 2026, 1:30 pm IST", "https://chamaro.com/account/login?reset=1"]) assert.ok(customer.html.includes(part) && customer.text.includes(part), part);
  assert.doesNotMatch(customer.html + customer.text, /token=|#token/);
  const admin = email.passwordChangedEmail({ name: "Ops", changedAt: new Date(), resetUrl: null });
  assert.doesNotMatch(admin.html + admin.text, /Reset password|reset=1/);
  assert.match(admin.text, /contact us/);
});

test("deliverEmail sends the text part, passes the idempotency key and returns the provider's message id", async () => {
  const calls: { message: Sent; options?: { idempotencyKey?: string } }[] = [];
  email.setEmailClientForTests({ emails: { send: async (message, options) => { calls.push({ message, options }); return { data: { id: "re_123" }, error: null }; } } });
  const result = await email.deliverEmail("a@example.test", { subject: "S", html: "<p>H</p>", text: "T" }, { idempotencyKey: "order:o1:placed" });
  assert.deepEqual(result, { providerMessageId: "re_123" });
  assert.equal(calls[0].message.text, "T");
  assert.deepEqual(calls[0].options, { idempotencyKey: "order:o1:placed" });
  await email.sendOtpEmail("a@example.test", "123456", "LOGIN");
  assert.equal(calls[1].options, undefined, "direct sends carry no idempotency key");
  assert.match(calls[1].message.text, /123456/);
  email.setEmailClientForTests(undefined);
});

test("a provider error or exception becomes EMAIL_SEND_FAILED without the provider's details", async () => {
  fakeClient(async () => ({ error: { message: "echo: 123456 https://chamaro.com/reset-password#token=secret" } }));
  await assert.rejects(email.sendOtpEmail("a@example.test", "123456", "LOGIN"), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EMAIL_SEND_FAILED");
    assert.equal(error.message, "Failed to send verification email");
    return true;
  });
  fakeClient(async () => { throw new Error("socket hang up: token=secret"); });
  await assert.rejects(email.deliverEmail("a@example.test", email.shipmentEmail({ id: "o", customerName: "A", carrier: "c", trackingNumber: "t", shippedAt: new Date(), items: [], shippingAddress: null })), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EMAIL_SEND_FAILED");
    assert.ok(!error.message.includes("secret"));
    return true;
  });
  email.setEmailClientForTests(undefined);
});

test("a failed send records only the provider's error name and status, never its message", async () => {
  // The shape Resend returns for a sender on an unverified domain (e.g. a gmail.com address).
  fakeClient(async () => ({ error: { name: "validation_error", statusCode: 403, message: "The gmail.com domain is not verified. token=secret 123456" } }));
  await assert.rejects(email.sendPasswordResetLinkEmail("a@example.test", "https://chamaro.com/reset-password#token=secret", 30), (error: Error & { code?: string; provider?: unknown }) => {
    assert.equal(error.code, "EMAIL_SEND_FAILED");
    assert.deepEqual(error.provider, { name: "validation_error", statusCode: 403 });
    const logged = JSON.stringify({ message: error.message, provider: error.provider });
    for (const leak of ["gmail", "secret", "123456", "not verified"]) assert.ok(!logged.includes(leak), leak);
    return true;
  });

  // Anything that is not a plain error name is replaced, so a hostile or odd payload can't smuggle text into logs.
  fakeClient(async () => ({ error: { name: "token=secret 123456", statusCode: "403" } }));
  await assert.rejects(email.sendOtpEmail("a@example.test", "123456", "LOGIN"), { provider: { name: "unknown_error", statusCode: null } });

  fakeClient(async () => { throw new Error("socket hang up: token=secret"); });
  await assert.rejects(email.sendOtpEmail("a@example.test", "123456", "LOGIN"), { provider: { name: "request_failed", statusCode: null } });
  email.setEmailClientForTests(undefined);
});

test("the OTP email keeps its subject and code", async () => {
  const sent = fakeClient();
  await email.sendOtpEmail("a@example.test", "042137", "FORGOT_PASSWORD");
  assert.equal(sent[0].subject, "Reset your Chamaro password");
  assert.ok(sent[0].html.includes(">042137</div>"));
  email.setEmailClientForTests(undefined);
});
