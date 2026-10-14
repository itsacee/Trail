// Authoritative booking snapshots from Postgres for read paths.
// When BOOKING_READS_ENABLED=1, callers must use these (or loadAuthoritative*)
// and fail closed if the store is unavailable — never return Blob-only data.

import { StorageUnavailableError } from "../store.js";
import { bookingReadsEnabled, bookingWritesEnabled } from "./flags.js";
import { getBookingStore } from "../bookingStore.js";
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
  return String(d).slice(0, 10);
}

function payloadOf(row) {
  const p = row?.payload;
  if (!p) return {};
  if (typeof p === "object") return p;
  try {
    return JSON.parse(p);
  } catch {
    return {};
  }
}

/** Map a Postgres booking row → lessons.json lesson shape. */
export function lessonFromDbRow(row) {
  const date = dateKey(row.slot_date || row.date);
  const payload = payloadOf(row);
  const source =
    row.source === "stripe" ? "stripe" : row.source === "member" ? "member" : row.source === "manual" ? "manual" : row.source;
  return {
    id: row.id,
    source,
    sourceId: row.source_ref || row.stripe_pi || row.membership_id || row.id,
    subId: row.membership_id || (source === "member" ? row.source_ref : "") || "",
    date,
    time: row.time_label || row.time || "",
    focus: row.focus || "",
    type: row.booking_type || (source === "member" ? "membership" : "single"),
    privacy: row.privacy || "standard",
    seats: Number(row.seats) || 1,
    athletes: Number(row.athletes) || 1,
    email: row.email || "",
    player: row.player || "",
    player2: row.player2 || "",
    parent: row.parent || "",
    phone: row.phone || "",
    loc: row.location_key || LOCATION_KEY,
    status: row.status === "cancelled" || row.status === "voided" ? "cancelled" : "active",
    createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).getTime() : undefined,
    origin: "postgres",
    ...payload.lessonFields,
  };
}

/** Map held Postgres rows → holds.json hold shape. */
export function holdFromDbRow(row) {
  return {
    sessionId: row.stripe_session || row.source_ref || row.id,
    date: dateKey(row.slot_date),
    time: row.time_label || "",
    mins: Number(row.mins) || 60,
    focus: row.focus || "",
    seats: Number(row.seats) || 1,
    type: row.booking_type || "",
    privacy: row.privacy || "",
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    expiresAt: row.hold_expires_at ? new Date(row.hold_expires_at).getTime() : 0,
    origin: "postgres",
  };
}

/** Map manual Postgres rows → manual-bookings.json booking shape. */
export function manualFromDbRow(row) {
  const payload = payloadOf(row);
  return {
    id: row.id,
    date: dateKey(row.slot_date),
    time: row.time_label || "",
    focus: row.focus || "",
    type: row.booking_type || "single",
    privacy: row.privacy || "standard",
    seats: Number(row.seats) || 1,
    athletes: Number(row.athletes) || 1,
    email: row.email || "",
    player: row.player || "",
    player2: row.player2 || "",
    parent: row.parent || "",
    phone: row.phone || "",
    loc: row.location_key || LOCATION_KEY,
    status: row.status === "cancelled" || row.status === "voided" ? "cancelled" : "active",
    paymentMethod: payload.paymentMethod || "cash",
    paymentStatus: payload.paymentStatus || "unpaid",
    amountCents: payload.amountCents || 0,
    amountPaidCents: payload.amountPaidCents || 0,
    amountDueCents: payload.amountDueCents || 0,
    note: payload.note || "",
    createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).getTime() : undefined,
    origin: "postgres",
  };
}

/**
 * Load full booking snapshots from Postgres.
 * @throws StorageUnavailableError when the store cannot be opened/queried.
 */
export async function loadPostgresBookingSnapshots(env = process.env) {
  let store;
  try {
    store = await getBookingStore(env);
  } catch (error) {
    throw new StorageUnavailableError(
      "Couldn't read bookings from the database. Blob booking data was not used as a fallback."
    );
  }
  if (!store) {
    throw new StorageUnavailableError(
      "Couldn't read bookings from the database. Blob booking data was not used as a fallback."
    );
  }
  try {
    const { rows } = await store.query(
      `SELECT * FROM bookings
       WHERE status IN ('active', 'held', 'cancelled', 'voided')
       ORDER BY slot_date, time_label, id`
    );
    const lessons = [];
    const voids = [];
    const holds = [];
    const manuals = [];
    for (const row of rows) {
      if (row.status === "held") {
        holds.push(holdFromDbRow(row));
        continue;
      }
      if (row.source === "manual") {
        manuals.push(manualFromDbRow(row));
        if (row.status === "cancelled" || row.status === "voided") {
          /* cancelled manuals stay in list with status */
        }
        continue;
      }
      // stripe + member → lessons.json shape
      const lesson = lessonFromDbRow(row);
      if (row.status === "cancelled" || row.status === "voided") {
        voids.push({
          email: String(lesson.email || "").toLowerCase(),
          date: lesson.date,
          time: lesson.time,
          sourceId: lesson.sourceId || "",
          at: lesson.cancelledAt || Date.now(),
        });
        continue;
      }
      lessons.push(lesson);
    }
    return {
      lessons: { lessons, voids, _origin: "postgres" },
      holds: { holds, _origin: "postgres" },
      manual: { bookings: manuals, _origin: "postgres" },
    };
  } catch (error) {
    if (error instanceof StorageUnavailableError) throw error;
    throw new StorageUnavailableError(
      "Couldn't read bookings from the database. Blob booking data was not used as a fallback."
    );
  }
}

/**
 * Dual-period bridge: when reads are on but writes are still off, capacity
 * mutations still land in Blob. Overlay Blob-only rows that are missing from
 * Postgres so brand-new Blob writes remain visible — but never substitute Blob
 * when Postgres itself is unavailable.
 */
export function mergeBlobBridge(pgSnapshot, blobSnapshot, { key = "lessons" } = {}) {
  if (!blobSnapshot || blobSnapshot._readFailed || blobSnapshot._unreachable) {
    return pgSnapshot;
  }
  if (key === "lessons") {
    const ids = new Set((pgSnapshot.lessons || []).map((l) => l.id));
    const merged = [...(pgSnapshot.lessons || [])];
    for (const lesson of blobSnapshot.lessons || []) {
      if (lesson?.id && !ids.has(lesson.id)) {
        merged.push({ ...lesson, origin: lesson.origin || "blob_bridge" });
        ids.add(lesson.id);
      }
    }
    const voidKeys = new Set(
      (pgSnapshot.voids || []).map((v) => `${v.email}|${v.date}|${v.time}|${v.sourceId || ""}`)
    );
    const voids = [...(pgSnapshot.voids || [])];
    for (const v of blobSnapshot.voids || []) {
      const k = `${v.email}|${v.date}|${v.time}|${v.sourceId || ""}`;
      if (!voidKeys.has(k)) {
        voids.push(v);
        voidKeys.add(k);
      }
    }
    return { lessons: merged, voids, _origin: "postgres+blob_bridge" };
  }
  if (key === "manual") {
    const ids = new Set((pgSnapshot.bookings || []).map((b) => b.id));
    const merged = [...(pgSnapshot.bookings || [])];
    for (const booking of blobSnapshot.bookings || []) {
      if (booking?.id && !ids.has(booking.id)) {
        merged.push({ ...booking, origin: booking.origin || "blob_bridge" });
        ids.add(booking.id);
      }
    }
    return { bookings: merged, _origin: "postgres+blob_bridge" };
  }
  if (key === "holds") {
    const ids = new Set((pgSnapshot.holds || []).map((h) => `${h.sessionId}|${h.date}|${h.time}`));
    const merged = [...(pgSnapshot.holds || [])];
    for (const hold of blobSnapshot.holds || []) {
      const k = `${hold.sessionId}|${hold.date}|${hold.time}`;
      if (!ids.has(k)) {
        merged.push({ ...hold, origin: hold.origin || "blob_bridge" });
        ids.add(k);
      }
    }
    return { holds: merged, _origin: "postgres+blob_bridge" };
  }
  return pgSnapshot;
}

export function bookingReadsActive(env = process.env) {
  return bookingReadsEnabled(env);
}

export function bookingWritesActive(env = process.env) {
  return bookingWritesEnabled(env);
}
