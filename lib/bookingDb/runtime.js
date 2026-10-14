// Runtime switches between Blob and Postgres booking persistence.
// Writes stay disabled unless BOOKING_WRITES_ENABLED=1 (Preview approval gate).

import { bookingReadsEnabled, bookingWritesEnabled } from "./flags.js";
import {
  dbConfirmPaid,
  dbMemberBook,
  dbReleaseHold,
  dbReschedule,
  dbReserveHold,
  loadDbOccupancy,
} from "../bookingStore.js";

export { bookingReadsEnabled, bookingWritesEnabled };

export async function reserveHoldRuntime(args, env = process.env) {
  if (!bookingWritesEnabled(env)) return { ok: false, code: "writes_disabled", used: "none" };
  const result = await dbReserveHold(args, env);
  return { ...result, used: "postgres" };
}

export async function releaseHoldRuntime(sessionId, env = process.env) {
  if (!bookingWritesEnabled(env)) return { ok: false, code: "writes_disabled", used: "none" };
  const result = await dbReleaseHold(sessionId, env);
  return { ...result, used: "postgres" };
}

export async function confirmPaidRuntime(args, env = process.env) {
  if (!bookingWritesEnabled(env)) return { ok: false, code: "writes_disabled", used: "none" };
  const result = await dbConfirmPaid(args, env);
  return { ...result, used: "postgres" };
}

export async function memberBookRuntime(args, env = process.env) {
  if (!bookingWritesEnabled(env)) return { ok: false, code: "writes_disabled", used: "none" };
  return dbMemberBook(args, env);
}

export async function rescheduleRuntime(args, env = process.env) {
  if (!bookingWritesEnabled(env)) return { ok: false, code: "writes_disabled", used: "none" };
  return dbReschedule(args, env);
}

export async function occupancyFromDb(date, opts, env = process.env) {
  if (!bookingReadsEnabled(env)) return null;
  return loadDbOccupancy(date, opts, env);
}

/** When DB writes are on, Blob capacity files are no longer the write target. */
export function skipBlobCapacityFiles(env = process.env) {
  return bookingWritesEnabled(env);
}
