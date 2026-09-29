// Site-wide booking rules. Defaults are below; the coach can override them
// from Coach Desk (Blob coach-status.json) without a redeploy.
//
// Env escape hatch: AP_SITE_NORMAL=1 forces everything open.

import { coachStatusCached } from "./coachStatus.js";

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

function override() {
  return coachStatusCached() || {};
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

export function effectivePeriodEnd(periodEndUnix) {
  const end = Number(periodEndUnix) || 0;
  if (!end || !isMembershipFrozen()) return end;
  return end + membershipFreezeDays() * 86400;
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
