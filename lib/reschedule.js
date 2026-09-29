// Moving a booked lesson to a new day and time.
//
// Three kinds of lesson can be moved, and each one lives somewhere different:
//
//   manual  — cash / Coach Desk bookings in manual-bookings.json (edited in place)
//   member  — portal lessons in lessons.json (edited in place)
//   stripe  — the slot a parent picked at checkout, which lives in the Stripe
//             payment metadata. Those can't be edited in place, so the old slot
//             is voided and the new time is written to lessons.json instead.
//
// Both Coach Desk and the member portal go through here so a move behaves the
// same either way.

import { locationKeyFor, seatsFor, isExclusiveType, SLOT_CAPACITY } from "./schedule.js";
import { newLessonId, voidStripeLesson } from "./lessons.js";
import { findBooking } from "./manualBookings.js";

export function seatsOnLesson(row) {
  if (isExclusiveType(row?.type)) return SLOT_CAPACITY;
  const explicit = Number(row?.seats);
  if (explicit > 0) return Math.min(SLOT_CAPACITY, explicit);
  return seatsFor(row?.type, row?.athletes);
}

// Clear one lesson slot off a Stripe payment so the time opens back up. Safe to
// call without a key — the void in lessons.json already hides it either way.
export async function clearStripeSlot(key, sourceId, lessonId) {
  const id = String(sourceId || "");
  if (!key || !id || id.startsWith("cash_")) return;
  const slot = String(lessonId || "").match(/-([1-4])$/)?.[1] || "1";
  const path = id.startsWith("sub_") ? `subscriptions/${id}` : `payment_intents/${id}`;
  const body = new URLSearchParams();
  body.append(`metadata[date${slot}]`, "");
  body.append(`metadata[time${slot}]`, "");
  body.append(`metadata[loc${slot}]`, "");
  if (slot === "1") {
    body.append("metadata[date]", "");
    body.append("metadata[time]", "");
  }
  try {
    await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch {
    /* the void already hides the old slot */
  }
}

// Apply a move to the in-memory stores. The caller saves whichever store comes
// back in `changed` and clears the Stripe slot when `clearStripe` is set.
export function moveLesson({ row, stored, manual, date, time, focus, availability }) {
  if (!row) return { ok: false, error: "Lesson not found." };
  const loc = locationKeyFor(date, availability);
  const nextFocus = focus || row.focus || "";

  if (row.source === "manual") {
    const booking = findBooking(manual, row.id);
    if (!booking) return { ok: false, error: "That cash booking isn't on file anymore." };
    booking.date = date;
    booking.time = time;
    booking.loc = loc;
    booking.focus = nextFocus;
    booking.movedAt = Date.now();
    return { ok: true, changed: ["manual"], moved: { ...booking } };
  }

  if (row.source === "member") {
    const lesson = (stored.lessons || []).find((l) => l.id === row.id);
    if (!lesson) return { ok: false, error: "That lesson isn't on file anymore." };
    lesson.date = date;
    lesson.time = time;
    lesson.loc = loc;
    lesson.focus = nextFocus;
    lesson.movedAt = Date.now();
    return { ok: true, changed: ["lessons"], moved: { ...lesson } };
  }

  // Stripe checkout slot: void the old time, write the new one to the blob.
  voidStripeLesson(stored, {
    email: row.email,
    date: row.date,
    time: row.time,
    sourceId: row.sourceId || "",
  });
  const moved = {
    id: newLessonId(),
    subId: row.sourceId || "",
    source: "member",
    type: row.type || "single",
    player: row.player || "",
    player2: row.player2 || "",
    athletes: Number(row.athletes) || 1,
    seats: seatsOnLesson(row),
    parent: row.parent || "",
    phone: row.phone || "",
    email: String(row.email || "").toLowerCase(),
    focus: nextFocus,
    date,
    time,
    loc,
    createdAt: Date.now(),
    movedAt: Date.now(),
    movedFrom: { date: row.date, time: row.time },
  };
  stored.lessons.push(moved);
  return {
    ok: true,
    changed: ["lessons"],
    moved,
    clearStripe: { sourceId: row.sourceId || "", lessonId: row.id },
  };
}
