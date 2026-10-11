// Emergency calendar recovery: public Blob capacity reads restore schedules;
// unreadable storage must error (not become an empty calendar).
import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  blobCompareAndSet,
  StorageUnavailableError,
  storeConfigured,
} from "../lib/store.js";
import { loadLessons } from "../lib/lessons.js";
import { loadManualBookings } from "../lib/manualBookings.js";
import { loadHolds } from "../lib/holds.js";
import { fetchBookings } from "../lib/bookings.js";
import { bookedTimes } from "../api/slots.js";

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

test("existing lessons and manual bookings load from the public capacity store", async () => {
  assert.equal(storeConfigured(), true);
  assert.equal(
    (
      await blobCompareAndSet(
        "lessons.json",
        {
          lessons: [
            {
              id: "lsn_keep",
              email: "parent@example.com",
              player: "Casey",
              type: "membership",
              focus: "Hitting",
              date: "2026-11-20",
              time: "5:00 PM",
              source: "member",
            },
          ],
          voids: [],
        },
        ""
      )
    ).ok,
    true
  );
  assert.equal(
    (
      await blobCompareAndSet(
        "manual-bookings.json",
        {
          bookings: [
            {
              id: "mb_keep",
              email: "cash@example.com",
              player: "Riley",
              type: "single",
              focus: "Fielding",
              date: "2026-11-20",
              time: "6:00 PM",
              status: "scheduled",
            },
          ],
        },
        ""
      )
    ).ok,
    true
  );

  const lessons = await loadLessons();
  const manual = await loadManualBookings();
  assert.equal(lessons._readFailed, false);
  assert.equal(manual._readFailed, false);
  assert.equal(lessons.lessons[0].id, "lsn_keep");
  assert.equal(manual.bookings[0].id, "mb_keep");

  mock.method(globalThis, "fetch", async (url) => {
    const path = String(url);
    if (path.includes("api.stripe.com")) {
      return { ok: true, json: async () => ({ data: [], has_more: false }) };
    }
    throw new Error(`Unexpected fetch: ${path}`);
  });
  try {
    const rows = await fetchBookings("sk_test");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.id).sort(), ["lsn_keep", "mb_keep"]);
  } finally {
    mock.restoreAll();
  }
});

test("bookedTimes marks occupied slots from stored lessons and manuals", async () => {
  await blobCompareAndSet(
    "lessons.json",
    {
      lessons: [
        {
          id: "lsn_slot",
          email: "a@example.com",
          type: "membership",
          focus: "Hitting",
          date: "2026-11-21",
          time: "5:00 PM",
          source: "member",
        },
      ],
      voids: [],
    },
    ""
  );
  await blobCompareAndSet(
    "manual-bookings.json",
    {
      bookings: [
        {
          id: "mb_slot",
          email: "b@example.com",
          type: "single",
          focus: "Fielding",
          date: "2026-11-21",
          time: "6:00 PM",
          status: "scheduled",
          seats: 1,
        },
      ],
    },
    ""
  );
  await blobCompareAndSet("holds.json", { holds: [] }, "");

  mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ data: [] }),
  }));
  try {
    const rows = await bookedTimes("sk_test", "2026-11-21");
    assert.deepEqual(rows.map((r) => r.time).sort(), ["5:00 PM", "6:00 PM"]);
  } finally {
    mock.restoreAll();
  }
});

test("corrupt lessons.json is read-failed, not an empty schedule", async () => {
  assert.equal((await blobCompareAndSet("lessons.json", "NOT_JSON{{{", "")).ok, true);
  const stored = await loadLessons();
  assert.equal(stored._readFailed, true);
  assert.deepEqual(stored.lessons, []);

  mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("api.stripe.com")) {
      return { ok: true, json: async () => ({ data: [], has_more: false }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    await assert.rejects(
      () => fetchBookings("sk_test"),
      (err) => err instanceof StorageUnavailableError && err.code === "schedule_unavailable"
    );
  } finally {
    mock.restoreAll();
  }
});

test("corrupt holds.json is unreachable/read-failed for slot checks", async () => {
  assert.equal((await blobCompareAndSet("holds.json", "BROKEN", "")).ok, true);
  const holds = await loadHolds();
  assert.equal(holds._unreachable, true);
  assert.equal(holds._readFailed, true);

  await blobCompareAndSet("lessons.json", { lessons: [], voids: [] }, "");
  await blobCompareAndSet("manual-bookings.json", { bookings: [] }, "");

  mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ data: [] }),
  }));
  try {
    await assert.rejects(
      () => bookedTimes("sk_test", "2026-11-22"),
      (err) => err instanceof StorageUnavailableError
    );
  } finally {
    mock.restoreAll();
  }
});

test("empty missing capacity files remain a valid empty schedule", async () => {
  mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("api.stripe.com")) {
      return { ok: true, json: async () => ({ data: [], has_more: false }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    assert.deepEqual(await fetchBookings("sk_test"), []);
    const lessons = await loadLessons();
    assert.equal(lessons._readFailed, false);
  } finally {
    mock.restoreAll();
  }
});
