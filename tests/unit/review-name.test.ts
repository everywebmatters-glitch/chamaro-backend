import test from "node:test";
import assert from "node:assert/strict";
import { displayName } from "../../src/routes/review.routes.js";

test("reviews show the first name and the last initial only", () => {
  assert.equal(displayName("Priya Sharma"), "Priya S.");
  assert.equal(displayName("  Anil  Kumar  Rao "), "Anil R.");
  assert.equal(displayName("Meera"), "Meera");
  assert.equal(displayName(""), "Customer");
  assert.equal(displayName("   "), "Customer");
});
