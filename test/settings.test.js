// What one athlete on a booking costs. The private price is a premium for
// keeping the hour to yourself; a pair already fills the hour, so two athletes
// on a private hour pay the regular per-athlete rate.
import { test } from "node:test";
import assert from "node:assert/strict";

import { unitPriceFor, DEFAULT_SETTINGS } from "../lib/settings.js";

const PRICES = { single: 8000, thirty: 6000, membership: 28000, private: 10000 };

test("a lone athlete pays the price for their lesson type", () => {
  assert.equal(unitPriceFor("single", 1, PRICES), 8000);
  assert.equal(unitPriceFor("thirty", 1, PRICES), 6000);
  assert.equal(unitPriceFor("membership", 1, PRICES), 28000);
  assert.equal(unitPriceFor("private", 1, PRICES), 10000);
});

test("two athletes on a private hour pay the regular rate, not the premium", () => {
  assert.equal(unitPriceFor("private", 2, PRICES), 8000);
  // $80 each, so the hour brings in the same $160 as a shared hour.
  assert.equal(unitPriceFor("private", 2, PRICES) * 2, 16000);
});

test("a second athlete never changes the price of the other types", () => {
  assert.equal(unitPriceFor("single", 2, PRICES), 8000);
  assert.equal(unitPriceFor("thirty", 2, PRICES), 6000);
});

test("the private pair rate follows whatever the coach sets the regular price to", () => {
  const raised = { ...PRICES, single: 9000, private: 12000 };
  assert.equal(unitPriceFor("private", 1, raised), 12000);
  assert.equal(unitPriceFor("private", 2, raised), 9000);
});

test("missing or partial price tables fall back to the defaults", () => {
  assert.equal(unitPriceFor("single", 1, undefined), DEFAULT_SETTINGS.prices.single);
  assert.equal(unitPriceFor("private", 1, {}), DEFAULT_SETTINGS.prices.private);
  // Only the private price is saved, so the pair rate comes from the default.
  assert.equal(unitPriceFor("private", 2, { private: 11000 }), DEFAULT_SETTINGS.prices.single);
  assert.equal(unitPriceFor("nonsense", 1, PRICES), 0);
});
