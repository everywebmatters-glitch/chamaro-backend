// Email templates and delivery, with a fake Resend client: nothing here reaches the network.
import test from "node:test";
import assert from "node:assert/strict";

// An empty key (dotenv never overwrites a variable that is already set) proves the module imports without one.
process.env.RESEND_API_KEY = "";
process.env.RESEND_FROM_EMAIL = "Chamaro <noreply@example.test>";
const email = await import("../../src/services/email.service.js");

type Sent = { from: string; to: string; subject: string; html: string };
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

test("the order confirmation lists the order, items, totals and address, with user text escaped", async () => {
  const sent = fakeClient();
  await email.sendOrderConfirmationEmail("asha@example.test", order);
  const { subject, html } = sent[0];
  assert.equal(subject, "Your Chamaro order cmorder123");
  for (const part of ["cmorder123", "Lounge Chair", "Walnut", "&times; 2", "24000.00", "27000.00", "Shipping (standard)", "12 MG Road", "Bengaluru, Karnataka, 560001"]) assert.ok(html.includes(part), part);
  assert.ok(!html.includes("<script>"), "product names are escaped");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Asha &lt;b&gt;Rao&lt;/b&gt;"), "customer name is escaped");
});

test("the shipment email carries the carrier and tracking number", async () => {
  const sent = fakeClient();
  await email.sendShipmentEmail("asha@example.test", { id: "cmorder123", customerName: "Asha", carrier: "Blue Dart", trackingNumber: "BD-12345", shippedAt: new Date("2026-10-19T08:00:00Z"), items: order.items, shippingAddress: order.shippingAddress });
  assert.equal(sent[0].subject, "Your Chamaro order cmorder123 has shipped");
  for (const part of ["Blue Dart", "BD-12345", "Lounge Chair", "12 MG Road"]) assert.ok(sent[0].html.includes(part), part);
});

test("a provider error or exception becomes EMAIL_SEND_FAILED without the provider's details", async () => {
  fakeClient(async () => ({ error: { message: "echo: 123456 https://chamaro.com/reset-password#token=secret" } }));
  await assert.rejects(email.sendOtpEmail("a@example.test", "123456", "LOGIN"), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EMAIL_SEND_FAILED");
    assert.equal(error.message, "Failed to send verification email");
    return true;
  });
  fakeClient(async () => { throw new Error("socket hang up: token=secret"); });
  await assert.rejects(email.sendShipmentEmail("a@example.test", { id: "o", customerName: "A", carrier: "c", trackingNumber: "t", shippedAt: new Date(), items: [], shippingAddress: null }), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EMAIL_SEND_FAILED");
    assert.ok(!error.message.includes("secret"));
    return true;
  });
  email.setEmailClientForTests(undefined);
});

test("the OTP email keeps its subject and code", async () => {
  const sent = fakeClient();
  await email.sendOtpEmail("a@example.test", "042137", "FORGOT_PASSWORD");
  assert.equal(sent[0].subject, "Reset your Chamaro password");
  assert.ok(sent[0].html.includes(">042137</div>"));
  email.setEmailClientForTests(undefined);
});
