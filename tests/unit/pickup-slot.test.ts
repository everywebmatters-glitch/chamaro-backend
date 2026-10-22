import test from "node:test";
import assert from "node:assert/strict";
import { pickupSlot } from "../../src/shared/pickup-slot.js";
import { autoPickupEnabled, readPickupTime } from "../../src/config/delhivery.js";

// 2026-10-23 08:00 IST = 02:30 UTC
const at = (hh: number, mm: number) => Date.UTC(2026, 9, 23, hh, mm) - 5.5 * 3600_000;

test("pickup today when the time is at least 30 minutes away (Indian time), otherwise tomorrow", () => {
  assert.deepEqual(pickupSlot(at(8, 0), "16:00:00"), { date: "2026-10-23", time: "16:00:00" });
  assert.equal(pickupSlot(at(15, 30), "16:00:00").date, "2026-10-23", "exactly 30 minutes ahead is still today");
  assert.equal(pickupSlot(at(15, 31), "16:00:00").date, "2026-10-24");
  assert.equal(pickupSlot(at(23, 50), "10:00:00").date, "2026-10-24");
  assert.equal(pickupSlot(at(0, 5), "10:00:00").date, "2026-10-23");
});

test("the Indian date is used, not the UTC one", () => {
  // 2026-10-22 20:00 UTC is already 23 Oct 01:30 in India.
  assert.equal(pickupSlot(Date.UTC(2026, 9, 22, 20, 0), "16:00:00").date, "2026-10-23");
  assert.throws(() => pickupSlot(Date.now(), "4pm"));
});

test("automatic pickup is off by default and its time is never defaulted", () => {
  assert.equal(autoPickupEnabled({ DELHIVERY_ENABLED: "true" } as NodeJS.ProcessEnv), false);
  assert.equal(autoPickupEnabled({ DELHIVERY_ENABLED: "true", DELHIVERY_AUTO_PICKUP: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(autoPickupEnabled({ DELHIVERY_AUTO_PICKUP: "true" } as NodeJS.ProcessEnv), false, "needs shipping enabled");
  assert.throws(() => readPickupTime({} as NodeJS.ProcessEnv), /DELHIVERY_PICKUP_TIME is not set/);
  assert.throws(() => readPickupTime({ DELHIVERY_PICKUP_TIME: "25:00" } as NodeJS.ProcessEnv), /HH:MM/);
  assert.equal(readPickupTime({ DELHIVERY_PICKUP_TIME: "16:30" } as NodeJS.ProcessEnv), "16:30:00");
});
