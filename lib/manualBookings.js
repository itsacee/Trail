import { blobReadVersioned, blobWrite } from "./store.js";
import { locationKeyFor, seatsFor, isExclusiveType, SLOT_CAPACITY } from "./schedule.js";

const FILE = "manual-bookings.json";

function empty() {
  return { bookings: [] };
}

export async function loadManualBookings() {
  const { text: raw, etag } = await blobReadVersioned(FILE);
  if (!raw) return empty();
  try {
    const data = JSON.parse(raw);
    const result = { bookings: Array.isArray(data?.bookings) ? data.bookings : [] };
    Object.defineProperty(result, "_etag", { value: etag || "", enumerable: false });
    return result;
  } catch {
    return empty();
  }
}

export async function saveManualBookings(data) {
  const cutoff = Date.now() - 400 * 86400 * 1000;
  const bookings = (data.bookings || []).filter((b) => {
    if (b?.status === "cancelled" && b.cancelledAt && b.cancelledAt < cutoff) return false;
    if (!b?.date) return true;
    const t = new Date(`${b.date}T12:00:00`).getTime();
    return Number.isNaN(t) || t >= cutoff;
  });
  const ok = await blobWrite(FILE, { bookings }, { ifMatch: data._etag || "" });
  return ok ? { bookings } : null;
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
  const count = second ? 2 : Math.min(SLOT_CAPACITY, Math.max(1, Math.round(Number(athletes) || 1)));
  return {
    id: newBookingId(),
    source: "manual",
    type: type || "single",
    player: player || "",
    player2: second,
    athletes: count,
    // A private hour is never shared, so it always holds both athlete seats.
    seats: isExclusiveType(type) ? SLOT_CAPACITY : seatsFor(type, count),
    parent: parent || "",
    phone: phone || "",
    email: String(email || "").toLowerCase(),
    focus: focus || "",
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
