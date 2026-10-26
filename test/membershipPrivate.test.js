// Stage 3: Private Membership ($360) alongside Standard Membership ($280).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  MEMBER_CREDITS,
  MEMBER_PERIOD_DAYS,
  fromPayment,
  fromCashMember,
  membershipSummary,
  bookingBlocked,
  pickPrimaryMembership,
  isMembershipType,
  membershipTierOf,
  membershipTypeOf,
  membershipLabel,
} from "../lib/members.js";
import {
  MEMBERSHIP_PRIVATE,
  MEMBERSHIP_STANDARD,
  lessonBelongsToMembership,
} from "../lib/membershipTypes.js";
import {
  privacyForPurchaseType,
  isExclusiveBooking,
  slotBlocked,
  seatsFor,
  durationFor,
  SLOT_CAPACITY,
} from "../lib/schedule.js";
import { unitPriceFor, DEFAULT_SETTINGS } from "../lib/settings.js";
import { makeMemberLesson, upsertStripeLessons } from "../lib/lessons.js";
import {
  activeMembershipsFromPayments,
  capacitySummary,
} from "../lib/membershipCapacity.js";

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
      date1: chicagoIso(2),
      time1: "5:00 PM",
    },
  };
}

test("privacy maps from purchase type, not focus", () => {
  assert.equal(privacyForPurchaseType("membership"), "standard");
  assert.equal(privacyForPurchaseType("membership_private"), "private");
  assert.equal(isExclusiveBooking({ type: "membership_private", focus: "Hitting" }), true);
  assert.equal(isExclusiveBooking({ type: "membership", focus: "Both", privacy: "standard" }), false);
  assert.equal(seatsFor("membership_private", 1), SLOT_CAPACITY);
  assert.equal(durationFor("membership_private"), 60);
});

test("standard and private membership prices are $280 and $360", () => {
  assert.equal(unitPriceFor("membership", 1, DEFAULT_SETTINGS.prices), 28000);
  assert.equal(unitPriceFor("membership_private", 1, DEFAULT_SETTINGS.prices), 36000);
  assert.equal(DEFAULT_SETTINGS.prices.membership, 28000);
  assert.equal(DEFAULT_SETTINGS.prices.membership_private, 36000);
});

test("both memberships are one-time 30-day purchases with four credits", () => {
  const std = fromPayment(payment("pi_std", "a@example.com", "membership"));
  const priv = fromPayment(payment("pi_priv", "b@example.com", "membership_private"));
  assert.ok(std);
  assert.ok(priv);
  assert.equal(std.current_period_end - std.current_period_start, MEMBER_PERIOD_DAYS * 86400);
  assert.equal(priv.current_period_end - priv.current_period_start, MEMBER_PERIOD_DAYS * 86400);
  assert.equal(membershipTierOf(std), "standard");
  assert.equal(membershipTierOf(priv), "private");
  assert.equal(membershipLabel(membershipTierOf(priv)), "Private Membership");

  const stdSummary = membershipSummary(std, []);
  const privSummary = membershipSummary(priv, []);
  assert.equal(stdSummary.credits, MEMBER_CREDITS);
  assert.equal(privSummary.credits, MEMBER_CREDITS);
  assert.equal(stdSummary.remaining, 4);
  assert.equal(privSummary.remaining, 4);
  assert.equal(stdSummary.privacy, "standard");
  assert.equal(privSummary.privacy, "private");
  assert.equal(privSummary.exclusive, true);
});

test("legacy memberships without a tier stay standard", () => {
  const legacy = fromPayment({
    id: "pi_legacy",
    status: "succeeded",
    created: Math.floor(Date.now() / 1000),
    metadata: { type: "membership", email: "legacy@example.com", player: "Lee" },
  });
  assert.equal(membershipTypeOf(legacy), MEMBERSHIP_STANDARD);
  assert.equal(membershipTierOf(legacy), "standard");
  assert.equal(membershipSummary(legacy, []).privacy, "standard");
});

test("one credit per lesson including Hitting & Fielding combined", () => {
  const sub = fromPayment(payment("pi_credits", "c@example.com", "membership"));
  const lesson = makeMemberLesson({
    sub,
    date: chicagoIso(3),
    time: "5:00 PM",
    focus: "Both",
    availability: null,
  });
  assert.equal(lesson.focus, "Both");
  assert.equal(lesson.privacy, "standard");
  assert.equal(lesson.type, "membership");
  const summary = membershipSummary(sub, [lesson]);
  assert.equal(summary.used, 1);
  assert.equal(summary.remaining, 3);
});

test("private membership lesson is exclusive; standard remains shareable", () => {
  const privSub = fromPayment(payment("pi_p", "p@example.com", "membership_private"));
  const privLesson = makeMemberLesson({
    sub: privSub,
    date: chicagoIso(3),
    time: "6:00 PM",
    focus: "Fielding",
    availability: null,
  });
  assert.equal(privLesson.privacy, "private");
  assert.equal(privLesson.seats, SLOT_CAPACITY);

  const bookedPriv = [
    {
      time: "6:00 PM",
      mins: 60,
      seats: SLOT_CAPACITY,
      exclusive: true,
      focuses: ["Fielding"],
      privacy: "private",
    },
  ];
  assert.equal(
    slotBlocked(bookedPriv, "6:00 PM", 60, "Hitting", { seats: 1, privacy: "standard" }),
    true
  );

  const bookedStd = [
    { time: "6:00 PM", mins: 60, seats: 1, focuses: ["Hitting"], privacy: "standard" },
  ];
  assert.equal(
    slotBlocked(bookedStd, "6:00 PM", 60, "Hitting", { seats: 1, privacy: "standard" }),
    false
  );
  assert.equal(
    slotBlocked(bookedStd, "6:00 PM", 60, "Hitting", {
      seats: SLOT_CAPACITY,
      exclusive: true,
      privacy: "private",
    }),
    true
  );
});

test("cancellation restores the correct tier credit", () => {
  const sub = fromPayment(payment("pi_cancel", "x@example.com", "membership_private"));
  const a = makeMemberLesson({
    sub,
    date: chicagoIso(3),
    time: "5:00 PM",
    focus: "Hitting",
    availability: null,
  });
  const b = makeMemberLesson({
    sub,
    date: chicagoIso(4),
    time: "5:00 PM",
    focus: "Hitting",
    availability: null,
  });
  assert.equal(membershipSummary(sub, [a, b]).remaining, 2);
  assert.equal(membershipSummary(sub, [a]).remaining, 3);
});

test("rescheduling preserves privacy and credit accounting", () => {
  const sub = fromPayment(payment("pi_move", "m@example.com", "membership_private"));
  const moved = makeMemberLesson({
    sub,
    date: chicagoIso(5),
    time: "7:00 PM",
    focus: "Both",
    availability: null,
  });
  assert.equal(moved.privacy, "private");
  assert.equal(moved.type, MEMBERSHIP_PRIVATE);
  assert.equal(membershipSummary(sub, [moved]).used, 1);
  assert.equal(membershipSummary(sub, [moved]).remaining, 3);
});

test("expired membership cannot book", () => {
  const sub = fromPayment(payment("pi_exp", "e@example.com", "membership"), 0);
  const summary = membershipSummary(sub, [
    makeMemberLesson({ sub, date: chicagoIso(2), time: "5:00 PM", focus: "Hitting", availability: null }),
    makeMemberLesson({ sub, date: chicagoIso(3), time: "5:00 PM", focus: "Hitting", availability: null }),
    makeMemberLesson({ sub, date: chicagoIso(4), time: "5:00 PM", focus: "Hitting", availability: null }),
    makeMemberLesson({ sub, date: chicagoIso(5), time: "5:00 PM", focus: "Hitting", availability: null }),
  ]);
  assert.equal(summary.remaining, 0);
  assert.match(bookingBlocked(summary, chicagoIso(6), summary.lessons) || "", /used all 4/i);
});

test("standard and private credits do not combine across purchases", () => {
  const std = fromPayment(payment("pi_s1", "both@example.com", "membership"));
  const priv = fromPayment(payment("pi_p1", "both@example.com", "membership_private"));
  const stdLesson = makeMemberLesson({
    sub: std,
    date: chicagoIso(3),
    time: "5:00 PM",
    focus: "Hitting",
    availability: null,
  });
  const privLesson = makeMemberLesson({
    sub: priv,
    date: chicagoIso(4),
    time: "5:00 PM",
    focus: "Hitting",
    availability: null,
  });
  assert.equal(lessonBelongsToMembership(stdLesson, std), true);
  assert.equal(lessonBelongsToMembership(stdLesson, priv), false);
  assert.equal(lessonBelongsToMembership(privLesson, priv), true);
  assert.equal(membershipSummary(std, [stdLesson, privLesson]).used, 1);
  assert.equal(membershipSummary(priv, [stdLesson, privLesson]).used, 1);
});

test("overlapping purchases prefer the newest primary membership", () => {
  const older = fromPayment(payment("pi_old", "o@example.com", "membership", 5));
  const newer = fromPayment(payment("pi_new", "o@example.com", "membership_private", 0));
  const pick = pickPrimaryMembership([older, newer]);
  assert.equal(pick.id, "pi_new");
  assert.equal(membershipTierOf(pick), "private");
});

test("capacity counts standard and private in separate pools", () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(payment(`pi_s${i}`, `std${i}@example.com`, "membership"));
  for (let i = 0; i < 4; i++) rows.push(payment(`pi_p${i}`, `priv${i}@example.com`, "membership_private"));
  const active = activeMembershipsFromPayments(rows);
  assert.equal(active.length, 12);
  const summary = capacitySummary(active, [], "newbie@example.com", "membership");
  assert.equal(summary.standard.limit, 8);
  assert.equal(summary.private.limit, 4);
  assert.equal(summary.standard.available, false);
  assert.equal(summary.private.available, false);
  assert.equal(summary.available, false);
  // Buying Private while both are full stays blocked; with room only in Private:
  const roomPriv = capacitySummary(
    activeMembershipsFromPayments(rows.slice(0, 8)),
    [],
    "newbie@example.com",
    "membership_private"
  );
  assert.equal(roomPriv.standard.available, false);
  assert.equal(roomPriv.private.available, true);
  assert.equal(roomPriv.available, true);
});

test("mixed roster still admits renewals of an existing email in its category", () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    payment(
      `pi_${i}`,
      `m${i}@example.com`,
      i < 8 ? "membership" : "membership_private"
    )
  );
  const active = activeMembershipsFromPayments(rows);
  const summary = capacitySummary(active, [], "m0@example.com", "membership");
  assert.equal(summary.available, true);
  assert.equal(summary.requestedAdmitted, true);
});

test("duplicate Stripe mirror does not duplicate membership lessons", () => {
  const stored = { lessons: [], voids: [] };
  const meta = {
    type: "membership_private",
    privacy: "private",
    player: "Sam",
    email: "dup@example.com",
    focus: "Hitting",
    seats: "2",
    date1: "2099-05-01",
    time1: "5:00 PM",
    loc1: "mustang",
  };
  assert.equal(upsertStripeLessons(stored, "pi_dup", meta), true);
  assert.equal(upsertStripeLessons(stored, "pi_dup", meta), true);
  assert.equal(stored.lessons.filter((l) => l.id === "pi_dup-1").length, 1);
  assert.equal(stored.lessons[0].type, "membership_private");
  assert.equal(stored.lessons[0].privacy, "private");
});

test("cash private membership metadata stamps private tier", () => {
  const now = Math.floor(Date.now() / 1000);
  const row = fromCashMember(
    {
      cashMembership: true,
      cashMembershipStart: now,
      cashMembershipEnd: now + MEMBER_PERIOD_DAYS * 86400,
      membershipType: "membership_private",
      privacy: "private",
      player: "Cash Kid",
    },
    "cash@example.com"
  );
  assert.ok(row);
  assert.equal(membershipTypeOf(row), MEMBERSHIP_PRIVATE);
  assert.equal(membershipSummary(row, []).privacy, "private");
});

test("isMembershipType recognizes both tiers", () => {
  assert.equal(isMembershipType("membership"), true);
  assert.equal(isMembershipType("membership_private"), true);
  assert.equal(isMembershipType("private"), false);
  assert.equal(isMembershipType("single"), false);
});
