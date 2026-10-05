// Site-wide booking rules. Defaults are below; the coach can override them
// from Coach Desk (Blob coach-status.json) without a redeploy.
//
// Env escape hatch: AP_SITE_NORMAL=1 forces everything open.

import { coachStatusCached } from "./coachStatus.js";

export const SITE_STATUS_VERSION = 2;
export const FACILITY_FREEZE_START = "2026-09-28";
export const FACILITY_REOPENED = "2026-10-04";

function todayChicago() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export const SITE_STATUS = {
  blockNewMemberships: false,
  blockNewMembershipsReason:
    "New memberships are temporarily unavailable. Call or text (405) 819-4401 with questions.",
  membershipFrozen: false,
  membershipFreezeSince: null,
  membershipFrozenReason:
    "Membership expiration dates are temporarily paused.",
  fieldingOnly: false,
  fieldingOnlyReason:
    "Hitting is temporarily unavailable. Lessons are fielding only until further notice.",
};

function override() {
  const saved = coachStatusCached() || {};
  // Ignore the old renovation-era Blob flags. The next Coach Desk save writes
  // this version, so future pause toggles still work normally.
  return Number(saved.siteStatusVersion) === SITE_STATUS_VERSION ? saved : {};
}

function flag(key) {
  const o = override();
  if (typeof o[key] === "boolean") return o[key];
  return Boolean(SITE_STATUS[key]);
}

function reason(key, fallbackKey) {
  const o = override();
  if (typeof o[key] === "string" && o[key].trim()) return o[key];
  return SITE_STATUS[fallbackKey || key] || "";
}

export function isMembershipFrozen() {
  if (process.env.AP_SITE_NORMAL === "1") return false;
  return Boolean(flag("membershipFrozen") && (override().membershipFreezeSince || SITE_STATUS.membershipFreezeSince));
}

export function membershipFreezeDays() {
  if (!isMembershipFrozen()) return 0;
  const since = override().membershipFreezeSince || SITE_STATUS.membershipFreezeSince;
  const start = new Date(`${since}T12:00:00`);
  const now = new Date(`${todayChicago()}T12:00:00`);
  return Math.max(0, Math.round((now - start) / 86400000));
}

function daysBetween(startKey, endKey) {
  const start = new Date(`${startKey}T12:00:00`);
  const end = new Date(`${endKey}T12:00:00`);
  return Math.max(0, Math.round((end - start) / 86400000));
}

function freezeSince() {
  return override().membershipFreezeSince || SITE_STATUS.membershipFreezeSince;
}

function chicagoKey(unix) {
  return new Date(Number(unix) * 1000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

// Whether this particular membership's clock is paused. Only memberships that
// were already running when the freeze started are held: someone who buys
// during the freeze knew what they were buying, so their 30 days run normally.
// Without this, selling memberships mid-freeze would hand out a longer and
// longer free extension the later somebody bought.
export function isPeriodFrozen(periodStartUnix) {
  if (!isMembershipFrozen()) return false;
  const start = Number(periodStartUnix) || 0;
  if (!start) return true;
  return chicagoKey(start) < freezeSince();
}

export function effectivePeriodEnd(periodEndUnix, periodStartUnix = 0) {
  const end = Number(periodEndUnix) || 0;
  if (!end) return end;

  const start = Number(periodStartUnix) || 0;
  const startKey = start ? chicagoKey(start) : "";
  const endKey = chicagoKey(end);
  const wasActiveWhenFacilityPaused =
    (!startKey || startKey < FACILITY_FREEZE_START) && endKey >= FACILITY_FREEZE_START;
  const completedFacilityBonus = wasActiveWhenFacilityPaused
    ? daysBetween(FACILITY_FREEZE_START, FACILITY_REOPENED)
    : 0;
  const activePauseBonus = isPeriodFrozen(periodStartUnix) ? membershipFreezeDays() : 0;
  return end + (completedFacilityBonus + activePauseBonus) * 86400;
}

export function getSiteStatus() {
  const o = override();
  const frozen = isMembershipFrozen();
  const blockNew = process.env.AP_SITE_NORMAL === "1" ? false : flag("blockNewMemberships");
  const fieldingOnly = process.env.AP_SITE_NORMAL === "1" ? false : flag("fieldingOnly");
  return {
    blockNewMemberships: blockNew,
    blockNewMembershipsReason: reason("blockNewMembershipsReason"),
    membershipFrozen: frozen,
    membershipFreezeSince: o.membershipFreezeSince || SITE_STATUS.membershipFreezeSince,
    membershipFrozenReason: reason("membershipFrozenReason"),
    membershipFreezeDays: membershipFreezeDays(),
    fieldingOnly,
    fieldingOnlyReason: reason("fieldingOnlyReason"),
    membershipPaused: blockNew,
    membershipPausedReason: reason("blockNewMembershipsReason"),
  };
}

export function newMembershipBlockedMessage() {
  if (process.env.AP_SITE_NORMAL === "1") return null;
  if (!flag("blockNewMemberships")) return null;
  return reason("blockNewMembershipsReason");
}

/** @deprecated use newMembershipBlockedMessage */
export function membershipBlockedMessage() {
  return newMembershipBlockedMessage();
}

export function allowedFocusValues() {
  if (process.env.AP_SITE_NORMAL === "1") return ["Hitting", "Fielding", "Both"];
  if (flag("fieldingOnly")) return ["Fielding"];
  return ["Hitting", "Fielding", "Both"];
}

export function normalizeFocus(focus, type) {
  const allowed = allowedFocusValues();
  const value = String(focus || "").trim();
  if (allowed.includes(value)) return value;
  if (flag("fieldingOnly")) return "Fielding";
  if (type === "thirty") return "Hitting";
  return "Both";
}

export function focusBlockedMessage(focus) {
  if (process.env.AP_SITE_NORMAL === "1") return null;
  if (!flag("fieldingOnly")) return null;
  if (focus === "Fielding") return null;
  return reason("fieldingOnlyReason");
}
