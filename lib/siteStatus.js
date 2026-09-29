// Site-wide booking rules. Flip these when the facility situation changes.
//
// To resume normal operation:
//   blockNewMemberships: false
//   membershipFrozen: false
//   fieldingOnly: false

function todayChicago() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export const SITE_STATUS = {
  blockNewMemberships: true,
  blockNewMembershipsReason:
    "New memberships are paused while Mustang redoes the indoor facility. Already a member? Sign in to book fielding lessons — your days aren't counting down. Call or text (405) 819-4401 with questions.",
  membershipFrozen: true,
  membershipFreezeSince: "2026-09-28",
  membershipFrozenReason:
    "Your membership clock is paused while the facility is renovated. Book fielding lessons with your credits — your expiry date isn't counting down right now.",
  fieldingOnly: true,
  fieldingOnlyReason:
    "Mustang is redoing the indoor facility — hitting isn't available right now. Lessons are fielding only until further notice.",
};

export function isMembershipFrozen() {
  return Boolean(SITE_STATUS.membershipFrozen && SITE_STATUS.membershipFreezeSince);
}

export function membershipFreezeDays() {
  if (!isMembershipFrozen()) return 0;
  const start = new Date(`${SITE_STATUS.membershipFreezeSince}T12:00:00`);
  const now = new Date(`${todayChicago()}T12:00:00`);
  return Math.max(0, Math.round((now - start) / 86400000));
}

export function effectivePeriodEnd(periodEndUnix) {
  const end = Number(periodEndUnix) || 0;
  if (!end || !isMembershipFrozen()) return end;
  return end + membershipFreezeDays() * 86400;
}

export function getSiteStatus() {
  return {
    blockNewMemberships: SITE_STATUS.blockNewMemberships,
    blockNewMembershipsReason: SITE_STATUS.blockNewMembershipsReason,
    membershipFrozen: SITE_STATUS.membershipFrozen,
    membershipFreezeSince: SITE_STATUS.membershipFreezeSince,
    membershipFrozenReason: SITE_STATUS.membershipFrozenReason,
    membershipFreezeDays: membershipFreezeDays(),
    fieldingOnly: SITE_STATUS.fieldingOnly,
    fieldingOnlyReason: SITE_STATUS.fieldingOnlyReason,
    // Back-compat for older front-end checks
    membershipPaused: SITE_STATUS.blockNewMemberships,
    membershipPausedReason: SITE_STATUS.blockNewMembershipsReason,
  };
}

export function newMembershipBlockedMessage() {
  if (!SITE_STATUS.blockNewMemberships) return null;
  return SITE_STATUS.blockNewMembershipsReason;
}

/** @deprecated use newMembershipBlockedMessage */
export function membershipBlockedMessage() {
  return newMembershipBlockedMessage();
}

export function allowedFocusValues() {
  if (SITE_STATUS.fieldingOnly) return ["Fielding"];
  return ["Hitting", "Fielding", "Both"];
}

export function normalizeFocus(focus, type) {
  const allowed = allowedFocusValues();
  const value = String(focus || "").trim();
  if (allowed.includes(value)) return value;
  if (SITE_STATUS.fieldingOnly) return "Fielding";
  if (type === "thirty") return "Hitting";
  return "Both";
}

export function focusBlockedMessage(focus) {
  if (!SITE_STATUS.fieldingOnly) return null;
  if (focus === "Fielding") return null;
  return SITE_STATUS.fieldingOnlyReason;
}
