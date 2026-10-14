// Collect-payment Postgres authority + idempotency (pg-mem).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createBookingStore, closeBookingStore } from "../lib/bookingDb/createStore.js";
import {
  bookingPostgresAuthoritative,
  bookingReadsEnabled,
  bookingWritesEnabled,
} from "../lib/bookingDb/flags.js";

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
  await store.query("DELETE FROM idempotency_keys");
});

test("bookingPostgresAuthoritative follows reads or writes", () => {
  assert.equal(bookingPostgresAuthoritative({ BOOKING_STORE: "blob" }), false);
  assert.equal(bookingPostgresAuthoritative({ BOOKING_STORE: "postgres" }), false);
  assert.equal(
    bookingPostgresAuthoritative({ BOOKING_STORE: "postgres", BOOKING_READS_ENABLED: "1" }),
    true
  );
  assert.equal(
    bookingPostgresAuthoritative({ BOOKING_STORE: "postgres", BOOKING_WRITES_ENABLED: "1" }),
    true
  );
  assert.equal(
    bookingWritesEnabled({ BOOKING_STORE: "postgres", BOOKING_WRITES_ENABLED: "1" }),
    true
  );
  assert.equal(
    bookingReadsEnabled({ BOOKING_STORE: "postgres", BOOKING_READS_ENABLED: "1" }),
    true
  );
});

test("collectManualPayment pays unpaid manual booking without changing slot occupancy", async () => {
  const booked = await store.manualBook({
    id: "mb_e8_pay",
    date: "2026-11-10",
    time: "6:00 PM",
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    seats: 1,
    email: "e8.pay@example.com",
    player: "E8 Pay",
    payload: {
      paymentMethod: "cash",
      paymentStatus: "unpaid",
      amountCents: 8000,
      amountPaidCents: 0,
      amountDueCents: 8000,
    },
  });
  assert.equal(booked.ok, true);

  const paid = await store.collectManualPayment({ id: "mb_e8_pay", amountCents: 8000 });
  assert.equal(paid.ok, true);
  assert.equal(paid.take, 8000);
  assert.equal(paid.idempotent, false);
  assert.equal(paid.booking.paymentStatus, "paid");
  assert.equal(paid.booking.amountDueCents, 0);

  const before = await store.query(
    `SELECT count(*)::int AS n FROM bookings WHERE slot_date='2026-11-10' AND time_label='6:00 PM' AND status='active'`
  );
  assert.equal(before.rows[0].n, 1);

  const again = await store.collectManualPayment({ id: "mb_e8_pay", amountCents: 8000 });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(again.take, 0);

  const after = await store.query(
    `SELECT count(*)::int AS n FROM bookings WHERE slot_date='2026-11-10' AND time_label='6:00 PM' AND status='active'`
  );
  assert.equal(after.rows[0].n, 1);

  const row = await store.getBooking("mb_e8_pay");
  assert.equal(row.payload.amountPaidCents, 8000);
  assert.equal(row.payload.amountDueCents, 0);
  assert.equal(row.source, "manual");
});

test("collectManualPayment does not create a second booking row", async () => {
  await store.manualBook({
    id: "mb_e8_once",
    date: "2026-11-11",
    time: "6:00 PM",
    focus: "Fielding",
    type: "single",
    privacy: "standard",
    seats: 1,
    email: "e8.once@example.com",
    player: "E8 Once",
    payload: {
      paymentMethod: "cash",
      paymentStatus: "unpaid",
      amountCents: 8000,
      amountPaidCents: 0,
      amountDueCents: 8000,
    },
  });
  await store.collectManualPayment({ id: "mb_e8_once", amountCents: 8000 });
  await store.collectManualPayment({ id: "mb_e8_once", amountCents: 8000 });
  const { rows } = await store.query(`SELECT id FROM bookings WHERE email='e8.once@example.com'`);
  assert.equal(rows.length, 1);
});
