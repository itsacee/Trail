// Membership rules: week math, the 12-hour cutoff, credit counting, and the
// booking/reschedule gate. The clock is frozen so date-relative rules are
// deterministic. Frozen "now" = Wednesday 2026-08-26 17:00 America/Chicago.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  weekKey,
  inPeriod,
  chicagoDate,
  lessonStartMs,
  canCancelLesson,
  todayChicago,
  daysAhead,
  membershipSummary,
  bookingBlocked,
  MEMBER_CREDITS,
} from "../lib/members.js";

const NOW = "2026-08-26T17:00:00-05:00"; // Chicago afternoon, CDT

function atTime(iso, fn) {
  mock.timers.enable({ apis: ["Date"], now: new Date(iso) });
  try {
    return fn();
  } finally {
    mock.timers.reset();
  }
}

// A membership period that comfortably contains late-Aug dates.
const SUB = {
  metadata: { player: "Sam", email: "sam@example.com" },
  current_period_start: Math.floor(Date.parse("2026-08-20T12:00:00Z") / 1000),
  current_period_end: Math.floor(Date.parse("2026-09-17T12:00:00Z") / 1000),
};

function lesson(id, date, time, extra = {}) {
  return { id, date, time, source: "member", type: "membership", email: "sam@example.com", ...extra };
}

test("weekKey groups a Sun–Sat week under its Sunday", () => {
  // 2026-08-23 is a Sunday; 08-27 (Thu) and 08-29 (Sat) share that week.
  assert.equal(weekKey("2026-08-23"), "2026-08-23");
  assert.equal(weekKey("2026-08-27"), "2026-08-23");
  assert.equal(weekKey("2026-08-29"), "2026-08-23");
  // 08-30 is the next Sunday → a new week.
  assert.equal(weekKey("2026-08-30"), "2026-08-30");
});

test("inPeriod uses the membership window, end-exclusive", () => {
  assert.equal(inPeriod("2026-08-27", SUB.current_period_start, SUB.current_period_end), true);
  assert.equal(inPeriod("2026-08-19", SUB.current_period_start, SUB.current_period_end), false);
});

test("lessonStartMs respects Chicago DST offset", () => {
  // Late August is CDT (-05:00).
  const summer = lessonStartMs("2026-08-27", "5:00 PM");
  assert.equal(summer, Date.parse("2026-08-27T17:00:00-05:00"));
  // Late December is CST (-06:00).
  const winter = lessonStartMs("2026-12-27", "5:00 PM");
  assert.equal(winter, Date.parse("2026-12-27T17:00:00-06:00"));
});

test("todayChicago / daysAhead are anchored to the frozen clock", () => {
  atTime(NOW, () => {
    assert.equal(todayChicago(), "2026-08-26");
    assert.equal(daysAhead("2026-08-26"), 0);
    assert.equal(daysAhead("2026-08-27"), 1);
    assert.equal(daysAhead("2026-09-05"), 10);
  });
});

test("canCancelLesson enforces a 12-hour cutoff before the lesson", () => {
  // Lesson tomorrow 5pm; from 24h out it's cancelable.
  atTime(NOW, () => assert.equal(canCancelLesson("2026-08-27", "5:00 PM"), true));
  // From 8h before (same-day 9am), it's locked.
  atTime("2026-08-27T09:00:00-05:00", () => assert.equal(canCancelLesson("2026-08-27", "5:00 PM"), false));
  // Exactly 12h before is allowed (>=).
  atTime("2026-08-27T05:00:00-05:00", () => assert.equal(canCancelLesson("2026-08-27", "5:00 PM"), true));
});

test("membershipSummary counts only lessons inside the period", () => {
  atTime(NOW, () => {
    const scheduled = [
      lesson("a", "2026-08-27", "5:00 PM"), // in period
      lesson("b", "2026-09-03", "5:00 PM"), // in period, next week
      lesson("c", "2026-09-20", "5:00 PM"), // AFTER period end → not counted
    ];
    const s = membershipSummary(SUB, scheduled);
    assert.equal(s.credits, MEMBER_CREDITS);
    assert.equal(s.used, 2);
    assert.equal(s.remaining, MEMBER_CREDITS - 2);
    assert.equal(s.player, "Sam");
  });
});

test("bookingBlocked enforces the booking window and one-per-week", () => {
  atTime(NOW, () => {
    const summary = membershipSummary(SUB, []);
    // Today or earlier is rejected.
    assert.match(bookingBlocked(summary, "2026-08-26", []), /tomorrow onward/);
    // More than 10 days out is rejected.
    assert.match(bookingBlocked(summary, "2026-09-10", []), /next 10 days/);
    // A valid day in an empty week passes.
    assert.equal(bookingBlocked(summary, "2026-08-28", []), null);
  });
});

test("bookingBlocked stops a second lesson in a week already booked", () => {
  atTime(NOW, () => {
    const existing = [lesson("a", "2026-08-27", "5:00 PM")]; // Thu
    const summary = membershipSummary(SUB, existing);
    // 08-28 (Fri) is the same week → blocked.
    assert.match(bookingBlocked(summary, "2026-08-28", existing), /already have a lesson this week/);
  });
});

// The reschedule feature hinges on judging the new slot as if the lesson being
// moved weren't on the calendar. These two tests pin that behavior.
test("reschedule: excluding the moved lesson frees its week", () => {
  atTime(NOW, () => {
    const all = [lesson("a", "2026-08-27", "5:00 PM")];
    // With the lesson present, moving it to another day the same week is blocked...
    const blocked = bookingBlocked(membershipSummary(SUB, all), "2026-08-28", all);
    assert.match(blocked, /already have a lesson this week/);
    // ...but once excluded (as the reschedule action does), the same move is allowed.
    const others = all.filter((l) => l.id !== "a");
    const ok = bookingBlocked(membershipSummary(SUB, others), "2026-08-28", others);
    assert.equal(ok, null);
  });
});

test("reschedule: a fully-used membership can still move an existing lesson", () => {
  atTime(NOW, () => {
    const all = [
      lesson("a", "2026-08-27", "5:00 PM"),
      lesson("b", "2026-09-03", "5:00 PM"),
      lesson("c", "2026-09-10", "5:00 PM"),
      lesson("d", "2026-09-16", "5:00 PM"),
    ];
    // All 4 credits used → a brand-new booking is refused.
    assert.match(bookingBlocked(membershipSummary(SUB, all), "2026-08-28", all), /used all 4/);
    // Moving lesson "a" excludes it, so remaining is 1 and the move is allowed.
    const others = all.filter((l) => l.id !== "a");
    assert.equal(bookingBlocked(membershipSummary(SUB, others), "2026-08-28", others), null);
  });
});

test("chicagoDate renders a unix time as a Chicago calendar day", () => {
  assert.equal(chicagoDate(Math.floor(Date.parse("2026-08-27T02:00:00Z") / 1000)), "2026-08-26");
});
