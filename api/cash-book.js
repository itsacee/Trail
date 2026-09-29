// Public cash (or "pay at the field") booking — no Stripe Checkout.
// Still validates the slot, emails parent + coach, syncs Google Calendar,
// and records a finance entry when marked paid later by the coach.

import { bookedTimes } from "./slots.js";
import {
  allowedTimes,
  getAvailability,
  durationFor,
  labelToMin,
  LOCATIONS,
} from "../lib/schedule.js";
import {
  loadManualBookings,
  saveManualBookings,
  makeManualBooking,
} from "../lib/manualBookings.js";
import { loadSettings } from "../lib/settings.js";
import { upsertGoogleEvent } from "../lib/googleCalendar.js";
import {
  loadMembersState,
  saveMembersState,
  upsertMember,
} from "../lib/membersStore.js";

const REPLY_TO = "Apacademybsb@gmail.com";
const FOCUS = { Hitting: true, Fielding: true, Both: true };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2} (AM|PM)$/;

async function sendMail({ to, subject, text }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey || !to) return false;
  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        bcc: [REPLY_TO],
        reply_to: REPLY_TO,
        subject,
        text,
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const settings = await loadSettings();
  if (!settings.allowCash) {
    res.status(400).json({ error: "Cash booking isn't turned on right now. Please pay by card or call (405) 819-4401." });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  const body = req.body || {};
  const type = ["single", "thirty", "membership"].includes(body.type) ? body.type : "";
  const player = String(body.player || "").trim();
  const parent = String(body.parent || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const focus = FOCUS[body.focus] ? String(body.focus) : "";
  const date = String(body.date || "");
  const time = String(body.time || "");
  const payMode = body.payMode === "cash" ? "cash" : "";

  if (!type || !player || !email || !DATE_RE.test(date) || !TIME_RE.test(time) || payMode !== "cash") {
    res.status(400).json({
      error: "Please pick a day and time, enter the player's name and email, and choose cash pay.",
    });
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Please enter a valid email." });
    return;
  }

  const availability = await getAvailability();
  if (!allowedTimes(date, availability, durationFor(type)).includes(time)) {
    res.status(400).json({ error: "That time isn't open. Pick another slot." });
    return;
  }

  if (key) {
    try {
      const taken = await bookedTimes(key, date);
      const start = labelToMin(time);
      const dur = durationFor(type);
      const conflict =
        start !== null &&
        taken.some((b) => {
          const bStart = labelToMin(b.time);
          return bStart !== null && start < bStart + b.mins && bStart < start + dur;
        });
      if (conflict) {
        res.status(409).json({ error: "Sorry — that time was just booked. Pick another." });
        return;
      }
    } catch {
      /* continue */
    }
  }

  const price = settings.prices[type] || 0;
  const isMember = type === "membership";
  const booking = makeManualBooking({
    type,
    player,
    parent,
    phone,
    email,
    focus,
    date,
    time,
    availability,
    paymentMethod: "cash",
    paymentStatus: "unpaid",
    amountCents: price,
    amountPaidCents: 0,
    amountDueCents: price,
    note: isMember ? "Full membership — pay cash (or remaining balance) to coach" : "Pay cash at the lesson",
    createdBy: "parent",
  });

  // Cash memberships still get portal access for 28 days from signup.
  if (isMember) {
    const members = await loadMembersState();
    const start = Math.floor(Date.now() / 1000);
    upsertMember(members, email, {
      cashMembership: true,
      cashMembershipStart: start,
      cashMembershipEnd: start + 28 * 86400,
      player,
      parent,
      phone,
      credits: 4,
      paymentMethod: "cash",
      amountDueCents: price,
      amountPaidCents: 0,
    });
    await saveMembersState(members);
    booking.membershipId = `cash_${email}`;
  }

  const g = await upsertGoogleEvent(booking, settings.googleCalendarId);
  if (g.eventId) booking.googleEventId = g.eventId;

  const store = await loadManualBookings();
  store.bookings.push(booking);
  const saved = await saveManualBookings(store);
  if (!saved) {
    res.status(500).json({ error: "Couldn't save that booking. Call or text (405) 819-4401." });
    return;
  }

  const loc = LOCATIONS.mustang || {};
  const dollars = (price / 100).toFixed(2);
  const sent = await sendMail({
    to: email,
    subject: isMember
      ? `Membership reserved — first lesson ${date} at ${time}`
      : `Lesson reserved — ${date} at ${time} (pay cash)`,
    text:
      `${player}'s ${isMember ? "membership first lesson" : "lesson"} is reserved for ${date} at ${time}.\n\n` +
      `Pay $${dollars} cash at the field` +
      (isMember ? " (covers all 4 lessons)." : ".") +
      `\n\n` +
      (loc.address ? `Where: ${loc.address}\n${loc.note || ""}\n\n` : "") +
      (isMember
        ? `After this, sign in at apacademybsb.com/account.html with ${email} to book your other lessons.\n\n`
        : "") +
      `Questions? (405) 819-4401`,
  });

  const places = loc.address
    ? [{ name: loc.name, address: loc.address, mapUrl: `https://maps.google.com/?q=${encodeURIComponent(loc.address)}` }]
    : [];

  res.status(200).json({
    ok: true,
    sent,
    booking,
    player,
    email,
    sessions: [{ date, time }],
    places,
    payMode: "cash",
    amountDue: price,
    member: isMember,
  });
}
