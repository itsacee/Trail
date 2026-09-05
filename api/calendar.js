// Calendar feed of booked lessons, for subscribing from iPhone Calendar,
// Google Calendar, or Outlook. Protected by the same coach passcode:
//
//   webcal://www.apacademybsb.com/api/calendar?key=YOUR_PASSCODE
//
// Calendar apps can't send headers, so the passcode travels in the URL.
//
// Every booking lands here: lessons picked at checkout (from Stripe metadata)
// and the ones members book themselves later (from Vercel Blob). Cancelling
// removes the lesson, so it disappears on the next refresh.

import { fetchBookings } from "../lib/bookings.js";
import { LOCATIONS, locationKeyFor } from "../lib/schedule.js";
import { buildCalendar, eventLines, stamp } from "../lib/ics.js";

const TYPE_LABEL = { single: "1 hour", thirty: "30-min", membership: "Membership" };
const FOCUS_LABELS = { Hitting: "Hitting", Fielding: "Fielding", Both: "Hitting & Fielding" };

// Shared by the feed and the emailed invite so an event looks the same
// wherever it's added from.
export function bookingEvent(b, now) {
  const who = b.player || "Lesson";
  const kind = TYPE_LABEL[b.type] || "Lesson";
  const focusText = FOCUS_LABELS[b.focus] || b.focus || "";
  const place = LOCATIONS[b.loc || locationKeyFor(b.date)] || null;

  return eventLines({
    uid: `${b.id}@apacademybsb.com`,
    date: b.date,
    time: b.time,
    // 30-minute lessons run half an hour; everything else is a full hour.
    durationMin: b.type === "thirty" ? 30 : 60,
    summary: `${who} — ${kind}${focusText ? ` · ${focusText}` : ""}${place ? ` @ ${place.name}` : ""}`,
    location: place ? place.address || place.name : "",
    description: [
      focusText ? `Working on: ${focusText}` : "",
      b.parent ? `Parent: ${b.parent}` : "",
      b.phone ? `Phone: ${b.phone}` : "",
      b.email ? `Email: ${b.email}` : "",
      `Session: ${kind}`,
      place ? `Location: ${place.name}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    alarmMinutes: 60,
    now,
  });
}

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const pass = process.env.COACH_PASS;

  if (!key || !pass) {
    res.status(500).send("Calendar feed is not set up yet.");
    return;
  }
  if (String(req.query?.key || "") !== pass) {
    res.status(401).send("Wrong passcode.");
    return;
  }

  let bookings = [];
  try {
    bookings = await fetchBookings(key);
  } catch {
    bookings = [];
  }

  const now = stamp();
  const body = buildCalendar({
    name: "AP Academy Lessons",
    // Ask subscribers to re-check every 15 minutes
    refreshMinutes: 15,
    events: bookings.map((b) => bookingEvent(b, now)),
  });

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="ap-academy-lessons.ics"');
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.status(200).send(body);
}
