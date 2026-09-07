import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activeMembershipsFromPayments,
  capacitySummary,
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

function active(id, email, started = 1) {
  return {
    id,
    email,
    metadata: { email },
    current_period_start: started,
    current_period_end: Math.floor(Date.now() / 1000) + 86400,
  };
}

function pending(id, email, created) {
  return { id, created, metadata: { type: "membership", email } };
}

test("activeMembershipsFromPayments counts current members once per coach-page email", () => {
  const rows = [
    payment("new", "PARENT@example.com"),
    payment("old", "parent@example.com", 2),
    payment("expired", "past@example.com", 29),
    payment("failed", "failed@example.com", 0, { status: "requires_payment_method" }),
    payment("single", "single@example.com", 0, { metadata: { type: "single" } }),
  ];

  const memberships = activeMembershipsFromPayments(rows);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].id, "new");
  assert.equal(memberships[0].email, "parent@example.com");
});

test("capacitySummary opens and closes at exactly 15 active memberships", () => {
  const fourteen = Array.from({ length: 14 }, (_, i) => active(`m${i}`, `member${i}@example.com`, i));
  const open = capacitySummary(fourteen);
  assert.equal(open.limit, MEMBERSHIP_LIMIT);
  assert.equal(open.active, 14);
  assert.equal(open.spotsAvailable, 1);
  assert.equal(open.available, true);

  const full = capacitySummary([...fourteen, active("m14", "member14@example.com", 14)]);
  assert.equal(full.active, 15);
  assert.equal(full.spotsAvailable, 0);
  assert.equal(full.available, false);
});

test("open Stripe checkouts reserve the final spot in creation order", () => {
  const activeMembers = Array.from(
    { length: 14 },
    (_, i) => active(`m${i}`, `member${i}@example.com`, i)
  );
  const checkouts = [
    pending("cs_first", "first@example.com", 100),
    pending("cs_second", "second@example.com", 101),
  ];

  const first = capacitySummary(activeMembers, checkouts, "first@example.com");
  const second = capacitySummary(activeMembers, checkouts, "second@example.com");
  assert.equal(first.spotsAvailable, 0);
  assert.equal(first.requestedAdmitted, true);
  assert.equal(second.requestedAdmitted, false);
});

test("an existing active email can renew without taking a sixteenth spot", () => {
  const full = Array.from(
    { length: MEMBERSHIP_LIMIT },
    (_, i) => active(`m${i}`, `member${i}@example.com`, i)
  );
  const summary = capacitySummary(
    full,
    [pending("cs_renew", "member3@example.com", 100)],
    "MEMBER3@example.com"
  );

  assert.equal(summary.active, MEMBERSHIP_LIMIT);
  assert.equal(summary.spotsAvailable, 0);
  assert.equal(summary.available, true);
  assert.equal(summary.requestedAdmitted, true);
});
