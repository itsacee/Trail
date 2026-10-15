// Customer-facing booking mutation gate.
//
// PUBLIC_BOOKING_ENABLED must be exactly "1" to allow public/member mutations.
// Absent, empty, "0", "false", or any other value fails closed.
//
// Public mutations also require Postgres booking writes
// (BOOKING_STORE=postgres + BOOKING_WRITES_ENABLED=1). Legacy
// CAPACITY_WRITES_ENABLED alone must never reopen customer booking.

import { bookingWritesEnabled } from "./bookingDb/flags.js";

export const PUBLIC_BOOKING_PAUSED_CODE = "public_booking_paused";

const PUBLIC_BOOKING_PAUSED_ERROR =
  "Online booking is temporarily paused while we restore the calendar. No payment was taken — please try again shortly or call (405) 819-4401.";

/** True only when PUBLIC_BOOKING_ENABLED is exactly "1". */
export function publicBookingEnabled(env = process.env) {
  return String(env.PUBLIC_BOOKING_ENABLED || "").trim() === "1";
}

/**
 * Customer-facing create/cancel/move/reserve/modify paths.
 * Requires BOTH Postgres booking writes and the public flag.
 */
export function publicBookingMutationsAllowed(env = process.env) {
  return bookingWritesEnabled(env) && publicBookingEnabled(env);
}

export function publicBookingBlockedPayload() {
  return {
    error: PUBLIC_BOOKING_PAUSED_ERROR,
    code: PUBLIC_BOOKING_PAUSED_CODE,
    publicBookingPaused: true,
  };
}

/**
 * If public mutations are closed, write a 503 JSON response and return true.
 * Callers should `return` when this returns true.
 */
export function rejectIfPublicBookingClosed(res, env = process.env) {
  if (publicBookingMutationsAllowed(env)) return false;
  res.status(503).json(publicBookingBlockedPayload());
  return true;
}
