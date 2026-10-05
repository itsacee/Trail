import { labelToMin } from "./schedule.js";
import { effectivePeriodEnd, isPeriodFrozen } from "./siteStatus.js";
import {
  loadMembersState,
  memberRecord,
  isMemberFrozen,
  totalPeriodBonusDays,
} from "./membersStore.js";

export const MEMBER_CREDITS = 4;
export const MEMBER_PERIOD_DAYS = 30; // one paid month = 30 days, then they buy again
export const CANCEL_HOURS = 12;
const ACTIVE = ["active", "trialing", "past_due"];

function dateFromKey(key) {
  return new Date(`${key}T12:00:00`);
}

function addDaysKey(key, n) {
  const d = dateFromKey(key);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayOfWeekChicago(key) {
  const name = new Date(`${key}T12:00:00`).toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
  });
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name];
}

// Always keep the rest of this week and the entire following calendar week open.
// On Monday that means up to 13 days ahead; on Sunday it means the next 7 days.
export function bookingWindow(todayKey = todayChicago()) {
  const tomorrow = addDaysKey(todayKey, 1);
  const dow = dayOfWeekChicago(todayKey);
  const daysThroughNextSunday = dow === 0 ? 7 : 14 - dow;
  const endKey = addDaysKey(todayKey, daysThroughNextSunday);
  const dates = [];
  for (let cur = tomorrow; cur <= endKey; cur = addDaysKey(cur, 1)) dates.push(cur);
  return {
    startKey: tomorrow,
    endKey,
    dates,
  };
}

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
  const effectiveEnd = effectivePeriodEnd(end, start);
  if (!start || effectiveEnd * 1000 < Date.now()) return null;
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

// Cash / coach-created memberships live in members.json (not Stripe).
// Coach freeze days are written into cashMembershipEnd on unfreeze; while a
// freeze is still active we provisionally extend the end the same way so the
// membership doesn't look expired mid-pause.
export function fromCashMember(row, email, membersState = null) {
  if (!row?.cashMembership) return null;
  const e = String(email || row.email || "")
    .trim()
    .toLowerCase();
  const start = Number(row.cashMembershipStart) || 0;
  let end = Number(row.cashMembershipEnd) || 0;
  if (!start || !end || !e) return null;

  if (membersState?.freezeAll && membersState.freezeAllAt) {
    end += Math.max(0, Math.ceil((Date.now() - membersState.freezeAllAt) / 86400000)) * 86400;
  } else if (row.frozen && row.frozenAt) {
    end += Math.max(0, Math.ceil((Date.now() - row.frozenAt) / 86400000)) * 86400;
  }

  const effectiveEnd = effectivePeriodEnd(end, start);
  if (effectiveEnd * 1000 < Date.now()) return null;

  return {
    id: `cash_${e}`,
    metadata: {
      type: "membership",
      player: row.player || "",
      parent: row.parent || "",
      phone: row.phone || "",
      email: e,
    },
    email: e,
    current_period_start: start,
    current_period_end: end,
    kind: "cash",
  };
}

export async function findCashMembership(email) {
  const e = String(email || "")
    .trim()
    .toLowerCase();
  if (!e || !e.includes("@")) return null;
  try {
    const state = await loadMembersState();
    return fromCashMember(memberRecord(state, e), e, state);
  } catch {
    return null;
  }
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

  if (key) {
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
  }

  // Cash / coach desk memberships — no Stripe payment intent.
  return findCashMembership(e);
}

// The period runs [start, end) — so the last day they can actually train on is
// the day before the end date.
export function lastUsableDate(periodEnd) {
  const d = new Date(`${chicagoDate(periodEnd)}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Coach freeze days for Stripe members live in membersStore.periodBonusDays
// (cash memberships already bake those days into current_period_end).
export function memberEffectivePeriodEnd(sub, periodBonusDays = 0) {
  const base = effectivePeriodEnd(sub.current_period_end, sub.current_period_start);
  if (sub?.kind === "cash") return base;
  return base + Math.max(0, Number(periodBonusDays) || 0) * 86400;
}

export function membershipOptsFromState(membersState, email) {
  const freeze = isMemberFrozen(membersState, email);
  return {
    periodBonusDays: totalPeriodBonusDays(membersState, email),
    memberFrozen: freeze.frozen,
    freezeReason: freeze.reason || "",
  };
}

export function membershipSummary(sub, scheduled, opts = {}) {
  const periodStart = sub.current_period_start;
  const periodEnd = sub.current_period_end;
  const effectiveEnd = memberEffectivePeriodEnd(sub, opts.periodBonusDays);
  const inThisMonth = scheduled.filter((l) => inPeriod(l.date, periodStart, effectiveEnd));
  const used = inThisMonth.length;
  const remaining = Math.max(0, MEMBER_CREDITS - used);
  const lastDay = lastUsableDate(effectiveEnd);
  const bookingPaused = Boolean(opts.memberFrozen);
  return {
    player: sub.metadata?.player || "",
    parent: sub.metadata?.parent || "",
    phone: sub.metadata?.phone || "",
    email: String(sub.metadata?.email || sub.email || "").toLowerCase(),
    credits: MEMBER_CREDITS,
    used,
    remaining,
    periodStart,
    periodEnd,
    effectivePeriodEnd: effectiveEnd,
    periodStartDate: chicagoDate(periodStart),
    periodEndDate: chicagoDate(periodEnd),
    effectiveLastDay: lastDay,
    // The last day these 4 lessons can be used, and a friendly version of it
    lastDay,
    lastDayPretty: prettyDate(lastDay),
    daysLeft: Math.max(0, daysAhead(lastDay)),
    expired: remaining <= 0 || lastDay < todayChicago(),
    frozen: isPeriodFrozen(periodStart),
    bookingPaused,
    bookingPausedReason: bookingPaused
      ? opts.freezeReason || "This membership is paused. Call or text (405) 819-4401."
      : "",
    kind: sub.kind || "payment",
    // Deposit memberships still owe the balance in cash at the first lesson —
    // the portal reminds them until the coach marks it collected.
    cashDue: Math.max(0, Number(sub.metadata?.amount_due) || 0),
    lessons: scheduled
      .filter((l) => l.date >= todayChicago())
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      // `canChange` lets the portal grey out Move/Cancel inside the 12-hour
      // window instead of failing after the parent has picked a new time.
      .map((l) => ({ ...l, canChange: canCancelLesson(l.date, l.time) })),
  };
}

// Members get 4 lessons to spend on any 4 days inside their paid month — they
// pick them one day at a time, week by week. The other limits are: don't spend
// more than 4, don't book the past, don't run past the expiry date, and one
// lesson per day.
export function bookWindowBlocked(date) {
  if (daysAhead(date) < 1) return "Please pick a day from tomorrow onward.";
  const { startKey, endKey } = bookingWindow();
  if (date < startKey || date > endKey) {
    return "That day isn't open yet. You can book from tomorrow through the end of next week.";
  }
  return null;
}

export function bookingBlocked(summary, date, scheduled) {
  if (summary.bookingPaused) {
    return summary.bookingPausedReason || "This membership is paused. Call or text (405) 819-4401.";
  }
  if (summary.remaining <= 0) {
    return "You've used all 4 lessons in this membership. Buy another month when you're ready for 4 more.";
  }
  const window = bookWindowBlocked(date);
  if (window) return window;
  if (!inPeriod(date, summary.periodStart, summary.effectivePeriodEnd || summary.periodEnd)) {
    return `These 4 lessons have to be used by ${summary.lastDayPretty}. Pick an earlier day, or buy another month.`;
  }
  const hit = scheduled.find((l) => l.date === date);
  if (hit) {
    return `You already have a lesson that day (${prettyDate(date)} at ${hit.time}). Pick a different day.`;
  }
  return null;
}
