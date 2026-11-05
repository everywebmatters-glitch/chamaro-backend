import { fromMinor, toMinor } from "./order-pricing.js";

const STATE_CODES: Record<string, string> = {
  "andaman and nicobar islands": "35",
  "andhra pradesh": "37",
  "arunachal pradesh": "12",
  assam: "18",
  bihar: "10",
  chandigarh: "04",
  chhattisgarh: "22",
  "dadra and nagar haveli and daman and diu": "26",
  delhi: "07",
  goa: "30",
  gujarat: "24",
  haryana: "06",
  "himachal pradesh": "02",
  "jammu and kashmir": "01",
  jharkhand: "20",
  karnataka: "29",
  kerala: "32",
  ladakh: "38",
  lakshadweep: "31",
  "madhya pradesh": "23",
  maharashtra: "27",
  manipur: "14",
  meghalaya: "17",
  mizoram: "15",
  nagaland: "13",
  odisha: "21",
  puducherry: "34",
  punjab: "03",
  rajasthan: "08",
  sikkim: "11",
  "tamil nadu": "33",
  telangana: "36",
  tripura: "16",
  "uttar pradesh": "09",
  uttarakhand: "05",
  "west bengal": "19",
};

export type GstInvoiceSummary = {
  taxableValue: string;
  gstTotal: string;
  split:
    | { type: "intra"; centralTax: string; stateTax: string }
    | { type: "inter"; integratedTax: string }
    | null;
  sellerGstin: string | null;
};

export function gstInvoiceSummary(
  input: {
    subtotal: string;
    discountTotal: string;
    shippingAddress: { country?: string; state?: string } | null;
  },
  sellerGstin: string | null,
  sellerStateCode: string | null = null,
): GstInvoiceSummary {
  const productGrossMinor = toMinor(input.subtotal) - toMinor(input.discountTotal);
  if (productGrossMinor < 0) throw new Error("Order discount exceeds product subtotal");

  const taxableMinor = Math.round((productGrossMinor * 100) / 118);
  const gstMinor = productGrossMinor - taxableMinor;
  const cleanedGstin = sellerGstin && /^[0-9A-Z]{15}$/.test(sellerGstin) ? sellerGstin : null;
  const knownStateCodes = new Set(Object.values(STATE_CODES));
  const gstinStateCode = cleanedGstin?.slice(0, 2);
  const configuredStateCode = sellerStateCode && knownStateCodes.has(sellerStateCode) ? sellerStateCode : null;
  const sellerState = gstinStateCode && knownStateCodes.has(gstinStateCode) ? gstinStateCode : configuredStateCode;
  const address = input.shippingAddress;
  const destinationState = address?.country && address.country.trim().toUpperCase() !== "IN"
    ? undefined
    : address?.state?.trim().toLowerCase();
  const destinationCode = destinationState ? STATE_CODES[destinationState] : undefined;

  let split: GstInvoiceSummary["split"] = null;
  if (sellerState && destinationCode) {
    if (sellerState === destinationCode) {
      const centralMinor = Math.ceil(gstMinor / 2);
      split = { type: "intra", centralTax: fromMinor(centralMinor), stateTax: fromMinor(gstMinor - centralMinor) };
    } else {
      split = { type: "inter", integratedTax: fromMinor(gstMinor) };
    }
  }

  return {
    taxableValue: fromMinor(taxableMinor),
    gstTotal: fromMinor(gstMinor),
    split,
    sellerGstin: cleanedGstin,
  };
}
