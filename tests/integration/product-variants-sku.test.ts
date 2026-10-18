// The planner's idea of "the same SKU" must agree with the database's. Whatever the column's collation says is
// the truth: where the two agree the update proceeds normally; where they don't it is refused (409 AMBIGUOUS_SKU)
// before anything changes. Runs only against the isolated test database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();

test("SKU equivalence is checked against the database's own collation before any change", { skip: skipReason }, async () => {
  const { buildApp } = await import("../../src/app.js");
  const { skuKey } = await import("../../src/shared/variant-sync.js");
  const app = await buildApp();
  const unique = randomBytes(6).toString("hex");
  const made: { userId?: string; productIds: string[]; categoryId?: string } = { productIds: [] };

  try {
    const admin = await app.prisma.user.create({ data: { name: "SKU Admin", email: `sku-${unique}@example.test`, passwordHash: "unused", role: "ADMIN" } });
    made.userId = admin.id;
    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin.id, role: "ADMIN" })}` };
    const category = await app.prisma.category.create({ data: { name: `SKU ${unique}`, slug: `sku-${unique}` } });
    made.categoryId = category.id;

    const [column] = await app.prisma.$queryRaw<{ c: string }[]>`SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductVariant' AND COLUMN_NAME = 'sku'`;
    assert.match(column.c, /^utf8mb4_unicode_ci$/i, "the migrations create ProductVariant.sku as utf8mb4_unicode_ci");
    const databaseSaysEqual = async (x: string, y: string) => {
      const [row] = await app.prisma.$queryRawUnsafe<{ same: number | bigint }[]>(
        `SELECT (CAST(? AS CHAR CHARACTER SET utf8mb4) COLLATE ${column.c} = CAST(? AS CHAR CHARACTER SET utf8mb4) COLLATE ${column.c}) AS same`,
        x,
        y,
      );
      return Number(row.same) === 1;
    };

    // [existing SKU, SKU sent in the update]; a unique suffix is appended to both so rows never collide.
    const pairs: [string, string][] = [
      ["lower-case", "LOWER-CASE"],
      ["pad-space", "pad-space   "],
      [" leading", "leading"],
      ["cafe", "café"],
      ["strasse", "STRAßE"],
      ["abc", "ＡＢＣ"],
      ["zero​width", "zerowidth"],
      ["tab", "tab\t"],
    ];
    const outcomes: string[] = [];

    for (const [index, [existing, sent]] of pairs.entries()) {
      // The suffix goes before any trailing padding so that the edge case stays at the end of the SKU.
      const withSuffix = (sku: string) => { const trimmed = sku.trimEnd(); return `${trimmed}-${unique}-${index}${sku.slice(trimmed.length)}`; };
      const existingSku = withSuffix(existing);
      const sentSku = withSuffix(sent);

      const created = await app.inject({ method: "POST", url: "/api/v1/admin/products", headers, payload: { name: `SKU ${index} ${unique}`, slug: `sku-${index}-${unique}`, price: 1, categoryId: category.id, variants: [{ name: "V", sku: existingSku, options: {} }] } });
      assert.equal(created.statusCode, 201, created.body);
      const productId = created.json().data.id as string;
      made.productIds.push(productId);
      const variantId = created.json().data.variants[0].id as string;

      const planner = skuKey(existingSku) === skuKey(sentSku);
      const database = await databaseSaysEqual(existingSku, sentSku);
      const response = await app.inject({ method: "PUT", url: `/api/v1/admin/products/${productId}`, headers, payload: { variants: [{ name: "V2", sku: sentSku, options: {} }] } });
      const after = await app.prisma.productVariant.findMany({ where: { productId } });
      const label = JSON.stringify([existing, sent]);

      if (planner === database) {
        assert.equal(response.statusCode, 200, `${label}: ${response.body}`);
        if (database) assert.deepEqual(after.map((variant) => variant.id), [variantId], `${label}: same SKU in the database's eyes keeps the variant ID`);
        else assert.ok(after.length === 1 && after[0].id !== variantId, `${label}: a different SKU replaces the old variant`);
        outcomes.push(`${label}: ${database ? "same variant" : "different variant"}`);
      } else {
        assert.equal(response.statusCode, 409, `${label}: planner=${planner} database=${database}: ${response.body}`);
        assert.equal(response.json().error.code, "AMBIGUOUS_SKU");
        assert.deepEqual(after.map((variant) => [variant.id, variant.sku, variant.name]), [[variantId, existingSku, "V"]], `${label}: nothing may change`);
        outcomes.push(`${label}: refused (planner ${planner}, database ${database})`);
      }
    }

    // Certain under utf8mb4_unicode_ci on every MySQL version: case and trailing spaces match; leading spaces don't.
    assert.match(outcomes[0], /same variant/);
    assert.match(outcomes[1], /same variant/);
    assert.match(outcomes[2], /different variant/);
    console.log(`SKU equivalence outcomes on this server (collation ${column.c}):\n  ${outcomes.join("\n  ")}`);
  } finally {
    if (made.productIds.length) await app.prisma.product.deleteMany({ where: { id: { in: made.productIds } } }).catch(() => undefined);
    if (made.categoryId) await app.prisma.category.delete({ where: { id: made.categoryId } }).catch(() => undefined);
    if (made.userId) await app.prisma.user.delete({ where: { id: made.userId } }).catch(() => undefined);
    await app.close();
  }
});
