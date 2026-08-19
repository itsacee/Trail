// Where and when lessons happen.
//
// Availability (which days, what hours) is editable by the coach and stored in
// the KV store under "availability". The DEFAULT_AVAILABILITY below is the
// fallback used whenever nothing is saved yet (or the store isn't configured).
//
// IMPORTANT: DEFAULT_AVAILABILITY is mirrored in js/main.js so the booking form
// can render instantly. If you change the defaults, change both together.

import { kvGet } from "./store.js";

export const LOCATIONS = {
  mustang: {
    name: "Mustang High School",
    // Shown publicly (before payment) — general area only
    area: "Mustang High School — Bronco baseball field",
    // Shown only after payment, in the confirmation email
    address: "231 W Juniper Dr, Mustang, OK 73064",
    note: "We train at the Mustang High School baseball field. Park by the field and plan to arrive about 5 minutes early.",
  },
  // Kept so any earlier Del City bookings still resolve to the right place.
  delcity: {
    name: "Del City",
    area: "Del City — just off I-40, southeast OKC metro",
    address: "3701 S Bryant Ave, Del City, OK 73115",
    note: "Plan to arrive about 5 minutes early.",
  },
};

// Every open day trains at the Mustang High School baseball field.
export const LOCATION_KEY = "mustang";

// Weekly hours. `start`/`end` are 24h wall-clock; lessons run one slot long, so
// the last start is `end` minus one slot. 0 = Sunday ... 6 = Saturday.
export const DEFAULT_AVAILABILITY = {
  slotMinutes: 60,
  days: {
    0: { open: true, start: "09:00", end: "19:00" }, // Sun
    1: { open: true, start: "17:00", end: "21:00" }, // Mon
    2: { open: true, start: "17:00", end: "21:00" }, // Tue
    3: { open: true, start: "17:00", end: "21:00" }, // Wed
    4: { open: true, start: "17:00", end: "21:00" }, // Thu
    5: { open: true, start: "17:00", end: "21:00" }, // Fri
    6: { open: true, start: "09:00", end: "19:00" }, // Sat
  },
  blocked: [], // specific "YYYY-MM-DD" dates that are fully off
};

function toMin(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}
function fromMin(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Fill in any missing pieces so a partial saved config can't break rendering.
export function normalizeAvailability(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const days = {};
  for (let i = 0; i <= 6; i++) {
    const d = (a.days && a.days[i]) || {};
    const def = DEFAULT_AVAILABILITY.days[i];
    days[i] = {
      open: d.open === undefined ? def.open : Boolean(d.open),
      start: /^\d{2}:\d{2}$/.test(d.start || "") ? d.start : def.start,
      end: /^\d{2}:\d{2}$/.test(d.end || "") ? d.end : def.end,
    };
  }
  const slot = Number(a.slotMinutes) > 0 ? Number(a.slotMinutes) : DEFAULT_AVAILABILITY.slotMinutes;
  const blocked = Array.isArray(a.blocked)
    ? a.blocked.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
    : [];
  return { slotMinutes: slot, days, blocked: [...new Set(blocked)].sort() };
}

// Reads the saved availability from the store, falling back to defaults.
export async function getAvailability() {
  const raw = await kvGet("availability");
  if (!raw) return normalizeAvailability(DEFAULT_AVAILABILITY);
  try {
    return normalizeAvailability(JSON.parse(raw));
  } catch {
    return normalizeAvailability(DEFAULT_AVAILABILITY);
  }
}

// Noon avoids any timezone shifting the day of the week
function dayOf(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  return isNaN(d) ? null : d.getDay();
}

// Slot START times ("HH:mm") for a date given an availability config.
export function startTimesForDate(isoDate, availability) {
  const av = availability || normalizeAvailability(DEFAULT_AVAILABILITY);
  const day = dayOf(isoDate);
  if (day === null) return [];
  if (av.blocked.includes(isoDate)) return [];
  const cfg = av.days[day];
  if (!cfg || !cfg.open) return [];
  const start = toMin(cfg.start);
  const end = toMin(cfg.end);
  const out = [];
  for (let t = start; t + av.slotMinutes <= end; t += av.slotMinutes) out.push(fromMin(t));
  return out;
}

// Formatted ("9:00 AM") allowed times for a date. `availability` is optional;
// omit it to use the built-in defaults (kept for backward compatibility).
export function allowedTimes(isoDate, availability) {
  return startTimesForDate(isoDate, availability).map(fmtTime);
}

export function isOpenOn(isoDate, availability) {
  return startTimesForDate(isoDate, availability).length > 0;
}

export function locationKeyFor(isoDate, availability) {
  return isOpenOn(isoDate, availability) ? LOCATION_KEY : "";
}

export function locationFor(isoDate, availability) {
  const key = locationKeyFor(isoDate, availability);
  return key ? LOCATIONS[key] : null;
}
