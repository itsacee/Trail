import { blobReadVersioned, blobWrite } from "./store.js";
import { locationKeyFor } from "./schedule.js";
import { activeBookings } from "./manualBookings.js";

const FILE = "lessons.json";
const YEAR_MS = 366 * 86400 * 1000;

function empty() {
  return { lessons: [], voids: [] };
}

export async function loadLessons() {
  const { text: raw, etag } = await blobReadVersioned(FILE);
  if (!raw) return empty();
  try {
    const data = JSON.parse(raw);
    const lessons = Array.isArray(data?.lessons) ? data.lessons : [];
    const voids = Array.isArray(data?.voids) ? data.voids : [];
    const result = { lessons, voids };
    Object.defineProperty(result, "_etag", { value: etag || "", enumerable: false });
    return result;
  } catch {
    return empty();
  }
}

export async function saveLessons(data) {
  const cutoff = Date.now() - YEAR_MS;
  const keep = (iso) => {
    if (!iso) return false;
    const t = new Date(`${iso}T12:00:00`).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  };
  const lessons = (data.lessons || []).filter((l) => keep(l?.date));
  const voids = (data.voids || []).filter((v) => keep(v?.date));
  return blobWrite(FILE, { lessons, voids }, { ifMatch: data._etag || "" });
}

export function newLessonId() {
  return `lsn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function lessonsOnDate(data, date) {
  return (data.lessons || []).filter((l) => isActiveLesson(l) && l.date === date);
}

// Cancelled records may remain in Blob for history or may have been written by
// an older version of the site. They must never occupy a slot or spend a
// membership credit.
export function isActiveLesson(lesson) {
  const status = String(lesson?.status || "").toLowerCase();
  return status !== "cancelled" && status !== "canceled" && !lesson?.cancelledAt && !lesson?.canceledAt;
}

export function isVoided(stored, { sourceId, date, time }) {
  return (stored.voids || []).some(
    (v) =>
      v.date === date &&
      v.time === time &&
      (!sourceId || !v.sourceId || v.sourceId === sourceId)
  );
}

export function voidStripeLesson(data, lesson) {
  data.voids = Array.isArray(data.voids) ? data.voids : [];
  data.voids.push({
    email: String(lesson.email || "").toLowerCase(),
    date: lesson.date,
    time: lesson.time,
    sourceId: lesson.sourceId || "",
    at: Date.now(),
  });
}

export function lessonsForEmail(data, email) {
  const e = String(email || "").trim().toLowerCase();
  return (data.lessons || []).filter(
    (l) => isActiveLesson(l) && String(l.email || "").toLowerCase() === e
  );
}

// Only membership lessons spend membership credits. A drop-in or private lesson
// booked on the same email (or moved there by the coach) must not count.
export function memberLessonsForEmail(data, email) {
  return lessonsForEmail(data, email).filter((l) => (l.type || "membership") === "membership");
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
    player2: m.player2 || "",
    athletes: Number(m.athletes) || 1,
    seats: Number(m.seats) || 0,
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

// Mirror a paid Stripe checkout into Blob immediately. Stripe Search is
// eventually consistent, so this record is what closes the slot and puts the
// lesson on Coach Desk as soon as the confirmation/webhook runs.
export function upsertStripeLessons(data, sourceId, metadata) {
  data.lessons = Array.isArray(data.lessons) ? data.lessons : [];
  const incoming = lessonFromStripeMeta(sourceId, metadata || {}, "single");
  let changed = false;
  incoming.forEach((lesson) => {
    if (isVoided(data, lesson)) return;
    const index = data.lessons.findIndex((existing) => existing.id === lesson.id);
    const next = { ...lesson, source: "stripe", mirroredAt: Date.now() };
    if (index >= 0) {
      data.lessons[index] = { ...data.lessons[index], ...next };
    } else {
      data.lessons.push(next);
    }
    changed = true;
  });
  return changed;
}

// Everything on a member's calendar: the lesson they picked at checkout (which
// lives in Stripe metadata) plus the ones they booked later from the portal,
// plus cash/manual membership lessons from Coach Desk or pay-at-field.
export function scheduledFor(sub, stored, manual = null) {
  const email = String(sub.metadata?.email || sub.email || "").toLowerCase();
  const voids = new Set(
    (stored.voids || [])
      .filter((v) => String(v.email || "").toLowerCase() === email)
      .map((v) => `${v.date}|${v.time}`)
  );
  const fromBlob = memberLessonsForEmail(stored, email).filter(
    (lesson) => !voids.has(`${lesson.date}|${lesson.time}`)
  );
  const fromStripe = lessonFromStripeMeta(sub.id, sub.metadata || {}, "membership").filter(
    (l) => !voids.has(`${l.date}|${l.time}`)
  );
  const seen = new Set(fromBlob.map((l) => `${l.date}|${l.time}`));
  const merged = [...fromBlob];
  fromStripe.forEach((l) => {
    const k = `${l.date}|${l.time}`;
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(l);
    }
  });
  if (manual) {
    activeBookings(manual)
      .filter(
        (b) =>
          b.type === "membership" &&
          String(b.email || "").toLowerCase() === email &&
          b.date &&
          b.time &&
          !voids.has(`${b.date}|${b.time}`)
      )
      .forEach((b) => {
        const k = `${b.date}|${b.time}`;
        if (seen.has(k)) return;
        seen.add(k);
        merged.push({
          id: b.id,
          sourceId: b.id,
          source: "manual",
          type: "membership",
          player: b.player || "",
          parent: b.parent || "",
          phone: b.phone || "",
          email,
          focus: b.focus || "",
          date: b.date,
          time: b.time,
          loc: b.loc || "",
        });
      });
  }
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
