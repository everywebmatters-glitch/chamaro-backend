// When the next automatic Delhivery pickup is asked for. Pure, unit-tested.
//
// The pickup time of day is the operator's setting (DELHIVERY_PICKUP_TIME, Indian local time). If that time is still at
// least LEAD_MINUTES away today the pickup is requested for today, otherwise for tomorrow.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const PICKUP_LEAD_MINUTES = 30;

export function pickupSlot(nowMs: number, pickupTime: string): { date: string; time: string } {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/.exec(pickupTime);
  if (!match) throw new Error("pickupTime must be HH:MM:SS");
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const nowMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const pickupMinutes = Number(match[1]) * 60 + Number(match[2]);
  const day = nowMinutes + PICKUP_LEAD_MINUTES <= pickupMinutes ? ist : new Date(ist.getTime() + 24 * 60 * 60 * 1000);
  return { date: day.toISOString().slice(0, 10), time: pickupTime };
}
