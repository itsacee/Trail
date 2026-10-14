// Public BookingStore facade.
// Defaults: Blob remains authoritative; Postgres path inert until flags enable it.

import {
  bookingReadsEnabled,
  bookingStoreMode,
  bookingWritesEnabled,
} from "./bookingDb/flags.js";
import { createBookingStore, closeBookingStore } from "./bookingDb/createStore.js";
import { toOccupancyRows } from "./bookingDb/capacity.js";

let cached = null;

export async function getBookingStore(env = process.env) {
  const mode = bookingStoreMode(env);
  if (mode === "blob") return null;
  if (cached?.mode === mode && cached.store) return cached.store;
  if (cached?.pool) await closeBookingStore(cached);
  cached = await createBookingStore({
    env,
    mode: mode === "postgres" ? "postgres" : "memory",
    useMem: mode === "memory",
  });
  return cached.store;
}

/** Test helper — inject or reset singleton. */
export async function resetBookingStoreCache() {
  if (cached) await closeBookingStore(cached);
  cached = null;
}

export function bookingStoreStatus(env = process.env) {
  return {
    mode: bookingStoreMode(env),
    reads: bookingReadsEnabled(env),
    writes: bookingWritesEnabled(env),
  };
}

/**
 * Occupancy rows shaped for schedule.js / bookedTimes merge.
 * Returns null when DB reads are disabled (caller keeps Blob path).
 */
export async function loadDbOccupancy(date, opts = {}, env = process.env) {
  if (!bookingReadsEnabled(env)) return null;
  const store = await getBookingStore(env);
  if (!store) return null;
  const rows = await store.listOccupancy(date, opts);
  return toOccupancyRows(rows);
}

/**
 * Coach Desk / schedule listing from Postgres when reads are enabled.
 * Returns null when reads are off (caller keeps Blob+Stripe path).
 */
export async function loadDbScheduleBookings(opts = {}, env = process.env) {
  if (!bookingReadsEnabled(env)) return null;
  const store = await getBookingStore(env);
  if (!store) {
    const err = new Error("booking_store_unavailable");
    err.code = "booking_store_unavailable";
    throw err;
  }
  return store.listActiveBookings(opts);
}

export async function dbReserveHold(args, env = process.env) {
  if (!bookingWritesEnabled(env)) {
    return { ok: false, code: "writes_disabled", error: "Database booking writes are disabled." };
  }
  const store = await getBookingStore(env);
  if (!store) return { ok: false, code: "store_unavailable" };
  return store.reserveHold(args);
}

export async function dbReleaseHold(sessionId, env = process.env) {
  if (!bookingWritesEnabled(env)) {
    return { ok: false, code: "writes_disabled" };
  }
  const store = await getBookingStore(env);
  if (!store) return { ok: false, code: "store_unavailable" };
  return store.releaseHold(sessionId);
}

export async function dbConfirmPaid(args, env = process.env) {
  if (!bookingWritesEnabled(env)) {
    return { ok: false, code: "writes_disabled", error: "Database booking writes are disabled." };
  }
  const store = await getBookingStore(env);
  if (!store) return { ok: false, code: "store_unavailable" };
  return store.confirmPaid(args);
}

export async function dbMemberBook(args, env = process.env) {
  if (!bookingWritesEnabled(env)) {
    return { ok: false, code: "writes_disabled", error: "Database booking writes are disabled." };
  }
  const store = await getBookingStore(env);
  if (!store) return { ok: false, code: "store_unavailable" };
  return store.memberBook(args);
}

export async function dbReschedule(args, env = process.env) {
  if (!bookingWritesEnabled(env)) {
    return { ok: false, code: "writes_disabled", error: "Database booking writes are disabled." };
  }
  const store = await getBookingStore(env);
  if (!store) return { ok: false, code: "store_unavailable" };
  return store.reschedule(args);
}

export async function dbCancelBooking(id, opts, env = process.env) {
  if (!bookingWritesEnabled(env)) {
    return { ok: false, code: "writes_disabled" };
  }
  const store = await getBookingStore(env);
  if (!store) return { ok: false, code: "store_unavailable" };
  return store.cancelBooking(id, opts);
}
