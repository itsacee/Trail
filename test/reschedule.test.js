// Moving a lesson: where the new time gets written depends on where the lesson
// lives, and the old slot always has to stop blocking the calendar.
import { test } from "node:test";
import assert from "node:assert/strict";

import { moveLesson, seatsOnLesson } from "../lib/reschedule.js";
import { isVoided } from "../lib/lessons.js";
import { SLOT_CAPACITY } from "../lib/schedule.js";

const availability = {
  slotMinutes: 60,
  days: {
    1: { open: true, start: "18:00", end: "20:00" },
    2: { open: true, start: "18:00", end: "20:00" },
  },
  blocked: [],
};

function emptyStores() {
  return { stored: { lessons: [], voids: [] }, manual: { bookings: [] } };
}

test("seatsOnLesson reads the seat count off any kind of lesson", () => {
  assert.equal(seatsOnLesson({ type: "private" }), SLOT_CAPACITY);
  assert.equal(seatsOnLesson({ type: "single", athletes: 2 }), 2);
  assert.equal(seatsOnLesson({ type: "single", seats: 2 }), 2);
  assert.equal(seatsOnLesson({ type: "single" }), 1);
  assert.equal(seatsOnLesson({ type: "membership" }), 1);
});

test("a cash booking is moved in place", () => {
  const { stored, manual } = emptyStores();
  manual.bookings.push({
    id: "mb_1",
    type: "single",
    player: "Dylan",
    date: "2026-10-05",
    time: "6:00 PM",
    focus: "Fielding",
    status: "active",
  });
  const row = { id: "mb_1", source: "manual", type: "single", date: "2026-10-05", time: "6:00 PM" };

  const result = moveLesson({ row, stored, manual, date: "2026-10-06", time: "7:00 PM", focus: "Hitting", availability });

  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ["manual"]);
  assert.equal(manual.bookings[0].date, "2026-10-06");
  assert.equal(manual.bookings[0].time, "7:00 PM");
  assert.equal(manual.bookings[0].focus, "Hitting");
  assert.equal(stored.lessons.length, 0);
  assert.equal(result.clearStripe, undefined);
});

test("a portal lesson is moved in place", () => {
  const { stored, manual } = emptyStores();
  stored.lessons.push({
    id: "ml_1",
    type: "membership",
    email: "a@b.com",
    date: "2026-10-05",
    time: "6:00 PM",
    focus: "Fielding",
  });
  const row = { id: "ml_1", source: "member", type: "membership", email: "a@b.com", date: "2026-10-05", time: "6:00 PM" };

  const result = moveLesson({ row, stored, manual, date: "2026-10-06", time: "7:00 PM", focus: "Fielding", availability });

  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ["lessons"]);
  assert.equal(stored.lessons.length, 1);
  assert.equal(stored.lessons[0].time, "7:00 PM");
});

test("a checkout slot is voided and rewritten, so the old time reopens", () => {
  const { stored, manual } = emptyStores();
  // Another family's lesson already shares the old hour — moving must not hide it.
  stored.lessons.push({
    id: "ml_keep",
    source: "member",
    type: "membership",
    email: "other@example.com",
    date: "2026-10-05",
    time: "6:00 PM",
    focus: "Hitting",
  });
  const row = {
    id: "pi_123-1",
    sourceId: "pi_123",
    source: "stripe",
    type: "private",
    player: "Easton",
    email: "Parent@Example.com",
    date: "2026-10-05",
    time: "6:00 PM",
    focus: "Fielding",
  };

  const result = moveLesson({ row, stored, manual, date: "2026-10-06", time: "7:00 PM", focus: "Fielding", availability });

  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ["lessons"]);
  assert.deepEqual(result.clearStripe, { sourceId: "pi_123", lessonId: "pi_123-1" });

  // The old Stripe slot no longer blocks 6:00 PM...
  assert.equal(isVoided(stored, { sourceId: "pi_123", date: "2026-10-05", time: "6:00 PM" }), true);
  // ...but the other lesson at that hour stays on the calendar.
  assert.equal(
    isVoided(stored, {
      id: "ml_keep",
      email: "other@example.com",
      date: "2026-10-05",
      time: "6:00 PM",
      subId: "sub_other",
    }),
    false
  );
  assert.equal(stored.lessons.some((l) => l.id === "ml_keep"), true);
  // ...and the new time is on file, still owning the whole hour.
  assert.equal(stored.lessons.length, 2);
  const moved = stored.lessons.find((l) => l.id !== "ml_keep");
  assert.equal(moved.date, "2026-10-06");
  assert.equal(moved.time, "7:00 PM");
  assert.equal(moved.seats, SLOT_CAPACITY);
  assert.equal(moved.email, "parent@example.com");
  assert.deepEqual(moved.movedFrom, { date: "2026-10-05", time: "6:00 PM" });
});

test("moving a lesson that isn't on file fails instead of inventing one", () => {
  const { stored, manual } = emptyStores();
  const gone = moveLesson({
    row: { id: "mb_missing", source: "manual", type: "single" },
    stored,
    manual,
    date: "2026-10-06",
    time: "7:00 PM",
    availability,
  });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /isn't on file/);
  assert.equal(moveLesson({ row: null, stored, manual, date: "2026-10-06", time: "7:00 PM", availability }).ok, false);
});
