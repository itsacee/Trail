// Lesson records: building them, filtering by member, removing them, and
// reconstructing signup lessons from Stripe metadata. Pure — no blob store.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  lessonsForEmail,
  removeLesson,
  lessonFromStripeMeta,
  makeMemberLesson,
  newLessonId,
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
