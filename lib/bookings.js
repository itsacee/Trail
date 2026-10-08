// Shared helper: reads paid bookings out of Stripe plus membership lessons
// booked from the member portal (Vercel Blob), plus cash/manual
// bookings.

import { loadLessons, isActiveLesson, isVoided } from "./lessons.js";
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
    const [payments, subscriptions, checkoutSessions] = await Promise.all([
      fetchAll(`https://api.stripe.com/v1/payment_intents?limit=100&created[gte]=${since}`),
      fetchAll(`https://api.stripe.com/v1/subscriptions?limit=100&status=all&created[gte]=${since}`),
      fetchAll(`https://api.stripe.com/v1/checkout/sessions?limit=100&created[gte]=${since}`),
    ]);

    const collect = (id, m, fallbackType) => {
      if (!m) return;
      const base = {
        sourceId: id,
        player: m.player || "",
        player2: m.player2 || "",
        athletes: Number(m.athletes) || 1,
        parent: m.parent || "",
        phone: m.phone || "",
        email: m.email || "",
        type: m.type || fallbackType,
        focus: m.focus || "",
        paymentMethod: m.payment_mode || "card",
        paymentStatus: m.payment_status || "paid",
        amountDueCents: Number(m.amount_due || 0) || 0,
        // Coach Desk can move any lesson; only cash/manual money is editable.
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
    checkoutSessions
      .filter((session) => session.payment_status === "paid")
      .forEach((session) =>
        collect(
          session.payment_intent || session.subscription || session.id,
          session.metadata,
          session.subscription ? "membership" : "single"
        )
      );

    // Checkout Sessions and their Payment Intents describe the same booking.
    // Keep one row while still using the Session as a strongly-consistent
    // fallback when payment metadata has not appeared yet.
    const unique = new Map();
    out.forEach((booking) => {
      const key = `${booking.sourceId}|${booking.date}|${booking.time}`;
      if (!unique.has(key)) unique.set(key, booking);
    });
    out.length = 0;
    out.push(...unique.values());
  }

  let seen = new Set(out.map((b) => `${String(b.email || "").toLowerCase()}|${b.date}|${b.time}`));
  try {
    const stored = await loadLessons();
    // Stripe metadata can lag after a cancellation, and Checkout Session
    // metadata cannot be edited. The local void is authoritative immediately.
    const activeStripe = out.filter((booking) => !isVoided(stored, booking));
    out.length = 0;
    out.push(...activeStripe);
    seen = new Set(out.map((b) => `${String(b.email || "").toLowerCase()}|${b.date}|${b.time}`));

    (stored.lessons || [])
      .filter((l) => isActiveLesson(l) && !isVoided(stored, l))
      .forEach((l) => {
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
          source: l.source === "stripe" ? "stripe" : "member",
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
        player2: b.player2 || "",
        athletes: Number(b.athletes) || 1,
        paymentMethod: b.paymentMethod || "cash",
        paymentStatus: b.paymentStatus || "unpaid",
        amountCents: b.amountCents || 0,
        amountPaidCents: b.amountPaidCents || 0,
        amountDueCents: b.amountDueCents || 0,
        note: b.note || "",
        editable: true,
        source: "manual",
      });
    });
  } catch {
    /* blob optional */
  }

  return out;
}
