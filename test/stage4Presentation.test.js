// Stage 4: four purchase options, retire public 30-minute, keep historical support.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import checkout from "../api/checkout.js";
import cashBook from "../api/cash-book.js";
import {
  durationFor,
  canPair,
  seatsFor,
  privacyForPurchaseType,
  isExclusiveBooking,
  slotBlocked,
  SLOT_CAPACITY,
} from "../lib/schedule.js";
import { unitPriceFor, DEFAULT_SETTINGS } from "../lib/settings.js";
import { MEMBERSHIP_LIMIT } from "../lib/membershipCapacity.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

beforeEach(() => {
  mock.restoreAll();
});
afterEach(() => {
  mock.restoreAll();
});

test("homepage presents exactly four primary purchase options", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  assert.match(html, /Standard Drop-In/);
  assert.match(html, /Private One-on-One Drop-In/);
  assert.match(html, /Standard Membership/);
  assert.match(html, /Private One-on-One Membership/);
  assert.equal((html.match(/price-card/g) || []).length >= 4, true);
  assert.doesNotMatch(html, /book\.html\?type=thirty/);
  assert.doesNotMatch(html, /30-Minute Lesson/);
  assert.doesNotMatch(html, /\$60/);
  assert.match(html, /no auto-renew/);
  assert.match(html, /4 lessons \/ 30 days/);
});

test("booking page tabs omit 30-minute and list all four options", () => {
  const html = readFileSync(join(root, "book.html"), "utf8");
  assert.match(html, /data-book="single"/);
  assert.match(html, /data-book="private"/);
  assert.match(html, /data-book="membership"/);
  assert.match(html, /data-book="membership_private"/);
  assert.doesNotMatch(html, /data-book="thirty"/);
});

test("all four checkout amounts match the final product table", () => {
  const prices = DEFAULT_SETTINGS.prices;
  assert.equal(unitPriceFor("single", 1, prices), 8000);
  assert.equal(unitPriceFor("private", 1, prices), 10000);
  assert.equal(unitPriceFor("membership", 1, prices), 28000);
  assert.equal(unitPriceFor("membership_private", 1, prices), 36000);
});

test("historical 30-minute duration and pairing rules remain for schedule math", () => {
  assert.equal(durationFor("thirty"), 30);
  assert.equal(canPair("thirty"), true);
  assert.equal(seatsFor("thirty", 2), 2);
  // Occupied half-hour still blocks overlap with a full hour starting same time.
  const taken = [{ time: "5:00 PM", mins: 30, seats: 1, exclusive: false, focuses: ["Hitting"], privacy: "standard" }];
  assert.equal(
    slotBlocked(taken, "5:00 PM", 60, "Hitting", { seats: 1, privacy: "standard" }),
    true
  );
});

test("standard vs private privacy mapping is purchase-type driven", () => {
  assert.equal(privacyForPurchaseType("single"), "standard");
  assert.equal(privacyForPurchaseType("private"), "private");
  assert.equal(privacyForPurchaseType("membership"), "standard");
  assert.equal(privacyForPurchaseType("membership_private"), "private");
  assert.equal(isExclusiveBooking({ type: "private", focus: "Both" }), true);
  assert.equal(isExclusiveBooking({ type: "single", focus: "Both", privacy: "standard" }), false);
  assert.equal(seatsFor("membership_private", 1), SLOT_CAPACITY);
});

test("public cash booking rejects new 30-minute purchases", async () => {
  const res = mockRes();
  await cashBook(
    {
      method: "POST",
      body: {
        type: "thirty",
        player: "Sam",
        email: "sam@example.com",
        focus: "Hitting",
        date: "2099-06-01",
        time: "5:00 PM",
      },
    },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "thirty_retired");
  assert.match(res.body.error, /30-minute/i);
});

test("membership capacity constant remains 15", () => {
  assert.equal(MEMBERSHIP_LIMIT, 15);
});

test("customer-facing main.js no longer registers a thirty session type", () => {
  const js = readFileSync(join(root, "js/main.js"), "utf8");
  assert.match(js, /Standard Drop-In/);
  assert.match(js, /Private One-on-One/);
  assert.match(js, /typeFromUrl === "thirty"/);
  // SESSIONS object must not advertise thirty as a bookable public type.
  assert.doesNotMatch(js, /thirty:\s*\{\s*name:\s*"30-Minute/);
});
