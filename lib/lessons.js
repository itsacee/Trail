import { blobRead, blobWrite } from "./store.js";
import { locationKeyFor } from "./schedule.js";

const FILE = "lessons.json";
const YEAR_MS = 366 * 86400 * 1000;

function empty() {
  return { lessons: [] };
}

export async function loadLessons() {
  const raw = await blobRead(FILE);
  if (!raw) return empty();
  try {
    const data = JSON.parse(raw);
    const lessons = Array.isArray(data?.lessons) ? data.lessons : [];
    return { lessons };
  } catch {
    return empty();
  }
}

export async function saveLessons(data) {
  const cutoff = Date.now() - YEAR_MS;
  const lessons = (data.lessons || []).filter((l) => {
    if (!l?.date) return false;
    const t = new Date(`${l.date}T12:00:00`).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });
  return blobWrite(FILE, { lessons });
}

export function newLessonId() {
  return `lsn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function lessonsOnDate(data, date) {
  return (data.lessons || []).filter((l) => l.date === date);
}

export function lessonsForEmail(data, email) {
  const e = String(email || "").trim().toLowerCase();
  return (data.lessons || []).filter((l) => String(l.email || "").toLowerCase() === e);
}

export function addLesson(data, lesson) {
  data.lessons.push(lesson);
  return lesson;
}

export function removeLesson(data, id, email) {
  const e = String(email || "").trim().toLowerCase();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter(
    (l) => !(l.id === id && String(l.email || "").toLowerCase() === e)
  );
  return data.lessons.length < before;
}

export function lessonFromStripeMeta(sourceId, m, fallbackType) {
  const base = {
    sourceId,
    player: m.player || "",
    parent: m.parent || "",
    phone: m.phone || "",
    email: String(m.email || "").toLowerCase(),
    type: m.type || fallbackType,
    focus: m.focus || "",
    source: "stripe",
  };
  const out = [];
  for (let i = 1; i <= 4; i++) {
    if (m[`date${i}`] && m[`time${i}`]) {
      out.push({
        ...base,
        id: `${sourceId}-${i}`,
        date: m[`date${i}`],
        time: m[`time${i}`],
        loc: m[`loc${i}`] || "",
      });
    }
  }
  if (!out.length && m.date && m.time) {
    out.push({ ...base, id: `${sourceId}-1`, date: m.date, time: m.time, loc: m.loc || "" });
  }
  return out;
}

// Everything on a member's calendar: the lesson they picked at checkout (which
// lives in Stripe metadata) plus the ones they booked later from the portal.
export function scheduledFor(sub, stored) {
  const email = String(sub.metadata?.email || sub.email || "").toLowerCase();
  const fromBlob = lessonsForEmail(stored, email);
  const fromStripe = lessonFromStripeMeta(sub.id, sub.metadata || {}, "membership");
  const seen = new Set(fromBlob.map((l) => `${l.date}|${l.time}`));
  const merged = [...fromBlob];
  fromStripe.forEach((l) => {
    const k = `${l.date}|${l.time}`;
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(l);
    }
  });
  return merged;
}

export function makeMemberLesson({ sub, date, time, focus, availability }) {
  const m = sub.metadata || {};
  return {
    id: newLessonId(),
    subId: sub.id,
    source: "member",
    type: "membership",
    player: m.player || "",
    parent: m.parent || "",
    phone: m.phone || "",
    email: String(m.email || sub.email || "").toLowerCase(),
    focus: focus || "",
    date,
    time,
    loc: locationKeyFor(date, availability),
    createdAt: Date.now(),
  };
}
