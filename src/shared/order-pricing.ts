// Money rules for orders. Pure functions: every amount is computed on the server from catalogue prices read from
// the database; nothing a client sends (prices, totals, discounts) is ever used. Amounts are handled in paise
// (integer hundredths of a rupee) so sums never accumulate floating-point error.

export type ShippingMethod = "standard" | "express";
export const SHIPPING_METHODS: ShippingMethod[] = ["standard", "express"];

// Keep these rules aligned with the storefront's cart pricing.
export const SHIPPING_RULES: Record<ShippingMethod, { priceMinor: number }> = {
  standard: { priceMinor: 49_900 },
  express: { priceMinor: 99_900 },
};

export const MAX_LINE_QUANTITY = 99;

export const COUPONS = {
  WELCOME10: { label: "10% off Boss chairs", percentOff: 10, appliesTo: "boss-chair" },
  WELCOME5: { label: "5% off chairs", percentOff: 5, appliesTo: "chair" },
} as const;

export type CouponCode = keyof typeof COUPONS;

type Amount = string | number | { toString(): string };
type PricedLine = {
  unitMinor: number;
  quantity: number;
  productName?: string | null;
  categoryName?: string | null;
  categorySlug?: string | null;
};

export function normaliseCouponCode(code: string): CouponCode | undefined {
  const normalised = code.trim().toUpperCase();
  return Object.hasOwn(COUPONS, normalised) ? (normalised as CouponCode) : undefined;
}

function productTerms(line: Pick<PricedLine, "productName" | "categoryName" | "categorySlug">): string {
  return [line.productName, line.categoryName, line.categorySlug].filter(Boolean).join(" ").toLowerCase();
}

export function isChairLine(line: Pick<PricedLine, "productName" | "categoryName" | "categorySlug">): boolean {
  return /\bchairs?\b/.test(productTerms(line)) || /\bboss\b/.test(productTerms(line));
}

export function isBossChairLine(line: Pick<PricedLine, "productName" | "categoryName" | "categorySlug">): boolean {
  const terms = productTerms(line);
  return /\bboss\b/.test(terms) && isChairLine(line);
}

export function couponDiscountMinor(lines: PricedLine[], code: CouponCode): number {
  const coupon = COUPONS[code];
  const eligibleSubtotal = lines.reduce((sum, line) => {
    const eligible = coupon.appliesTo === "boss-chair" ? isBossChairLine(line) : isChairLine(line);
    return eligible ? sum + line.unitMinor * line.quantity : sum;
  }, 0);
  return Math.round((eligibleSubtotal * coupon.percentOff) / 100);
}

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

export function shippingMinor(method: ShippingMethod, chairCount: number): number {
  const rule = SHIPPING_RULES[method];
  return method === "standard" && chairCount > 1 ? 0 : rule.priceMinor;
}

export interface OrderTotals {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
}

export function computeTotals(lines: PricedLine[], method: ShippingMethod, couponCode?: CouponCode): OrderTotals {
  const subtotalMinor = lines.reduce((sum, line) => sum + line.unitMinor * line.quantity, 0);
  const discount = couponCode ? couponDiscountMinor(lines, couponCode) : 0;
  const chairCount = lines.reduce((sum, line) => sum + (isChairLine(line) ? line.quantity : 0), 0);
  const shipping = shippingMinor(method, chairCount);
  return {
    subtotalMinor,
    discountMinor: discount,
    shippingMinor: shipping,
    totalMinor: subtotalMinor - discount + shipping,
  };
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
