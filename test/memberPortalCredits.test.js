// Member portal credit display after PG book / cancel — attribution + ledger sync.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createBookingStore, closeBookingStore } from "../lib/bookingDb/createStore.js";
import { manualFromDbRow, lessonFromDbRow } from "../lib/bookingDb/readSnapshots.js";
import { scheduledFor } from "../lib/lessons.js";
import { membershipSummary, MEMBER_CREDITS } from "../lib/members.js";

let handle;
let store;

before(async () => {
  handle = await createBookingStore({
    mode: "memory",
    useMem: true,
    env: { BOOKING_ALLOW_NON_PREVIEW: "1", VERCEL_ENV: "preview" },
  });
  store = handle.store;
});

after(async () => {
  await closeBookingStore(handle);
});

beforeEach(async () => {
  await store.query("DELETE FROM bookings");
  await store.query("DELETE FROM membership_credits");
  await store.query("DELETE FROM slot_locks");
});

function cashSub(email) {
  const start = Math.floor(Date.now() / 1000) - 3600;
  return {
    id: `cash_${email}`,
    kind: "cash",
    email,
    current_period_start: start,
    current_period_end: start + 30 * 86400,
    metadata: {
      type: "membership",
      privacy: "standard",
      email,
      player: "Portal Kid",
    },
  };
}

test("manualFromDbRow preserves membership_id for credit attribution", () => {
  const row = {
    id: "mb_cash_1",
    source: "manual",
    membership_id: "cash_kid@example.com",
    slot_date: "2026-10-20",
    time_label: "6:00 PM",
    booking_type: "membership",
    privacy: "standard",
    focus: "Hitting",
    seats: 1,
    athletes: 1,
    email: "kid@example.com",
    player: "Kid",
    status: "active",
    payload: { paymentStatus: "unpaid", amountDueCents: 28000 },
  };
  const manual = manualFromDbRow(row);
  assert.equal(manual.membershipId, "cash_kid@example.com");
  assert.equal(manual.subId, "cash_kid@example.com");
  assert.equal(manual.type, "membership");
});

test("scheduledFor counts cash manual + portal member lessons immediately", async () => {
  const email = "portal.credits@example.com";
  const membershipId = `cash_${email}`;
  const sub = cashSub(email);

  await store.manualBook({
    id: "mb_first",
    date: "2026-10-20",
    time: "6:00 PM",
    focus: "Hitting",
    type: "membership",
    privacy: "standard",
    seats: 1,
    email,
    player: "Portal Kid",
    membershipId,
    payload: { paymentMethod: "cash", paymentStatus: "unpaid", amountDueCents: 28000 },
  });

  const second = await store.memberBook({
    membershipId,
    email,
    date: "2026-10-21",
    time: "6:00 PM",
    focus: "Hitting",
    type: "membership",
    privacy: "standard",
    player: "Portal Kid",
    creditsTotal: 4,
  });
  assert.equal(second.ok, true);
  assert.equal(second.creditsUsed, 2);

  const { rows } = await store.query(
    `SELECT * FROM bookings WHERE lower(email)=$1 AND status='active' ORDER BY slot_date`,
    [email]
  );
  assert.equal(rows.length, 2);

  const manuals = { bookings: rows.filter((r) => r.source === "manual").map(manualFromDbRow) };
  const lessons = {
    lessons: rows.filter((r) => r.source === "member").map(lessonFromDbRow),
    voids: [],
  };

  const scheduled = scheduledFor(sub, lessons, manuals, [sub]);
  assert.equal(scheduled.length, 2, `expected 2 lessons, got ${scheduled.map((l) => l.id)}`);

  const summary = membershipSummary(sub, scheduled);
  assert.equal(summary.used, 2);
  assert.equal(summary.remaining, MEMBER_CREDITS - 2);
  assert.equal(summary.lessons.length, 2);
});

test("cancel restores membership_credits for member-source lesson", async () => {
  const email = "portal.cancel@example.com";
  const membershipId = `cash_${email}`;

  await store.manualBook({
    id: "mb_keep",
    date: "2026-10-20",
    time: "7:00 PM",
    focus: "Fielding",
    type: "membership",
    privacy: "standard",
    seats: 1,
    email,
    player: "Cancel Kid",
    membershipId,
  });
  const booked = await store.memberBook({
    membershipId,
    email,
    date: "2026-10-21",
    time: "7:00 PM",
    focus: "Fielding",
    type: "membership",
    privacy: "standard",
    player: "Cancel Kid",
  });
  assert.equal(booked.creditsUsed, 2);

  const cancelled = await store.cancelBooking(booked.bookingId, { restoreCredit: true });
  assert.equal(cancelled.ok, true);

  const credit = await store.getMembershipCredits(membershipId);
  assert.equal(Number(credit.credits_used), 1);
});
