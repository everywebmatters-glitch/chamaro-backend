// Money rules for orders. Pure functions: every amount is computed on the server from catalogue prices read from
// the database; nothing a client sends (prices, totals, discounts) is ever used. Amounts are handled in paise
// (integer hundredths of a rupee) so sums never accumulate floating-point error.

export type ShippingMethod = "standard" | "express";
export const SHIPPING_METHODS: ShippingMethod[] = ["standard", "express"];

// PLACEHOLDER business rules, mirrored from the storefront's cart constants (webapp/app/lib/cart.ts, marked
// "TODO: confirm with the business"). Change them here once the real shipping policy is decided.
export const SHIPPING_RULES: Record<ShippingMethod, { priceMinor: number; freeFromMinor: number | null }> = {
  standard: { priceMinor: 49_900, freeFromMinor: 1_000_000 },
  express: { priceMinor: 99_900, freeFromMinor: null },
};

export const MAX_LINE_QUANTITY = 99;

type Amount = string | number | { toString(): string };

export function toMinor(value: Amount): number {
  const minor = Math.round(Number(value.toString()) * 100);
  if (!Number.isFinite(minor) || minor < 0) throw new Error(`Invalid amount: ${value.toString()}`);
  return minor;
}

export function fromMinor(minor: number): string {
  const whole = Math.floor(minor / 100);
  return `${whole}.${String(minor - whole * 100).padStart(2, "0")}`;
}

// A variant with its own price overrides the product price; a variant with no price uses the product's.
export function unitPriceMinor(product: { price: Amount }, variant?: { price: Amount | null } | null): number {
  return toMinor(variant?.price != null ? variant.price : product.price);
}

// TEMPORARY (launch testing): FREE_SHIPPING_FOR_ALL=true on the API makes every shipping method free for every order.
// The storefront shows the same thing from its own FREE_SHIPPING_FOR_ALL constant (webapp/app/lib/cart.ts); change
// both together, or the price shown and the amount charged will differ. Unset (default) = the rules above.
export function freeShippingForAll(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FREE_SHIPPING_FOR_ALL === "true";
}

export function shippingMinor(method: ShippingMethod, subtotalMinor: number, freeForAll = freeShippingForAll()): number {
  if (freeForAll) return 0;
  const rule = SHIPPING_RULES[method];
  return rule.freeFromMinor !== null && subtotalMinor >= rule.freeFromMinor ? 0 : rule.priceMinor;
}

export interface OrderTotals {
  subtotalMinor: number;
  shippingMinor: number;
  totalMinor: number;
}

export function computeTotals(lines: { unitMinor: number; quantity: number }[], method: ShippingMethod): OrderTotals {
  const subtotalMinor = lines.reduce((sum, line) => sum + line.unitMinor * line.quantity, 0);
  const shipping = shippingMinor(method, subtotalMinor);
  return { subtotalMinor, shippingMinor: shipping, totalMinor: subtotalMinor + shipping };
}

export interface CartLineInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

// Lines for the same product and variant become one line (the cart table is unique on them, but NULL variants
// would not be enforced by the database); quantities add up and stop at MAX_LINE_QUANTITY.
export function mergeCartLines(lines: CartLineInput[]): { productId: string; variantId: string | null; quantity: number }[] {
  const merged = new Map<string, { productId: string; variantId: string | null; quantity: number }>();
  for (const line of lines) {
    const variantId = line.variantId ?? null;
    const key = `${line.productId}\u0000${variantId ?? ""}`;
    const current = merged.get(key);
    if (current) current.quantity = Math.min(MAX_LINE_QUANTITY, current.quantity + line.quantity);
    else merged.set(key, { productId: line.productId, variantId, quantity: Math.min(MAX_LINE_QUANTITY, line.quantity) });
  }
  return [...merged.values()];
}

// Total units wanted per product (several cart lines can be variants of one product), for stock checks.
export function unitsPerProduct(lines: { productId: string; quantity: number }[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.productId, (totals.get(line.productId) ?? 0) + line.quantity);
  return totals;
}
