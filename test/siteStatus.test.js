// Facility-wide flags. The freeze is the delicate one: memberships are on sale
// during the facility work, so the paused clock must only hold the memberships
// that were already running when the freeze started.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SITE_STATUS,
  isMembershipFrozen,
  isPeriodFrozen,
  effectivePeriodEnd,
  membershipFreezeDays,
  allowedFocusValues,
  normalizeFocus,
  focusBlockedMessage,
  newMembershipBlockedMessage,
  getSiteStatus,
} from "../lib/siteStatus.js";

const DAY = 86400;
const freezeStart = Math.floor(new Date(`${SITE_STATUS.membershipFreezeSince}T12:00:00Z`).getTime() / 1000);

test("memberships are on sale, and nothing blocks a new one", () => {
  assert.equal(SITE_STATUS.blockNewMemberships, false);
  assert.equal(newMembershipBlockedMessage(), null);
  assert.equal(getSiteStatus().blockNewMemberships, false);
});

test("lessons are still fielding only, and that message is still there", () => {
  assert.equal(isMembershipFrozen(), true);
  assert.deepEqual(allowedFocusValues(), ["Fielding"]);
  assert.equal(normalizeFocus("Hitting", "single"), "Fielding");
  assert.equal(normalizeFocus("Both", "single"), "Fielding");
  assert.equal(focusBlockedMessage("Fielding"), null);
  assert.match(focusBlockedMessage("Hitting"), /Mustang/);
  assert.match(getSiteStatus().fieldingOnlyReason, /fielding only/i);
});

test("a membership bought before the freeze keeps its paused clock", () => {
  const start = freezeStart - 10 * DAY;
  const end = start + 30 * DAY;
  assert.equal(isPeriodFrozen(start), true);
  assert.equal(effectivePeriodEnd(end, start), end + membershipFreezeDays() * DAY);
});

test("a membership bought during the freeze runs on its normal 30 days", () => {
  const start = freezeStart + 2 * DAY;
  const end = start + 30 * DAY;
  assert.equal(isPeriodFrozen(start), false);
  // No bonus days, however long the facility work runs.
  assert.equal(effectivePeriodEnd(end, start), end);
});

test("a later buyer doesn't collect a bigger extension than an earlier one", () => {
  const early = freezeStart + 1 * DAY;
  const late = freezeStart + 20 * DAY;
  const span = 30 * DAY;
  assert.equal(effectivePeriodEnd(early + span, early) - (early + span), 0);
  assert.equal(effectivePeriodEnd(late + span, late) - (late + span), 0);
});

test("an unknown start date is treated as frozen, so nobody loses days by accident", () => {
  assert.equal(isPeriodFrozen(0), true);
  const end = freezeStart + 30 * DAY;
  assert.equal(effectivePeriodEnd(end), end + membershipFreezeDays() * DAY);
  assert.equal(effectivePeriodEnd(0, 0), 0);
});

test("AP_SITE_NORMAL=1 opens everything back up", () => {
  const previous = process.env.AP_SITE_NORMAL;
  process.env.AP_SITE_NORMAL = "1";
  try {
    assert.equal(isMembershipFrozen(), false);
    assert.equal(isPeriodFrozen(freezeStart - 10 * DAY), false);
    assert.deepEqual(allowedFocusValues(), ["Hitting", "Fielding", "Both"]);
    assert.equal(focusBlockedMessage("Hitting"), null);
  } finally {
    previous === undefined
      ? delete process.env.AP_SITE_NORMAL
      : (process.env.AP_SITE_NORMAL = previous);
  }
});
