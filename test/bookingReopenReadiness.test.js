// Isolated readiness checks for safely reopening production bookings.
// No production Blob/Stripe access. Does not enable CAPACITY_WRITES in Vercel.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  capacityWritesEnabled,
  blobCompareAndSet,
  blobAccessFor,
} from "../lib/store.js";
import { placeHold } from "../lib/holds.js";
import { unitPriceFor, DEFAULT_SETTINGS } from "../lib/settings.js";
import {
  SLOT_CAPACITY,
  seatsFor,
  slotBlocked,
  isExclusiveBooking,
  privacyForPurchaseType,
} from "../lib/schedule.js";
import { membershipSummary } from "../lib/members.js";
import { scheduledFor, upsertStripeLessons, loadLessons } from "../lib/lessons.js";

before(() => useMemoryBlobStore(true));
after(() => useMemoryBlobStore(false));
beforeEach(() => {
  clearMemoryBlobStore();
  process.env.CAPACITY_WRITES_ENABLED = "1";
});

test("product prices: $80 / $100 / $280 / $360", () => {
  const p = DEFAULT_SETTINGS.prices;
  assert.equal(unitPriceFor("single", 1, p), 8000);
  assert.equal(unitPriceFor("private", 1, p), 10000);
  assert.equal(unitPriceFor("membership", 1, p), 28000);
  assert.equal(unitPriceFor("membership_private", 1, p), 36000);
});

test("standard shared capacity is 2; private owns the hour", () => {
  assert.equal(SLOT_CAPACITY, 2);
  assert.equal(seatsFor("single", 1), 1);
  assert.equal(seatsFor("private", 1), SLOT_CAPACITY);
  assert.equal(isExclusiveBooking({ type: "private", privacy: "private" }), true);
  assert.equal(privacyForPurchaseType("membership_private"), "private");

  const oneStd = [{ time: "5:00 PM", mins: 60, seats: 1, focuses: ["Fielding"], privacy: "standard" }];
  assert.equal(
    slotBlocked(oneStd, "5:00 PM", 60, "Fielding", { seats: 1, exclusive: false, privacy: "standard" }),
    false
  );
  assert.equal(
    slotBlocked(oneStd, "5:00 PM", 60, "Hitting", { seats: 1, exclusive: false, privacy: "standard" }),
    true
  );
  assert.equal(
    slotBlocked(oneStd, "5:00 PM", 60, "Fielding", {
      seats: SLOT_CAPACITY,
      exclusive: true,
      privacy: "private",
    }),
    true
  );
});

test("membership credits stay purchase-scoped with 4 total", () => {
  const now = Math.floor(Date.now() / 1000);
  const sub = {
    id: "pi_reopen_std",
    kind: "payment",
    email: "reopen@example.com",
    current_period_start: now - 2 * 86400,
    current_period_end: now + 28 * 86400,
    metadata: { type: "membership", email: "reopen@example.com", player: "Reopen", privacy: "standard" },
  };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const stored = {
    lessons: [
      {
        id: "lsn_1",
        subId: sub.id,
        email: "reopen@example.com",
        type: "membership",
        date: today,
        time: "5:00 PM",
        source: "member",
      },
    ],
    voids: [],
  };
  const summary = membershipSummary(sub, scheduledFor(sub, stored));
  assert.equal(summary.credits, 4);
  assert.equal(summary.used, 1);
  assert.equal(summary.remaining, 3);
  assert.equal(summary.membershipId, sub.id);
});

test("Stripe mirror upsert is idempotent (no duplicate lesson ids)", async () => {
  assert.equal((await blobCompareAndSet("lessons.json", { lessons: [], voids: [] }, "")).ok, true);
  const stored = await loadLessons();
  const meta = {
    type: "single",
    email: "pay@example.com",
    player: "Pay",
    focus: "Hitting",
    privacy: "standard",
    date1: "2026-11-01",
    time1: "6:00 PM",
  };
  assert.equal(upsertStripeLessons(stored, "pi_pay_1", meta), true);
  assert.equal(upsertStripeLessons(stored, "pi_pay_1", meta), true);
  assert.equal(stored.lessons.filter((l) => l.id === "pi_pay_1-1").length, 1);
  assert.equal((await blobCompareAndSet("lessons.json", stored, stored._etag)).ok, true);
});

test("capacity writes pause blocks holds without inventing empty schedules", async () => {
  process.env.CAPACITY_WRITES_ENABLED = "0";
  assert.equal(capacityWritesEnabled(), false);
  assert.equal(
    await placeHold("cs_reopen", [{ date: "2026-11-02", time: "5:00 PM" }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    false
  );
  const cas = await blobCompareAndSet("holds.json", { holds: [] }, "");
  assert.equal(cas.paused, true);
});

test("hotfix keeps capacity files on the public store (PR #63 not required for read recovery)", () => {
  assert.equal(blobAccessFor("holds.json"), "public");
  assert.equal(blobAccessFor("lessons.json"), "public");
  assert.equal(blobAccessFor("manual-bookings.json"), "public");
});

test("PR #65 confirm/webhook sources fail closed on mirror failure when present", async () => {
  const confirm = await readFile(new URL("../api/confirm.js", import.meta.url), "utf8");
  const webhook = await readFile(new URL("../api/webhook.js", import.meta.url), "utf8");
  if (!confirm.includes("bookingMirrorFailed")) {
    // Production main without PR #65 still has the silent-continue mirror path.
    assert.match(confirm, /Could not save paid booking mirror/);
    assert.equal(webhook.includes("bookingMirrorFailed"), false);
    return;
  }
  assert.match(confirm, /bookingMirrorFailed/);
  assert.match(confirm, /status:\s*503/);
  assert.match(webhook, /bookingMirrorFailed/);
  assert.match(webhook, /res\.status\(503\)/);
});
