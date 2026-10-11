import { blobReadVersioned, blobCompareAndSet, blobWrite } from "./store.js";
import { mutateVersioned, DEFAULT_TXN_ATTEMPTS } from "./blobTxn.js";
import { locationKeyFor, privacyForPurchaseType } from "./schedule.js";
import { activeBookings } from "./manualBookings.js";
import {
  isMembershipType,
  membershipTypeOf,
  membershipTierOf,
  membershipLabel,
  isMembershipLesson,
  lessonBelongsToMembership,
} from "./membershipTypes.js";

const FILE = "lessons.json";
const YEAR_MS = 366 * 86400 * 1000;

function empty() {
  return { lessons: [], voids: [] };
}

function withMeta(result, etag, conditional, readFailed = false, allowUnconditionalCreate = false) {
  Object.defineProperty(result, "_etag", { value: etag || "", enumerable: false });
  Object.defineProperty(result, "_conditional", { value: Boolean(conditional), enumerable: false });
  // True only when we could not reach the store at all. A missing lessons.json
  // is a valid empty schedule — the first member booking creates it.
  Object.defineProperty(result, "_readFailed", { value: Boolean(readFailed), enumerable: false });
  // Missing file (404) may be created once without an ETag. Existing content
  // without a conditional ETag must NOT be overwritten (fail closed).
  Object.defineProperty(result, "_allowUnconditionalCreate", {
    value: Boolean(allowUnconditionalCreate),
    enumerable: false,
  });
  return result;
}

function withinCutoff(iso, cutoff) {
  if (!iso) return false;
  const t = new Date(`${iso}T12:00:00`).getTime();
  return !Number.isNaN(t) && t >= cutoff;
}

function payloadFrom(data) {
  const cutoff = Date.now() - YEAR_MS;
  const lessons = (data.lessons || []).filter((l) => withinCutoff(l?.date, cutoff));
  const voids = (data.voids || []).filter((v) => withinCutoff(v?.date, cutoff));
  return { lessons, voids };
}

export async function loadLessons() {
  const { text: raw, etag, conditional, unreachable } = await blobReadVersioned(FILE);
  if (!raw) {
    // 404 / empty file → allow first create. Unreachable store → block saves.
    return withMeta(empty(), etag, conditional, Boolean(unreachable), !unreachable);
  }
  try {
    const data = JSON.parse(raw);
    const lessons = Array.isArray(data?.lessons) ? data.lessons : [];
    const voids = Array.isArray(data?.voids) ? data.voids : [];
    return withMeta({ lessons, voids }, etag, conditional, false, false);
  } catch {
    return withMeta(empty(), "", false, true, false);
  }
}

// Strict commit for lessons.json. Never silently overwrites a concurrent change.
// Returns { ok, conflict?, unsafe? }.
export async function commitLessons(data) {
  if (data?._readFailed) return { ok: false, conflict: false };
  const payload = payloadFrom(data);
  const etag = data._etag || "";
  const conditional = Boolean(data._conditional && etag);

  if (conditional) {
    return blobCompareAndSet(FILE, payload, etag);
  }

  if (data._allowUnconditionalCreate) {
    // First create of a missing file only.
    return blobCompareAndSet(FILE, payload, "");
  }

  // Content was readable but we have no SDK ETag — refusing is safer than the
  // Lock-in #58/#54 silent overwrite that dropped sibling bookings.
  return { ok: false, conflict: false, unsafe: true };
}

// Backward-compatible boolean save. Prefer mutateLessons for booking paths.
export async function saveLessons(data) {
  const result = await commitLessons(data);
  return Boolean(result?.ok);
}

/**
 * Load → mutator → CAS commit, with reload/revalidate/reapply on conflict.
 * mutator(data) must return { ok:true } / { ok:true, skipSave:true } / { ok:false, error, code? }.
 */
export async function mutateLessons(mutator, { attempts = DEFAULT_TXN_ATTEMPTS } = {}) {
  return mutateVersioned({
    load: loadLessons,
    commit: commitLessons,
    mutator,
    attempts,
    unavailableError: "Couldn't safely reserve that lesson. Please try again.",
  });
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

// A void hides one specific Stripe slot. It must never hide a different family's
// lesson (or a member credit) that happens to share the same day and time.
export function isVoided(stored, row) {
  const date = row?.date;
  const time = row?.time;
  const sourceId = row?.sourceId || row?.subId || "";
  const email = String(row?.email || "").toLowerCase();
  return (stored.voids || []).some((v) => {
    if (v.date !== date || v.time !== time) return false;
    if (v.sourceId) {
      return Boolean(sourceId) && v.sourceId === sourceId;
    }
    // Legacy voids without a payment id: only hide the same inbox at that slot.
    if (v.email) return Boolean(email) && v.email === email;
    return true;
  });
}

export function voidStripeLesson(data, lesson) {
  data.voids = Array.isArray(data.voids) ? data.voids : [];
  data.voids.push({
    email: String(lesson.email || "").toLowerCase(),
    date: lesson.date,
    time: lesson.time,
    sourceId: lesson.sourceId || lesson.subId || "",
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
  return lessonsForEmail(data, email).filter((l) => isMembershipLesson(l));
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
  const type = m.type || fallbackType;
  const privacy =
    String(m.privacy || "").toLowerCase() ||
    (isMembershipType(type) || type === "private" ? privacyForPurchaseType(type) : "");
  const base = {
    sourceId,
    player: m.player || "",
    player2: m.player2 || "",
    athletes: Number(m.athletes) || 1,
    seats: Number(m.seats) || 0,
    parent: m.parent || "",
    phone: m.phone || "",
    email: String(m.email || "").toLowerCase(),
    type,
    focus: m.focus || "",
    privacy,
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
// Pass `siblings` (all purchases for the email) so legacy lessons without subId
// are attributed to exactly one purchase when several same-tier buys overlap.
export function scheduledFor(sub, stored, manual = null, siblings = null) {
  const email = String(sub.metadata?.email || sub.email || "").toLowerCase();
  const peers = Array.isArray(siblings) && siblings.length ? siblings : sub ? [sub] : [];
  const voids = new Set(
    (stored.voids || [])
      .filter((v) => String(v.email || "").toLowerCase() === email)
      .map((v) => `${v.date}|${v.time}`)
  );
  const fromBlob = memberLessonsForEmail(stored, email).filter(
    (lesson) => !voids.has(`${lesson.date}|${lesson.time}`)
  );
  const fromStripe = [];
  peers.forEach((purchase) => {
    lessonFromStripeMeta(purchase.id, purchase.metadata || {}, "membership").forEach((l) => {
      if (!voids.has(`${l.date}|${l.time}`)) fromStripe.push(l);
    });
  });
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
          isMembershipType(b.type || "membership") &&
          String(b.email || "").toLowerCase() === email &&
          b.date &&
          b.time &&
          !voids.has(`${b.date}|${b.time}`)
      )
      .forEach((b) => {
        const k = `${b.date}|${b.time}`;
        if (seen.has(k)) return;
        seen.add(k);
        const type = membershipTypeOf(b);
        merged.push({
          id: b.id,
          sourceId: b.id,
          source: "manual",
          type,
          player: b.player || "",
          parent: b.parent || "",
          phone: b.phone || "",
          email,
          focus: b.focus || "",
          privacy: b.privacy || privacyForPurchaseType(type),
          date: b.date,
          time: b.time,
          loc: b.loc || "",
        });
      });
  }
  // When a specific purchase is in hand, keep only lessons that belong to it so
  // standard and private credits never combine across overlapping buys.
  if (sub?.id) {
    return merged.filter((l) => lessonBelongsToMembership(l, sub, peers));
  }
  return merged;
}

/** Union of upcoming lessons across every purchase for an email (deduped by id). */
export function scheduledAcrossMemberships(subs, stored, manual = null) {
  const peers = (subs || []).filter(Boolean);
  const byId = new Map();
  peers.forEach((sub) => {
    scheduledFor(sub, stored, manual, peers).forEach((lesson) => {
      if (!byId.has(lesson.id)) {
        byId.set(lesson.id, {
          ...lesson,
          membershipId: lesson.subId || lesson.membershipId || sub.id || "",
          membershipTier: membershipTierOf(sub),
          membershipLabel: membershipLabel(membershipTierOf(sub)),
        });
      }
    });
  });
  return [...byId.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export function makeMemberLesson({ sub, date, time, focus, availability }) {
  const m = sub.metadata || {};
  const type = membershipTypeOf(sub);
  const privacy = privacyForPurchaseType(type);
  return {
    id: newLessonId(),
    subId: sub.id,
    source: "member",
    type,
    player: m.player || "",
    parent: m.parent || "",
    phone: m.phone || "",
    email: String(m.email || sub.email || "").toLowerCase(),
    focus: focus || "",
    privacy,
    membershipTier: membershipTierOf(sub),
    seats: privacy === "private" ? 2 : 1,
    date,
    time,
    loc: locationKeyFor(date, availability),
    createdAt: Date.now(),
  };
}
