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
    name: "Mustang High School indoor facility",
    // Shown publicly (before payment) — general area only
    area: "Mustang High School indoor facility",
    // Shown only after payment, in the confirmation email
    address: "231 W Juniper Dr, Mustang, OK 73064",
    note: "We train at the Mustang High School indoor baseball facility. Plan to arrive about 5 minutes early.",
  },
  // Kept so any earlier Del City bookings still resolve to the right place.
  delcity: {
    name: "Del City",
    area: "Del City — just off I-40, southeast OKC metro",
    address: "3701 S Bryant Ave, Del City, OK 73115",
    note: "Plan to arrive about 5 minutes early.",
  },
};

// Every open day trains at the Mustang High School indoor facility.
export const LOCATION_KEY = "mustang";

// Weekly hours. `start`/`end` are 24h wall-clock; lessons run one slot long, so
// the last start is `end` minus one slot. 0 = Sunday ... 6 = Saturday.
export const DEFAULT_AVAILABILITY = {
  slotMinutes: 60,
  days: {
    0: { open: false, start: "18:00", end: "20:00" }, // Sun
    1: { open: true, start: "18:00", end: "20:00" }, // Mon 6–8 PM
    2: { open: true, start: "18:00", end: "20:00" }, // Tue
    3: { open: true, start: "18:00", end: "20:00" }, // Wed
    4: { open: false, start: "18:00", end: "20:00" }, // Thu
    5: { open: false, start: "18:00", end: "20:00" }, // Fri
    6: { open: false, start: "18:00", end: "20:00" }, // Sat
  },
  blocked: [], // specific "YYYY-MM-DD" dates that are fully off
};

// Hourly starts — Mon–Wed 6:00 and 7:00. Two athletes can share each start.
export const STEP_MINUTES = 60;

// How long each session actually occupies, in minutes.
export const DURATIONS = { single: 60, thirty: 30, membership: 60, private: 60 };

// An hour holds two athlete seats. One athlete leaves a seat open for someone
// else at the same focus; two athletes (siblings) fill the hour; a private
// lesson buys both seats so nobody can join.
export const SLOT_CAPACITY = 2;

// A private lesson takes the whole hour no matter how many athletes are on it.
export function seatsFor(type, athletes = 1) {
  if (type === "private") return SLOT_CAPACITY;
  const n = Math.round(Number(athletes) || 1);
  return Math.min(SLOT_CAPACITY, Math.max(1, n));
}

export function isExclusiveType(type) {
  return type === "private";
}

// Types that can put two athletes on one booking. A private pair still owns the
// whole hour; a membership credit belongs to a single athlete.
export function canPair(type) {
  return type === "single" || type === "thirty" || type === "private";
}

export function durationFor(type) {
  return DURATIONS[type] || 60;
}

// "5:00 PM" -> minutes since midnight (null if it doesn't parse).
export function labelToMin(label) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(label).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

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
// Saved hours from when weeknights were 5–9. Swap those for Mon–Wed 6–8
// so the live site picks up the new schedule without a manual coach save.
export function migrateSavedAvailability(av) {
  const d = av?.days || {};
  const oldNights = [1, 2, 3, 4, 5].every(
    (i) => d[i] && d[i].open && d[i].start === "17:00" && d[i].end === "21:00"
  );
  if (!oldNights) return av;
  const next = normalizeAvailability(DEFAULT_AVAILABILITY);
  next.blocked = Array.isArray(av.blocked) ? av.blocked : [];
  return next;
}

export async function getAvailability() {
  const raw = await kvGet("availability");
  if (!raw) return normalizeAvailability(DEFAULT_AVAILABILITY);
  try {
    return migrateSavedAvailability(normalizeAvailability(JSON.parse(raw)));
  } catch {
    return normalizeAvailability(DEFAULT_AVAILABILITY);
  }
}

// Noon avoids any timezone shifting the day of the week
function dayOf(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  return isNaN(d) ? null : d.getDay();
}

// Slot START times ("HH:mm") for a date, offered every STEP_MINUTES. A start is
// only included if a lesson of `durationMin` fits before the day's close time.
export function startTimesForDate(isoDate, availability, durationMin) {
  const av = availability || normalizeAvailability(DEFAULT_AVAILABILITY);
  const day = dayOf(isoDate);
  if (day === null) return [];
  if (av.blocked.includes(isoDate)) return [];
  const cfg = av.days[day];
  if (!cfg || !cfg.open) return [];
  const start = toMin(cfg.start);
  const end = toMin(cfg.end);
  const dur = durationMin || STEP_MINUTES;
  const step = av.slotMinutes || STEP_MINUTES;
  const out = [];
  for (let t = start; t + dur <= end; t += step) out.push(fromMin(t));
  return out;
}

// Formatted ("9:00 AM") allowed times for a date. `durationMin` is optional and
// defaults to one slot step (used for a general "is this day open" check).
export function allowedTimes(isoDate, availability, durationMin) {
  return startTimesForDate(isoDate, availability, durationMin).map(fmtTime);
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

function rangeOf(time, mins) {
  const start = labelToMin(time);
  if (start === null) return null;
  return [start, start + (Number(mins) > 0 ? Number(mins) : 60)];
}

export function focusMatches(bookedFocuses, requestedFocus) {
  const wanted = String(requestedFocus || "");
  const focuses = [...new Set((bookedFocuses || []).map((focus) => String(focus || "")).filter(Boolean))];
  return Boolean(wanted && focuses.length === 1 && focuses[0] === wanted);
}

// Seats already sold at a start. Older rows only carried a booking `count`, so
// fall back to that when no seat total was recorded.
function seatsTaken(row) {
  const seats = Number(row?.seats);
  if (seats > 0) return seats;
  const count = Number(row?.count);
  return count > 0 ? count : 1;
}

function normalizeWant(want) {
  if (typeof want === "number") return { seats: Math.max(1, want), exclusive: false };
  const seats = Math.max(1, Number(want?.seats) || 1);
  return { seats, exclusive: Boolean(want?.exclusive) || seats >= SLOT_CAPACITY };
}

// Seats left for a new booking at this start — 0 when it's full, taken by a
// private lesson, a different focus, or a different lesson length.
export function seatsLeft(booked, timeLabel, mins, focus) {
  const dur = Number(mins) > 0 ? Number(mins) : 60;
  const want = rangeOf(timeLabel, dur);
  if (!want) return 0;
  const [ws, we] = want;
  let left = SLOT_CAPACITY;
  for (const b of booked || []) {
    const got = rangeOf(b.time, b.mins);
    if (!got) continue;
    const [bs, be] = got;
    if (!(ws < be && bs < we)) continue;
    if (b.time !== timeLabel || (b.mins || 60) !== dur) return 0;
    if (b.exclusive) return 0;
    if (!focusMatches(b.focuses, focus)) return 0;
    left -= seatsTaken(b);
  }
  return Math.max(0, left);
}

// True when this start can't take the booking: it's full, it overlaps another
// time, the focus differs, or a private lesson owns the hour. `want` is the
// number of athlete seats needed, or { seats, exclusive } for private lessons.
// Old bookings without a saved focus stay exclusive for safety.
export function slotBlocked(booked, timeLabel, mins, focus, want = 1) {
  const { seats, exclusive } = normalizeWant(want);
  const range = rangeOf(timeLabel, mins);
  if (!range) return true;
  const [ws, we] = range;
  const dur = Number(mins) > 0 ? Number(mins) : 60;

  for (const b of booked || []) {
    const got = rangeOf(b.time, b.mins);
    if (!got) continue;
    const [bs, be] = got;
    if (!(ws < be && bs < we)) continue;
    const sameStart = b.time === timeLabel;
    const sameLen = (b.mins || 60) === dur;
    if (!sameStart || !sameLen) return true;
    // A private lesson owns the hour, and a private booking can't join anyone.
    if (b.exclusive || exclusive) return true;
    if (!focusMatches(b.focuses, focus)) return true;
    if (seatsTaken(b) + seats > SLOT_CAPACITY) return true;
  }
  return false;
}
