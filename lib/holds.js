// Short-lived slot reservations, taken the moment someone reaches Stripe
// Checkout and released when the hold expires.
//
// Two players can share a time on purpose. Holds still stop a third person
// from paying for a slot that already has two, in two cases:
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

import { blobReadVersioned, blobCompareAndSet } from "./store.js";

const FILE = "holds.json";

// Long enough to pay without being rushed, short enough that an abandoned
// checkout frees the slot again reasonably soon. A parent is never blocked by
// their own hold — see `mine` in api/slots.js and `previousSession` in
// api/checkout.js — so this only ever holds the slot against other people.
export const HOLD_MINUTES = 31;

function empty() {
  return { holds: [] };
}

export function isActive(h, now = Date.now()) {
  return Boolean(h && h.expiresAt > now && h.date && h.time);
}

function withMeta(result, etag, conditional, unreachable = false) {
  Object.defineProperty(result, "_etag", { value: etag || "", enumerable: false });
  Object.defineProperty(result, "_conditional", { value: Boolean(conditional), enumerable: false });
  Object.defineProperty(result, "_unreachable", { value: Boolean(unreachable), enumerable: false });
  return result;
}

export async function loadHolds() {
  const { text: raw, etag, conditional, unreachable } = await blobReadVersioned(FILE);
  if (unreachable) return withMeta(empty(), "", false, true);
  if (!raw) return withMeta(empty(), etag, conditional, false);
  try {
    const data = JSON.parse(raw);
    return withMeta({ holds: Array.isArray(data?.holds) ? data.holds : [] }, etag, conditional, false);
  } catch {
    return withMeta(empty(), "", false, false);
  }
}

// Expired holds are dropped on every write, so the file can't grow forever.
// Always compare-and-set: with an ETag when the read was origin-fresh, or
// create-only (empty ifMatch) on first write. Never unconditionally overwrite
// an existing holds.json — that is how concurrent checkouts lost seats.
export async function saveHolds(data, { etag = "", conditional = false } = {}) {
  const now = Date.now();
  const payload = { holds: (data.holds || []).filter((h) => isActive(h, now)) };
  const ifMatch = conditional && etag ? etag : "";
  return blobCompareAndSet(FILE, payload, ifMatch);
}

export function holdsOnDate(data, date, now = Date.now()) {
  return (data.holds || []).filter((h) => isActive(h, now) && h.date === date);
}

// Reserve every slot in a checkout. Never throws — a booking must not fail
// because the hold store is unavailable. `seats` is how many of the hour's two
// athlete seats this checkout is buying (a private lesson holds both).
export async function placeHold(sessionId, slots, mins, focus = "", { seats = 1, type = "", privacy = "" } = {}) {
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const data = await loadHolds();
      // Stale CDN / origin mismatch — do not invent an empty holds file.
      if (data._unreachable) continue;
      const expiresAt = Date.now() + HOLD_MINUTES * 60 * 1000;
      // Replace any earlier attempt from the same checkout rather than stacking.
      data.holds = (data.holds || []).filter((h) => h.sessionId !== sessionId);
      slots.forEach((s) => {
        data.holds.push({
          sessionId,
          date: s.date,
          time: s.time,
          mins,
          focus,
          seats,
          type,
          privacy,
          createdAt: Date.now(),
          expiresAt,
        });
      });
      const etag = data._etag || "";
      const conditional = Boolean(data._conditional && etag);
      const result = await saveHolds(data, { etag, conditional });
      if (result?.ok) return true;
      if (result?.conflict) continue;
      return false;
    }
    return false;
  } catch {
    return false;
  }
}

// Called when a parent abandons or replaces a checkout. Paid checkout holds are
// intentionally left to expire so they cover Stripe's search-index delay.
export async function releaseHold(sessionId) {
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const data = await loadHolds();
      if (data._unreachable) continue;
      const before = data.holds.length;
      data.holds = data.holds.filter((h) => h.sessionId !== sessionId);
      if (data.holds.length === before) return true;
      const etag = data._etag || "";
      const conditional = Boolean(data._conditional && etag);
      const result = await saveHolds(data, { etag, conditional });
      if (result?.ok) return true;
      if (result?.conflict) continue;
      return false;
    }
    return false;
  } catch {
    return false;
  }
}
