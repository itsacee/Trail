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

import { durationFor } from "../lib/schedule.js";
import { loadLessons, lessonsOnDate } from "../lib/lessons.js";
import { loadHolds, holdsOnDate } from "../lib/holds.js";

// Returns [{ time: "5:00 PM", mins: 60, sources: [...] }] — each taken slot with
// how long it runs, so callers can block overlapping start times (a 1-hour
// lesson blocks both the hour and the half-hour that follow it).
export async function bookedTimes(key, date) {
  const byTime = new Map(); // time label -> { mins, sources }
  const add = (time, mins, source) => {
    if (!time) return;
    const cur = byTime.get(time) || { mins: 0, sources: [] };
    cur.mins = Math.max(cur.mins, mins);
    if (source) cur.sources.push(source);
    byTime.set(time, cur);
  };

  const search = async (resource, query, pick) => {
    const url = `https://api.stripe.com/v1/${resource}/search?query=${encodeURIComponent(query)}&limit=100`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return;
    ((await res.json()).data || []).forEach((item) => {
      const m = item.metadata || {};
      const { time, mins } = pick(m);
      add(time, mins, {
        kind: "paid",
        id: item.id,
        player: m.player || "",
        type: m.type || "",
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

  await Promise.all(queries);

  try {
    const stored = await loadLessons();
    lessonsOnDate(stored, date).forEach((l) =>
      add(l.time, durationFor(l.type || "membership"), {
        kind: "member",
        id: l.id,
        player: l.player || "",
        email: l.email || "",
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
    holdsOnDate(holds, date).forEach((h) =>
      add(h.time, h.mins || 60, {
        kind: "hold",
        id: h.sessionId,
        expiresAt: h.expiresAt,
        expiresInMin: Math.max(0, Math.round((h.expiresAt - Date.now()) / 60000)),
      })
    );
  } catch {
    /* holds optional */
  }

  return [...byTime.entries()].map(([time, v]) => ({ time, mins: v.mins, sources: v.sources }));
}

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const date = String(req.query?.date || "").slice(0, 10);
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(200).json({ booked: [] });
    return;
  }
  const pass = process.env.COACH_PASS;
  const isCoach = Boolean(pass && String(req.query?.key || "") === pass);
  try {
    const booked = await bookedTimes(key, date);
    res.status(200).json({
      date,
      // Names and ids stay private unless the coach asked.
      booked: isCoach ? booked : booked.map(({ time, mins }) => ({ time, mins })),
    });
  } catch {
    res.status(200).json({ booked: [] });
  }
}
