// Preview-safe import: READ Blob capacity snapshots and INSERT into Postgres.
// Never writes, deletes, or mutates Blob objects.
// Idempotent: safe to retry (bookings ON CONFLICT DO NOTHING; credits GREATEST).

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
 * Fail closed if Blob capacity snapshots are incomplete/unreadable.
 * @returns {{ ok: true } | { ok: false, reason: string, details: object }}
 */
export function preflightBlobSnapshots(snapshots) {
  const details = {
    lessons_read_failed: Boolean(snapshots.lessons?._readFailed || snapshots.lessons?._unreachable),
    holds_read_failed: Boolean(snapshots.holds?._readFailed || snapshots.holds?._unreachable),
    manual_read_failed: Boolean(snapshots.manual?._readFailed || snapshots.manual?._unreachable),
  };
  if (details.lessons_read_failed || details.holds_read_failed || details.manual_read_failed) {
    return { ok: false, reason: "source_incomplete", details };
  }
  // Ambiguous: corrupt parse leaves empty with readFailed; already covered.
  // Empty files are valid (first-create state).
  return { ok: true, details };
}

/**
 * @param {object} snapshots
 * @param {{ lessons?: object, holds?: object, manual?: object }} snapshots
 * @param {import('./postgresStore.js').PostgresBookingStore} store
 */
export async function importBlobSnapshots(snapshots, store, { now = Date.now() } = {}) {
  const gate = preflightBlobSnapshots(snapshots);
  if (!gate.ok) {
    return {
      ok: false,
      stopped: true,
      stop_reason: gate.reason,
      details: gate.details,
      lessons_imported: 0,
      lessons_skipped: 0,
      holds_imported: 0,
      holds_skipped: 0,
      manual_imported: 0,
      manual_skipped: 0,
      credits_upserted: 0,
      errors: [],
    };
  }

  const report = {
    ok: true,
    stopped: false,
    lessons_imported: 0,
    lessons_already_present: 0,
    lessons_skipped: 0,
    holds_imported: 0,
    holds_already_present: 0,
    holds_skipped: 0,
    manual_imported: 0,
    manual_already_present: 0,
    manual_skipped: 0,
    credits_upserted: 0,
    errors: [],
  };

  const lessons = snapshots.lessons?.lessons || [];
  const creditUse = new Map(); // membershipId -> { email, used, tier }

  for (const lesson of lessons) {
    try {
      if (!lesson?.id || !lesson?.date || !lesson?.time) {
        report.lessons_skipped += 1;
        continue;
      }
      const active = isActiveLesson(lesson);
      const membershipId = lesson.subId || (lesson.source === "member" ? lesson.sourceId : null);
      if (active && membershipId && (lesson.source === "member" || String(lesson.type || "").includes("membership"))) {
        const cur = creditUse.get(membershipId) || {
          email: lesson.email || "",
          used: 0,
          tier: String(lesson.type || "").includes("private") ? "private" : "standard",
        };
        cur.used += 1;
        if (lesson.email) cur.email = lesson.email;
        creditUse.set(membershipId, cur);
      }
      const result = await store.importBookingRow({
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
        membership_id: membershipId,
        stripe_pi: String(lesson.sourceId || "").startsWith("pi_") ? lesson.sourceId : null,
        payload: { importedFrom: "lessons.json", mirroredAt: lesson.mirroredAt || null },
        created_at: lesson.createdAt || null,
        cancelled_at: active ? null : lesson.cancelledAt || now,
      });
      if (result.inserted) report.lessons_imported += 1;
      else report.lessons_already_present += 1;
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
      const result = await store.importBookingRow({
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
      if (result.inserted) report.holds_imported += 1;
      else report.holds_already_present += 1;
    } catch (error) {
      report.errors.push({ kind: "hold", id: hold?.sessionId, name: error?.name || "Error" });
    }
  }

  const allManual = snapshots.manual?.bookings || activeBookings(snapshots.manual || { bookings: [] });
  for (const booking of allManual) {
    try {
      if (!booking?.id || !booking?.date || !booking?.time) {
        report.manual_skipped += 1;
        continue;
      }
      const cancelled = String(booking.status || "").toLowerCase() === "cancelled";
      const result = await store.importBookingRow({
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
      if (result.inserted) report.manual_imported += 1;
      else report.manual_already_present += 1;
    } catch (error) {
      report.errors.push({ kind: "manual", id: booking?.id, name: error?.name || "Error" });
    }
  }

  for (const [membershipId, info] of creditUse) {
    try {
      await store.importMembershipCredits({
        membershipId,
        email: info.email,
        tier: info.tier,
        creditsTotal: Math.max(4, info.used),
        creditsUsed: info.used,
      });
      report.credits_upserted += 1;
    } catch (error) {
      report.errors.push({ kind: "credits", id: membershipId, name: error?.name || "Error" });
    }
  }

  report.ok = report.errors.length === 0;
  return report;
}
