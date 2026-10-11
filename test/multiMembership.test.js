// Stage 3 correction: multiple active memberships remain independently usable.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MEMBER_CREDITS,
  MEMBER_PERIOD_DAYS,
  fromPayment,
  membershipSummary,
  bookingBlocked,
  pickPrimaryMembership,
  publicMembershipCard,
  todayChicago,
} from "../lib/members.js";
import {
  lessonBelongsToMembership,
  membershipTierOf,
} from "../lib/membershipTypes.js";
import { privacyForPurchaseType } from "../lib/schedule.js";
import {
  makeMemberLesson,
  scheduledFor,
  scheduledAcrossMemberships,
} from "../lib/lessons.js";

function chicagoIso(offsetDays = 2) {
  const ms = Date.now() + offsetDays * 86400 * 1000;
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function payment(id, email, type = "membership", ageDays = 0) {
  const created = Math.floor(Date.now() / 1000) - ageDays * 86400;
  return {
    id,
    status: "succeeded",
    created,
    metadata: {
      type,
      email,
      player: "Sam",
      privacy: privacyForPurchaseType(type),
      membership_tier: membershipTierOf({ type }),
    },
  };
}

/** Build a membership row whose usable window ended well before today. */
function expiredMembership(id, email, type = "membership") {
  // Far enough back that facility freeze bonuses cannot reopen the period.
  const end = Math.floor(Date.now() / 1000) - 90 * 86400;
  const start = end - MEMBER_PERIOD_DAYS * 86400;
  return {
    id,
    email,
    kind: "payment",
    current_period_start: start,
    current_period_end: end,
    metadata: {
      type,
      email,
      player: "Sam",
      privacy: privacyForPurchaseType(type),
    },
  };
}

test("single active membership summary stays primary-compatible", () => {
  const sub = fromPayment(payment("pi_one", "one@example.com", "membership"));
  const summary = membershipSummary(sub, []);
  assert.equal(summary.membershipId, "pi_one");
  assert.equal(summary.remaining, MEMBER_CREDITS);
  assert.equal(summary.periodOpen, true);
  const card = publicMembershipCard(summary);
  assert.equal(card.id, "pi_one");
  assert.equal(card.membershipLabel, "Standard Membership");
});

test("two active memberships different tiers keep separate credits", () => {
  const std = fromPayment(payment("pi_std", "mix@example.com", "membership", 3));
  const priv = fromPayment(payment("pi_priv", "mix@example.com", "membership_private", 0));
  const siblings = [std, priv];
  const stdLesson = makeMemberLesson({
    sub: std,
    date: chicagoIso(2),
    time: "5:00 PM",
    focus: "Hitting",
    availability: null,
  });
  const privLesson = makeMemberLesson({
    sub: priv,
    date: chicagoIso(3),
    time: "5:00 PM",
    focus: "Fielding",
    availability: null,
  });
  const all = [stdLesson, privLesson];
  const stdSummary = membershipSummary(std, all, { siblings });
  const privSummary = membershipSummary(priv, all, { siblings });
  assert.equal(stdSummary.used, 1);
  assert.equal(stdSummary.remaining, 3);
  assert.equal(privSummary.used, 1);
  assert.equal(privSummary.remaining, 3);
  assert.equal(stdSummary.privacy, "standard");
  assert.equal(privSummary.privacy, "private");
});

test("two active purchases of the same tier do not combine credits", () => {
  const older = fromPayment(payment("pi_a", "same@example.com", "membership", 10));
  const newer = fromPayment(payment("pi_b", "same@example.com", "membership", 0));
  const siblings = [older, newer];
  const olderLesson = makeMemberLesson({
    sub: older,
    date: chicagoIso(2),
    time: "4:00 PM",
    focus: "Both",
    availability: null,
  });
  const newerLesson = makeMemberLesson({
    sub: newer,
    date: chicagoIso(3),
    time: "4:00 PM",
    focus: "Hitting",
    availability: null,
  });
  assert.equal(lessonBelongsToMembership(olderLesson, older, siblings), true);
  assert.equal(lessonBelongsToMembership(olderLesson, newer, siblings), false);
  assert.equal(membershipSummary(older, [olderLesson, newerLesson], { siblings }).used, 1);
  assert.equal(membershipSummary(newer, [olderLesson, newerLesson], { siblings }).used, 1);
  // Newest remains the default primary, but older credits stay countable.
  assert.equal(pickPrimaryMembership(siblings).id, "pi_b");
  assert.equal(membershipSummary(older, [olderLesson], { siblings }).remaining, 3);
});

test("choosing standard vs private credits binds subId on the lesson", () => {
  const std = fromPayment(payment("pi_s", "pick@example.com", "membership", 2));
  const priv = fromPayment(payment("pi_p", "pick@example.com", "membership_private", 0));
  const fromStd = makeMemberLesson({
    sub: std,
    date: chicagoIso(4),
    time: "5:00 PM",
    focus: "Hitting",
    availability: null,
  });
  const fromPriv = makeMemberLesson({
    sub: priv,
    date: chicagoIso(5),
    time: "5:00 PM",
    focus: "Hitting",
    availability: null,
  });
  assert.equal(fromStd.subId, "pi_s");
  assert.equal(fromStd.privacy, "standard");
  assert.equal(fromPriv.subId, "pi_p");
  assert.equal(fromPriv.privacy, "private");
  assert.equal(fromStd.type, "membership");
  assert.equal(fromPriv.type, "membership_private");
});

test("canceling a booking on an older membership restores that purchase only", () => {
  const older = fromPayment(payment("pi_old", "cancel@example.com", "membership", 8));
  const newer = fromPayment(payment("pi_new", "cancel@example.com", "membership_private", 0));
  const siblings = [older, newer];
  const lesson = makeMemberLesson({
    sub: older,
    date: chicagoIso(2),
    time: "5:00 PM",
    focus: "Hitting",
    availability: null,
  });
  assert.equal(membershipSummary(older, [lesson], { siblings }).remaining, 3);
  assert.equal(membershipSummary(newer, [lesson], { siblings }).remaining, 4);
  // After cancel the lesson is gone from the scheduled set.
  assert.equal(membershipSummary(older, [], { siblings }).remaining, 4);
  assert.equal(membershipSummary(newer, [], { siblings }).remaining, 4);
});

test("rescheduling preserves the source membership purchase id", () => {
  const older = fromPayment(payment("pi_move", "move@example.com", "membership", 6));
  const newer = fromPayment(payment("pi_other", "move@example.com", "membership_private", 0));
  const siblings = [older, newer];
  const original = makeMemberLesson({
    sub: older,
    date: chicagoIso(2),
    time: "5:00 PM",
    focus: "Hitting",
    availability: null,
  });
  const moved = makeMemberLesson({
    sub: older,
    date: chicagoIso(4),
    time: "6:00 PM",
    focus: "Fielding",
    availability: null,
  });
  assert.equal(moved.subId, original.subId);
  assert.equal(moved.subId, "pi_move");
  assert.equal(moved.privacy, "standard");
  assert.equal(membershipSummary(older, [moved], { siblings }).used, 1);
  assert.equal(membershipSummary(newer, [moved], { siblings }).used, 0);
});

test("expired purchases are excluded from period-open lists", () => {
  const expired = expiredMembership("pi_exp", "exp@example.com", "membership");
  const active = fromPayment(payment("pi_live", "exp@example.com", "membership_private", 0));
  const expiredSummary = membershipSummary(expired, []);
  const activeSummary = membershipSummary(active, []);
  assert.equal(expiredSummary.periodOpen, false);
  assert.equal(expiredSummary.expired, true);
  assert.equal(activeSummary.periodOpen, true);
  const open = [expiredSummary, activeSummary].filter((s) => s.periodOpen);
  assert.equal(open.length, 1);
  assert.equal(open[0].membershipId, "pi_live");
});

test("one-lesson-per-day looks across all purchases", () => {
  const std = fromPayment(payment("pi_d1", "day@example.com", "membership", 2));
  const priv = fromPayment(payment("pi_d2", "day@example.com", "membership_private", 0));
  const day = chicagoIso(3);
  const existing = makeMemberLesson({
    sub: std,
    date: day,
    time: "4:00 PM",
    focus: "Hitting",
    availability: null,
  });
  const privSummary = membershipSummary(priv, []);
  const blocked = bookingBlocked(privSummary, day, [], [existing]);
  assert.match(blocked, /already have a lesson that day/i);
  assert.equal(bookingBlocked(privSummary, chicagoIso(4), [], [existing]), null);
});

test("scheduledAcrossMemberships includes lessons from every purchase", () => {
  const std = fromPayment(payment("pi_u1", "union@example.com", "membership", 2));
  const priv = fromPayment(payment("pi_u2", "union@example.com", "membership_private", 0));
  const stored = {
    lessons: [
      makeMemberLesson({
        sub: std,
        date: chicagoIso(2),
        time: "5:00 PM",
        focus: "Hitting",
        availability: null,
      }),
      makeMemberLesson({
        sub: priv,
        date: chicagoIso(3),
        time: "5:00 PM",
        focus: "Hitting",
        availability: null,
      }),
    ],
    voids: [],
  };
  const union = scheduledAcrossMemberships([std, priv], stored, null);
  assert.equal(union.length, 2);
  assert.equal(union.filter((l) => l.membershipId === "pi_u1").length, 1);
  assert.equal(union.filter((l) => l.membershipId === "pi_u2").length, 1);
  const onlyStd = scheduledFor(std, stored, null, [std, priv]);
  assert.equal(onlyStd.length, 1);
  assert.equal(onlyStd[0].subId, "pi_u1");
});

test("buying another membership does not extend an older purchase period", () => {
  const older = fromPayment(payment("pi_keep", "keep@example.com", "membership", 10));
  const newer = fromPayment(payment("pi_buy", "keep@example.com", "membership_private", 0));
  const olderSummary = membershipSummary(older, []);
  const newerSummary = membershipSummary(newer, []);
  assert.ok(olderSummary.periodEnd < newerSummary.periodEnd);
  assert.equal(older.current_period_end, olderSummary.periodEnd);
  // Newer purchase must not rewrite older bounds.
  assert.equal(older.current_period_start + MEMBER_PERIOD_DAYS * 86400, older.current_period_end);
});

test("concurrent credit spend on one purchase cannot exceed four", () => {
  const sub = fromPayment(payment("pi_race", "race@example.com", "membership_private"));
  const siblings = [sub];
  const lessons = [];
  for (let i = 0; i < 5; i++) {
    const summary = membershipSummary(sub, lessons, { siblings });
    const date = chicagoIso(2 + i);
    const blocked = bookingBlocked(summary, date, lessons, lessons);
    if (blocked) {
      assert.equal(i, 4);
      assert.match(blocked, /used all 4/i);
      break;
    }
    lessons.push(
      makeMemberLesson({
        sub,
        date,
        time: "5:00 PM",
        focus: "Hitting",
        availability: null,
      })
    );
  }
  assert.equal(lessons.length, 4);
  assert.equal(membershipSummary(sub, lessons, { siblings }).remaining, 0);
});

test("todayChicago helper remains usable for period-open checks", () => {
  assert.match(todayChicago(), /^\d{4}-\d{2}-\d{2}$/);
});
