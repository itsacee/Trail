// Calendar feed of booked lessons, for subscribing from iPhone Calendar,
// Google Calendar, or Outlook. Protected by the same coach passcode:
//
//   webcal://www.apacademybsb.com/api/calendar?key=YOUR_PASSCODE
//
// Calendar apps can't send headers, so the passcode travels in the URL.

import { fetchBookings } from "../lib/bookings.js";
import { LOCATIONS, locationKeyFor } from "../lib/schedule.js";

const TYPE_LABEL = { single: "Private", thirty: "30-min", membership: "Membership" };

// US Central, so times stay correct across daylight saving changes.
const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/Chicago",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0600",
  "TZOFFSETTO:-0500",
  "TZNAME:CDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0600",
  "TZNAME:CST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

function esc(v) {
  return String(v)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// ICS content lines must be 75 octets or less; continuations start with a space.
function fold(line) {
  const bytes = (s) => Buffer.byteLength(s, "utf8");
  if (bytes(line) <= 75) return line;
  const parts = [];
  let rest = line;
  while (bytes(rest) > 75) {
    let cut = Math.min(75, rest.length);
    while (bytes(rest.slice(0, cut)) > 75) cut--;
    parts.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  parts.push(rest);
  return parts.join("\r\n");
}

function to24(time) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(time).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return { h, min: parseInt(m[2], 10) };
}

const pad = (n) => String(n).padStart(2, "0");

function stamp() {
  const d = new Date();
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
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
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AP Academy//Lesson Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:AP Academy Lessons",
    "X-WR-TIMEZONE:America/Chicago",
    // Ask subscribers to re-check every 15 minutes
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
    ...VTIMEZONE,
  ];

  bookings.forEach((b) => {
    const t = to24(b.time);
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return;
    const [y, mo, d] = b.date.split("-").map(Number);
    const start = `${y}${pad(mo)}${pad(d)}T${pad(t.h)}${pad(t.min)}00`;
    // 30-minute lessons run half an hour; everything else is a full hour.
    const durationMin = b.type === "thirty" ? 30 : 60;
    const endMin = t.h * 60 + t.min + durationMin;
    const end = `${y}${pad(mo)}${pad(d)}T${pad(Math.floor(endMin / 60))}${pad(endMin % 60)}00`;

    const who = b.player || "Lesson";
    const kind = TYPE_LABEL[b.type] || "Lesson";
    const place = LOCATIONS[b.loc || locationKeyFor(b.date)] || null;
    const where = place ? place.address || place.name : "";
    const details = [
      b.parent ? `Parent: ${b.parent}` : "",
      b.phone ? `Phone: ${b.phone}` : "",
      b.email ? `Email: ${b.email}` : "",
      `Session: ${kind}`,
      place ? `Location: ${place.name}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    lines.push(
      "BEGIN:VEVENT",
      fold(`UID:${esc(b.id)}@apacademybsb.com`),
      `DTSTAMP:${now}`,
      `DTSTART;TZID=America/Chicago:${start}`,
      `DTEND;TZID=America/Chicago:${end}`,
      fold(`SUMMARY:${esc(`${who} — ${kind}${place ? ` @ ${place.name}` : ""}`)}`),
      fold(`LOCATION:${esc(where)}`),
      fold(`DESCRIPTION:${esc(details)}`),
      "STATUS:CONFIRMED",
      "BEGIN:VALARM",
      "TRIGGER:-PT60M",
      "ACTION:DISPLAY",
      fold(`DESCRIPTION:${esc(`${who} lesson in 1 hour`)}`),
      "END:VALARM",
      "END:VEVENT"
    );
  });

  lines.push("END:VCALENDAR");

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="ap-academy-lessons.ics"');
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.status(200).send(lines.join("\r\n") + "\r\n");
}
