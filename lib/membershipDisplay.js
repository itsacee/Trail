// Coach Desk membership-type badge resolution.
// Prefer the active purchase from member-links (Stripe / cash credit window).
// Never let a stale roster card override a verified purchase type, and never
// invent "Standard Membership" when the purchase type is unverified.

import {
  MEMBERSHIP_PRIVATE,
  MEMBERSHIP_STANDARD,
  isMembershipType,
  membershipLabel,
} from "./membershipTypes.js";

export const MEMBERSHIP_TYPE_NEEDS_REVIEW = "Membership type needs review";

/**
 * Resolve the membership-type badge for a Coach Desk member card.
 *
 * @param {{
 *   link?: {
 *     membershipType?: string,
 *     membershipLabel?: string,
 *     membershipTier?: string,
 *     membershipId?: string,
 *   } | null,
 *   desk?: {
 *     membershipType?: string,
 *     membershipLabel?: string,
 *     cashMembership?: boolean,
 *     privacy?: string,
 *   } | null,
 * }} input
 * @returns {{ text: string, source: "purchase"|"cash"|"unverified"|"none", verified: boolean }}
 */
export function resolveCoachMembershipTypeDisplay({ link = null, desk = null } = {}) {
  const purchaseType = String(link?.membershipType || "").toLowerCase();
  if (link && isMembershipType(purchaseType)) {
    const text =
      String(link.membershipLabel || "").trim() ||
      membershipLabel(purchaseType === MEMBERSHIP_PRIVATE ? "private" : "standard");
    return { text, source: "purchase", verified: true };
  }

  // Cash roster cards with an explicit type are authoritative when no Stripe
  // credit window is attached yet (same sources as membership capacity).
  if (desk?.cashMembership) {
    const cashType = String(desk.membershipType || "").toLowerCase();
    if (isMembershipType(cashType)) {
      const text =
        String(desk.membershipLabel || "").trim() ||
        membershipLabel(cashType === MEMBERSHIP_PRIVATE ? "private" : "standard");
      return { text, source: "cash", verified: true };
    }
    if (String(desk.membershipLabel || "").trim()) {
      return {
        text: String(desk.membershipLabel).trim(),
        source: "cash",
        verified: true,
      };
    }
  }

  // Stale desk labels (often left over from an older purchase) must not win.
  if (link || desk?.membershipLabel || desk?.membershipType) {
    return {
      text: MEMBERSHIP_TYPE_NEEDS_REVIEW,
      source: "unverified",
      verified: false,
    };
  }

  return { text: "", source: "none", verified: false };
}

export { MEMBERSHIP_STANDARD, MEMBERSHIP_PRIVATE, membershipLabel };
