// Customer data protection: existing lessons/memberships must not be mutated
// while capacity writes are paused, and credits must stay attribution-stable.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  blobCompareAndSet,
  capacityWritesEnabled,
  blobRead,
} from "../lib/store.js";
import {
  loadLessons,
  mutateLessons,
  upsertStripeLessons,
  scheduledFor,
  isActiveLesson,
} from "../lib/lessons.js";
import { loadManualBookings, mutateManualBookings, activeBookings } from "../lib/manualBookings.js";
import { placeHold } from "../lib/holds.js";
import { membershipSummary, todayChicago } from "../lib/members.js";
import { fetchBookings } from "../lib/bookings.js";
import { mock } from "node:test";

const NOW = Math.floor(Date.now() / 1000);
const PERIOD_START = NOW - 3 * 86400;
const PERIOD_END = NOW + 27 * 86400;

function chicagoPlusDays(days) {
  const base = new Date(`${todayChicago()}T12:00:00`);
  base.setDate(base.getDate() + days);
  return base.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

before(() => {
  useMemoryBlobStore(true);
});

after(() => {
  useMemoryBlobStore(false);
});

beforeEach(() => {
  clearMemoryBlobStore();
  process.env.CAPACITY_WRITES_ENABLED = "1";
});

async function seedExistingCustomerData() {
  const upcoming = chicagoPlusDays(2);
  const completed = chicagoPlusDays(-1);
  const cancelled = chicagoPlusDays(3);
  const voidDate = chicagoPlusDays(4);
  const cashDate = chicagoPlusDays(5);
  const lessonsPayload = {
    lessons: [
      {
        id: "lsn_existing_1",
        subId: "pi_mem_std",
        sourceId: "pi_mem_std",
        email: "keep@example.com",
        player: "Protected Player",
        type: "membership",
        focus: "Hitting",
        privacy: "standard",
        date: upcoming,
        time: "5:00 PM",
        source: "member",
        status: "scheduled",
      },
      {
        id: "lsn_done_1",
        subId: "pi_mem_std",
        sourceId: "pi_mem_std",
        email: "keep@example.com",
        player: "Protected Player",
        type: "membership",
        focus: "Fielding",
        privacy: "standard",
        date: completed,
        time: "6:00 PM",
        source: "member",
        status: "scheduled",
      },
      {
        id: "lsn_cancelled_1",
        subId: "pi_mem_std",
        email: "keep@example.com",
        type: "membership",
        focus: "Both",
        date: cancelled,
        time: "7:00 PM",
        source: "member",
        status: "cancelled",
        cancelledAt: Date.now() - 86400 * 1000,
      },
    ],
    voids: [
      {
        sourceId: "pi_voided",
        email: "keep@example.com",
        date: voidDate,
        time: "5:00 PM",
      },
    ],
  };
  const manualPayload = {
    bookings: [
      {
        id: "mb_existing_1",
        email: "cash@example.com",
        player: "Cash Player",
        type: "single",
        focus: "Fielding",
        privacy: "standard",
        date: cashDate,
        time: "6:00 PM",
        status: "scheduled",
        paymentMethod: "cash",
        amountCents: 8000,
      },
    ],
  };
  assert.equal((await blobCompareAndSet("lessons.json", lessonsPayload, "")).ok, true);
  assert.equal((await blobCompareAndSet("manual-bookings.json", manualPayload, "")).ok, true);
  assert.equal((await blobCompareAndSet("holds.json", { holds: [] }, "")).ok, true);
  return { lessonsPayload, manualPayload };
}

test("paused capacity writes block holds, lesson mutations, and manual mutations", async () => {
  await seedExistingCustomerData();
  const beforeLessons = await blobRead("lessons.json");
  const beforeManual = await blobRead("manual-bookings.json");
  const beforeHolds = await blobRead("holds.json");

  process.env.CAPACITY_WRITES_ENABLED = "0";
  assert.equal(capacityWritesEnabled(), false);

  assert.equal(
    await placeHold("cs_new", [{ date: "2026-11-22", time: "5:00 PM" }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    false
  );

  const cancelAttempt = await mutateLessons((stored) => {
    const row = stored.lessons.find((l) => l.id === "lsn_existing_1");
    row.status = "cancelled";
    row.cancelledAt = Date.now();
    return { ok: true };
  });
  assert.equal(cancelAttempt.ok, false);
  assert.equal(cancelAttempt.paused, true);

  const moveAttempt = await mutateLessons((stored) => {
    const row = stored.lessons.find((l) => l.id === "lsn_existing_1");
    row.date = "2026-12-01";
    row.time = "8:00 PM";
    return { ok: true };
  });
  assert.equal(moveAttempt.ok, false);

  const manualCancel = await mutateManualBookings((store) => {
    store.bookings[0].status = "cancelled";
    return { ok: true };
  });
  assert.equal(manualCancel.ok, false);
  assert.equal(manualCancel.paused, true);

  const mirror = await mutateLessons((stored) => {
    upsertStripeLessons(stored, "pi_new_paid", {
      type: "single",
      email: "new@example.com",
      player: "New",
      date1: "2026-11-25",
      time1: "5:00 PM",
      focus: "Hitting",
    });
    return { ok: true };
  });
  assert.equal(mirror.ok, false);
  assert.equal(mirror.paused, true);

  assert.equal(await blobRead("lessons.json"), beforeLessons);
  assert.equal(await blobRead("manual-bookings.json"), beforeManual);
  assert.equal(await blobRead("holds.json"), beforeHolds);
});

test("existing membership credits stay attributed and do not reset while paused", async () => {
  await seedExistingCustomerData();
  const stored = await loadLessons();
  const membership = {
    id: "pi_mem_std",
    kind: "payment",
    email: "keep@example.com",
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    metadata: {
      type: "membership",
      email: "keep@example.com",
      player: "Protected Player",
      privacy: "standard",
    },
  };

  const scheduled = scheduledFor(membership, stored);
  const before = membershipSummary(membership, scheduled);
  assert.equal(before.credits, 4);
  assert.equal(before.used >= 1, true);
  assert.equal(before.remaining, before.credits - before.used);
  const beforeRemaining = before.remaining;
  const beforeLastDay = before.lastDay;
  const beforePeriodEnd = before.periodEnd;

  process.env.CAPACITY_WRITES_ENABLED = "0";
  // Re-read after pause — no writes possible, credits must match.
  const storedAgain = await loadLessons();
  const scheduledAgain = scheduledFor(membership, storedAgain);
  const after = membershipSummary(membership, scheduledAgain);
  assert.equal(after.remaining, beforeRemaining);
  assert.equal(after.used, before.used);
  assert.equal(after.lastDay, beforeLastDay);
  assert.equal(after.periodEnd, beforePeriodEnd);
  assert.equal(after.membershipTier, "standard");

  // Cancelled lesson must not spend a credit.
  assert.equal(
    scheduledAgain.some((l) => l.id === "lsn_cancelled_1"),
    false
  );
});

test("separate memberships do not combine credits", async () => {
  await seedExistingCustomerData();
  const stored = await loadLessons();
  const std = {
    id: "pi_mem_std",
    kind: "payment",
    email: "keep@example.com",
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    metadata: {
      type: "membership",
      email: "keep@example.com",
      player: "Protected Player",
      privacy: "standard",
    },
  };
  const priv = {
    id: "pi_mem_priv",
    kind: "payment",
    email: "keep@example.com",
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    metadata: {
      type: "membership_private",
      email: "keep@example.com",
      player: "Protected Player",
      privacy: "private",
    },
  };
  const siblings = [std, priv];
  const stdSummary = membershipSummary(std, scheduledFor(std, stored, null, siblings), { siblings });
  const privSummary = membershipSummary(priv, scheduledFor(priv, stored, null, siblings), {
    siblings,
  });
  assert.equal(stdSummary.credits, 4);
  assert.equal(privSummary.credits, 4);
  assert.equal(stdSummary.remaining + privSummary.remaining <= 8, true);
  assert.equal(stdSummary.membershipId, "pi_mem_std");
  assert.equal(privSummary.membershipId, "pi_mem_priv");
});

test("recovery read shows existing lessons/manuals without inventing duplicates", async () => {
  await seedExistingCustomerData();
  mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("api.stripe.com")) {
      return { ok: true, json: async () => ({ data: [], has_more: false }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    const rows = await fetchBookings("sk_test");
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ["lsn_done_1", "lsn_existing_1", "mb_existing_1"]);
    assert.equal(rows.filter((r) => r.id === "lsn_existing_1").length, 1);
    assert.equal(
      rows.some((r) => r.id === "lsn_cancelled_1"),
      false
    );

    const lessons = await loadLessons();
    assert.equal(lessons.lessons.filter((l) => l.id === "lsn_existing_1").length, 1);
    assert.equal(isActiveLesson(lessons.lessons.find((l) => l.id === "lsn_cancelled_1")), false);
    assert.equal(activeBookings(await loadManualBookings()).length, 1);
  } finally {
    mock.restoreAll();
  }
});
