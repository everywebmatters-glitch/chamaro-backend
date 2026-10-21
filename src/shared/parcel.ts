// The parcel a courier is booked with, from the products' own packed-unit weight and size. Pure, unit-tested.
//
// Only an order of exactly one unit is booked automatically: its parcel is that product's packed unit. Several units
// (or lines) mean several boxes or a repack, which only a person can measure, and a product without all four values
// can't be booked either: such orders are flagged for an admin, never booked with invented numbers.

export type Parcel = { weightGrams: number; lengthCm: number; widthCm: number; heightCm: number };
export type ParcelLine = { quantity: number; product: { weightGrams: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null } };
export type ParcelProblem = "PARCEL_DETAILS_MISSING" | "MULTI_PARCEL_ORDER";

const positive = (value: number | null): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

export function parcelFor(lines: ParcelLine[]): { parcel: Parcel } | { problem: ParcelProblem } {
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (units !== 1) return { problem: "MULTI_PARCEL_ORDER" };
  const { weightGrams, lengthCm, widthCm, heightCm } = lines.find((line) => line.quantity === 1)!.product;
  if (!positive(weightGrams) || !positive(lengthCm) || !positive(widthCm) || !positive(heightCm)) return { problem: "PARCEL_DETAILS_MISSING" };
  return { parcel: { weightGrams, lengthCm, widthCm, heightCm } };
}

export const PARCEL_PROBLEM_TEXT: Record<ParcelProblem, string> = {
  PARCEL_DETAILS_MISSING: "The product has no packed weight and size; enter the parcel to book the courier",
  MULTI_PARCEL_ORDER: "More than one unit: pack the order and enter the parcel to book the courier",
};
