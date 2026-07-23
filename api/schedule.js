// Coach-only endpoint: returns all upcoming booked lessons, read straight
// from Stripe (paid payments + active memberships). Protected by a passcode
// set in the COACH_PASS environment variable in Vercel.

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const pass = process.env.COACH_PASS;
  if (!key) {
    res.status(500).json({ error: "Stripe is not connected yet." });
    return;
  }
  if (!pass) {
    res.status(500).json({
      error: "Coach page isn't set up yet. In Vercel: Settings → Environment Variables → add COACH_PASS with a passcode you make up, then redeploy.",
    });
    return;
  }
  if (String(req.query?.key || "") !== pass) {
    res.status(401).json({ error: "Wrong passcode." });
    return;
  }

  // Look at bookings created in the last 90 days (parents can only book
  // 28 days ahead, so this comfortably covers everything upcoming).
  const since = Math.floor(Date.now() / 1000) - 90 * 86400;

  const fetchAll = async (base) => {
    let items = [];
    let url = base;
    let guard = 0;
    while (url && guard++ < 5) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) break;
      const d = await r.json();
      items = items.concat(d.data || []);
      url = d.has_more && items.length ? `${base}&starting_after=${items[items.length - 1].id}` : null;
    }
    return items;
  };

  const [payments, subscriptions] = await Promise.all([
    fetchAll(`https://api.stripe.com/v1/payment_intents?limit=100&created[gte]=${since}`),
    fetchAll(`https://api.stripe.com/v1/subscriptions?limit=100&status=all&created[gte]=${since}`),
  ]);

  const sessions = [];
  const collect = (m, fallbackType) => {
    if (!m) return;
    const base = {
      player: m.player || "",
      parent: m.parent || "",
      phone: m.phone || "",
      type: m.type || fallbackType,
    };
    let found = false;
    for (let i = 1; i <= 4; i++) {
      if (m[`date${i}`] && m[`time${i}`]) {
        sessions.push({ ...base, date: m[`date${i}`], time: m[`time${i}`] });
        found = true;
      }
    }
    // Older bookings stored a single date/time pair
    if (!found && m.date && m.time) {
      sessions.push({ ...base, date: m.date, time: m.time });
    }
  };

  payments
    .filter((p) => p.status === "succeeded")
    .forEach((p) => collect(p.metadata, "single"));
  subscriptions
    .filter((s) => ["active", "trialing", "past_due"].includes(s.status))
    .forEach((s) => collect(s.metadata, "membership"));

  res.status(200).json({ sessions });
}
