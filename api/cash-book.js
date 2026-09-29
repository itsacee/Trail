// Public cash booking — reserve a slot and pay at the field.

import { bookedTimes } from "./slots.js";
import {
  allowedTimes,
  getAvailability,
  durationFor,
  slotBlocked,
  seatsFor,
  isExclusiveType,
  SLOT_CAPACITY,
  LOCATIONS,
} from "../lib/schedule.js";
import { bookWindowBlocked, MEMBER_PERIOD_DAYS } from "../lib/members.js";
import {
  loadManualBookings,
  saveManualBookings,
  makeManualBooking,
} from "../lib/manualBookings.js";
import { loadSettings } from "../lib/settings.js";
import {
  loadMembersState,
  saveMembersState,
  upsertMember,
} from "../lib/membersStore.js";
import { loadCoachStatus } from "../lib/coachStatus.js";
import {
  membershipBlockedMessage,
  normalizeFocus,
  focusBlockedMessage,
} from "../lib/siteStatus.js";
import {
  getMembershipCapacity,
  MEMBERSHIP_LIMIT,
} from "../lib/membershipCapacity.js";

const REPLY_TO = "Apacademybsb@gmail.com";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2} (AM|PM)$/;
const FOCUS = { Hitting: true, Fielding: true, Both: true };

async function sendMail({ to, subject, text }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey || !to) return false;
  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], bcc: [REPLY_TO], reply_to: REPLY_TO, subject, text }),
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

  await loadCoachStatus();
  const settings = await loadSettings();
  if (!settings.allowCash) {
    res.status(400).json({ error: "Cash booking isn't turned on. Please pay by card or call (405) 819-4401." });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY || "";
  const body = req.body || {};
  const type = ["single", "thirty", "private", "membership"].includes(body.type) ? body.type : "";
  const player = String(body.player || "").trim();
  const player2 = String(body.player2 || "").trim();
  const parent = String(body.parent || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const focusRaw = FOCUS[body.focus] ? String(body.focus) : "";
  const date = String(body.date || body.sessions?.[0]?.date || "");
  const time = String(body.time || body.sessions?.[0]?.time || "");
  // A second athlete is only possible on the shared-hour lesson types.
  const canShare = type === "single" || type === "thirty";
  const athletes = canShare && player2 ? 2 : 1;
  const seats = isExclusiveType(type) ? SLOT_CAPACITY : seatsFor(type, athletes);

  if (!type || !player || !email || !DATE_RE.test(date) || !TIME_RE.test(time)) {
    res.status(400).json({ error: "Please pick a day and time, enter the athlete's name and email, and choose cash." });
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Please enter a valid email." });
    return;
  }

  if (type === "membership") {
    const paused = membershipBlockedMessage();
    if (paused) {
      res.status(503).json({ error: paused, code: "membership_paused" });
      return;
    }
    if (key) {
      try {
        const { summary } = await getMembershipCapacity(key, email);
        if (!summary.available) {
          res.status(409).json({
            error: `Memberships are full — all ${MEMBERSHIP_LIMIT} spots are taken.`,
            code: "membership_full",
          });
          return;
        }
      } catch {
        res.status(503).json({ error: "Couldn't confirm membership availability. Try again shortly." });
        return;
      }
    }
  }

  const focusError = focusBlockedMessage(focusRaw);
  if (focusError) {
    res.status(400).json({ error: focusError });
    return;
  }
  const focus = normalizeFocus(focusRaw, type);

  const windowBlock = bookWindowBlocked(date);
  if (windowBlock) {
    res.status(400).json({ error: windowBlock });
    return;
  }

  const availability = await getAvailability();
  const lessonMins = durationFor(type);
  if (!allowedTimes(date, availability, lessonMins).includes(time)) {
    res.status(400).json({ error: "That time isn't open. Pick another slot." });
    return;
  }

  if (key) {
    try {
      const taken = await bookedTimes(key, date);
      if (slotBlocked(taken, time, lessonMins, focus, { seats, exclusive: isExclusiveType(type) })) {
        res.status(409).json({
          error: isExclusiveType(type)
            ? "Sorry — that hour already has a lesson on it, so it can't be private. Pick another."
            : athletes > 1
            ? "Sorry — that hour doesn't have room for two athletes. Pick another."
            : "Sorry — that time is full or has a different focus. Pick another.",
        });
        return;
      }
    } catch {
      /* continue */
    }
  }

  const price = (settings.prices[type] || 0) * athletes;
  const isMember = type === "membership";
  const booking = makeManualBooking({
    type,
    player,
    player2,
    athletes,
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
    note: isMember ? "Cash membership — collect at field" : "Pay cash at the lesson",
    createdBy: "parent",
  });

  if (isMember) {
    const members = await loadMembersState();
    const start = Math.floor(Date.now() / 1000);
    upsertMember(members, email, {
      cashMembership: true,
      cashMembershipStart: start,
      cashMembershipEnd: start + MEMBER_PERIOD_DAYS * 86400,
      player,
      parent,
      phone,
      amountDueCents: price,
      amountPaidCents: 0,
      paymentMethod: "cash",
    });
    await saveMembersState(members);
  }

  const store = await loadManualBookings();
  store.bookings.push(booking);
  const saved = await saveManualBookings(store);
  if (!saved) {
    res.status(500).json({ error: "Couldn't save that booking. Call or text (405) 819-4401." });
    return;
  }

  const loc = LOCATIONS.mustang || {};
  const dollars = (price / 100).toFixed(2);
  const who = player2 ? `${player} & ${player2}` : player;
  const sent = await sendMail({
    to: email,
    subject: isMember
      ? `Membership reserved — first lesson ${date} at ${time}`
      : `Lesson reserved — ${date} at ${time} (pay cash)`,
    text:
      `${who}'s ${isMember ? "membership first lesson" : "lesson"} is reserved for ${date} at ${time}.\n\n` +
      `Pay $${dollars} cash at the field` +
      (isMember ? " (covers all 4 lessons)." : athletes > 1 ? ` (covers both athletes).` : ".") +
      `\n\n` +
      (type === "private" ? `This is a private 1-on-1 hour — nobody else will be added to it.\n\n` : "") +
      (athletes > 1 ? `Both athletes are on this hour, so the time is now full.\n\n` : "") +
      (loc.address ? `Where: ${loc.address}\n${loc.note || ""}\n\n` : "") +
      (isMember ? `Sign in at apacademybsb.com/account.html with ${email} to book the other lessons.\n\n` : "") +
      `Questions? (405) 819-4401`,
  });

  res.status(200).json({
    ok: true,
    sent,
    booking,
    player,
    email,
    sessions: [{ date, time }],
    places: loc.address
      ? [{ name: loc.name, address: loc.address, mapUrl: `https://maps.google.com/?q=${encodeURIComponent(loc.address)}` }]
      : [],
    payMode: "cash",
    amountDue: price,
    member: isMember,
  });
}
