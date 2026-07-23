// Creates a Stripe Checkout session for a booking.
// Runs as a Vercel serverless function. Requires the STRIPE_SECRET_KEY
// environment variable to be set in the Vercel project settings.

import { bookedTimes } from "./slots.js";

const SESSION_TYPES = {
  single: { amount: 7000, quantity: 1, label: "Private Lesson (1 hour)", mode: "payment" },
  group: { amount: 3500, quantity: 2, label: "Group Session — 1 hour, 2 players (per player)", mode: "payment" },
  membership: { amount: 24000, quantity: 1, label: "Membership — 4 one-hour lessons / month", mode: "subscription" },
};

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

  const { type, date, time, player, parent, phone } = req.body || {};
  const session = SESSION_TYPES[type];
  if (!session || !date || !time || !player) {
    res.status(400).json({ error: "Please pick a date, time and enter the player's name." });
    return;
  }

  // Last line of defense against double-booking: re-check the slot
  // right before creating the payment.
  try {
    const taken = await bookedTimes(key, date);
    if (taken.includes(time)) {
      res.status(409).json({ error: "Sorry — that time was just booked. Please pick another time." });
      return;
    }
  } catch {
    // If the check fails, continue; the owner reconciles via Stripe dashboard.
  }

  const quantity = session.quantity;
  const origin = `https://${req.headers.host}`;
  const sessionLabel = `${date} at ${time} — ${player}`;

  const params = new URLSearchParams();
  params.append("mode", session.mode);
  params.append("success_url", `${origin}/?booked=1`);
  params.append("cancel_url", `${origin}/#book`);
  params.append("line_items[0][quantity]", String(quantity));
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
  for (const [k, v] of [
    ["player", player],
    ["parent", parent || ""],
    ["phone", phone || ""],
    ["date", date],
    ["time", time],
    ["type", type],
  ]) {
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
