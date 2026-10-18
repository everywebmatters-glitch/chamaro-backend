import "dotenv/config";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const skipReason = await isolatedDatabaseSkipReason();
const scrypt = promisify(scryptCallback);
test("health endpoint", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  try { const response = await app.inject({ method: "GET", url: "/health" }); assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { success: true, data: { status: "ok" } }); } finally { await app.close(); }
});
test("admin authentication, catalogue, CMS, and authorization flows", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js"); const app = await buildApp(); const email = `test-${randomBytes(6).toString("hex")}@example.test`; const password = "integration-test-password"; const salt = randomBytes(16).toString("hex"); const passwordHash = `${salt}:${Buffer.from(await scrypt(password, salt, 64) as Buffer).toString("hex")}`;
  let categoryId: string | undefined, productId: string | undefined, pageId: string | undefined, customerId: string | undefined;
  try {
    await app.prisma.user.create({ data: { name: "Test Admin", email, passwordHash, role: "ADMIN" } });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/admin/login", payload: { email, password } }); assert.equal(login.statusCode, 200); const token = login.json().data.token; const headers = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/me", headers })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/me" })).statusCode, 401);
    const unique = randomBytes(6).toString("hex");
    const category = await app.inject({ method: "POST", url: "/api/v1/admin/categories", headers, payload: { name: `Category ${unique}`, slug: `category-${unique}`, status: "ACTIVE" } }); assert.equal(category.statusCode, 201); categoryId = category.json().data.id;
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/categories" })).statusCode, 200);
    const product = await app.inject({ method: "POST", url: "/api/v1/admin/products", headers, payload: { name: `Product ${unique}`, slug: `product-${unique}`, price: 10, categoryId, status: "ACTIVE", quantity: 3 } }); assert.equal(product.statusCode, 201); productId = product.json().data.id;
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/products/product-${unique}` })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url: `/api/v1/admin/products/${productId}`, headers, payload: { price: 12 } })).statusCode, 200);
    const page = await app.inject({ method: "POST", url: "/api/v1/admin/cms/pages", headers, payload: { title: `Page ${unique}`, slug: `page-${unique}`, sections: [{ type: "hero", content: { heading: "Hello" } }] } }); assert.equal(page.statusCode, 201); pageId = page.json().data.id;
    assert.equal((await app.inject({ method: "PUT", url: `/api/v1/admin/cms/pages/${pageId}`, headers, payload: { seoTitle: "Updated" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `/api/v1/admin/cms/pages/${pageId}/publish`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/cms/pages/page-${unique}` })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `/api/v1/admin/cms/pages/${pageId}/unpublish`, headers })).statusCode, 200);
    const customer = await app.prisma.user.create({ data: { name: "Customer", email: `customer-${unique}@example.test`, passwordHash, role: "CUSTOMER" } }); customerId = customer.id;
    const customerToken = app.jwt.sign({ sub: customer.id, role: "CUSTOMER" });
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/me", headers: { authorization: `Bearer ${customerToken}` } })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/admin/products/${productId}`, headers })).statusCode, 204); productId = undefined;
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/admin/categories/${categoryId}`, headers })).statusCode, 204); categoryId = undefined;
  } finally { if (pageId) await app.prisma.cmsPage.delete({ where: { id: pageId } }).catch(() => undefined); if (productId) await app.prisma.product.delete({ where: { id: productId } }).catch(() => undefined); if (categoryId) await app.prisma.category.delete({ where: { id: categoryId } }).catch(() => undefined); if (customerId) await app.prisma.user.delete({ where: { id: customerId } }).catch(() => undefined); await app.prisma.user.delete({ where: { email } }).catch(() => undefined); await app.close(); }
});
