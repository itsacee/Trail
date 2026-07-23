// Returns the times already booked (paid) for a given date, so the
// booking widget can gray them out. Reads paid bookings from Stripe —
// no separate database needed.

export async function bookedTimes(key, date) {
  const times = new Set();

  const query = async (url) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return [];
    return (await res.json()).data || [];
  };

  const q = (s) => encodeURIComponent(s);
  const [payments, subscriptions] = await Promise.all([
    query(`https://api.stripe.com/v1/payment_intents/search?query=${q(`status:'succeeded' AND metadata['date']:'${date}'`)}&limit=100`),
    query(`https://api.stripe.com/v1/subscriptions/search?query=${q(`metadata['date']:'${date}'`)}&limit=100`),
  ]);

  payments.forEach((p) => p.metadata?.time && times.add(p.metadata.time));
  subscriptions.forEach((s) => s.metadata?.time && times.add(s.metadata.time));
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
