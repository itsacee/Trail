import { fromPayment, MEMBER_PERIOD_DAYS } from "./members.js";

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
      if (payment?.status !== "succeeded" || String(payment?.metadata?.type || "") !== "membership") return;
      if (!normalizedEmail(payment?.metadata?.email)) return;
      const membership = fromPayment(payment, payment?.metadata?.email);
      if (!membership) return;
      const key = memberKey(membership);
      if (!byMember.has(key)) byMember.set(key, membership);
    });
  return [...byMember.values()];
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
      String(session?.metadata?.type || "") === "membership" &&
      Number(session?.expires_at || 0) > now
  );
}

export async function getMembershipCapacity(stripeKey, requestedEmail = "") {
  const [activeMemberships, pendingCheckouts] = await Promise.all([
    listActiveMemberships(stripeKey),
    listPendingMembershipCheckouts(stripeKey),
  ]);
  return {
    activeMemberships,
    pendingCheckouts,
    summary: capacitySummary(activeMemberships, pendingCheckouts, requestedEmail),
  };
}
