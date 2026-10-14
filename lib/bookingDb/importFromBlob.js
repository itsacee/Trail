// Preview-safe import: READ Blob capacity snapshots and INSERT into Postgres.
// Never writes, deletes, or mutates Blob objects.

import { isActiveLesson } from "../lessons.js";
import { isActive as holdIsActive } from "../holds.js";
import { activeBookings } from "../manualBookings.js";
import { resolvePrivacy, seatsFor, SLOT_CAPACITY, LOCATION_KEY } from "../schedule.js";

function seatsOn(row) {
  const privacy = resolvePrivacy({
    type: row.type,
    focus: row.focus,
    privacy: row.privacy,
  });
  if (privacy === "private") return SLOT_CAPACITY;
  const explicit = Number(row.seats);
  if (explicit > 0) return Math.min(SLOT_CAPACITY, explicit);
  return seatsFor(row.type, row.athletes);
}

/**
 * @param {object} snapshots
 * @param {{ lessons?: object, holds?: object, manual?: object }} snapshots
 * @param {import('./postgresStore.js').PostgresBookingStore} store
 */
export async function importBlobSnapshots(snapshots, store, { now = Date.now() } = {}) {
  const report = {
    lessons_imported: 0,
    lessons_skipped: 0,
    holds_imported: 0,
    holds_skipped: 0,
    manual_imported: 0,
    manual_skipped: 0,
    errors: [],
  };

  const lessons = snapshots.lessons?.lessons || [];
  for (const lesson of lessons) {
    try {
      if (!lesson?.id || !lesson?.date || !lesson?.time) {
        report.lessons_skipped += 1;
        continue;
      }
      const active = isActiveLesson(lesson);
      await store.importBookingRow({
        id: lesson.id,
        source: lesson.source === "stripe" ? "stripe" : "member",
        source_ref: lesson.sourceId || lesson.subId || lesson.id,
        status: active ? "active" : "cancelled",
        slot_date: lesson.date,
        time_label: lesson.time,
        mins: 60,
        location_key: lesson.loc || LOCATION_KEY,
        focus: lesson.focus || "",
        privacy: resolvePrivacy({
          type: lesson.type,
          focus: lesson.focus,
          privacy: lesson.privacy,
        }),
        seats: seatsOn(lesson),
        email: lesson.email,
        player: lesson.player,
        player2: lesson.player2,
        parent: lesson.parent,
        phone: lesson.phone,
        booking_type: lesson.type,
        athletes: lesson.athletes,
        membership_id: lesson.subId || null,
        stripe_pi: String(lesson.sourceId || "").startsWith("pi_") ? lesson.sourceId : null,
        payload: { importedFrom: "lessons.json", mirroredAt: lesson.mirroredAt || null },
        created_at: lesson.createdAt || null,
        cancelled_at: active ? null : lesson.cancelledAt || now,
      });
      report.lessons_imported += 1;
    } catch (error) {
      report.errors.push({ kind: "lesson", id: lesson?.id, name: error?.name || "Error" });
    }
  }

  const holds = snapshots.holds?.holds || [];
  for (const hold of holds) {
    try {
      if (!hold?.sessionId || !hold?.date || !hold?.time) {
        report.holds_skipped += 1;
        continue;
      }
      const active = holdIsActive(hold, now);
      await store.importBookingRow({
        id: `hold_${hold.sessionId}_${hold.date}_${String(hold.time).replace(/\s+/g, "")}`,
        source: "hold",
        source_ref: hold.sessionId,
        status: active ? "held" : "cancelled",
        slot_date: hold.date,
        time_label: hold.time,
        mins: hold.mins || 60,
        location_key: LOCATION_KEY,
        focus: hold.focus || "",
        privacy: resolvePrivacy({
          type: hold.type,
          focus: hold.focus,
          privacy: hold.privacy,
        }),
        seats: Number(hold.seats) || seatsOn(hold),
        booking_type: hold.type || "",
        stripe_session: hold.sessionId,
        hold_expires_at: hold.expiresAt ? new Date(hold.expiresAt).toISOString() : null,
        payload: { importedFrom: "holds.json" },
        created_at: hold.createdAt || null,
        cancelled_at: active ? null : now,
      });
      report.holds_imported += 1;
    } catch (error) {
      report.errors.push({ kind: "hold", id: hold?.sessionId, name: error?.name || "Error" });
    }
  }

  const manuals = snapshots.manual ? activeBookings(snapshots.manual) : [];
  // Also import cancelled manuals as cancelled for reconciliation completeness.
  const allManual = snapshots.manual?.bookings || manuals;
  for (const booking of allManual) {
    try {
      if (!booking?.id || !booking?.date || !booking?.time) {
        report.manual_skipped += 1;
        continue;
      }
      const cancelled = String(booking.status || "").toLowerCase() === "cancelled";
      await store.importBookingRow({
        id: booking.id,
        source: "manual",
        source_ref: booking.id,
        status: cancelled ? "cancelled" : "active",
        slot_date: booking.date,
        time_label: booking.time,
        mins: 60,
        location_key: booking.loc || LOCATION_KEY,
        focus: booking.focus || "",
        privacy: resolvePrivacy({
          type: booking.type,
          focus: booking.focus,
          privacy: booking.privacy,
        }),
        seats: seatsOn(booking),
        email: booking.email,
        player: booking.player,
        player2: booking.player2,
        parent: booking.parent,
        phone: booking.phone,
        booking_type: booking.type,
        athletes: booking.athletes,
        payload: { importedFrom: "manual-bookings.json" },
        created_at: booking.createdAt || null,
        cancelled_at: cancelled ? booking.cancelledAt || now : null,
      });
      report.manual_imported += 1;
    } catch (error) {
      report.errors.push({ kind: "manual", id: booking?.id, name: error?.name || "Error" });
    }
  }

  return report;
}
