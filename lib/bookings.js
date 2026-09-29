// Shared helper: reads paid bookings out of Stripe plus membership lessons
// booked week-by-week from the member portal (Vercel Blob), plus cash/manual
// bookings recorded by parents or the coach.

import { loadLessons } from "./lessons.js";
import { loadManualBookings, activeBookings } from "./manualBookings.js";

const ACTIVE_SUB = ["active", "trialing", "past_due"];

export async function fetchBookings(key, daysBack = 90) {
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;
  const out = [];

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

  if (key) {
    const [payments, subscriptions] = await Promise.all([
      fetchAll(`https://api.stripe.com/v1/payment_intents?limit=100&created[gte]=${since}`),
      fetchAll(`https://api.stripe.com/v1/subscriptions?limit=100&status=all&created[gte]=${since}`),
    ]);

    const collect = (id, m, fallbackType, extras = {}) => {
      if (!m) return;
      const base = {
        sourceId: id,
        player: m.player || "",
        parent: m.parent || "",
        phone: m.phone || "",
        email: m.email || "",
        type: m.type || fallbackType,
        focus: m.focus || "",
        paymentMethod: m.payment_mode || extras.paymentMethod || "card",
        paymentStatus: m.payment_status || extras.paymentStatus || "paid",
        amountDueCents: Number(m.amount_due || 0) || 0,
        editable: false,
        source: "stripe",
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
      if (!found && m.date && m.time) {
        out.push({ ...base, id: `${id}-1`, date: m.date, time: m.time, loc: m.loc || "" });
      }
    };

    payments.filter((p) => p.status === "succeeded").forEach((p) => collect(p.id, p.metadata, "single"));
    subscriptions.filter((s) => ACTIVE_SUB.includes(s.status)).forEach((s) => collect(s.id, s.metadata, "membership"));
  }

  const seen = new Set(out.map((b) => `${String(b.email || "").toLowerCase()}|${b.date}|${b.time}`));

  try {
    const stored = await loadLessons();
    (stored.lessons || []).forEach((l) => {
      const k = `${String(l.email || "").toLowerCase()}|${l.date}|${l.time}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({
        sourceId: l.subId || l.id,
        id: l.id,
        player: l.player || "",
        parent: l.parent || "",
        phone: l.phone || "",
        email: l.email || "",
        type: l.type || "membership",
        focus: l.focus || "",
        date: l.date,
        time: l.time,
        loc: l.loc || "",
        paymentMethod: "membership",
        paymentStatus: "paid",
        editable: false,
        source: "member",
      });
    });
  } catch {
    /* blob optional */
  }

  try {
    const manual = await loadManualBookings();
    activeBookings(manual).forEach((b) => {
      const k = `${String(b.email || "").toLowerCase()}|${b.date}|${b.time}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({
        sourceId: b.id,
        id: b.id,
        player: b.player || "",
        parent: b.parent || "",
        phone: b.phone || "",
        email: b.email || "",
        type: b.type || "single",
        focus: b.focus || "",
        date: b.date,
        time: b.time,
        loc: b.loc || "",
        paymentMethod: b.paymentMethod || "cash",
        paymentStatus: b.paymentStatus || "unpaid",
        amountCents: b.amountCents || 0,
        amountPaidCents: b.amountPaidCents || 0,
        amountDueCents: b.amountDueCents || 0,
        note: b.note || "",
        googleEventId: b.googleEventId || "",
        editable: true,
        source: "manual",
      });
    });
  } catch {
    /* blob optional */
  }

  return out;
}
