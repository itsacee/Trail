// Facility-wide flags and the completed historical membership extension.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SITE_STATUS,
  FACILITY_FREEZE_START,
  FACILITY_REOPENED,
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
const unix = (date) => Math.floor(new Date(`${date}T12:00:00Z`).getTime() / 1000);
const freezeStart = unix(FACILITY_FREEZE_START);
const reopened = unix(FACILITY_REOPENED);

test("the reopened site sells memberships and offers every focus", () => {
  assert.equal(SITE_STATUS.blockNewMemberships, false);
  assert.equal(newMembershipBlockedMessage(), null);
  assert.equal(getSiteStatus().blockNewMemberships, false);
  assert.equal(isMembershipFrozen(), false);
  assert.equal(membershipFreezeDays(), 0);
  assert.deepEqual(allowedFocusValues(), ["Hitting", "Fielding", "Both"]);
  assert.equal(normalizeFocus("Hitting", "single"), "Hitting");
  assert.equal(normalizeFocus("Both", "single"), "Both");
  assert.equal(focusBlockedMessage("Fielding"), null);
  assert.equal(focusBlockedMessage("Hitting"), null);
});

test("a membership active across the completed pause keeps six extra days", () => {
  const start = freezeStart - 10 * DAY;
  const end = start + 30 * DAY;
  assert.equal(isPeriodFrozen(start), false);
  assert.equal(reopened - freezeStart, 6 * DAY);
  assert.equal(effectivePeriodEnd(end, start), end + 6 * DAY);
});

test("a membership started during the pause keeps its normal 30 days", () => {
  const start = freezeStart + 2 * DAY;
  const end = start + 30 * DAY;
  assert.equal(isPeriodFrozen(start), false);
  assert.equal(effectivePeriodEnd(end, start), end);
});

test("a membership that expired before the pause receives no extension", () => {
  const start = freezeStart - 40 * DAY;
  const end = freezeStart - 10 * DAY;
  assert.equal(effectivePeriodEnd(end, start), end);
});

test("AP_SITE_NORMAL=1 remains harmless while the site is open", () => {
  const previous = process.env.AP_SITE_NORMAL;
  process.env.AP_SITE_NORMAL = "1";
  try {
    assert.equal(isMembershipFrozen(), false);
    assert.equal(isPeriodFrozen(freezeStart - 10 * DAY), false);
    assert.deepEqual(allowedFocusValues(), ["Hitting", "Fielding", "Both"]);
    assert.equal(focusBlockedMessage("Hitting"), null);
    assert.equal(newMembershipBlockedMessage(), null);
  } finally {
    previous === undefined
      ? delete process.env.AP_SITE_NORMAL
      : (process.env.AP_SITE_NORMAL = previous);
  }
});
