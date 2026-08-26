// Building iCalendar (.ics) data. Used two ways:
//
//   /api/calendar  — the subscribed feed of every booking
//   confirmations  — a single event attached to the email, so the coach and the
//                    parent can drop it straight into any calendar in one tap
//                    instead of waiting for the feed to refresh.

// US Central, so times stay correct across daylight saving changes.
export const VTIMEZONE = [
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

export function escapeIcs(v) {
  return String(v)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// ICS content lines must be 75 octets or less; continuations start with a space.
export function foldLine(line) {
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

export function to24(time) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(time).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return { h, min: parseInt(m[2], 10) };
}

const pad = (n) => String(n).padStart(2, "0");

export function stamp(d = new Date()) {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// One VEVENT. Returns [] if the date or time can't be parsed, so a single bad
// booking can never break the whole calendar.
export function eventLines({
  uid,
  date,
  time,
  durationMin = 60,
  summary,
  location = "",
  description = "",
  alarmMinutes = 60,
  now = stamp(),
}) {
  const t = to24(time);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return [];
  const [y, mo, d] = String(date).split("-").map(Number);
  const start = `${y}${pad(mo)}${pad(d)}T${pad(t.h)}${pad(t.min)}00`;
  const endMin = t.h * 60 + t.min + durationMin;
  const end = `${y}${pad(mo)}${pad(d)}T${pad(Math.floor(endMin / 60))}${pad(endMin % 60)}00`;

  const lines = [
    "BEGIN:VEVENT",
    foldLine(`UID:${escapeIcs(uid)}`),
    `DTSTAMP:${now}`,
    `DTSTART;TZID=America/Chicago:${start}`,
    `DTEND;TZID=America/Chicago:${end}`,
    foldLine(`SUMMARY:${escapeIcs(summary)}`),
  ];
  if (location) lines.push(foldLine(`LOCATION:${escapeIcs(location)}`));
  if (description) lines.push(foldLine(`DESCRIPTION:${escapeIcs(description)}`));
  lines.push("STATUS:CONFIRMED");
  if (alarmMinutes) {
    lines.push(
      "BEGIN:VALARM",
      `TRIGGER:-PT${alarmMinutes}M`,
      "ACTION:DISPLAY",
      foldLine(`DESCRIPTION:${escapeIcs(summary)}`),
      "END:VALARM"
    );
  }
  lines.push("END:VEVENT");
  return lines;
}

// `refreshMinutes` only matters for a subscribed feed; a one-off attachment
// leaves it off.
export function buildCalendar({ name, events = [], refreshMinutes = 0, method = "PUBLISH" }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AP Academy//Lesson Schedule//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
  ];
  if (name) {
    lines.push(foldLine(`X-WR-CALNAME:${escapeIcs(name)}`), "X-WR-TIMEZONE:America/Chicago");
  }
  if (refreshMinutes) {
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${refreshMinutes}M`, `X-PUBLISHED-TTL:PT${refreshMinutes}M`);
  }
  lines.push(...VTIMEZONE, ...events.flat(), "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
