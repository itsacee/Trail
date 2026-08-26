// Creates a Stripe Checkout session for a booking.
// Runs as a Vercel serverless function. Requires the STRIPE_SECRET_KEY
// environment variable to be set in the Vercel project settings.

import { bookedTimes } from "./slots.js";
import { allowedTimes, locationKeyFor, getAvailability, durationFor, labelToMin } from "../lib/schedule.js";
import { placeHold, releaseHold } from "../lib/holds.js";

const SESSION_ID_RE = /^cs_[A-Za-z0-9_]+$/;

const SESSION_TYPES = {
  single: { amount: 7000, quantity: 1, picks: 1, label: "Private Lesson (1 hour)", mode: "payment" },
  thirty: { amount: 5000, quantity: 1, picks: 1, label: "30-Minute Lesson", mode: "payment" },
  // Members pick lesson 1 of 4 here; the other 3 get booked from /account.html.
  membership: { amount: 24000, quantity: 1, picks: 1, label: "Membership — 4 one-hour lessons (4 weeks)", mode: "payment" },
};

const FOCUS_LABELS = { Hitting: "Hitting", Fielding: "Fielding", Both: "Hitting & Fielding" };

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

  // Backing out of Stripe returns them here; drop the hold so the slot frees up
  // straight away instead of sitting reserved until it expires.
  if (req.body?.action === "release") {
    const id = String(req.body?.sessionId || "");
    if (SESSION_ID_RE.test(id)) await releaseHold(id);
    res.status(200).json({ released: true });
    return;
  }

  // A retry after an abandoned payment must not collide with the hold that
  // attempt left behind.
  const previous = String(req.body?.previousSession || "");
  if (SESSION_ID_RE.test(previous)) await releaseHold(previous);

  const { type, player, parent, phone } = req.body || {};
  // Stored lowercase so member sign-in can find them later — Stripe's metadata
  // search is case-sensitive, and parents type their address however they like.
  const email = String(req.body?.email || "").trim().toLowerCase();
  const focus = FOCUS_LABELS[req.body?.focus] ? String(req.body.focus) : "";
  const session = SESSION_TYPES[type];
  let sessions = Array.isArray(req.body?.sessions) ? req.body.sessions : [];
  // Backwards compatibility with single date/time payloads
  if (!sessions.length && req.body?.date && req.body?.time) {
    sessions = [{ date: req.body.date, time: req.body.time }];
  }
  const isMember = type === "membership";
  const emailOk = email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const valid =
    session &&
    player &&
    (!isMember || emailOk) &&
    sessions.length === session.picks &&
    sessions.every((s) => DATE_RE.test(String(s?.date || "")) && TIME_RE.test(String(s?.time || "")));
  if (!valid) {
    res.status(400).json({
      error: isMember
        ? "Please pick your first lesson day and time, the player's name, and a valid email — that email is how you sign in to book the other 3."
        : "Please pick your lesson day, time and enter the player's name.",
    });
    return;
  }

  // The time has to be one we actually offer on that day, per the coach's
  // current availability — and a lesson of this length must fit before close.
  const availability = await getAvailability();
  const lessonMins = durationFor(type);
  const offSchedule = sessions.find((s) => !allowedTimes(s.date, availability, lessonMins).includes(s.time));
  if (offSchedule) {
    res.status(400).json({
      error: `We're not open ${offSchedule.date} at ${offSchedule.time}. Please pick a time shown on the booking form.`,
    });
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
    // A slot conflicts if this lesson's time range overlaps any booked range.
    const conflict = sessions.find((s) => {
      const start = labelToMin(s.time);
      if (start === null) return false;
      const endMin = start + lessonMins;
      return (takenByDate[s.date] || []).some((b) => {
        const bStart = labelToMin(b.time);
        return bStart !== null && start < bStart + b.mins && bStart < endMin;
      });
    });
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
  const ADDRESS = "231 W Juniper Dr, Mustang, OK 73064";
  const sessionLabel = sessions.length
    ? sessions.map((s) => `${s.date} at ${s.time}`).join(", ") + ` — ${player}`
    : `Membership — ${player}`;

  const successUrl = isMember
      ? `${origin}/account.html?welcome=1&session_id={CHECKOUT_SESSION_ID}`
      : `${origin}/book.html?booked=1&session_id={CHECKOUT_SESSION_ID}`;

  const params = new URLSearchParams();
  params.append("mode", session.mode);
  params.append("success_url", successUrl);
  if (emailOk) {
    params.append("customer_email", email);
  }
  params.append(
    "cancel_url",
    `${origin}/book.html?type=${encodeURIComponent(type)}&cancelled={CHECKOUT_SESSION_ID}`
  );
  params.append("line_items[0][quantity]", String(session.quantity));
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][unit_amount]", String(session.amount));
  params.append("line_items[0][price_data][product_data][name]", session.label);
  params.append("line_items[0][price_data][product_data][description]", sessionLabel);

  // Metadata on the payment/subscription itself, so /api/slots can find
  // paid bookings via Stripe Search and block those times.
  const metaTarget = session.mode === "subscription" ? "subscription_data" : "payment_intent_data";
  // Readable description for the receipt email and Stripe dashboard —
  // this is where the buyer gets the training address (not shown pre-payment)
  params.append(
    `${metaTarget}[description]`,
    `${session.label}: ${sessionLabel}${focus ? ` · Focus: ${FOCUS_LABELS[focus]}` : ""}${phone ? ` (${phone})` : ""} · Location: ${ADDRESS}`
  );
  const meta = [
    ["player", player],
    ["parent", parent || ""],
    ["phone", phone || ""],
    ["email", email || ""],
    ["type", type],
    ["focus", focus],
  ];
  if (sessions[0]) {
    meta.push(["date", sessions[0].date], ["time", sessions[0].time]);
  }
  sessions.forEach((s, i) => {
    meta.push([`date${i + 1}`, s.date], [`time${i + 1}`, s.time], [`loc${i + 1}`, locationKeyFor(s.date, availability)]);
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

  // Hold the slot for the length of the checkout. Until the payment succeeds
  // nothing else marks it as taken, so without this a second parent could pay
  // for the same time while this one is still entering their card.
  if (data.id && sessions.length) {
    await placeHold(data.id, sessions, lessonMins);
  }

  // The browser keeps this so it can ignore — and later release — its own hold.
  res.status(200).json({ url: data.url, sessionId: data.id || "" });
}
