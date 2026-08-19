// Returns the times already booked (paid) for a given date, so the
// booking widget can gray them out. Reads paid bookings from Stripe —
// no separate database needed.
//
// Bookings store their slots as metadata date1/time1 ... date4/time4
// (memberships have four). Stripe Search doesn't support OR, so each
// dateN key is queried separately, in parallel.

import { durationFor } from "../lib/schedule.js";

// Returns [{ time: "5:00 PM", mins: 60 }] — each taken slot with how long it
// runs, so callers can block overlapping start times (a 1-hour lesson blocks
// both the hour and the half-hour that follow it).
export async function bookedTimes(key, date) {
  const byTime = new Map(); // time label -> longest duration seen at that start
  const add = (time, mins) => {
    if (!time) return;
    byTime.set(time, Math.max(byTime.get(time) || 0, mins));
  };

  const search = async (resource, query, pick) => {
    const url = `https://api.stripe.com/v1/${resource}/search?query=${encodeURIComponent(query)}&limit=100`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return;
    ((await res.json()).data || []).forEach((item) => {
      const m = item.metadata || {};
      const { time, mins } = pick(m);
      add(time, mins);
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
  return [...byTime.entries()].map(([time, mins]) => ({ time, mins }));
}

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const date = String(req.query?.date || "").slice(0, 10);
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(200).json({ booked: [] });
    return;
  }
  try {
    res.status(200).json({ booked: await bookedTimes(key, date) });
  } catch {
    res.status(200).json({ booked: [] });
  }
}
