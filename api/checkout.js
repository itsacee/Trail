// Creates a Stripe Checkout session for a booking.
// Supports full card pay, or membership deposit (rest cash later).

import { bookedTimes } from "./slots.js";
import { allowedTimes, locationKeyFor, getAvailability, durationFor, labelToMin } from "../lib/schedule.js";
import { loadSettings } from "../lib/settings.js";

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

  const settings = await loadSettings();
  const { type, player, parent, phone, email } = req.body || {};
  const payMode = req.body?.payMode === "deposit" ? "deposit" : "card";
  const focus = FOCUS_LABELS[req.body?.focus] ? String(req.body.focus) : "";

  const baseAmount = settings.prices?.[type];
  const picks = type === "membership" || type === "single" || type === "thirty" ? 1 : 0;
  const labels = {
    single: "Private Lesson (1 hour)",
    thirty: "30-Minute Lesson",
    membership: "Membership — 4 one-hour lessons (4 weeks)",
  };
  if (!labels[type] || !baseAmount) {
    res.status(400).json({ error: "Unknown lesson type." });
    return;
  }

  let amount = baseAmount;
  let amountDue = 0;
  let label = labels[type];
  if (type === "membership" && payMode === "deposit") {
    if (!settings.allowDeposit) {
      res.status(400).json({ error: "Deposit option isn't available right now. Pay in full by card or choose cash." });
      return;
    }
    amount = Math.min(settings.membershipDeposit || 10000, baseAmount);
    amountDue = Math.max(0, baseAmount - amount);
    label = `Membership deposit ($${(amount / 100).toFixed(0)}) — balance $${(amountDue / 100).toFixed(0)} cash`;
  }

  let sessions = Array.isArray(req.body?.sessions) ? req.body.sessions : [];
  if (!sessions.length && req.body?.date && req.body?.time) {
    sessions = [{ date: req.body.date, time: req.body.time }];
  }

  const isMember = type === "membership";
  const emailOk = email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const valid =
    player &&
    (!isMember || emailOk) &&
    sessions.length === picks &&
    sessions.every((s) => DATE_RE.test(String(s?.date || "")) && TIME_RE.test(String(s?.time || "")));
  if (!valid) {
    res.status(400).json({
      error: isMember
        ? "Please pick your first lesson day and time, enter the player's name, and a valid email — that's how you sign in to book the rest."
        : "Please pick your lesson day, time and enter the player's name.",
    });
    return;
  }

  const availability = await getAvailability();
  const lessonMins = durationFor(type);
  const offSchedule = sessions.find((s) => !allowedTimes(s.date, availability, lessonMins).includes(s.time));
  if (offSchedule) {
    res.status(400).json({
      error: `We're not open ${offSchedule.date} at ${offSchedule.time}. Please pick a time shown on the booking form.`,
    });
    return;
  }

  const slotKeys = sessions.map((s) => `${s.date} ${s.time}`);
  if (new Set(slotKeys).size !== slotKeys.length) {
    res.status(400).json({ error: "You picked the same day and time twice — each lesson needs its own slot." });
    return;
  }

  try {
    const dates = [...new Set(sessions.map((s) => s.date))];
    const takenByDate = Object.fromEntries(
      await Promise.all(dates.map(async (d) => [d, await bookedTimes(key, d)]))
    );
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
    /* continue */
  }

  const origin = `https://${req.headers.host}`;
  const ADDRESS = "231 W Juniper Dr, Mustang, OK 73064";
  const sessionLabel = sessions.map((s) => `${s.date} at ${s.time}`).join(", ") + ` — ${player}`;

  const successUrl = isMember
    ? `${origin}/account.html?welcome=1&session_id={CHECKOUT_SESSION_ID}`
    : `${origin}/book.html?booked=1&session_id={CHECKOUT_SESSION_ID}`;

  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", successUrl);
  if (emailOk) params.append("customer_email", email);
  params.append("cancel_url", `${origin}/book.html?type=${encodeURIComponent(type)}`);
  params.append("line_items[0][quantity]", "1");
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][unit_amount]", String(amount));
  params.append("line_items[0][price_data][product_data][name]", label);
  params.append("line_items[0][price_data][product_data][description]", sessionLabel);

  const metaTarget = "payment_intent_data";
  params.append(
    `${metaTarget}[description]`,
    `${label}: ${sessionLabel}${focus ? ` · Focus: ${FOCUS_LABELS[focus]}` : ""}${phone ? ` (${phone})` : ""} · Location: ${ADDRESS}`
  );
  const meta = [
    ["player", player],
    ["parent", parent || ""],
    ["phone", phone || ""],
    ["email", email || ""],
    ["type", type],
    ["focus", focus],
    ["payment_mode", payMode],
    ["payment_status", amountDue > 0 ? "deposit_paid" : "paid"],
    ["amount_paid", String(amount)],
    ["amount_due", String(amountDue)],
    ["amount_total", String(baseAmount)],
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

  res.status(200).json({ url: data.url });
}
