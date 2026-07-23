// Creates a Stripe Checkout session for a booking.
// Runs as a Vercel serverless function. Requires the STRIPE_SECRET_KEY
// environment variable to be set in the Vercel project settings.

import { bookedTimes } from "./slots.js";

const SESSION_TYPES = {
  single: { amount: 7000, quantity: 1, picks: 1, label: "Private Lesson (1 hour)", mode: "payment" },
  group: { amount: 3500, quantity: 2, picks: 1, label: "Group Session — 1 hour, 2 players (per player)", mode: "payment" },
  membership: { amount: 24000, quantity: 1, picks: 4, label: "Membership — 4 one-hour lessons / month", mode: "subscription" },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2} (AM|PM)$/;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(500).json({ error: "Stripe is not connected yet. Call or text (405) 819-4401 to book." });
    return;
  }

  const { type, player, parent, phone } = req.body || {};
  const session = SESSION_TYPES[type];
  let sessions = Array.isArray(req.body?.sessions) ? req.body.sessions : [];
  // Backwards compatibility with single date/time payloads
  if (!sessions.length && req.body?.date && req.body?.time) {
    sessions = [{ date: req.body.date, time: req.body.time }];
  }

  const valid =
    session &&
    player &&
    sessions.length === session.picks &&
    sessions.every((s) => DATE_RE.test(String(s?.date || "")) && TIME_RE.test(String(s?.time || "")));
  if (!valid) {
    res.status(400).json({ error: "Please pick your lesson day(s), time(s) and enter the player's name." });
    return;
  }

  // No duplicate slots within the same booking
  const slotKeys = sessions.map((s) => `${s.date} ${s.time}`);
  if (new Set(slotKeys).size !== slotKeys.length) {
    res.status(400).json({ error: "You picked the same day and time twice — each lesson needs its own slot." });
    return;
  }

  // Last line of defense against double-booking: re-check every requested
  // slot right before creating the payment.
  try {
    const dates = [...new Set(sessions.map((s) => s.date))];
    const takenByDate = Object.fromEntries(
      await Promise.all(dates.map(async (d) => [d, await bookedTimes(key, d)]))
    );
    const conflict = sessions.find((s) => takenByDate[s.date]?.includes(s.time));
    if (conflict) {
      res.status(409).json({
        error: `Sorry — ${conflict.date} at ${conflict.time} was just booked. Please pick another time for that lesson.`,
      });
      return;
    }
  } catch {
    // If the check fails, continue; the owner reconciles via Stripe dashboard.
  }

  const origin = `https://${req.headers.host}`;
  const sessionLabel = sessions.map((s) => `${s.date} at ${s.time}`).join(", ") + ` — ${player}`;

  const params = new URLSearchParams();
  params.append("mode", session.mode);
  params.append("success_url", `${origin}/?booked=1`);
  params.append("cancel_url", `${origin}/#book`);
  params.append("line_items[0][quantity]", String(session.quantity));
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][unit_amount]", String(session.amount));
  params.append("line_items[0][price_data][product_data][name]", session.label);
  params.append("line_items[0][price_data][product_data][description]", sessionLabel);
  if (session.mode === "subscription") {
    params.append("line_items[0][price_data][recurring][interval]", "month");
  }

  // Metadata on the payment/subscription itself, so /api/slots can find
  // paid bookings via Stripe Search and block those times.
  const metaTarget = session.mode === "subscription" ? "subscription_data" : "payment_intent_data";
  const meta = [
    ["player", player],
    ["parent", parent || ""],
    ["phone", phone || ""],
    ["type", type],
    ["date", sessions[0].date],
    ["time", sessions[0].time],
  ];
  sessions.forEach((s, i) => {
    meta.push([`date${i + 1}`, s.date], [`time${i + 1}`, s.time]);
  });
  for (const [k, v] of meta) {
    params.append(`metadata[${k}]`, v);
    params.append(`${metaTarget}[metadata][${k}]`, v);
  }

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const data = await response.json();
  if (!response.ok) {
    res.status(502).json({ error: data.error?.message || "Payment setup failed. Please try again." });
    return;
  }

  res.status(200).json({ url: data.url });
}
