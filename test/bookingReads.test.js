// Preview Postgres read-path: occupancy and Coach Desk must not silently
// fall back to Blob when BOOKING_READS_ENABLED=1.
import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { bookedTimes } from "../api/slots.js";
import { fetchBookings } from "../lib/bookings.js";
import { getBookingStore, resetBookingStoreCache } from "../lib/bookingStore.js";
import { StorageUnavailableError } from "../lib/store.js";
import { importBlobSnapshots } from "../lib/bookingDb/importFromBlob.js";

const SNAPSHOTS = {
  lessons: {
    lessons: [
      {
        id: "pi_read_hit",
        source: "stripe",
        sourceId: "pi_read_hit",
        date: "2026-11-15",
        time: "6:00 PM",
        focus: "Hitting",
        type: "single",
        privacy: "standard",
        email: "a@example.com",
        player: "A",
        seats: 1,
      },
      {
        id: "pi_read_field",
        source: "stripe",
        sourceId: "pi_read_field",
        date: "2026-11-15",
        time: "7:00 PM",
        focus: "Fielding",
        type: "single",
        privacy: "standard",
        email: "b@example.com",
        player: "B",
        seats: 1,
      },
      {
        id: "pi_read_both",
        source: "stripe",
        sourceId: "pi_read_both",
        date: "2026-11-16",
        time: "6:00 PM",
        focus: "Both",
        type: "private",
        privacy: "private",
        email: "c@example.com",
        player: "C",
        seats: 2,
      },
    ],
    voids: [],
  },
  holds: { holds: [] },
  manual: { bookings: [] },
};

async function seedMemoryStore() {
  await resetBookingStoreCache();
  process.env.BOOKING_STORE = "memory";
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "0";
  process.env.VERCEL_ENV = "preview";
  process.env.BOOKING_ALLOW_NON_PREVIEW = "1";
  delete process.env.BOOKING_DATABASE_URL;
  const store = await getBookingStore(process.env);
  await importBlobSnapshots(SNAPSHOTS, store);
  return store;
}

before(async () => {
  await seedMemoryStore();
});

after(async () => {
  await resetBookingStoreCache();
  delete process.env.BOOKING_STORE;
  delete process.env.BOOKING_READS_ENABLED;
  delete process.env.BOOKING_WRITES_ENABLED;
  delete process.env.VERCEL_ENV;
  delete process.env.BOOKING_ALLOW_NON_PREVIEW;
  delete process.env.BOOKING_DATABASE_URL;
});

beforeEach(async () => {
  process.env.BOOKING_STORE = "memory";
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "0";
  process.env.VERCEL_ENV = "preview";
  process.env.BOOKING_ALLOW_NON_PREVIEW = "1";
});

test("bookedTimes with reads on uses Postgres and marks occupancy_source", async () => {
  mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ data: [] }),
  }));
  try {
    const rows = await bookedTimes("sk_test", "2026-11-15");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.time).sort(),
      ["6:00 PM", "7:00 PM"]
    );
    assert.ok(rows.every((r) => r.occupancy_source === "postgres"));
    const hitting = rows.find((r) => r.time === "6:00 PM");
    assert.deepEqual(hitting.focuses, ["Hitting"]);
    assert.equal(hitting.seats, 1);
    assert.equal(hitting.exclusive, false);
    assert.ok(hitting.sources.every((s) => s.origin === "postgres"));
  } finally {
    mock.restoreAll();
  }
});

test("bookedTimes private exclusivity comes from Postgres", async () => {
  mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ data: [] }),
  }));
  try {
    const rows = await bookedTimes("sk_test", "2026-11-16");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].exclusive, true);
    assert.equal(rows[0].privacy, "private");
    assert.equal(rows[0].seats, 2);
    assert.deepEqual(rows[0].focuses, ["Both"]);
  } finally {
    mock.restoreAll();
  }
});

test("fetchBookings with reads on lists Postgres rows without Blob fallback", async () => {
  const rows = await fetchBookings("sk_test", 365);
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((r) => r.origin === "postgres"));
  const focuses = new Set(rows.map((r) => r.focus));
  assert.ok(focuses.has("Hitting"));
  assert.ok(focuses.has("Fielding"));
  assert.ok(focuses.has("Both"));
});

test("fetchBookings daysBack window is measured in days not seconds", async () => {
  // Seeded lessons are on 2026-11-15/16. A correct 90-day window from "now"
  // must include them; the ms/seconds mix-up would collapse the window to hours.
  const rows = await fetchBookings("sk_test", 90);
  assert.ok(rows.length >= 3, `expected >=3 rows in 90-day window, got ${rows.length}`);
});

test("bookedTimes fail-closed when Postgres store cannot be opened", async () => {
  await resetBookingStoreCache();
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "0";
  process.env.BOOKING_DATABASE_URL = "";
  mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ data: [] }),
  }));
  try {
    await assert.rejects(
      () => bookedTimes("sk_test", "2026-11-15"),
      (err) => err instanceof StorageUnavailableError
    );
  } finally {
    mock.restoreAll();
    await seedMemoryStore();
  }
});
