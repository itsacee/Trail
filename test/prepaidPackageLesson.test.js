// Prepaid private package lessons: zero balance, exclusive hour, no membership credits.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createBookingStore, closeBookingStore } from "../lib/bookingDb/createStore.js";
import { makeManualBooking } from "../lib/manualBookings.js";
import { isMembershipLesson } from "../lib/membershipTypes.js";
import { isExclusiveBooking, SLOT_CAPACITY } from "../lib/schedule.js";
import { membershipSummary, fromCashMember, MEMBER_CREDITS } from "../lib/members.js";
import { scheduledFor } from "../lib/lessons.js";

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
  if (handle) await closeBookingStore(handle);
});

beforeEach(async () => {
  await store.query("DELETE FROM bookings");
  await store.query("DELETE FROM membership_credits");
  await store.query("DELETE FROM slot_locks");
  await store.query("DELETE FROM idempotency_keys");
});

function chicagoIso(offsetDays = 2) {
  const ms = Date.now() + offsetDays * 86400 * 1000;
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

test("prepaid private lesson books exclusive hour with zero amounts", async () => {
  const date = chicagoIso(3);
  const booking = makeManualBooking({
    type: "private",
    player: "Preview Package Athlete",
    focus: "Hitting",
    privacy: "private",
    date,
    time: "5:00 PM",
    paymentMethod: "prepaid_external",
    paymentStatus: "prepaid_external",
    amountCents: 0,
    amountPaidCents: 0,
    amountDueCents: 0,
    createdBy: "coach",
  });
  assert.equal(booking.paymentMethod, "prepaid_external");
  assert.equal(booking.amountDueCents, 0);
  assert.equal(booking.amountCents, 0);
  assert.equal(isExclusiveBooking(booking), true);
  assert.equal(booking.seats, SLOT_CAPACITY);
  assert.equal(isMembershipLesson(booking), false);

  const saved = await store.manualBook({
    id: booking.id,
    date,
    time: "5:00 PM",
    focus: "Hitting",
    type: "private",
    privacy: "private",
    seats: SLOT_CAPACITY,
    athletes: 1,
    email: "preview.parent@example.com",
    player: booking.player,
    membershipId: null,
    payload: {
      paymentMethod: "prepaid_external",
      paymentStatus: "prepaid_external",
      amountCents: 0,
      amountPaidCents: 0,
      amountDueCents: 0,
      createdBy: "coach",
    },
  });
  assert.equal(saved.ok, true);

  // Second athlete cannot share the prepaid private hour.
  const clash = await store.manualBook({
    id: "mb_clash_prepaid",
    date,
    time: "5:00 PM",
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    seats: 1,
    athletes: 1,
    email: "other@example.com",
    player: "Other",
    payload: { paymentMethod: "cash", paymentStatus: "unpaid", amountDueCents: 8000 },
  });
  assert.equal(clash.ok, false);
});

test("prepaid private lessons do not spend or grant membership credits", () => {
  const email = "cash.member@example.com";
  const sub = fromCashMember({
    cashMembership: true,
    cashMembershipStart: Math.floor(Date.now() / 1000) - 86400,
    cashMembershipEnd: Math.floor(Date.now() / 1000) + 20 * 86400,
    membershipType: "membership_private",
    privacy: "private",
    player: "Member Kid",
    email,
  });
  assert.ok(sub);
  const prepaid = makeManualBooking({
    type: "private",
    player: "Member Kid",
    email,
    focus: "Fielding",
    privacy: "private",
    date: chicagoIso(4),
    time: "6:00 PM",
    paymentMethod: "prepaid_external",
    paymentStatus: "prepaid_external",
    amountCents: 0,
    amountPaidCents: 0,
    amountDueCents: 0,
  });
  const scheduled = scheduledFor(sub, { lessons: [], voids: [] }, { bookings: [prepaid] });
  const summary = membershipSummary(sub, scheduled);
  assert.equal(summary.used, 0);
  assert.equal(summary.remaining, MEMBER_CREDITS);
});
