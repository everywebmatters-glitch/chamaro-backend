// Money rules for orders. Pure functions: amounts are computed from catalogue prices read from the database;
// client-supplied prices, totals and discount amounts are never used. Amounts are handled in paise (integer
// hundredths of a rupee) so sums never accumulate floating-point error.

export type ShippingMethod = "standard" | "express";
export const SHIPPING_METHODS: ShippingMethod[] = ["standard", "express"];

export const SHIPPING_RULES: Record<ShippingMethod, { priceMinor: number }> = {
  standard: { priceMinor: 49_900 },
  express: { priceMinor: 99_900 },
};

export const MAX_LINE_QUANTITY = 99;
export const COUPONS = {
  WELCOME10: { percentOff: 10, eligible: "boss-chair" },
  WELCOME5: { percentOff: 5, eligible: "chair" },
} as const;

export type CouponCode = keyof typeof COUPONS;

export type CouponLine = {
  name: string;
  category: { slug: string; name: string };
  unitMinor: number;
  quantity: number;
};

export function couponCode(value: string | undefined): CouponCode | null {
  const normalized = value?.trim().toUpperCase();
  return normalized && Object.hasOwn(COUPONS, normalized) ? normalized as CouponCode : null;
}

function isChair(line: Pick<CouponLine, "name" | "category">): boolean {
  return /\bchairs?\b/i.test(`${line.name} ${line.category.slug} ${line.category.name}`);
}

export function eligibleCouponMinor(code: CouponCode, lines: CouponLine[]): number {
  const { percentOff, eligible } = COUPONS[code];
  const eligibleMinor = lines.reduce((sum, line) => {
    const matches = eligible === "chair"
      ? isChair(line)
      : isChair(line) && /\bboss\b/i.test(`${line.name} ${line.category.slug} ${line.category.name}`);
    return matches ? sum + line.unitMinor * line.quantity : sum;
  }, 0);
  return Math.round(eligibleMinor * percentOff / 100);
}

export function chairCount(lines: { name: string; category: { slug: string; name: string }; quantity: number }[]): number {
  return lines.reduce((count, line) => count + (isChair(line) ? line.quantity : 0), 0);
}

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

export function shippingMinor(method: ShippingMethod, chairs: number): number {
  const rule = SHIPPING_RULES[method];
  return method === "standard" && chairs >= 2 ? 0 : rule.priceMinor;
}

export interface OrderTotals {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
}

export function computeTotals(
  lines: { unitMinor: number; quantity: number }[],
  method: ShippingMethod,
  chairs: number,
  discountMinor = 0,
): OrderTotals {
  const subtotalMinor = lines.reduce((sum, line) => sum + line.unitMinor * line.quantity, 0);
  const shipping = shippingMinor(method, chairs);
  return { subtotalMinor, discountMinor, shippingMinor: shipping, totalMinor: subtotalMinor - discountMinor + shipping };
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
