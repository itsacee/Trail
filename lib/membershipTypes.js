// Membership purchase tiers. Standard keeps type "membership" for compatibility.
// Private uses "membership_private". Focus never decides privacy.

export const MEMBERSHIP_STANDARD = "membership";
export const MEMBERSHIP_PRIVATE = "membership_private";

export function isMembershipType(type) {
  return type === MEMBERSHIP_STANDARD || type === MEMBERSHIP_PRIVATE;
}

export function normalizeMembershipType(type) {
  return type === MEMBERSHIP_PRIVATE ? MEMBERSHIP_PRIVATE : MEMBERSHIP_STANDARD;
}

/** @returns {"standard"|"private"} */
export function membershipTierFromType(type) {
  return type === MEMBERSHIP_PRIVATE ? "private" : "standard";
}

/** Privacy stamp for a membership purchase type. */
export function membershipPrivacyForType(type) {
  return membershipTierFromType(type) === "private" ? "private" : "standard";
}

/**
 * Tier of an existing membership row / Stripe payment / cash record.
 * Missing type → standard (legacy purchases).
 */
export function membershipTierOf(subOrMeta) {
  const meta = subOrMeta?.metadata || subOrMeta || {};
  const type = String(meta.type || subOrMeta?.type || "").toLowerCase();
  const privacy = String(meta.privacy || subOrMeta?.privacy || "").toLowerCase();
  if (type === MEMBERSHIP_PRIVATE || privacy === "private") return "private";
  return "standard";
}

export function membershipTypeOf(subOrMeta) {
  return membershipTierOf(subOrMeta) === "private" ? MEMBERSHIP_PRIVATE : MEMBERSHIP_STANDARD;
}

export function membershipLabel(tierOrType) {
  const tier =
    tierOrType === "private" || tierOrType === MEMBERSHIP_PRIVATE ? "private" : "standard";
  return tier === "private" ? "Private Membership" : "Standard Membership";
}

/** True when a lesson row spends a membership credit (not a drop-in). */
export function isMembershipLesson(lesson) {
  const type = String(lesson?.type || "").toLowerCase();
  if (isMembershipType(type)) return true;
  // Legacy portal lessons sometimes omitted type.
  if (!type && (lesson?.source === "member" || lesson?.subId)) return true;
  return false;
}

/** Tier of a booked membership lesson. Legacy / missing privacy → standard. */
export function lessonMembershipTier(lesson) {
  const type = String(lesson?.type || "").toLowerCase();
  if (type === MEMBERSHIP_PRIVATE) return "private";
  if (type === "private") return "private"; // should not credit, but never treat as standard
  const privacy = String(lesson?.privacy || "").toLowerCase();
  if (privacy === "private") return "private";
  return "standard";
}

/**
 * Attribute a scheduled lesson to one purchased membership.
 * Prefer explicit subId (portal books) or Stripe sourceId == payment id.
 * Cash first-lessons use a manual booking id as sourceId — those fall through
 * to tier matching so they still count on the cash membership.
 */
export function lessonBelongsToMembership(lesson, sub) {
  if (!lesson || !sub) return false;
  if (!isMembershipLesson(lesson)) return false;
  const purchaseId = String(sub.id || "");
  const subId = String(lesson.subId || "");
  if (subId && purchaseId && subId === purchaseId) return true;
  if (subId && purchaseId && subId !== purchaseId) return false;

  const sourceId = String(lesson.sourceId || "");
  if (lesson.source === "stripe" && sourceId && purchaseId) {
    return sourceId === purchaseId;
  }
  return lessonMembershipTier(lesson) === membershipTierOf(sub);
}
