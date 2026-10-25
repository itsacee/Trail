import {
  fromPayment,
  fromCashMember,
  membershipSummary,
  MEMBER_PERIOD_DAYS,
  isMembershipType,
} from "./members.js";
import { scheduledFor } from "./lessons.js";
import { loadMembersState, isMemberRemoved } from "./membersStore.js";
import { loadAuthoritativeBookingState } from "./bookingReads.js";
import {
  MEMBERSHIP_PRIVATE,
  MEMBERSHIP_STANDARD,
} from "./membershipTypes.js";

/** Separate roster caps — Standard and Private do not share a pool. */
export const STANDARD_MEMBERSHIP_CAP = 8;
export const PRIVATE_MEMBERSHIP_CAP = 4;
/** Combined maximum when both categories are full. */
export const MEMBERSHIP_TOTAL_CAP = STANDARD_MEMBERSHIP_CAP + PRIVATE_MEMBERSHIP_CAP;

/**
 * @deprecated Use STANDARD_MEMBERSHIP_CAP / PRIVATE_MEMBERSHIP_CAP.
 * Kept as the combined ceiling (12) so legacy imports do not silently keep 15.
 */
export const MEMBERSHIP_LIMIT = MEMBERSHIP_TOTAL_CAP;

const PAGE_LIMIT = 100;
const MAX_PAYMENT_PAGES = 10;
export const MEMBERSHIP_CHECKOUT_MINUTES = 31;

async function stripeGet(key, path) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error("Stripe membership lookup failed.");
  return response.json();
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function memberKey(row) {
  const email = normalizedEmail(row?.email || row?.metadata?.email);
  return email ? `email:${email}` : `id:${row?.id || ""}`;
}

/**
 * Classify a membership / checkout for capacity counting.
 * Never invents "standard" for an unknown type — returns "unverified".
 * @returns {"standard"|"private"|"unverified"}
 */
export function capacityTierOf(row) {
  const meta = row?.metadata || row || {};
  const type = String(meta.type || row?.type || "").toLowerCase();
  const privacy = String(meta.privacy || row?.privacy || "").toLowerCase();
  const tier = String(meta.membership_tier || row?.membershipTier || "").toLowerCase();
  if (type === MEMBERSHIP_PRIVATE || privacy === "private" || tier === "private") {
    return "private";
  }
  if (type === MEMBERSHIP_STANDARD || privacy === "standard" || tier === "standard") {
    return "standard";
  }
  return "unverified";
}

export function capForTier(tier) {
  return tier === "private" ? PRIVATE_MEMBERSHIP_CAP : STANDARD_MEMBERSHIP_CAP;
}

export function activeMembershipsFromPayments(payments) {
  const byMember = new Map();
  [...(payments || [])]
    .sort((a, b) => Number(b?.created || 0) - Number(a?.created || 0))
    .forEach((payment) => {
      if (payment?.status !== "succeeded" || !isMembershipType(payment?.metadata?.type)) return;
      if (!normalizedEmail(payment?.metadata?.email)) return;
      const membership = fromPayment(payment, payment?.metadata?.email);
      if (!membership) return;
      // One roster spot per email. Newest purchase wins the tier label.
      const key = memberKey(membership);
      if (!byMember.has(key)) byMember.set(key, membership);
    });
  return [...byMember.values()];
}

export function activeCashMemberships(membersState) {
  return Object.entries(membersState?.byEmail || {})
    .filter(([email]) => !isMemberRemoved(membersState, email))
    .map(([email, row]) => fromCashMember(row, email, membersState))
    .filter(Boolean);
}

// A membership stops occupying its category seat as soon as all four lesson
// credits are booked. Keep the Stripe payment for history/accounting.
export function membershipsWithCredits(memberships, storedLessons, manual = null) {
  return (memberships || []).filter((membership) => {
    const scheduled = scheduledFor(
      membership,
      storedLessons || { lessons: [], voids: [] },
      manual
    );
    return membershipSummary(membership, scheduled).remaining > 0;
  });
}

/**
 * Per-tier capacity: actives are grandfathered even above the cap; only new
 * emails compete for max(0, limit - activeCount) pending slots.
 */
function tierSummary(tier, activeMemberships, pendingCheckouts, requestedEmail = "") {
  const limit = capForTier(tier);
  const active = [...(activeMemberships || [])]
    .filter((row) => capacityTierOf(row) === tier)
    .sort(
      (a, b) => Number(a?.current_period_start || 0) - Number(b?.current_period_start || 0)
    );
  const pending = [...(pendingCheckouts || [])]
    .filter((row) => capacityTierOf(row) === tier)
    .sort(
      (a, b) =>
        Number(a?.created || 0) - Number(b?.created || 0) ||
        String(a?.id || "").localeCompare(String(b?.id || ""))
    );

  const activeKeys = new Set(active.map(memberKey));
  const occupied = new Map();
  active.forEach((membership) => occupied.set(memberKey(membership), { kind: "active", row: membership }));

  // Renewals (same email already active in this tier) always keep their seat.
  // New emails only take free slots under the cap.
  let freeSlots = Math.max(0, limit - activeKeys.size);
  const admittedKeys = new Set(activeKeys);
  pending.forEach((session) => {
    const key = memberKey(session);
    if (activeKeys.has(key)) {
      occupied.set(key, occupied.get(key) || { kind: "active", row: session });
      admittedKeys.add(key);
      return;
    }
    if (occupied.has(key)) return;
    if (freeSlots > 0) {
      occupied.set(key, { kind: "pending", row: session });
      admittedKeys.add(key);
      freeSlots -= 1;
    }
  });

  const occupiedCount = occupied.size;
  const spotsAvailable = Math.max(0, limit - occupiedCount);
  const requestedKey = requestedEmail ? `email:${normalizedEmail(requestedEmail)}` : "";
  const requestedAdmitted = requestedKey ? admittedKeys.has(requestedKey) : null;
  const available = requestedKey
    ? Boolean(requestedAdmitted) || spotsAvailable > 0
    : spotsAvailable > 0;

  return {
    tier,
    limit,
    active: activeKeys.size,
    pending: [...occupied.values()].filter((entry) => entry.kind === "pending").length,
    spotsAvailable,
    available,
    requestedAdmitted,
    overCap: activeKeys.size > limit,
  };
}

/**
 * @param {object[]} activeMemberships
 * @param {object[]} pendingCheckouts
 * @param {string} requestedEmail
 * @param {string} [requestedTypeOrTier] membership | membership_private | standard | private
 */
export function capacitySummary(
  activeMemberships,
  pendingCheckouts = [],
  requestedEmail = "",
  requestedTypeOrTier = ""
) {
  const unverified = (activeMemberships || []).filter((row) => capacityTierOf(row) === "unverified");
  const standard = tierSummary("standard", activeMemberships, pendingCheckouts, requestedEmail);
  const privateTier = tierSummary("private", activeMemberships, pendingCheckouts, requestedEmail);

  const requestedKind = String(requestedTypeOrTier || "").toLowerCase();
  let requested = null;
  if (requestedKind === "private" || requestedKind === MEMBERSHIP_PRIVATE) {
    requested = privateTier;
  } else if (requestedKind === "standard" || requestedKind === MEMBERSHIP_STANDARD) {
    requested = standard;
  }

  return {
    standard,
    private: privateTier,
    unverifiedActive: unverified.length,
    // Combined helpers for Coach Desk totals / legacy readers.
    limit: MEMBERSHIP_TOTAL_CAP,
    active: standard.active + privateTier.active,
    pending: standard.pending + privateTier.pending,
    spotsAvailable: standard.spotsAvailable + privateTier.spotsAvailable,
    // When a type is specified, availability is for that category only.
    available: requested ? requested.available : standard.available || privateTier.available,
    requestedAdmitted: requested ? requested.requestedAdmitted : null,
    requestedTier: requested ? requested.tier : null,
  };
}

export async function listActiveMemberships(stripeKey) {
  const since = Math.floor(Date.now() / 1000) - (MEMBER_PERIOD_DAYS + 7) * 86400;
  const payments = [];
  let startingAfter = "";

  for (let page = 0; page < MAX_PAYMENT_PAGES; page++) {
    const suffix = startingAfter ? `&starting_after=${encodeURIComponent(startingAfter)}` : "";
    const result = await stripeGet(
      stripeKey,
      `payment_intents?limit=${PAGE_LIMIT}&created[gte]=${since}${suffix}`
    );
    const rows = Array.isArray(result?.data) ? result.data : [];
    payments.push(...rows);
    if (!result?.has_more || !rows.length) break;
    startingAfter = rows[rows.length - 1].id;
  }

  return activeMembershipsFromPayments(payments);
}

export async function listPendingMembershipCheckouts(stripeKey) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - (MEMBERSHIP_CHECKOUT_MINUTES + 1) * 60;
  const result = await stripeGet(
    stripeKey,
    `checkout/sessions?limit=${PAGE_LIMIT}&status=open&created[gte]=${since}`
  );
  return (result?.data || []).filter(
    (session) =>
      isMembershipType(session?.metadata?.type) &&
      Number(session?.expires_at || 0) > now
  );
}

export async function getMembershipCapacity(stripeKey, requestedEmail = "", requestedTypeOrTier = "") {
  const [paidMemberships, pendingCheckouts, bookingState, membersState] = await Promise.all([
    listActiveMemberships(stripeKey),
    listPendingMembershipCheckouts(stripeKey),
    loadAuthoritativeBookingState(),
    loadMembersState(),
  ]);
  const storedLessons = bookingState.lessons;
  const cashMemberships = activeCashMemberships(membersState);
  const activeMemberships = membershipsWithCredits(
    [...paidMemberships, ...cashMemberships],
    storedLessons,
    bookingState.manual
  );
  return {
    activeMemberships,
    pendingCheckouts,
    summary: capacitySummary(
      activeMemberships,
      pendingCheckouts,
      requestedEmail,
      requestedTypeOrTier
    ),
    booking_origin: bookingState.origin || storedLessons?._origin || "blob",
  };
}

export function membershipFullMessage(tier) {
  const label = tier === "private" ? "Private" : "Standard";
  const limit = capForTier(tier === "private" ? "private" : "standard");
  return `${label} Memberships are full right now — all ${limit} spots are taken. A spot will reopen automatically when a ${label.toLowerCase()} membership ends or uses all four lessons.`;
}
