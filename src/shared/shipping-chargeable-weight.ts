export type ShippingMeasurement = {
  weightGrams: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
};

export type ShippingMeasurementLine = {
  quantity: number;
  product: ShippingMeasurement;
};

const VOLUMETRIC_DIVISOR_CM3_PER_KG = 5_000;

const positiveInteger = (value: number | null): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function shippingChargeableWeightGrams(lines: ShippingMeasurementLine[]): number | null {
  if (lines.length === 0) return null;

  let totalGrams = 0;
  for (const { quantity, product } of lines) {
    const { weightGrams, lengthCm, widthCm, heightCm } = product;
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      !positiveInteger(weightGrams) ||
      !positiveInteger(lengthCm) ||
      !positiveInteger(widthCm) ||
      !positiveInteger(heightCm)
    ) {
      return null;
    }

    const volumetricGrams = Math.ceil((lengthCm * widthCm * heightCm * 1_000) / VOLUMETRIC_DIVISOR_CM3_PER_KG);
    totalGrams += Math.max(weightGrams, volumetricGrams) * quantity;
    if (!Number.isSafeInteger(totalGrams)) return null;
  }

  return totalGrams;
}
