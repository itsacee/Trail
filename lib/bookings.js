// Shared helper: reads paid bookings out of Stripe.
// Used by the coach schedule page and the calendar feed.

const ACTIVE_SUB = ["active", "trialing", "past_due"];

export async function fetchBookings(key, daysBack = 90) {
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;

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

  const out = [];
  const collect = (id, m, fallbackType) => {
    if (!m) return;
    const base = {
      sourceId: id,
      player: m.player || "",
      parent: m.parent || "",
      phone: m.phone || "",
      email: m.email || "",
      type: m.type || fallbackType,
      focus: m.focus || "",
    };
    let found = false;
    for (let i = 1; i <= 4; i++) {
      if (m[`date${i}`] && m[`time${i}`]) {
        out.push({
          ...base,
          id: `${id}-${i}`,
          date: m[`date${i}`],
          time: m[`time${i}`],
          loc: m[`loc${i}`] || "",
        });
        found = true;
      }
    }
    // Older bookings stored a single date/time pair
    if (!found && m.date && m.time) {
      out.push({ ...base, id: `${id}-1`, date: m.date, time: m.time, loc: m.loc || "" });
    }
  };

  payments.filter((p) => p.status === "succeeded").forEach((p) => collect(p.id, p.metadata, "single"));
  subscriptions.filter((s) => ACTIVE_SUB.includes(s.status)).forEach((s) => collect(s.id, s.metadata, "membership"));

  return out;
}
