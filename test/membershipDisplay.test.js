// Coach Desk membership-type badge: purchase wins over stale roster labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCoachMembershipTypeDisplay,
  MEMBERSHIP_TYPE_NEEDS_REVIEW,
} from "../lib/membershipDisplay.js";

test("active private purchase wins over stale desk Standard label (Dylan case)", () => {
  const out = resolveCoachMembershipTypeDisplay({
    desk: {
      membershipType: "membership",
      membershipLabel: "Standard Membership",
      privacy: "standard",
    },
    link: {
      membershipId: "pi_private_current",
      membershipType: "membership_private",
      membershipLabel: "Private Membership",
      membershipTier: "private",
    },
  });
  assert.equal(out.text, "Private Membership");
  assert.equal(out.source, "purchase");
  assert.equal(out.verified, true);
});

test("active standard purchase wins over stale desk Private label", () => {
  const out = resolveCoachMembershipTypeDisplay({
    desk: {
      membershipType: "membership",
      membershipLabel: "Private Membership",
      privacy: "private",
    },
    link: {
      membershipId: "pi_standard_current",
      membershipType: "membership",
      membershipLabel: "Standard Membership",
      membershipTier: "standard",
    },
  });
  assert.equal(out.text, "Standard Membership");
  assert.equal(out.source, "purchase");
  assert.equal(out.verified, true);
});

test("cash membership with explicit type is accepted when no purchase link", () => {
  const out = resolveCoachMembershipTypeDisplay({
    desk: {
      cashMembership: true,
      membershipType: "membership_private",
      membershipLabel: "Private Membership",
    },
    link: null,
  });
  assert.equal(out.text, "Private Membership");
  assert.equal(out.source, "cash");
  assert.equal(out.verified, true);
});

test("stale desk label without a verified purchase needs review (no Standard default)", () => {
  const out = resolveCoachMembershipTypeDisplay({
    desk: {
      membershipType: "membership",
      membershipLabel: "Standard Membership",
      privacy: "standard",
    },
    link: null,
  });
  assert.equal(out.text, MEMBERSHIP_TYPE_NEEDS_REVIEW);
  assert.equal(out.verified, false);
  assert.notEqual(out.text, "Standard Membership");
});

test("purchase link missing membershipType needs review instead of desk fallback", () => {
  const out = resolveCoachMembershipTypeDisplay({
    desk: { membershipLabel: "Standard Membership" },
    link: { membershipId: "pi_x", membershipLabel: "Standard Membership" },
  });
  assert.equal(out.text, MEMBERSHIP_TYPE_NEEDS_REVIEW);
  assert.equal(out.verified, false);
});

test("no desk type and no link shows no badge", () => {
  const out = resolveCoachMembershipTypeDisplay({ desk: { player: "Sam" }, link: null });
  assert.equal(out.text, "");
  assert.equal(out.source, "none");
});
