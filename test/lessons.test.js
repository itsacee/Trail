// Lesson records: building them, filtering by member, removing them, and
// reconstructing signup lessons from Stripe metadata. Pure — no blob store.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  lessonsForEmail,
  lessonsOnDate,
  removeLesson,
  lessonFromStripeMeta,
  upsertStripeLessons,
  makeMemberLesson,
  newLessonId,
  scheduledFor,
  voidStripeLesson,
  isVoided,
  isActiveLesson,
  saveLessons,
} from "../lib/lessons.js";

test("newLessonId is unique-ish and prefixed", () => {
  const a = newLessonId();
  const b = newLessonId();
  assert.match(a, /^lsn_/);
  assert.notEqual(a, b);
});

test("lessonsForEmail matches case-insensitively", () => {
  const data = {
    lessons: [
      { id: "1", email: "Sam@Example.com", date: "2026-08-27" },
      { id: "2", email: "other@example.com", date: "2026-08-27" },
    ],
  };
  const mine = lessonsForEmail(data, "sam@example.com");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, "1");
});

test("cancelled stored lessons do not occupy a slot or spend a membership credit", () => {
  const data = {
    lessons: [
      {
        id: "active",
        email: "sam@example.com",
        type: "membership",
        date: "2026-08-27",
        time: "5:00 PM",
      },
      {
        id: "cancelled",
        email: "sam@example.com",
        type: "membership",
        date: "2026-08-28",
        time: "5:00 PM",
        status: "cancelled",
      },
      {
        id: "legacy-cancelled",
        email: "sam@example.com",
        type: "membership",
        date: "2026-08-29",
        time: "5:00 PM",
        cancelledAt: Date.now(),
      },
    ],
  };

  assert.equal(isActiveLesson(data.lessons[0]), true);
  assert.equal(isActiveLesson(data.lessons[1]), false);
  assert.equal(isActiveLesson(data.lessons[2]), false);
  assert.deepEqual(lessonsForEmail(data, "sam@example.com").map((lesson) => lesson.id), ["active"]);
  assert.equal(lessonsOnDate(data, "2026-08-28").length, 0);
});

test("removeLesson only drops the caller's own matching lesson", () => {
  const data = {
    lessons: [
      { id: "keep", email: "sam@example.com", date: "2026-08-27" },
      { id: "gone", email: "sam@example.com", date: "2026-08-28" },
    ],
  };
  // Wrong email can't remove someone else's lesson.
  assert.equal(removeLesson(data, "gone", "someone@else.com"), false);
  assert.equal(data.lessons.length, 2);
  // Right email removes it.
  assert.equal(removeLesson(data, "gone", "sam@example.com"), true);
  assert.deepEqual(data.lessons.map((l) => l.id), ["keep"]);
});

test("lessonFromStripeMeta expands multi-slot signup metadata", () => {
  const rows = lessonFromStripeMeta("pi_1", {
    player: "Sam",
    email: "sam@example.com",
    type: "membership",
    date1: "2026-08-27", time1: "5:00 PM", loc1: "mustang",
    date2: "2026-09-03", time2: "6:00 PM", loc2: "mustang",
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "pi_1-1");
  assert.equal(rows[0].source, "stripe");
  assert.equal(rows[1].date, "2026-09-03");
});

test("lessonFromStripeMeta falls back to a single legacy date/time", () => {
  const rows = lessonFromStripeMeta("pi_2", { player: "Sam", date: "2026-08-27", time: "5:00 PM" }, "single");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "pi_2-1");
  assert.equal(rows[0].type, "single");
});

test("paid checkout lessons are mirrored idempotently with seat details", () => {
  const stored = { lessons: [], voids: [] };
  const metadata = {
    player: "Cashin",
    email: "parent@example.com",
    type: "single",
    focus: "Both",
    athletes: "1",
    seats: "1",
    date1: "2026-10-06",
    time1: "5:00 PM",
    loc1: "mustang",
  };
  assert.equal(upsertStripeLessons(stored, "pi_cashin", metadata), true);
  assert.equal(upsertStripeLessons(stored, "pi_cashin", metadata), true);
  assert.equal(stored.lessons.length, 1);
  assert.deepEqual(
    {
      id: stored.lessons[0].id,
      sourceId: stored.lessons[0].sourceId,
      source: stored.lessons[0].source,
      seats: stored.lessons[0].seats,
    },
    { id: "pi_cashin-1", sourceId: "pi_cashin", source: "stripe", seats: 1 }
  );
});

test("a voided paid checkout mirror is not recreated", () => {
  const stored = {
    lessons: [],
    voids: [
      {
        sourceId: "pi_cancelled",
        date: "2026-10-06",
        time: "5:00 PM",
      },
    ],
  };
  const changed = upsertStripeLessons(stored, "pi_cancelled", {
    email: "parent@example.com",
    type: "single",
    date1: "2026-10-06",
    time1: "5:00 PM",
  });
  assert.equal(changed, false);
  assert.deepEqual(stored.lessons, []);
});

test("makeMemberLesson stamps a member-source membership lesson", () => {
  const av = { slotMinutes: 60, days: { 4: { open: true, start: "17:00", end: "21:00" } }, blocked: [] };
  const l = makeMemberLesson({
    sub: { id: "sub_1", metadata: { player: "Sam", email: "sam@example.com" } },
    date: "2026-08-27", // Thursday, open
    time: "5:00 PM",
    focus: "Hitting",
    availability: av,
  });
  assert.equal(l.source, "member");
  assert.equal(l.type, "membership");
  assert.equal(l.subId, "sub_1");
  assert.equal(l.player, "Sam");
  assert.equal(l.loc, "mustang");
  assert.match(l.id, /^lsn_/);
});

test("voided Stripe signup lessons drop off the member calendar", () => {
  const sub = {
    id: "pi_1",
    metadata: {
      player: "Sam",
      email: "sam@example.com",
      date1: "2026-08-27",
      time1: "5:00 PM",
    },
  };
  const stored = { lessons: [], voids: [] };
  upsertStripeLessons(stored, sub.id, { ...sub.metadata, type: "membership" });
  const before = scheduledFor(sub, stored);
  assert.equal(before.length, 1);
  assert.equal(before[0].source, "stripe");

  voidStripeLesson(stored, before[0]);
  assert.equal(isVoided(stored, { sourceId: "pi_1", date: "2026-08-27", time: "5:00 PM" }), true);

  const after = scheduledFor(sub, stored);
  assert.equal(after.length, 0);
});

test("voiding one Stripe slot does not hide another lesson at the same hour", () => {
  const stored = { lessons: [], voids: [] };
  voidStripeLesson(stored, {
    email: "a@example.com",
    date: "2026-10-06",
    time: "6:00 PM",
    sourceId: "pi_moved",
  });

  // Same hour, different payment — still open on the coach calendar.
  assert.equal(
    isVoided(stored, { sourceId: "pi_other", date: "2026-10-06", time: "6:00 PM", email: "b@example.com" }),
    false
  );
  // A member credit at that hour must stay visible too.
  assert.equal(
    isVoided(stored, {
      date: "2026-10-06",
      time: "6:00 PM",
      email: "member@example.com",
      subId: "sub_1",
    }),
    false
  );
  // The moved payment's old slot stays hidden.
  assert.equal(
    isVoided(stored, { sourceId: "pi_moved", date: "2026-10-06", time: "6:00 PM", email: "a@example.com" }),
    true
  );
});

test("saveLessons refuses to write when the store was unreachable", async () => {
  const empty = { lessons: [], voids: [] };
  Object.defineProperty(empty, "_readFailed", { value: true, enumerable: false });
  assert.equal(await saveLessons(empty), false);
});

test("saveLessons allows writing an empty-but-reachable store", async () => {
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevFetch = globalThis.fetch;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_test";
  let wrote = null;
  globalThis.fetch = async (url, opts = {}) => {
    if ((opts.method || "GET").toUpperCase() === "PUT") {
      wrote = opts.body;
      return { ok: true, json: async () => ({}) };
    }
    return { ok: false, status: 404, text: async () => "" };
  };
  try {
    // SDK put will fail in tests; REST fallback with allow-overwrite should land.
    const empty = { lessons: [{ id: "lsn_1", date: "2026-10-15", time: "6:00 PM" }], voids: [] };
    Object.defineProperty(empty, "_readFailed", { value: false, enumerable: false });
    assert.equal(await saveLessons(empty), true);
    assert.match(String(wrote), /lsn_1/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevToken;
  }
});

test("scheduledFor includes cash/manual membership lessons", () => {
  const sub = {
    id: "cash_sam@example.com",
    kind: "cash",
    email: "sam@example.com",
    metadata: { player: "Sam", email: "sam@example.com" },
  };
  const stored = { lessons: [], voids: [] };
  const manual = {
    bookings: [
      {
        id: "mb_1",
        type: "membership",
        email: "sam@example.com",
        player: "Sam",
        date: "2026-08-27",
        time: "5:00 PM",
        focus: "Fielding",
        status: "scheduled",
      },
      {
        id: "mb_2",
        type: "single",
        email: "sam@example.com",
        date: "2026-08-28",
        time: "5:00 PM",
        status: "scheduled",
      },
    ],
  };
  const list = scheduledFor(sub, stored, manual);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "mb_1");
  assert.equal(list[0].source, "manual");
});
