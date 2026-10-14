// Pure capacity admission using the same rules as lib/schedule.js.
// Used inside SQL transactions after slot lock acquisition.

import {
  slotBlocked,
  seatsFor,
  resolvePrivacy,
  SLOT_CAPACITY,
  isExclusiveBooking,
} from "../schedule.js";

export function seatsForRequest({ type = "", athletes = 1, privacy = "", focus = "" } = {}) {
  const resolved = resolvePrivacy({ type, focus, privacy });
  if (resolved === "private" || isExclusiveBooking({ type, focus, privacy: resolved })) {
    return SLOT_CAPACITY;
  }
  return seatsFor(type, athletes);
}

/** Map DB booking rows → schedule.js occupancy rows. */
export function toOccupancyRows(bookings, { now = Date.now() } = {}) {
  const rows = [];
  for (const b of bookings || []) {
    if (b.status === "cancelled" || b.status === "voided") continue;
    if (b.status === "held") {
      const exp = b.hold_expires_at ? new Date(b.hold_expires_at).getTime() : 0;
      if (exp && exp <= now) continue;
    }
    const privacy = resolvePrivacy({
      type: b.booking_type || b.type || "",
      focus: b.focus || "",
      privacy: b.privacy || "",
    });
    rows.push({
      time: b.time_label || b.time,
      mins: Number(b.mins) || 60,
      focuses: b.focus ? [b.focus] : [],
      focus: b.focus || "",
      privacy,
      exclusive: privacy === "private",
      seats: Number(b.seats) || 1,
      count: 1,
      id: b.id,
      source: b.source,
      sourceRef: b.source_ref || b.stripe_pi || "",
      status: b.status,
    });
  }
  return rows;
}

/**
 * @returns {{ ok: true } | { ok: false, code: string, error: string }}
 */
export function evaluateAdmission(existingBookings, request, { now = Date.now() } = {}) {
  const focus = String(request.focus || "");
  const time = String(request.time || request.time_label || "");
  const mins = Number(request.mins) || 60;
  const privacy = resolvePrivacy({
    type: request.type || request.booking_type || "",
    focus,
    privacy: request.privacy || "",
  });
  const seats = Math.max(
    1,
    Number(request.seats) ||
      seatsForRequest({
        type: request.type || request.booking_type || "",
        athletes: request.athletes,
        privacy,
        focus,
      })
  );
  const occupied = toOccupancyRows(existingBookings, { now });
  // Ignore the caller's own hold/booking ids when re-checking.
  const ignore = new Set((request.ignoreIds || []).map(String));
  const filtered = occupied.filter((r) => !ignore.has(String(r.id)));
  const blocked = slotBlocked(filtered, time, mins, focus, {
    seats,
    exclusive: privacy === "private" || seats >= SLOT_CAPACITY,
    privacy,
  });
  if (blocked) {
    return {
      ok: false,
      code: "slot_unavailable",
      error: "That time isn't available. Please pick another.",
    };
  }
  return { ok: true, seats, privacy, mins, focus, time };
}
