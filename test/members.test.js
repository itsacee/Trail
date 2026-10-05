// Membership rules: the 12-hour cutoff, credit counting, expiry, and the
// booking/reschedule gate. Members spend 4 lessons on any 4 days inside their
// paid month — one lesson per day, none in the past, none past the expiry.
// The clock is frozen so date-relative rules are deterministic:
// frozen "now" = Wednesday 2026-08-26 17:00 America/Chicago.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  inPeriod,
  chicagoDate,
  lessonStartMs,
  canCancelLesson,
  todayChicago,
  daysAhead,
  lastUsableDate,
  membershipSummary,
  bookingBlocked,
  bookWindowBlocked,
  bookingWindow,
  MEMBER_CREDITS,
  MEMBER_PERIOD_DAYS,
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

test("a paid membership lasts 30 days", () => {
  assert.equal(MEMBER_PERIOD_DAYS, 30);
});

function lesson(id, date, time, extra = {}) {
  return { id, date, time, source: "member", type: "membership", email: "sam@example.com", ...extra };
}

test("inPeriod uses the membership window, end-exclusive", () => {
  assert.equal(inPeriod("2026-08-27", SUB.current_period_start, SUB.current_period_end), true);
  assert.equal(inPeriod("2026-08-19", SUB.current_period_start, SUB.current_period_end), false);
});

test("lastUsableDate is the day before the period end", () => {
  // Period ends 2026-09-17 → last trainable day is 2026-09-16.
  assert.equal(lastUsableDate(SUB.current_period_end), "2026-09-16");
});

test("lessonStartMs respects Chicago DST offset", () => {
  // Late August is CDT (-05:00).
  assert.equal(lessonStartMs("2026-08-27", "5:00 PM"), Date.parse("2026-08-27T17:00:00-05:00"));
  // Late December is CST (-06:00).
  assert.equal(lessonStartMs("2026-12-27", "5:00 PM"), Date.parse("2026-12-27T17:00:00-06:00"));
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

test("membershipSummary counts lessons in the period and reports expiry", () => {
  atTime(NOW, () => {
    const scheduled = [
      lesson("a", "2026-08-27", "5:00 PM"), // in period
      lesson("b", "2026-09-03", "5:00 PM"), // in period
      lesson("c", "2026-09-20", "5:00 PM"), // AFTER period end → not counted
    ];
    const s = membershipSummary(SUB, scheduled);
    assert.equal(s.credits, MEMBER_CREDITS);
    assert.equal(s.used, 2);
    assert.equal(s.remaining, MEMBER_CREDITS - 2);
    assert.equal(s.lastDay, "2026-09-16");
    assert.equal(s.expired, false);
    assert.equal(s.player, "Sam");
  });
});

test("membershipSummary flags an expired membership", () => {
  atTime(NOW, () => {
    const past = {
      metadata: { player: "Sam", email: "sam@example.com" },
      current_period_start: Math.floor(Date.parse("2026-07-01T12:00:00Z") / 1000),
      current_period_end: Math.floor(Date.parse("2026-07-29T12:00:00Z") / 1000), // last day 07-28
    };
    assert.equal(membershipSummary(past, []).expired, true);
  });
});

test("bookingBlocked enforces the window, credit cap, and one-per-day", () => {
  atTime(NOW, () => {
    const summary = membershipSummary(SUB, []);
    // Today or earlier is rejected.
    assert.match(bookingBlocked(summary, "2026-08-26", []), /tomorrow onward/);
    // Past the expiry date is rejected even when that day is still inside the week window.
    const endingSoon = membershipSummary(
      {
        metadata: { player: "Sam", email: "sam@example.com" },
        current_period_start: Math.floor(Date.parse("2026-08-20T12:00:00Z") / 1000),
        current_period_end: Math.floor(Date.parse("2026-08-29T12:00:00Z") / 1000), // last day 08-28
      },
      []
    );
    assert.match(bookingBlocked(endingSoon, "2026-08-29", []), /have to be used by/);
    // Valid days in this week and the following week pass.
    assert.equal(bookingBlocked(summary, "2026-08-28", []), null);
    assert.equal(bookingBlocked(summary, "2026-09-02", []), null);
    assert.equal(bookingBlocked(summary, "2026-09-03", []), null);
    assert.match(bookingBlocked(summary, "2026-09-07", []), /isn't open yet/);
  });
});

test("bookingWindow opens through the end of next week on weekdays", () => {
  atTime(NOW, () => {
    const w = bookingWindow("2026-08-26");
    assert.equal(w.startKey, "2026-08-27");
    assert.equal(w.endKey, "2026-09-06");
    assert.equal(w.dates.length, 11);
    assert.equal(w.dates[0], "2026-08-27");
    assert.equal(w.dates[10], "2026-09-06");
  });
});

test("bookingWindow on Sunday opens the immediate next Mon–Sun", () => {
  atTime("2026-09-27T12:00:00-05:00", () => {
    const w = bookingWindow("2026-09-27");
    assert.equal(w.startKey, "2026-09-28");
    assert.equal(w.endKey, "2026-10-04");
    assert.equal(w.dates.length, 7);
    assert.equal(w.dates[0], "2026-09-28");
    assert.equal(w.dates[6], "2026-10-04");
  });
});

test("bookingWindow on Monday includes the rest of this week and all of next week", () => {
  atTime("2026-09-28T12:00:00-05:00", () => {
    const w = bookingWindow("2026-09-28");
    assert.deepEqual(w.dates.slice(0, 6), [
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    assert.deepEqual(w.dates.slice(6), [
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
  });
});

test("bookingWindow on a same-month Sunday opens the immediate next week", () => {
  atTime("2026-10-04T12:00:00-05:00", () => {
    const w = bookingWindow("2026-10-04");
    assert.equal(w.startKey, "2026-10-05");
    assert.equal(w.endKey, "2026-10-11");
  });
});

test("bookWindowBlocked allows the complete following week", () => {
  atTime(NOW, () => {
    assert.match(bookWindowBlocked("2026-08-26"), /tomorrow onward/);
    assert.equal(bookWindowBlocked("2026-08-27"), null);
    assert.equal(bookWindowBlocked("2026-09-02"), null);
    assert.equal(bookWindowBlocked("2026-09-06"), null);
    assert.match(bookWindowBlocked("2026-09-07"), /isn't open yet/);
  });
});

test("bookingBlocked stops a second lesson on a day already booked", () => {
  atTime(NOW, () => {
    const existing = [lesson("a", "2026-08-27", "5:00 PM")];
    const summary = membershipSummary(SUB, existing);
    assert.match(bookingBlocked(summary, "2026-08-27", existing), /already have a lesson that day/);
  });
});

test("bookingBlocked refuses a 5th lesson once all credits are used", () => {
  atTime(NOW, () => {
    const all = [
      lesson("a", "2026-08-27", "5:00 PM"),
      lesson("b", "2026-08-28", "5:00 PM"),
      lesson("c", "2026-08-29", "5:00 PM"),
      lesson("d", "2026-08-30", "5:00 PM"),
    ];
    assert.match(bookingBlocked(membershipSummary(SUB, all), "2026-08-31", all), /used all 4/);
  });
});

// The reschedule feature hinges on judging the new slot as if the lesson being
// moved weren't on the calendar. These two tests pin that behavior.
test("reschedule: excluding the moved lesson frees its day", () => {
  atTime(NOW, () => {
    const all = [lesson("a", "2026-08-27", "5:00 PM")];
    // Moving it to another time the same day is blocked while it still counts...
    assert.match(bookingBlocked(membershipSummary(SUB, all), "2026-08-27", all), /already have a lesson that day/);
    // ...but once excluded (as the reschedule action does), the move is allowed.
    const others = all.filter((l) => l.id !== "a");
    assert.equal(bookingBlocked(membershipSummary(SUB, others), "2026-08-27", others), null);
  });
});

test("reschedule: a fully-used membership can still move an existing lesson", () => {
  atTime("2026-09-27T12:00:00-05:00", () => {
    const sub = {
      metadata: { player: "Sam", email: "sam@example.com" },
      current_period_start: Math.floor(Date.parse("2026-09-20T12:00:00Z") / 1000),
      current_period_end: Math.floor(Date.parse("2026-10-20T12:00:00Z") / 1000),
    };
    const all = [
      lesson("a", "2026-09-28", "5:00 PM"),
      lesson("b", "2026-09-29", "5:00 PM"),
      lesson("c", "2026-09-30", "5:00 PM"),
      lesson("d", "2026-10-01", "5:00 PM"),
    ];
    // All 4 credits used → a brand-new booking is refused.
    assert.match(bookingBlocked(membershipSummary(sub, all), "2026-10-02", all), /used all 4/);
    // Moving lesson "a" excludes it, so remaining is 1 and the move is allowed within the open week.
    const others = all.filter((l) => l.id !== "a");
    assert.equal(bookingBlocked(membershipSummary(sub, others), "2026-10-02", others), null);
  });
});

test("chicagoDate renders a unix time as a Chicago calendar day", () => {
  assert.equal(chicagoDate(Math.floor(Date.parse("2026-08-27T02:00:00Z") / 1000)), "2026-08-26");
});

test("fromCashMember builds an active cash membership", async () => {
  const { fromCashMember } = await import("../lib/members.js");
  atTime(NOW, () => {
    const start = Math.floor(Date.parse("2026-08-20T12:00:00Z") / 1000);
    const row = {
      cashMembership: true,
      cashMembershipStart: start,
      cashMembershipEnd: start + MEMBER_PERIOD_DAYS * 86400,
      player: "Sam",
      parent: "Pat",
      phone: "405",
      email: "sam@example.com",
    };
    const sub = fromCashMember(row, "sam@example.com");
    assert.ok(sub);
    assert.equal(sub.kind, "cash");
    assert.equal(sub.metadata.player, "Sam");
    assert.equal(sub.current_period_start, start);
  });
});

test("fromCashMember returns null once the cash period has ended", async () => {
  const { fromCashMember } = await import("../lib/members.js");
  atTime(NOW, () => {
    const start = Math.floor(Date.parse("2026-07-01T12:00:00Z") / 1000);
    const row = {
      cashMembership: true,
      cashMembershipStart: start,
      cashMembershipEnd: start + MEMBER_PERIOD_DAYS * 86400,
      email: "sam@example.com",
    };
    assert.equal(fromCashMember(row, "sam@example.com"), null);
  });
});

test("membershipSummary applies Stripe periodBonusDays and coach freeze blocks booking", () => {
  atTime(NOW, () => {
    const endingSoon = {
      metadata: { player: "Sam", email: "sam@example.com" },
      kind: "payment",
      current_period_start: Math.floor(Date.parse("2026-08-01T12:00:00Z") / 1000),
      // Raw end would make last day 08-25 — already past frozen "today" 08-26
      current_period_end: Math.floor(Date.parse("2026-08-26T12:00:00Z") / 1000),
    };
    assert.equal(membershipSummary(endingSoon, []).expired, true);
    // 5 bonus days from coach freeze → last day moves later
    const extended = membershipSummary(endingSoon, [], { periodBonusDays: 5 });
    assert.equal(extended.expired, false);
    assert.ok(extended.lastDay >= "2026-08-26");

    const paused = membershipSummary(SUB, [], {
      memberFrozen: true,
      freezeReason: "Paused for travel.",
    });
    assert.equal(paused.bookingPaused, true);
    assert.match(bookingBlocked(paused, "2026-08-28", []), /Paused for travel/);
  });
});

test("cash membership does not double-count periodBonusDays", () => {
  atTime(NOW, () => {
    const start = Math.floor(Date.parse("2026-08-20T12:00:00Z") / 1000);
    const end = start + MEMBER_PERIOD_DAYS * 86400;
    const cash = {
      kind: "cash",
      metadata: { player: "Sam", email: "sam@example.com" },
      email: "sam@example.com",
      current_period_start: start,
      // End already includes 3 coach freeze days baked in
      current_period_end: end + 3 * 86400,
    };
    const withBonus = membershipSummary(cash, [], { periodBonusDays: 3 });
    const without = membershipSummary(cash, []);
    assert.equal(withBonus.lastDay, without.lastDay);
  });
});
