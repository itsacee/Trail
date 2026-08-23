// Short-lived slot reservations, taken the moment someone reaches Stripe
// Checkout and released when the hold expires.
//
// Without these there are two ways two people end up in the same slot:
//
//   1. A slot only counts as booked once payment succeeds. While one parent is
//      on Stripe's payment page — which can be several minutes — the slot still
//      looks free to everyone else, so a second parent can pay for it too.
//   2. Paid bookings are found through Stripe Search, which is eventually
//      consistent. A lesson paid seconds ago may not be indexed yet.
//
// A hold lives in blob storage and is read directly, so it covers both: it
// exists from the instant checkout opens, and it doesn't depend on the search
// index catching up. Abandoned checkouts simply expire.

import { blobRead, blobWrite } from "./store.js";

const FILE = "holds.json";

// Long enough to pay without being rushed, short enough that an abandoned
// checkout frees the slot again reasonably soon.
export const HOLD_MINUTES = 20;

function empty() {
  return { holds: [] };
}

export function isActive(h, now = Date.now()) {
  return Boolean(h && h.expiresAt > now && h.date && h.time);
}

export async function loadHolds() {
  const raw = await blobRead(FILE);
  if (!raw) return empty();
  try {
    const data = JSON.parse(raw);
    return { holds: Array.isArray(data?.holds) ? data.holds : [] };
  } catch {
    return empty();
  }
}

// Expired holds are dropped on every write, so the file can't grow forever.
export async function saveHolds(data) {
  const now = Date.now();
  return blobWrite(FILE, { holds: (data.holds || []).filter((h) => isActive(h, now)) });
}

export function holdsOnDate(data, date, now = Date.now()) {
  return (data.holds || []).filter((h) => isActive(h, now) && h.date === date);
}

// Reserve every slot in a checkout. Never throws — a booking must not fail
// because the hold store is unavailable.
export async function placeHold(sessionId, slots, mins) {
  try {
    const data = await loadHolds();
    const expiresAt = Date.now() + HOLD_MINUTES * 60 * 1000;
    // Replace any earlier attempt from the same checkout rather than stacking.
    data.holds = (data.holds || []).filter((h) => h.sessionId !== sessionId);
    slots.forEach((s) => {
      data.holds.push({
        sessionId,
        date: s.date,
        time: s.time,
        mins,
        expiresAt,
      });
    });
    return await saveHolds(data);
  } catch {
    return false;
  }
}

// Called once a payment is confirmed — the real booking now covers the slot,
// so the hold is redundant. Expiry would clear it anyway; this just tidies up.
export async function releaseHold(sessionId) {
  try {
    const data = await loadHolds();
    const before = data.holds.length;
    data.holds = data.holds.filter((h) => h.sessionId !== sessionId);
    if (data.holds.length === before) return true;
    return await saveHolds(data);
  } catch {
    return false;
  }
}
