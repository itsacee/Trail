import { blobReadVersioned, blobCompareAndSet } from "./store.js";
import { mutateVersioned, DEFAULT_TXN_ATTEMPTS } from "./blobTxn.js";
import {
  locationKeyFor,
  seatsFor,
  isExclusiveBooking,
  privacyForPurchaseType,
  normalizePrivacy,
  SLOT_CAPACITY,
} from "./schedule.js";

const FILE = "manual-bookings.json";

function empty() {
  return { bookings: [] };
}

function withMeta(result, etag, conditional, readFailed = false, allowUnconditionalCreate = false) {
  Object.defineProperty(result, "_etag", { value: etag || "", enumerable: false });
  Object.defineProperty(result, "_conditional", { value: Boolean(conditional), enumerable: false });
  Object.defineProperty(result, "_readFailed", { value: Boolean(readFailed), enumerable: false });
  Object.defineProperty(result, "_allowUnconditionalCreate", {
    value: Boolean(allowUnconditionalCreate),
    enumerable: false,
  });
  return result;
}

function payloadFrom(data) {
  const cutoff = Date.now() - 400 * 86400 * 1000;
  const bookings = (data.bookings || []).filter((b) => {
    if (b?.status === "cancelled" && b.cancelledAt && b.cancelledAt < cutoff) return false;
    if (!b?.date) return true;
    const t = new Date(`${b.date}T12:00:00`).getTime();
    return Number.isNaN(t) || t >= cutoff;
  });
  return { bookings };
}

export async function loadManualBookings() {
  const { text: raw, etag, conditional, unreachable } = await blobReadVersioned(FILE);
  if (!raw) return withMeta(empty(), etag, conditional, Boolean(unreachable), !unreachable);
  try {
    const data = JSON.parse(raw);
    return withMeta(
      { bookings: Array.isArray(data?.bookings) ? data.bookings : [] },
      etag,
      conditional,
      false,
      false
    );
  } catch {
    return withMeta(empty(), "", false, true, false);
  }
}

// Strict commit — never silently overwrite a concurrent change.
export async function commitManualBookings(data) {
  if (data?._readFailed) return { ok: false, conflict: false };
  const payload = payloadFrom(data);
  const etag = data._etag || "";
  const conditional = Boolean(data._conditional && etag);

  if (conditional) {
    return blobCompareAndSet(FILE, payload, etag);
  }
  if (data._allowUnconditionalCreate) {
    return blobCompareAndSet(FILE, payload, "");
  }
  return { ok: false, conflict: false, unsafe: true };
}

export async function saveManualBookings(data) {
  const result = await commitManualBookings(data);
  return result?.ok ? withMeta({ bookings: payloadFrom(data).bookings }, "", false) : null;
}

export async function mutateManualBookings(mutator, { attempts = DEFAULT_TXN_ATTEMPTS } = {}) {
  return mutateVersioned({
    load: loadManualBookings,
    commit: commitManualBookings,
    mutator,
    attempts,
    unavailableError: "Couldn't safely reserve that time. Please try again.",
  });
}

export function newBookingId() {
  return `mb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeManualBooking({
  type,
  player,
  player2,
  athletes,
  parent,
  phone,
  email,
  focus,
  privacy: privacyIn,
  date,
  time,
  availability,
  paymentMethod,
  paymentStatus,
  amountCents,
  amountPaidCents,
  amountDueCents,
  note,
  createdBy,
}) {
  const paid = Number(amountPaidCents) || 0;
  const total = Number(amountCents) || 0;
  const due = amountDueCents != null ? Number(amountDueCents) : Math.max(0, total - paid);
  const second = String(player2 || "").trim();
  const privacy = normalizePrivacy(privacyIn) || privacyForPurchaseType(type);
  const count = second ? 2 : Math.min(SLOT_CAPACITY, Math.max(1, Math.round(Number(athletes) || 1)));
  return {
    id: newBookingId(),
    source: "manual",
    type: type || "single",
    player: player || "",
    player2: second,
    athletes: count,
    // Private purchase types own the hour (both athlete seats).
    seats: isExclusiveBooking({ type, focus, privacy }) ? SLOT_CAPACITY : seatsFor(type, count),
    parent: parent || "",
    phone: phone || "",
    email: String(email || "").toLowerCase(),
    focus: focus || "",
    privacy,
    date,
    time,
    loc: locationKeyFor(date, availability),
    paymentMethod: paymentMethod || "cash",
    paymentStatus: paymentStatus || (due > 0 ? "unpaid" : "paid"),
    amountCents: total,
    amountPaidCents: paid,
    amountDueCents: due,
    note: note || "",
    createdBy: createdBy || "parent",
    createdAt: Date.now(),
    status: "scheduled",
  };
}

export function bookingsOnDate(data, date) {
  return (data.bookings || []).filter((b) => b.date === date && b.status !== "cancelled");
}

export function activeBookings(data) {
  return (data.bookings || []).filter((b) => b.status !== "cancelled");
}

export function findBooking(data, id) {
  return (data.bookings || []).find((b) => b.id === id) || null;
}
