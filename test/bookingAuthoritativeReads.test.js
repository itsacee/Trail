// Authoritative booking reads: Postgres fail-closed + dual-period Blob bridge.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  loadAuthoritativeLessons,
  loadAuthoritativeManual,
  loadAuthoritativeHolds,
  loadAuthoritativeBookingState,
} from "../lib/bookingReads.js";
import { mergeBlobBridge } from "../lib/bookingDb/readSnapshots.js";
import {
  getBookingStore,
  resetBookingStoreCache,
  dbManualBook,
  dbMemberBook,
} from "../lib/bookingStore.js";
import { StorageUnavailableError } from "../lib/store.js";
import { importBlobSnapshots } from "../lib/bookingDb/importFromBlob.js";
import { mutateLessons, loadLessons } from "../lib/lessons.js";
import { mutateManualBookings } from "../lib/manualBookings.js";
import { placeHold, loadHolds } from "../lib/holds.js";

const PG_SNAP = {
  lessons: {
    lessons: [
      {
        id: "pi_auth_1",
        source: "stripe",
        sourceId: "pi_auth_1",
        date: "2026-12-01",
        time: "6:00 PM",
        focus: "Hitting",
        type: "single",
        privacy: "standard",
        email: "pg@example.com",
        player: "PG",
        seats: 1,
      },
    ],
    voids: [],
  },
  holds: { holds: [] },
  manual: {
    bookings: [
      {
        id: "cash_auth_1",
        date: "2026-12-01",
        time: "7:00 PM",
        focus: "Fielding",
        type: "single",
        privacy: "standard",
        email: "cash@example.com",
        player: "Cash",
        seats: 1,
        status: "active",
        amountDueCents: 5000,
      },
    ],
  },
};

async function clearBlobMemory() {
  process.env.BLOB_MEMORY_STORE = "1";
  // Reset by writing empty snapshots through mutators.
  await mutateLessons((stored) => {
    stored.lessons = [];
    stored.voids = [];
    return { ok: true };
  });
  await mutateManualBookings((store) => {
    store.bookings = [];
    return { ok: true };
  });
}

async function seedMemoryStore() {
  await resetBookingStoreCache();
  process.env.BOOKING_STORE = "memory";
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "0";
  process.env.VERCEL_ENV = "preview";
  process.env.BOOKING_ALLOW_NON_PREVIEW = "1";
  process.env.BLOB_MEMORY_STORE = "1";
  delete process.env.BOOKING_DATABASE_URL;
  await clearBlobMemory();
  const store = await getBookingStore(process.env);
  await importBlobSnapshots(PG_SNAP, store);
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
  delete process.env.BLOB_MEMORY_STORE;
});

beforeEach(async () => {
  process.env.BOOKING_STORE = "memory";
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "0";
  process.env.VERCEL_ENV = "preview";
  process.env.BOOKING_ALLOW_NON_PREVIEW = "1";
  process.env.BLOB_MEMORY_STORE = "1";
});

test("loadAuthoritativeLessons returns Postgres rows when reads are on", async () => {
  const stored = await loadAuthoritativeLessons();
  assert.ok(stored.lessons.some((l) => l.id === "pi_auth_1"));
  assert.match(String(stored._origin || ""), /postgres/);
});

test("dual-period blob bridge overlays Blob-only lessons missing from Postgres", async () => {
  const saved = await mutateLessons((stored) => {
    if (!stored.lessons.some((l) => l.id === "pi_blob_only")) {
      stored.lessons.push({
        id: "pi_blob_only",
        source: "stripe",
        sourceId: "pi_blob_only",
        date: "2026-12-02",
        time: "6:00 PM",
        focus: "Hitting",
        type: "single",
        privacy: "standard",
        email: "blob@example.com",
        player: "Blob",
        seats: 1,
      });
    }
    return { ok: true };
  });
  assert.equal(saved.ok, true);
  const stored = await loadAuthoritativeLessons();
  assert.ok(stored.lessons.some((l) => l.id === "pi_auth_1"));
  assert.ok(stored.lessons.some((l) => l.id === "pi_blob_only"));
  assert.equal(stored._origin, "postgres+blob_bridge");
});

test("blob bridge does not replace Postgres when Blob is unreachable", () => {
  const pg = { lessons: [{ id: "pg1" }], voids: [], _origin: "postgres" };
  const blob = { lessons: [{ id: "b1" }], voids: [], _readFailed: true };
  const merged = mergeBlobBridge(pg, blob, { key: "lessons" });
  assert.deepEqual(merged.lessons.map((l) => l.id), ["pg1"]);
});

test("mergeBlobBridge overlays manual and holds without duplicating ids", () => {
  const pgManual = { bookings: [{ id: "m1" }], _origin: "postgres" };
  const blobManual = { bookings: [{ id: "m1" }, { id: "m2" }] };
  const mergedManual = mergeBlobBridge(pgManual, blobManual, { key: "manual" });
  assert.deepEqual(
    mergedManual.bookings.map((b) => b.id).sort(),
    ["m1", "m2"]
  );

  const pgHolds = { holds: [{ sessionId: "cs1", date: "2026-01-01", time: "6:00 PM" }] };
  const blobHolds = {
    holds: [
      { sessionId: "cs1", date: "2026-01-01", time: "6:00 PM" },
      { sessionId: "cs2", date: "2026-01-01", time: "7:00 PM" },
    ],
  };
  const mergedHolds = mergeBlobBridge(pgHolds, blobHolds, { key: "holds" });
  assert.equal(mergedHolds.holds.length, 2);
});

test("loadAuthoritativeManual fail-closed when Postgres cannot open", async () => {
  await resetBookingStoreCache();
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_DATABASE_URL = "";
  try {
    await assert.rejects(
      () => loadAuthoritativeManual(),
      (err) => err instanceof StorageUnavailableError
    );
  } finally {
    await seedMemoryStore();
  }
});

test("loadAuthoritativeBookingState fail-closed (no Blob-only substitute)", async () => {
  await resetBookingStoreCache();
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_DATABASE_URL = "";
  try {
    await assert.rejects(
      () => loadAuthoritativeBookingState(),
      (err) => err instanceof StorageUnavailableError
    );
  } finally {
    await seedMemoryStore();
  }
});

test("loadAuthoritativeHolds bridges Blob holds while writes remain off", async () => {
  const ok = await placeHold(
    "cs_bridge_auth",
    [{ date: "2026-12-03", time: "5:00 PM" }],
    60,
    "Hitting",
    { seats: 1, type: "single", privacy: "standard" }
  );
  assert.equal(ok, true, "Blob hold write should succeed under BLOB_MEMORY_STORE");
  const blob = await loadHolds();
  assert.ok(blob.holds.some((h) => h.sessionId === "cs_bridge_auth"));
  const holds = await loadAuthoritativeHolds();
  assert.ok(holds.holds.some((h) => h.sessionId === "cs_bridge_auth"));
  assert.equal(holds._origin, "postgres+blob_bridge");
});

test("db write facade stays disabled while BOOKING_WRITES_ENABLED=0", async () => {
  const manual = await dbManualBook({
    id: "cash_should_not_write",
    date: "2026-12-10",
    time: "6:00 PM",
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    seats: 1,
  });
  assert.equal(manual.ok, false);
  assert.equal(manual.code, "writes_disabled");

  const member = await dbMemberBook({
    membershipId: "sub_x",
    email: "x@example.com",
    date: "2026-12-10",
    time: "7:00 PM",
    focus: "Hitting",
    type: "membership",
    privacy: "standard",
  });
  assert.equal(member.ok, false);
  assert.equal(member.code, "writes_disabled");
});

test("when writes are on, authoritative reads skip Blob bridge", async () => {
  // Ensure Blob has a row that must NOT appear once writes are authoritative.
  await mutateLessons((stored) => {
    if (!stored.lessons.some((l) => l.id === "should_not_appear")) {
      stored.lessons.push({
        id: "should_not_appear",
        source: "stripe",
        sourceId: "should_not_appear",
        date: "2026-12-20",
        time: "1:00 AM",
        focus: "Hitting",
        type: "single",
        privacy: "standard",
        seats: 1,
      });
    }
    return { ok: true };
  });
  process.env.BOOKING_WRITES_ENABLED = "1";
  try {
    const blob = await loadLessons();
    assert.ok(blob.lessons.some((l) => l.id === "should_not_appear"));
    const state = await loadAuthoritativeBookingState();
    assert.equal(state.origin, "postgres");
    assert.ok(!state.lessons.lessons.some((l) => l.id === "should_not_appear"));
    assert.ok(state.lessons.lessons.some((l) => l.id === "pi_auth_1"));
  } finally {
    process.env.BOOKING_WRITES_ENABLED = "0";
  }
});

test("authoritative booking state includes Postgres manual outstanding rows", async () => {
  const state = await loadAuthoritativeBookingState();
  assert.ok(state.manual.bookings.some((b) => b.id === "cash_auth_1"));
  assert.match(String(state.origin || ""), /postgres/);
});
