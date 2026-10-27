import "dotenv/config";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();
const scrypt = promisify(scryptCallback);

test("public B2B enquiry submission persists and appears in the authorized admin list", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const suffix = randomBytes(6).toString("hex");
  const email = `b2b-${suffix}@example.test`;
  const password = "integration-test-password";
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `${salt}:${Buffer.from(await scrypt(password, salt, 64) as Buffer).toString("hex")}`;
  let enquiryId: string | undefined;

  try {
    await app.prisma.user.create({ data: { name: "Test Admin", email, passwordHash, role: "ADMIN" } });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/enquiries",
      payload: { name: "Test Buyer" },
    });
    assert.equal(invalid.statusCode, 400);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/enquiries",
      payload: {
        name: "Test Buyer",
        companyName: "Example Office",
        email: `buyer-${suffix}@example.test`,
        phone: "+919876543210",
        productType: "Office Chairs",
        quantity: 75,
        message: "Please share wholesale pricing.",
      },
    });
    assert.equal(created.statusCode, 201);
    const createdData = created.json().data as { id: string; status: string };
    enquiryId = createdData.id;
    assert.equal(createdData.status, "NEW");

    const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/admin/b2b-enquiries" });
    assert.equal(unauthenticated.statusCode, 401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/admin/login",
      payload: { email, password },
    });
    assert.equal(login.statusCode, 200);
    const token = login.json().data.token as string;
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/b2b-enquiries?page=1&limit=1",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(listed.statusCode, 200);

    const result = listed.json() as {
      data: Array<{
        id: string;
        name: string;
        companyName: string;
        items: Array<{ requirements: string; quantity: number }>;
      }>;
      meta: { page: number; limit: number; total: number; totalPages: number };
    };
    assert.equal(result.meta.page, 1);
    assert.equal(result.meta.limit, 1);
    assert.ok(result.meta.total >= 1);

    const allPages = await app.inject({
      method: "GET",
      url: "/api/v1/admin/b2b-enquiries?page=1&limit=100",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(allPages.statusCode, 200);
    const enquiries = allPages.json().data as Array<{
      id: string;
      name: string;
      companyName: string;
      items: Array<{ requirements: string; quantity: number }>;
    }>;
    const enquiry = enquiries.find((item) => item.id === enquiryId);
    assert.equal(enquiry?.name, "Test Buyer");
    assert.equal(enquiry?.companyName, "Example Office");
    assert.deepEqual(enquiry?.items.map(({ requirements, quantity }) => ({ requirements, quantity })), [
      { requirements: "Office Chairs", quantity: 75 },
    ]);
  } finally {
    if (enquiryId) await app.prisma.b2BEnquiry.delete({ where: { id: enquiryId } }).catch(() => undefined);
    await app.prisma.user.delete({ where: { email } }).catch(() => undefined);
    await app.close();
  }
});
