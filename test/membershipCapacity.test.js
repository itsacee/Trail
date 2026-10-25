import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activeMembershipsFromPayments,
  capacitySummary,
  capacityTierOf,
  membershipsWithCredits,
  STANDARD_MEMBERSHIP_CAP,
  PRIVATE_MEMBERSHIP_CAP,
  MEMBERSHIP_TOTAL_CAP,
  MEMBERSHIP_LIMIT,
} from "../lib/membershipCapacity.js";

function payment(id, email, ageDays = 0, extra = {}) {
  return {
    id,
    status: "succeeded",
    created: Math.floor(Date.now() / 1000) - ageDays * 86400,
    metadata: { type: "membership", email, ...extra.metadata },
    ...extra,
  };
}

function active(id, email, started = 1, type = "membership") {
  return {
    id,
    email,
    metadata: { email, type, privacy: type === "membership_private" ? "private" : "standard" },
    current_period_start: started,
    current_period_end: Math.floor(Date.now() / 1000) + 86400,
  };
}

function pending(id, email, created, type = "membership") {
  return { id, created, metadata: { type, email } };
}

test("caps are 8 Standard and 4 Private (12 combined)", () => {
  assert.equal(STANDARD_MEMBERSHIP_CAP, 8);
  assert.equal(PRIVATE_MEMBERSHIP_CAP, 4);
  assert.equal(MEMBERSHIP_TOTAL_CAP, 12);
  assert.equal(MEMBERSHIP_LIMIT, 12);
});

test("capacityTierOf never invents Standard for unknown types", () => {
  assert.equal(capacityTierOf({ metadata: { type: "membership" } }), "standard");
  assert.equal(capacityTierOf({ metadata: { type: "membership_private" } }), "private");
  assert.equal(capacityTierOf({ metadata: { privacy: "private" } }), "private");
  assert.equal(capacityTierOf({ metadata: {} }), "unverified");
  assert.equal(capacityTierOf({ metadata: { type: "single" } }), "unverified");
});

test("activeMembershipsFromPayments counts current members once per email", () => {
  const rows = [
    payment("new", "PARENT@example.com"),
    payment("old", "parent@example.com", 2),
    payment("expired", "past@example.com", 0, {
      created: Math.floor(Date.parse("2026-08-01T12:00:00Z") / 1000),
    }),
    payment("failed", "failed@example.com", 0, { status: "requires_payment_method" }),
    payment("single", "single@example.com", 0, { metadata: { type: "single" } }),
  ];

  const memberships = activeMembershipsFromPayments(rows);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].id, "new");
  assert.equal(memberships[0].email, "parent@example.com");
});

test("membershipsWithCredits removes a member as soon as all four lessons are used", () => {
  const now = Math.floor(Date.now() / 1000);
  const membership = {
    id: "pi_used",
    email: "used@example.com",
    metadata: { email: "used@example.com", type: "membership" },
    current_period_start: now - 86400,
    current_period_end: now + 27 * 86400,
  };
  const dates = Array.from({ length: 4 }, (_, i) =>
    new Date((now + i * 86400) * 1000).toLocaleDateString("en-CA", {
      timeZone: "America/Chicago",
    })
  );
  const stored = {
    voids: [],
    lessons: dates.map((date, i) => ({
      id: `lesson_${i}`,
      email: "used@example.com",
      date,
      time: "6:00 PM",
      type: "membership",
    })),
  };

  assert.equal(membershipsWithCredits([membership], stored).length, 0);
  assert.equal(
    membershipsWithCredits([membership], { ...stored, lessons: stored.lessons.slice(0, 3) }).length,
    1
  );
});

test("membershipsWithCredits counts Coach Desk manual membership lessons toward the 4", () => {
  const now = Math.floor(Date.now() / 1000);
  const email = "cash.desk@example.com";
  const membership = {
    id: `cash_${email}`,
    email,
    metadata: { email, type: "membership", privacy: "standard" },
    current_period_start: now - 86400,
    current_period_end: now + 27 * 86400,
    kind: "cash",
  };
  const dates = Array.from({ length: 4 }, (_, i) =>
    new Date((now + (i + 1) * 86400) * 1000).toLocaleDateString("en-CA", {
      timeZone: "America/Chicago",
    })
  );
  const stored = { voids: [], lessons: [] };
  const manual = {
    bookings: dates.map((date, i) => ({
      id: `mb_${i}`,
      email,
      date,
      time: "6:00 PM",
      type: "membership",
      focus: i === 0 ? "Both" : i === 1 ? "Hitting" : "Fielding",
      status: "scheduled",
      privacy: "standard",
    })),
  };

  assert.equal(membershipsWithCredits([membership], stored).length, 1);
  assert.equal(membershipsWithCredits([membership], stored, manual).length, 0);
  assert.equal(
    membershipsWithCredits([membership], stored, { bookings: manual.bookings.slice(0, 3) }).length,
    1
  );
});

test("Standard sells out at 8/8 while Private can stay open", () => {
  const eightStd = Array.from({ length: 8 }, (_, i) => active(`s${i}`, `std${i}@example.com`, i));
  const onePriv = active("p0", "priv0@example.com", 1, "membership_private");
  const summary = capacitySummary([...eightStd, onePriv]);
  assert.equal(summary.standard.active, 8);
  assert.equal(summary.standard.spotsAvailable, 0);
  assert.equal(summary.standard.available, false);
  assert.equal(summary.private.active, 1);
  assert.equal(summary.private.spotsAvailable, 3);
  assert.equal(summary.private.available, true);
});

test("Private sells out at 4/4 while Standard can stay open", () => {
  const fourPriv = Array.from({ length: 4 }, (_, i) =>
    active(`p${i}`, `priv${i}@example.com`, i, "membership_private")
  );
  const twoStd = Array.from({ length: 2 }, (_, i) => active(`s${i}`, `std${i}@example.com`, i));
  const summary = capacitySummary([...fourPriv, ...twoStd]);
  assert.equal(summary.private.active, 4);
  assert.equal(summary.private.spotsAvailable, 0);
  assert.equal(summary.private.available, false);
  assert.equal(summary.standard.active, 2);
  assert.equal(summary.standard.spotsAvailable, 6);
  assert.equal(summary.standard.available, true);
});

test("requested type uses only that category's availability", () => {
  const eightStd = Array.from({ length: 8 }, (_, i) => active(`s${i}`, `std${i}@example.com`, i));
  const summaryStd = capacitySummary(eightStd, [], "new@example.com", "membership");
  const summaryPriv = capacitySummary(eightStd, [], "new@example.com", "membership_private");
  assert.equal(summaryStd.available, false);
  assert.equal(summaryStd.requestedAdmitted, false);
  assert.equal(summaryPriv.available, true);
  assert.equal(summaryPriv.requestedAdmitted, false); // new email; admitted once checkout reserves
  assert.equal(summaryPriv.private.spotsAvailable, 4);
});

test("open Stripe checkouts reserve the final Standard spot in creation order", () => {
  const activeMembers = Array.from({ length: 7 }, (_, i) => active(`m${i}`, `member${i}@example.com`, i));
  const checkouts = [
    pending("cs_first", "first@example.com", 100, "membership"),
    pending("cs_second", "second@example.com", 101, "membership"),
  ];

  const first = capacitySummary(activeMembers, checkouts, "first@example.com", "membership");
  const second = capacitySummary(activeMembers, checkouts, "second@example.com", "membership");
  assert.equal(first.standard.spotsAvailable, 0);
  assert.equal(first.requestedAdmitted, true);
  assert.equal(second.requestedAdmitted, false);
  // Private checkouts are unaffected.
  const privBuyer = capacitySummary(activeMembers, checkouts, "priv@example.com", "membership_private");
  assert.equal(privBuyer.available, true);
});

test("Private pending checkouts do not consume Standard seats", () => {
  const sevenStd = Array.from({ length: 7 }, (_, i) => active(`s${i}`, `std${i}@example.com`, i));
  const privPending = [pending("cs_p", "newpriv@example.com", 50, "membership_private")];
  const summary = capacitySummary(sevenStd, privPending, "stdnew@example.com", "membership");
  assert.equal(summary.standard.spotsAvailable, 1);
  assert.equal(summary.available, true);
  assert.equal(summary.private.pending, 1);
  assert.equal(summary.private.spotsAvailable, 3);
});

test("an existing active email can renew without taking an extra Standard spot", () => {
  const full = Array.from({ length: STANDARD_MEMBERSHIP_CAP }, (_, i) =>
    active(`m${i}`, `member${i}@example.com`, i)
  );
  const summary = capacitySummary(
    full,
    [pending("cs_renew", "member3@example.com", 100, "membership")],
    "MEMBER3@example.com",
    "membership"
  );

  assert.equal(summary.standard.active, STANDARD_MEMBERSHIP_CAP);
  assert.equal(summary.standard.spotsAvailable, 0);
  assert.equal(summary.available, true);
  assert.equal(summary.requestedAdmitted, true);
});

test("over-cap Standard memberships are grandfathered and block new sales", () => {
  const nine = Array.from({ length: 9 }, (_, i) => active(`m${i}`, `member${i}@example.com`, i));
  const summary = capacitySummary(nine, [], "new@example.com", "membership");
  assert.equal(summary.standard.active, 9);
  assert.equal(summary.standard.overCap, true);
  assert.equal(summary.standard.spotsAvailable, 0);
  assert.equal(summary.available, false);
  const renew = capacitySummary(nine, [], "member0@example.com", "membership");
  assert.equal(renew.available, true);
  assert.equal(renew.requestedAdmitted, true);
});

test("unverified actives are not silently counted as Standard", () => {
  const rows = [
    active("s0", "std@example.com", 1, "membership"),
    {
      id: "mystery",
      email: "mystery@example.com",
      metadata: { email: "mystery@example.com" },
      current_period_start: 1,
      current_period_end: Math.floor(Date.now() / 1000) + 86400,
    },
  ];
  const summary = capacitySummary(rows);
  assert.equal(summary.standard.active, 1);
  assert.equal(summary.unverifiedActive, 1);
  assert.equal(capacityTierOf(rows[1]), "unverified");
});
