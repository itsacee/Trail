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

export const MEMBERSHIP_LIMIT = 15;
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

export function activeMembershipsFromPayments(payments) {
  const byMember = new Map();
  [...(payments || [])]
    .sort((a, b) => Number(b?.created || 0) - Number(a?.created || 0))
    .forEach((payment) => {
      if (payment?.status !== "succeeded" || !isMembershipType(payment?.metadata?.type)) return;
      if (!normalizedEmail(payment?.metadata?.email)) return;
      const membership = fromPayment(payment, payment?.metadata?.email);
      if (!membership) return;
      // One roster spot per email (existing capacity policy). Newest purchase wins
      // the label; both standard and private count toward the shared 15.
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

// A membership stops occupying one of the 15 roster spots as soon as all four
// lesson credits are booked. Keep the Stripe payment for history/accounting;
// only remove the used-up membership from the active roster and capacity count.
// `manual` must be included so Coach Desk cash / desk-booked membership lessons
// count toward the same 4 credits the member portal shows.
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

export function capacitySummary(activeMemberships, pendingCheckouts = [], requestedEmail = "") {
  const occupied = new Map();
  const active = [...(activeMemberships || [])].sort(
    (a, b) => Number(a?.current_period_start || 0) - Number(b?.current_period_start || 0)
  );
  active.forEach((membership) => occupied.set(memberKey(membership), { kind: "active", row: membership }));

  const pending = [...(pendingCheckouts || [])].sort(
    (a, b) => Number(a?.created || 0) - Number(b?.created || 0) || String(a?.id || "").localeCompare(String(b?.id || ""))
  );
  pending.forEach((session) => {
    const key = memberKey(session);
    if (!occupied.has(key)) occupied.set(key, { kind: "pending", row: session });
  });

  const admittedKeys = new Set([...occupied.keys()].slice(0, MEMBERSHIP_LIMIT));
  const requestedKey = requestedEmail ? `email:${normalizedEmail(requestedEmail)}` : "";
  const occupiedCount = Math.min(MEMBERSHIP_LIMIT, occupied.size);
  const spotsAvailable = Math.max(0, MEMBERSHIP_LIMIT - occupiedCount);

  return {
    limit: MEMBERSHIP_LIMIT,
    active: new Set(active.map(memberKey)).size,
    pending: [...occupied.values()].filter((entry) => entry.kind === "pending").length,
    spotsAvailable,
    available: requestedKey ? admittedKeys.has(requestedKey) || spotsAvailable > 0 : spotsAvailable > 0,
    requestedAdmitted: requestedKey ? admittedKeys.has(requestedKey) : null,
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

export async function getMembershipCapacity(stripeKey, requestedEmail = "") {
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
    summary: capacitySummary(activeMemberships, pendingCheckouts, requestedEmail),
    booking_origin: bookingState.origin || storedLessons?._origin || "blob",
  };
}
