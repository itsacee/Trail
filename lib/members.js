import { labelToMin } from "./schedule.js";

export const MEMBER_CREDITS = 4;
export const MEMBER_PERIOD_DAYS = 28; // one paid month = 4 weeks, then they buy again
export const CANCEL_HOURS = 12;
const ACTIVE = ["active", "trialing", "past_due"];

export function chicagoDate(unix) {
  return new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// "2026-09-19" -> "Saturday, September 19"
export function prettyDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (isNaN(d)) return iso;
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

export function inPeriod(iso, periodStart, periodEnd) {
  const start = chicagoDate(periodStart);
  const end = chicagoDate(periodEnd);
  return iso >= start && iso < end;
}

function isChicagoDST(y, m, d) {
  // US DST: 2nd Sunday in March → 1st Sunday in November
  const firstWeekday = (year, month) => new Date(year, month - 1, 1).getDay();
  const nthSunday = (year, month, n) => 1 + ((7 - firstWeekday(year, month)) % 7) + (n - 1) * 7;
  const start = nthSunday(y, 3, 2);
  const end = nthSunday(y, 11, 1);
  const val = y * 10000 + m * 100 + d;
  return val >= y * 10000 + 3 * 100 + start && val < y * 10000 + 11 * 100 + end;
}

export function lessonStartMs(iso, timeLabel) {
  const min = labelToMin(timeLabel);
  if (min === null) return NaN;
  const [y, m, d] = iso.split("-").map(Number);
  const hh = String(Math.floor(min / 60)).padStart(2, "0");
  const mm = String(min % 60).padStart(2, "0");
  const offset = isChicagoDST(y, m, d) ? "-05:00" : "-06:00";
  return new Date(`${iso}T${hh}:${mm}:00${offset}`).getTime();
}

export function canCancelLesson(iso, timeLabel) {
  const start = lessonStartMs(iso, timeLabel);
  if (Number.isNaN(start)) return false;
  return start - Date.now() >= CANCEL_HOURS * 3600 * 1000;
}

export function todayChicago() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export function daysAhead(iso) {
  const a = new Date(`${todayChicago()}T12:00:00`);
  const b = new Date(`${iso}T12:00:00`);
  return Math.round((b - a) / 86400000);
}

async function stripeGet(key, path) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return null;
  return r.json();
}

export function fromPayment(pi, email) {
  if (!pi || pi.status !== "succeeded") return null;
  const start = Number(pi.created) || 0;
  const end = start + MEMBER_PERIOD_DAYS * 86400;
  if (!start || end * 1000 < Date.now()) return null;
  const m = pi.metadata || {};
  return {
    id: pi.id,
    metadata: m,
    email: String(m.email || email || "").toLowerCase(),
    current_period_start: start,
    current_period_end: end,
    kind: "payment",
  };
}

function fromSubscription(sub, email) {
  if (!sub || !ACTIVE.includes(sub.status)) return null;
  const m = sub.metadata || {};
  return {
    id: sub.id,
    metadata: m,
    email: String(m.email || email || "").toLowerCase(),
    current_period_start: sub.current_period_start,
    current_period_end: sub.current_period_end,
    kind: "subscription",
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
}

async function stopAutoRenew(key, sub) {
  if (!sub?.id || sub.cancel_at_period_end) return;
  try {
    await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ cancel_at_period_end: "true" }),
    });
  } catch {
    /* they can still use this period; next charge is the thing we're stopping */
  }
}

// Case-insensitive sweep of recent membership payments. Slower than Stripe's
// search index, so it's only used when the search comes back empty.
async function scanRecentMemberships(key, e) {
  const since = Math.floor(Date.now() / 1000) - (MEMBER_PERIOD_DAYS + 7) * 86400;
  const list = await stripeGet(key, `payment_intents?limit=100&created[gte]=${since}`);
  return (
    (list?.data || [])
      .filter(
        (pi) =>
          pi.status === "succeeded" &&
          String(pi.metadata?.type || "") === "membership" &&
          String(pi.metadata?.email || "").trim().toLowerCase() === e
      )
      .map((pi) => fromPayment(pi, e))
      .filter(Boolean)
      .sort((a, b) => b.current_period_start - a.current_period_start)[0] || null
  );
}

export async function findMembership(key, email) {
  const e = String(email || "")
    .trim()
    .toLowerCase()
    .replace(/['\\]/g, "");
  if (!e || !e.includes("@")) return null;

  const piSearch = await stripeGet(
    key,
    `payment_intents/search?query=${encodeURIComponent(
      `status:'succeeded' AND metadata['type']:'membership' AND metadata['email']:'${e}'`
    )}&limit=20`
  );
  const payments = (piSearch?.data || [])
    .map((pi) => fromPayment(pi, e))
    .filter(Boolean)
    .sort((a, b) => b.current_period_start - a.current_period_start);
  if (payments[0]) return payments[0];

  // Stripe's metadata search matches exactly, capitals and all, and checkout
  // stores whatever the parent typed — so "TFlyingOut89@gmail.com" is invisible
  // to a search for the lowercase form. Scan recent payments and compare
  // case-insensitively, the same way /api/member-links finds people.
  const scanned = await scanRecentMemberships(key, e);
  if (scanned) return scanned;

  const customers = await stripeGet(key, `customers?email=${encodeURIComponent(e)}&limit=5`);
  for (const c of customers?.data || []) {
    const list = await stripeGet(key, `payment_intents?customer=${c.id}&limit=20`);
    (list?.data || []).forEach((pi) => {
      if (String(pi.metadata?.type || "") !== "membership") return;
      const row = fromPayment(pi, e);
      if (row) payments.push(row);
    });
  }
  payments.sort((a, b) => b.current_period_start - a.current_period_start);
  if (payments[0]) return payments[0];

  const search = await stripeGet(
    key,
    `subscriptions/search?query=${encodeURIComponent(
      `status:'active' AND metadata['email']:'${e}'`
    )}&limit=10`
  );
  let sub = (search?.data || []).find((s) => ACTIVE.includes(s.status));

  if (!sub) {
    for (const c of customers?.data || []) {
      const list = await stripeGet(key, `subscriptions?customer=${c.id}&status=all&limit=10`);
      sub = (list?.data || []).find((s) => ACTIVE.includes(s.status));
      if (sub) break;
    }
  }

  if (sub) {
    await stopAutoRenew(key, sub);
    return fromSubscription(sub, e);
  }

  return null;
}

// The period runs [start, end) — so the last day they can actually train on is
// the day before the end date.
export function lastUsableDate(periodEnd) {
  const d = new Date(`${chicagoDate(periodEnd)}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function membershipSummary(sub, scheduled) {
  const periodStart = sub.current_period_start;
  const periodEnd = sub.current_period_end;
  const inThisMonth = scheduled.filter((l) => inPeriod(l.date, periodStart, periodEnd));
  const used = inThisMonth.length;
  const remaining = Math.max(0, MEMBER_CREDITS - used);
  const lastDay = lastUsableDate(periodEnd);
  return {
    player: sub.metadata?.player || "",
    parent: sub.metadata?.parent || "",
    phone: sub.metadata?.phone || "",
    email: String(sub.metadata?.email || "").toLowerCase(),
    credits: MEMBER_CREDITS,
    used,
    remaining,
    periodStart,
    periodEnd,
    periodStartDate: chicagoDate(periodStart),
    periodEndDate: chicagoDate(periodEnd),
    // The last day these 4 lessons can be used, and a friendly version of it
    lastDay,
    lastDayPretty: prettyDate(lastDay),
    daysLeft: Math.max(0, daysAhead(lastDay)),
    expired: lastDay < todayChicago(),
    lessons: scheduled
      .filter((l) => l.date >= todayChicago())
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
  };
}

// Members get 4 lessons to spend on any 4 days inside their paid month — they
// pick them whenever they like, one day at a time. The only limits are: don't
// spend more than 4, don't book the past, don't run past the expiry date, and
// one lesson per day.
export function bookingBlocked(summary, date, scheduled) {
  if (summary.remaining <= 0) {
    return "You've used all 4 lessons in this membership. Buy another month when you're ready for 4 more.";
  }
  if (daysAhead(date) < 1) return "Please pick a day from tomorrow onward.";
  if (!inPeriod(date, summary.periodStart, summary.periodEnd)) {
    return `These 4 lessons have to be used by ${summary.lastDayPretty}. Pick an earlier day, or buy another month.`;
  }
  const hit = scheduled.find((l) => l.date === date);
  if (hit) {
    return `You already have a lesson that day (${prettyDate(date)} at ${hit.time}). Pick a different day.`;
  }
  return null;
}
