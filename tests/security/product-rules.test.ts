// L5 and L10 against the real product routes, with a stub Prisma client (no database).
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { productRoutes } from "../../src/routes/product.routes.js";
import { registerErrorHandler } from "../../src/middleware/error.middleware.js";
import { compareAtPriceViolation } from "../../src/shared/product-rules.js";

type Call = { model: string; op: string; args: any };

function stubApp(stored = { price: 100, compareAtPrice: 120 as number | null }) {
  const calls: Call[] = [];
  const product = { id: "p1", name: "Chair", images: [], variants: [], category: { id: "c", name: "C", slug: "c" }, inventory: null };
  const record = (model: string, op: string, result: unknown) => (args: any) => {
    calls.push({ model, op, args });
    return Promise.resolve(result);
  };
  const prisma = {
    product: {
      findMany: record("product", "findMany", [product]),
      findFirst: record("product", "findFirst", product),
      findUnique: record("product", "findUnique", { ...product, ...stored }),
      count: record("product", "count", 1),
      update: record("product", "update", product),
    },
    productImage: { findMany: record("productImage", "findMany", []) },
    media: { count: record("media", "count", 0), deleteMany: record("media", "deleteMany", { count: 0 }) },
    category: { findUnique: record("category", "findUnique", { id: "c" }) },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  registerErrorHandler(app);
  app.decorate("prisma", prisma as any);
  app.decorateRequest("requireAdmin", async function () {});
  app.register(productRoutes);
  return { app, calls };
}

test("L5: public product endpoints only include ACTIVE variants; admin ones include all", async () => {
  const { app, calls } = stubApp();
  await app.inject({ method: "GET", url: "/api/v1/products" });
  await app.inject({ method: "GET", url: "/api/v1/products/chair" });
  await app.inject({ method: "GET", url: "/api/v1/admin/products" });
  await app.inject({ method: "GET", url: "/api/v1/admin/products/p1" });
  const [publicList, publicOne, adminList, adminOne] = calls.filter((c) => c.model === "product" && c.op !== "count");
  assert.deepEqual(publicList.args.include.variants, { where: { status: "ACTIVE" } });
  assert.deepEqual(publicOne.args.include.variants, { where: { status: "ACTIVE" } });
  assert.equal(adminList.args.include.variants, true, "admin list keeps every variant");
  assert.equal(adminOne.args.include.variants, true, "admin detail keeps every variant");
  await app.close();
});

test("L10: compareAtPrice >= price is checked against stored values on partial updates", async () => {
  // Stored: price 100, compareAtPrice 120.
  const { app, calls } = stubApp();
  const put = (payload: object) => app.inject({ method: "PUT", url: "/api/v1/admin/products/p1", payload });

  const priceAboveStoredCompare = await put({ price: 150 });
  assert.equal(priceAboveStoredCompare.statusCode, 400, "new price 150 > stored compareAtPrice 120");
  assert.match(priceAboveStoredCompare.json().error.message, /compareAtPrice/);

  assert.equal((await put({ compareAtPrice: 90 })).statusCode, 400, "new compareAtPrice 90 < stored price 100");
  assert.equal((await put({ price: 110 })).statusCode, 200, "110 <= stored 120 is fine");
  assert.equal((await put({ price: 150, compareAtPrice: 200 })).statusCode, 200, "both sent and consistent");
  assert.equal(calls.filter((c) => c.op === "update").length, 2, "rejected updates never reach the database");
  await app.close();

  // A product without a compare-at price can take any price.
  const none = stubApp({ price: 100, compareAtPrice: null });
  assert.equal((await none.app.inject({ method: "PUT", url: "/api/v1/admin/products/p1", payload: { price: 5000 } })).statusCode, 200);
  await none.app.close();
});

test("L10: compareAtPriceViolation rule", () => {
  assert.equal(compareAtPriceViolation(100, 120), false);
  assert.equal(compareAtPriceViolation(100, 100), false);
  assert.equal(compareAtPriceViolation(100, 99.99), true);
  assert.equal(compareAtPriceViolation(100, null), false);
  assert.equal(compareAtPriceViolation(100, undefined), false);
});
