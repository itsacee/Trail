// Returns the times already booked (paid) for a given date, so the
// booking widget can gray them out. Reads paid bookings from Stripe —
// no separate database needed.
//
// Bookings store their slots as metadata date1/time1 ... date4/time4
// (memberships have four). Stripe Search doesn't support OR, so each
// dateN key is queried separately, in parallel.
//
// Three things can occupy a slot: a paid booking in Stripe, a lesson a member
// booked from the portal (blob storage), and a checkout someone is part-way
// through (a hold). Coaches can see which by adding their passcode:
//
//   /api/slots?date=YYYY-MM-DD&key=COACH_PASS
//
// That adds a `sources` list to each entry explaining what is blocking the
// slot. Without the passcode only times and durations are returned — names and
// booking ids are never exposed publicly.

import { durationFor, seatsFor, isExclusiveType, SLOT_CAPACITY } from "../lib/schedule.js";
import { loadLessons, lessonsOnDate, isVoided } from "../lib/lessons.js";
import { HOLD_MINUTES, loadHolds, holdsOnDate } from "../lib/holds.js";
import { loadManualBookings, bookingsOnDate } from "../lib/manualBookings.js";
import { isCoachPass } from "../lib/coachAuth.js";

const ACTIVE_SUBSCRIPTION = ["active", "trialing", "past_due"];

// How many of the hour's two athlete seats a booking occupies. Private lessons
// take both; a sibling pair takes both; a lone athlete takes one.
function seatsOn(row) {
  const type = String(row?.type || "");
  if (isExclusiveType(type)) return SLOT_CAPACITY;
  const explicit = Number(row?.seats);
  if (explicit > 0) return Math.min(SLOT_CAPACITY, explicit);
  return seatsFor(type, row?.athletes);
}

// Returns [{ time: "5:00 PM", mins: 60, sources: [...] }] — each taken slot with
// how long it runs, so callers can block overlapping start times (a 1-hour
// lesson blocks both the hour and the half-hour that follow it).
// `ignoreHold` is the caller's own checkout session. Without it a parent who
// backs out of payment and tries again is blocked by the hold they just
// created — the slot they were about to buy reads as taken, to them, for the
// full hold window.
export async function bookedTimes(
  key,
  date,
  { ignoreHold = "", ignoreSourceId = "", holdBefore = null } = {}
) {
  const byTime = new Map(); // time label -> { mins, sources }
  let stored = { lessons: [], voids: [] };
  try {
    stored = await loadLessons();
  } catch {
    /* blob optional */
  }

  const add = (time, mins, source) => {
    if (!time) return;
    const cur = byTime.get(time) || { mins: 0, sources: [] };
    cur.mins = Math.max(cur.mins, mins);
    if (
      source &&
      !cur.sources.some((existing) => existing.kind === source.kind && existing.id === source.id)
    ) {
      cur.sources.push(source);
    }
    byTime.set(time, cur);
  };

  const holdIsEarlier = (created, id) => {
    if (!holdBefore) return true;
    const boundary = Number(holdBefore.created) || 0;
    const at = Number(created) || 0;
    if (at !== boundary) return at < boundary;
    return String(id || "") < String(holdBefore.id || "");
  };

  const search = async (resource, query, pick) => {
    const url = `https://api.stripe.com/v1/${resource}/search?query=${encodeURIComponent(query)}&limit=100`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Stripe slot lookup failed (${res.status}).`);
    ((await res.json()).data || []).forEach((item) => {
      if (resource === "subscriptions" && !ACTIVE_SUBSCRIPTION.includes(item.status)) return;
      const m = item.metadata || {};
      const { time, mins } = pick(m);
      if (ignoreSourceId && item.id === ignoreSourceId) return;
      // Member moved/cancelled this Stripe signup slot — don't keep it blocked.
      if (isVoided(stored, { sourceId: item.id, date, time })) return;
      add(time, mins, {
        kind: "paid",
        id: item.id,
        player: m.player || "",
        player2: m.player2 || "",
        type: m.type || "",
        focus: m.focus || "",
        seats: seatsOn({ type: m.type, seats: m.seats, athletes: m.athletes }),
        created: item.created || 0,
      });
    });
  };

  const dur = (m) => durationFor(m.type);
  const queries = [];
  for (let i = 1; i <= 4; i++) {
    queries.push(
      search("payment_intents", `status:'succeeded' AND metadata['date${i}']:'${date}'`, (m) => ({ time: m[`time${i}`], mins: dur(m) })),
      search("subscriptions", `metadata['date${i}']:'${date}'`, (m) => ({ time: m[`time${i}`], mins: dur(m) }))
    );
  }
  // Older bookings (before multi-slot support) stored a single date/time pair
  queries.push(
    search("payment_intents", `status:'succeeded' AND metadata['date']:'${date}'`, (m) => ({ time: m.time, mins: dur(m) })),
    search("subscriptions", `metadata['date']:'${date}'`, (m) => ({ time: m.time, mins: dur(m) }))
  );

  // Open Stripe Checkout Sessions are strongly visible before payment and act
  // as the authoritative hold. This closes the race where two parents start
  // Checkout before either payment appears in Stripe Search.
  queries.push(
    (async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const since = nowSeconds - (HOLD_MINUTES + 1) * 60;
      const url =
        `https://api.stripe.com/v1/checkout/sessions?limit=100&status=open` +
        `&created[gte]=${since}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`Stripe checkout hold lookup failed (${res.status}).`);
      ((await res.json()).data || [])
        .filter(
          (session) =>
            session.status === "open" &&
            Number(session.expires_at || 0) > nowSeconds &&
            (!ignoreHold || session.id !== ignoreHold) &&
            holdIsEarlier(Number(session.created || 0) * 1000, session.id)
        )
        .forEach((session) => {
          const m = session.metadata || {};
          const source = {
            kind: "hold",
            id: session.id,
            focus: m.focus || "",
            seats: seatsOn({ type: m.type, seats: m.seats, athletes: m.athletes }),
            createdAt: Number(session.created || 0) * 1000,
            expiresAt: Number(session.expires_at || 0) * 1000,
          };
          let found = false;
          for (let i = 1; i <= 4; i++) {
            if (m[`date${i}`] !== date || !m[`time${i}`]) continue;
            found = true;
            add(m[`time${i}`], durationFor(m.type), source);
          }
          if (!found && m.date === date && m.time) {
            add(m.time, durationFor(m.type), source);
          }
        });
    })()
  );

  await Promise.all(queries);

  try {
    lessonsOnDate(stored, date)
      .filter((l) => !isVoided(stored, l))
      .filter(
        (l) =>
          !ignoreSourceId ||
          (l.id !== ignoreSourceId && l.sourceId !== ignoreSourceId)
      )
      .forEach((l) =>
      add(l.time, durationFor(l.type || "membership"), {
        kind: l.source === "stripe" ? "paid" : "member",
        id: l.source === "stripe" ? l.sourceId || l.id : l.id,
        player: l.player || "",
        email: l.email || "",
        focus: l.focus || "",
        seats: seatsOn({ type: l.type || "membership", seats: l.seats, athletes: l.athletes }),
        createdAt: l.createdAt || 0,
      })
    );
  } catch {
    /* blob optional */
  }

  // Slots someone is part-way through paying for. Read straight from storage,
  // so these are visible immediately — unlike Stripe Search, which lags.
  try {
    const holds = await loadHolds();
    holdsOnDate(holds, date)
      .filter((h) => !ignoreHold || h.sessionId !== ignoreHold)
      .filter((h) => holdIsEarlier(h.createdAt || 0, h.sessionId))
      .forEach((h) =>
      add(h.time, h.mins || 60, {
        kind: "hold",
        id: h.sessionId,
        focus: h.focus || "",
        seats: seatsOn({ type: h.type, seats: h.seats, athletes: h.athletes }),
        expiresAt: h.expiresAt,
        expiresInMin: Math.max(0, Math.round((h.expiresAt - Date.now()) / 60000)),
      })
    );
  } catch {
    /* holds optional */
  }

  try {
    const manual = await loadManualBookings();
    bookingsOnDate(manual, date)
      .filter((b) => !ignoreSourceId || b.id !== ignoreSourceId)
      .forEach((b) =>
      add(b.time, durationFor(b.type || "single"), {
        kind: "cash",
        id: b.id,
        player: b.player || "",
        player2: b.player2 || "",
        email: b.email || "",
        focus: b.focus || "",
        seats: seatsOn({ type: b.type || "single", seats: b.seats, athletes: b.athletes }),
        createdAt: b.createdAt || 0,
      })
    );
  } catch {
    /* optional */
  }

  return [...byTime.entries()].map(([time, v]) => {
    const seats = v.sources.reduce((n, source) => n + (Number(source.seats) || 1), 0);
    return {
      time,
      mins: v.mins,
      count: v.sources.length,
      seats,
      // Private lessons (and sibling pairs) own the hour outright.
      exclusive: seats >= SLOT_CAPACITY,
      focuses: [...new Set(v.sources.map((source) => source.focus || "").filter(Boolean))],
      sources: v.sources,
    };
  });
}

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const date = String(req.query?.date || "").slice(0, 10);
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(200).json({ booked: [] });
    return;
  }
  const isCoach = isCoachPass(req.query?.key);
  // The browser passes back the checkout it last started, so someone who
  // abandoned payment doesn't see their own hold sitting on the slot.
  const mine = /^cs_[A-Za-z0-9_]+$/.test(String(req.query?.mine || "")) ? String(req.query.mine) : "";
  try {
    const booked = await bookedTimes(key, date, { ignoreHold: mine });
    res.status(200).json({
      date,
      // Names and ids stay private unless the coach asked.
      booked: isCoach
        ? booked
        : booked.map(({ time, mins, count, seats, exclusive, focuses }) => ({
            time,
            mins,
            count,
            seats,
            exclusive,
            focuses,
          })),
    });
  } catch {
    res.status(503).json({
      error: "Couldn't confirm open times. Please try again shortly.",
      code: "schedule_unavailable",
    });
  }
}
