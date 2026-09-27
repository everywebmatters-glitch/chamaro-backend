// Product rules shared by the routes and their tests.

// Public (storefront) product responses only include variants that are on sale.
export const PUBLIC_VARIANT_FILTER = { where: { status: "ACTIVE" as const } };

// compareAtPrice (the struck-through "was" price) may never be below the selling price.
// On a partial update, a field that isn't sent keeps its stored value, so the rule is checked
// against the values the product will have after the update.
export function compareAtPriceViolation(price: number, compareAtPrice: number | null | undefined): boolean {
  return compareAtPrice !== null && compareAtPrice !== undefined && compareAtPrice < price;
}
