// Site-wide booking rules. Flip these when the facility situation changes.
//
// To resume normal operation:
//   membershipPaused: false
//   fieldingOnly: false

export const SITE_STATUS = {
  membershipPaused: true,
  membershipPausedReason:
    "Memberships are paused while Mustang redoes the indoor facility. We'll turn them back on when hitting is available again. Call or text (405) 819-4401 with questions.",
  fieldingOnly: true,
  fieldingOnlyReason:
    "Mustang is redoing the indoor facility — hitting isn't available right now. Lessons are fielding only until further notice.",
};

export function getSiteStatus() {
  return {
    membershipPaused: SITE_STATUS.membershipPaused,
    membershipPausedReason: SITE_STATUS.membershipPausedReason,
    fieldingOnly: SITE_STATUS.fieldingOnly,
    fieldingOnlyReason: SITE_STATUS.fieldingOnlyReason,
  };
}

export function membershipBlockedMessage() {
  if (!SITE_STATUS.membershipPaused) return null;
  return SITE_STATUS.membershipPausedReason;
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
