// Returns the times already booked (paid) for a given date, so the
// booking widget can gray them out. Reads paid bookings from Stripe —
// no separate database needed.
//
// Bookings store their slots as metadata date1/time1 ... date4/time4
// (memberships have four). Stripe Search doesn't support OR, so each
// dateN key is queried separately, in parallel.

export async function bookedTimes(key, date) {
  const times = new Set();

  const search = async (resource, query, pick) => {
    const url = `https://api.stripe.com/v1/${resource}/search?query=${encodeURIComponent(query)}&limit=100`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return;
    ((await res.json()).data || []).forEach((item) => {
      const t = pick(item.metadata || {});
      if (t) times.add(t);
    });
  };

  const queries = [];
  for (let i = 1; i <= 4; i++) {
    queries.push(
      search("payment_intents", `status:'succeeded' AND metadata['date${i}']:'${date}'`, (m) => m[`time${i}`]),
      search("subscriptions", `metadata['date${i}']:'${date}'`, (m) => m[`time${i}`])
    );
  }
  // Older bookings (before multi-slot support) stored a single date/time pair
  queries.push(
    search("payment_intents", `status:'succeeded' AND metadata['date']:'${date}'`, (m) => m.time),
    search("subscriptions", `metadata['date']:'${date}'`, (m) => m.time)
  );

  await Promise.all(queries);
  return [...times];
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
