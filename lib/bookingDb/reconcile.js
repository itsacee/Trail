// Compare Blob snapshots vs Postgres without mutating either store's source of truth.
// Blob is read-only here; DB is read-only here.

import { isActiveLesson } from "../lessons.js";
import { isActive as holdIsActive } from "../holds.js";
import { activeBookings } from "../manualBookings.js";
import { LOCATION_KEY } from "../schedule.js";

function dateKey(d) {
  if (!d) return "";
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  const parsed = new Date(d);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return String(d).slice(0, 10);
}

function slotKey(location, date, time) {
  return `${location}|${dateKey(date)}|${time}`;
}

/**
 * Build expected active occupancy keys from Blob snapshots.
 */
export function blobActiveIndex(snapshots, { now = Date.now() } = {}) {
  const byId = new Map();
  const bySlot = new Map();

  for (const lesson of snapshots.lessons?.lessons || []) {
    if (!isActiveLesson(lesson) || !lesson.id) continue;
    const loc = lesson.loc || LOCATION_KEY;
    byId.set(lesson.id, {
      id: lesson.id,
      source: lesson.source || "member",
      date: lesson.date,
      time: lesson.time,
      focus: lesson.focus || "",
      email: String(lesson.email || "").toLowerCase(),
    });
    const k = slotKey(loc, lesson.date, lesson.time);
    bySlot.set(k, (bySlot.get(k) || 0) + 1);
  }

  for (const hold of snapshots.holds?.holds || []) {
    if (!holdIsActive(hold, now)) continue;
    const id = `hold_${hold.sessionId}_${hold.date}_${String(hold.time).replace(/\s+/g, "")}`;
    byId.set(id, {
      id,
      source: "hold",
      date: hold.date,
      time: hold.time,
      focus: hold.focus || "",
      email: "",
    });
    const k = slotKey(LOCATION_KEY, hold.date, hold.time);
    bySlot.set(k, (bySlot.get(k) || 0) + 1);
  }

  for (const booking of activeBookings(snapshots.manual || { bookings: [] })) {
    byId.set(booking.id, {
      id: booking.id,
      source: "manual",
      date: booking.date,
      time: booking.time,
      focus: booking.focus || "",
      email: String(booking.email || "").toLowerCase(),
    });
    const k = slotKey(booking.loc || LOCATION_KEY, booking.date, booking.time);
    bySlot.set(k, (bySlot.get(k) || 0) + 1);
  }

  return { byId, bySlot };
}

export async function dbActiveIndex(store, { now = Date.now() } = {}) {
  const nowIso = new Date(now).toISOString();
  const { rows } = await store.query(
    `SELECT id, source, slot_date, time_label, location_key, focus, email, status, hold_expires_at
     FROM bookings
     WHERE status = 'active'
        OR (status = 'held' AND (hold_expires_at IS NULL OR hold_expires_at > $1::timestamptz))`,
    [nowIso]
  );
  const byId = new Map();
  const bySlot = new Map();
  for (const row of rows) {
    const date = dateKey(row.slot_date);
    byId.set(row.id, {
      id: row.id,
      source: row.source,
      date,
      time: row.time_label,
      focus: row.focus || "",
      email: String(row.email || "").toLowerCase(),
    });
    const k = slotKey(row.location_key || LOCATION_KEY, date, row.time_label);
    bySlot.set(k, (bySlot.get(k) || 0) + 1);
  }
  return { byId, bySlot };
}

/**
 * @returns {{ ok: boolean, missingInDb: array, missingInBlob: array, slotCountMismatches: array, summary: object }}
 */
export async function reconcileBlobToDb(snapshots, store, opts = {}) {
  const blob = blobActiveIndex(snapshots, opts);
  const db = await dbActiveIndex(store, opts);

  const missingInDb = [];
  for (const [id, row] of blob.byId) {
    if (!db.byId.has(id)) missingInDb.push(row);
  }
  const missingInBlob = [];
  for (const [id, row] of db.byId) {
    if (!blob.byId.has(id)) missingInBlob.push(row);
  }
  const slotCountMismatches = [];
  const slotKeys = new Set([...blob.bySlot.keys(), ...db.bySlot.keys()]);
  for (const k of slotKeys) {
    const a = blob.bySlot.get(k) || 0;
    const b = db.bySlot.get(k) || 0;
    if (a !== b) slotCountMismatches.push({ slot: k, blob: a, db: b });
  }

  const summary = {
    blob_active: blob.byId.size,
    db_active: db.byId.size,
    missing_in_db: missingInDb.length,
    missing_in_blob: missingInBlob.length,
    slot_mismatches: slotCountMismatches.length,
  };

  return {
    ok:
      missingInDb.length === 0 &&
      missingInBlob.length === 0 &&
      slotCountMismatches.length === 0,
    missingInDb,
    missingInBlob,
    slotCountMismatches,
    summary,
  };
}
