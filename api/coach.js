// Coach admin: schedule moves, finances, collect cash, freeze members, facility
// pause toggles, prices and hours.

import { fetchBookings } from "../lib/bookings.js";
import {
  mutateManualBookings,
  makeManualBooking,
  findBooking,
  activeBookings,
} from "../lib/manualBookings.js";
import { mutateLessons, removeLesson, voidStripeLesson } from "../lib/lessons.js";
import { moveLesson, clearStripeSlot, seatsOnLesson } from "../lib/reschedule.js";
import { sendLessonCancelledEmail, sendLessonMovedEmail } from "../lib/lessonMail.js";
import { requireCoach } from "../lib/coachAuth.js";
import {
  loadMembersState,
  saveMembersState,
  upsertMember,
  memberRecord,
  isMemberFrozen,
  isMemberRemoved,
  removeMember,
  restoreMember,
  removedMembers,
} from "../lib/membersStore.js";
import { loadFinance, saveFinance, addFinanceEntry, financeSummary } from "../lib/finance.js";
import { loadSettings, saveSettings, unitPriceFor } from "../lib/settings.js";
import { loadCoachStatus, saveCoachStatus } from "../lib/coachStatus.js";
import { getSiteStatus, normalizeFocus, SITE_STATUS_VERSION } from "../lib/siteStatus.js";
import {
  getAvailability,
  allowedTimes,
  durationFor,
  slotBlocked,
  seatsFor,
  isExclusiveBooking,
  privacyForPurchaseType,
  canPair,
  SLOT_CAPACITY,
  normalizeLessonTime,
} from "../lib/schedule.js";
import { bookedTimes } from "./slots.js";
import {
  lessonHasEnded,
  MEMBER_PERIOD_DAYS,
  isMembershipType,
  membershipTierOf,
  membershipTypeOf,
  membershipLabel,
} from "../lib/members.js";
import {
  listActiveMemberships,
  activeCashMemberships,
} from "../lib/membershipCapacity.js";
import { resolveCoachMembershipTypeDisplay } from "../lib/membershipDisplay.js";
import {
  bookingReadsEnabled,
  bookingWritesEnabled,
  bookingPostgresAuthoritative,
} from "../lib/bookingDb/flags.js";
import {
  dbManualBook,
  dbCancelBooking,
  dbReschedule,
  dbCollectManualPayment,
} from "../lib/bookingStore.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_TYPES = ["single", "thirty", "private", "membership", "membership_private"];

/** Resolve coach-entered time into canonical "h:mm AM/PM", with clear errors. */
function resolveCoachTime(raw, meridiem) {
  const parsed = normalizeLessonTime(raw, { meridiem });
  if (parsed.ok) return parsed;
  if (parsed.error === "missing") {
    return { ok: false, status: 400, error: "Choose a valid lesson time.", code: "missing_time" };
  }
  if (parsed.error === "ambiguous") {
    const h = parsed.hour;
    const mm = String(parsed.minute || 0).padStart(2, "0");
    return {
      ok: false,
      status: 400,
      error: `Is ${h}:${mm} AM or PM? Pick AM/PM and save again.`,
      code: "ambiguous_time",
      hour: parsed.hour,
      minute: parsed.minute,
    };
  }
  return { ok: false, status: 400, error: "Choose a valid lesson time.", code: "invalid_time" };
}

async function listOutstanding() {
  // Unpaid cash balances: prefer authoritative booking rows when reads are on
  // (payload carries amountDue). Member package balances stay on membersStore.
  // Fail closed: never substitute Blob-only when Postgres reads are required.
  const { loadAuthoritativeManual } = await import("../lib/bookingReads.js");
  const manual = await loadAuthoritativeManual();
  const members = await loadMembersState();
  const out = [];
  activeBookings(manual).forEach((b) => {
    if ((b.amountDueCents || 0) > 0) {
      out.push({
        id: b.id,
        kind: "booking",
        player: b.player,
        email: b.email,
        date: b.date,
        time: b.time,
        type: b.type,
        amountDueCents: b.amountDueCents,
      });
    }
  });
  Object.values(members.byEmail || {}).forEach((m) => {
    // A card that's off the members list doesn't bill from the Money tab either.
    if (m.removed) return;
    if ((m.amountDueCents || 0) > 0) {
      out.push({
        id: `mem_${m.email}`,
        kind: "membership",
        player: m.player || "",
        email: m.email,
        date: "",
        time: "",
        type: "membership",
        amountDueCents: m.amountDueCents,
      });
    }
  });
  return out;
}

async function dashboard() {
  await loadCoachStatus();
  const key = process.env.STRIPE_SECRET_KEY || "";
  // Fail closed: never replace an unreadable Blob schedule with [].
  let sessions = await fetchBookings(key);
  sessions = sessions.map((session) => ({
    ...session,
    canChange: !lessonHasEnded(session),
  }));
  const membersState = await loadMembersState();
  const finance = await loadFinance();
  const outstanding = await listOutstanding();
  const settings = await loadSettings();
  const siteStatus = getSiteStatus();
  const availability = await getAvailability();

  const members = Object.values(membersState.byEmail || {})
    .filter((m) => !m.removed)
    .map((m) => {
      const tier = membershipTierOf({
        type: m.membershipType || m.type || "membership",
        privacy: m.privacy || "",
      });
      return {
        email: m.email,
        player: m.player || "",
        parent: m.parent || "",
        phone: m.phone || "",
        frozen: isMemberFrozen(membersState, m.email).frozen,
        amountDueCents: m.amountDueCents || 0,
        cashMembership: Boolean(m.cashMembership),
        membershipType: m.membershipType || m.type || (m.cashMembership ? "membership" : ""),
        membershipTier: tier,
        membershipLabel: m.cashMembership || m.membershipType ? membershipLabel(tier) : "",
        privacy: m.privacy || "",
        note: m.note || "",
      };
    });

  // Also surface emails from upcoming membership lessons
  sessions
    .filter((s) => isMembershipType(s.type || "membership") && s.email)
    .forEach((s) => {
      const e = String(s.email).toLowerCase();
      if (members.some((m) => m.email === e)) return;
      // Stripe is the source of this one, so a removed card would otherwise
      // reappear here on the next load.
      if (isMemberRemoved(membersState, e)) return;
      const tier = membershipTierOf(s);
      members.push({
        email: e,
        player: s.player || "",
        parent: s.parent || "",
        phone: s.phone || "",
        frozen: isMemberFrozen(membersState, e).frozen,
        amountDueCents: 0,
        cashMembership: false,
        membershipType: s.type || "membership",
        membershipTier: tier,
        membershipLabel: membershipLabel(tier),
        privacy: s.privacy || "",
        note: "",
      });
    });

  // Display-only overlay: active purchase type from Stripe/cash credit windows
  // wins over a stale roster card. Never mutates members.json / Stripe metadata.
  const purchaseByEmail = new Map();
  try {
    if (key) {
      const active = await listActiveMemberships(key);
      for (const sub of active) {
        const email = String(sub.email || sub.metadata?.email || "")
          .trim()
          .toLowerCase();
        if (!email || purchaseByEmail.has(email)) continue;
        const type = membershipTypeOf(sub);
        const tier = membershipTierOf(sub);
        purchaseByEmail.set(email, {
          membershipId: sub.id,
          membershipType: type,
          membershipTier: tier,
          membershipLabel: membershipLabel(tier),
        });
      }
    }
  } catch {
    /* keep roster labels until member-links can verify */
  }
  for (const cash of activeCashMemberships(membersState)) {
    const email = String(cash.email || cash.metadata?.email || "")
      .trim()
      .toLowerCase();
    if (!email || purchaseByEmail.has(email)) continue;
    const type = membershipTypeOf(cash);
    const tier = membershipTierOf(cash);
    purchaseByEmail.set(email, {
      membershipId: cash.id,
      membershipType: type,
      membershipTier: tier,
      membershipLabel: membershipLabel(tier),
    });
  }

  const membersWithDisplay = members.map((m) => {
    const purchase = purchaseByEmail.get(String(m.email || "").toLowerCase()) || null;
    const display = resolveCoachMembershipTypeDisplay({ link: purchase, desk: m });
    return {
      ...m,
      membershipLabel: display.text,
      membershipTypeVerified: display.verified,
      membershipTypeSource: display.source,
      activeMembershipId: purchase?.membershipId || "",
    };
  });

  return {
    sessions,
    members: membersWithDisplay.sort((a, b) =>
      (a.player || a.email).localeCompare(b.player || b.email)
    ),
    removedMembers: removedMembers(membersState).map((m) => ({
      email: m.email,
      player: m.player || "",
      phone: m.phone || "",
      amountDueCents: m.amountDueCents || 0,
      removedAt: m.removedAt || null,
    })),
    freezeAll: membersState.freezeAll,
    freezeAllReason: membersState.freezeAllReason || "",
    finance: financeSummary(finance.entries, outstanding),
    settings,
    siteStatus,
    availability,
    slotCapacity: SLOT_CAPACITY,
  };
}

export default async function handler(req, res) {
  if (!requireCoach(req, res)) return;
  await loadCoachStatus();

  if (req.method === "GET") {
    try {
      res.status(200).json(await dashboard());
    } catch (e) {
      const code = e?.code || (e?.name === "StorageUnavailableError" ? "schedule_unavailable" : "");
      res.status(code === "schedule_unavailable" ? 503 : 500).json({
        error: e?.message || "Couldn't load coach data.",
        ...(code ? { code } : {}),
      });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const action = String(req.body?.action || "");
  const key = process.env.STRIPE_SECRET_KEY || "";

  try {
    if (action === "collect_payment") {
      // Accept bookingId alias — some clients send that instead of id.
      const id = String(req.body?.id || req.body?.bookingId || "").trim();
      const amount = Math.max(0, Number(req.body?.amountCents) || 0);
      const method = req.body?.method === "card" ? "card" : "cash";
      if (!id) {
        res.status(400).json({ error: "Missing booking id.", code: "missing_id" });
        return;
      }
      if (!amount) {
        res.status(400).json({ error: "Enter an amount." });
        return;
      }

      if (id.startsWith("mem_")) {
        const email = id.slice(4);
        const members = await loadMembersState();
        const row = memberRecord(members, email) || { email };
        const due = Math.max(0, Number(row.amountDueCents) || 0);
        // Already settled — idempotent no-op (no finance write).
        if (due <= 0) {
          res.status(200).json({
            ok: true,
            collected: { id, take: 0, idempotent: true },
            ...(await dashboard()),
          });
          return;
        }
        const take = Math.min(amount, due);
        if (!take) {
          res.status(400).json({ error: "Enter an amount." });
          return;
        }
        row.amountPaidCents = (Number(row.amountPaidCents) || 0) + take;
        row.amountDueCents = Math.max(0, due - take);
        upsertMember(members, email, row);
        await saveMembersState(members);
        const fin = await loadFinance();
        addFinanceEntry(fin, {
          amountCents: take,
          method,
          type: "membership",
          player: row.player || "",
          email,
          // Unique per progressive paid total so partial collections each ledger,
          // while a retry after the same payment hits due<=0 above.
          bookingId: `membal_${email}_${row.amountPaidCents}`,
          note: "Membership balance collected",
        });
        await saveFinance(fin);
        res.status(200).json({
          ok: true,
          collected: { id, take, idempotent: false },
          ...(await dashboard()),
        });
        return;
      }

      let collectedBooking = null;
      let take = 0;
      let collectIdempotent = false;

      // When Postgres is authoritative (reads and/or writes), never look up
      // manuals in Blob — PG-created cash bookings are not dual-written.
      if (bookingPostgresAuthoritative()) {
        if (!bookingWritesEnabled()) {
          res.status(503).json({
            error:
              "Cash collection is paused while database booking writes are disabled. No payment was recorded.",
            code: "writes_disabled",
          });
          return;
        }
        const collected = await dbCollectManualPayment({ id, amountCents: amount });
        if (!collected.ok) {
          res.status(collected.status || 503).json({
            error: collected.error || "Couldn't save that payment. Refresh and try again.",
            code: collected.code || "collect_failed",
          });
          return;
        }
        collectedBooking = collected.booking;
        take = Number(collected.take) || 0;
        collectIdempotent = Boolean(collected.idempotent);
      } else if (bookingReadsEnabled()) {
        // Defensive: reads-on without postgres-authoritative helper should still
        // never fall through to Blob manuals.
        res.status(503).json({
          error:
            "Cash collection is paused while database booking writes are disabled. No payment was recorded.",
          code: "writes_disabled",
        });
        return;
      } else {
        const collected = await mutateManualBookings((store) => {
          const b = findBooking(store, id);
          if (!b) {
            return {
              ok: false,
              error: "Booking not found (only cash/manual bookings can be collected here).",
              code: "not_found",
              status: 404,
            };
          }
          const due = Math.max(0, Number(b.amountDueCents) || 0);
          if (due <= 0) {
            collectedBooking = b;
            return { ok: true, take: 0, idempotent: true };
          }
          const paidTake = Math.min(amount, due);
          b.amountPaidCents = (b.amountPaidCents || 0) + paidTake;
          b.amountDueCents = Math.max(0, due - paidTake);
          b.paymentStatus = b.amountDueCents > 0 ? "deposit_paid" : "paid";
          collectedBooking = b;
          return { ok: true, take: paidTake, idempotent: false };
        });
        if (!collected.ok) {
          res.status(collected.status || 503).json({
            error: collected.error || "Couldn't save that payment. Refresh and try again.",
            code: collected.code || "collect_failed",
          });
          return;
        }
        take = Number(collected.take) || 0;
        collectIdempotent = Boolean(collected.idempotent);
      }
      const b = collectedBooking;
      if (!b?.id) {
        res.status(404).json({
          error: "Booking not found (only cash/manual bookings can be collected here).",
          code: "not_found",
        });
        return;
      }
      if (take > 0 && b.email && isMembershipType(b.type)) {
        const members = await loadMembersState();
        const row = memberRecord(members, b.email);
        if (row) {
          row.amountPaidCents = (Number(row.amountPaidCents) || 0) + take;
          row.amountDueCents = Math.max(0, (Number(row.amountDueCents) || 0) - take);
          upsertMember(members, b.email, row);
          await saveMembersState(members);
        }
      }
      // Skip zero-amount / idempotent retries so finance is not polluted.
      if (take > 0 && !collectIdempotent) {
        const fin = await loadFinance();
        addFinanceEntry(fin, {
          amountCents: take,
          method,
          type: b.type,
          player: b.player,
          email: b.email,
          bookingId: b.id,
          date: b.date,
          note: "Collected outstanding balance",
        });
        await saveFinance(fin);
      }
      res.status(200).json({ ok: true, collected: { id: b.id, take, idempotent: collectIdempotent }, ...(await dashboard()) });
      return;
    }

    // Move any lesson on the schedule — cash/manual, member-portal, or the slot
    // a parent picked at checkout — to a new day and time, and tell them.
    if (action === "move_booking") {
      const id = String(req.body?.id || "");
      const date = String(req.body?.date || "");
      if (!DATE_RE.test(date)) {
        res.status(400).json({ error: "Select a lesson date.", code: "missing_date" });
        return;
      }
      const resolved = resolveCoachTime(req.body?.time, req.body?.meridiem);
      if (!resolved.ok) {
        res.status(resolved.status).json({
          error: resolved.error,
          code: resolved.code,
          hour: resolved.hour,
          minute: resolved.minute,
        });
        return;
      }
      const time = resolved.label;

      const sessions = await fetchBookings(key);
      const row = sessions.find((s) => s.id === id);
      if (!row) {
        res.status(404).json({ error: "That lesson isn't on the schedule anymore — refresh and try again." });
        return;
      }
      if (lessonHasEnded(row)) {
        res.status(400).json({
          error: "That lesson has already ended, so it cannot be moved or returned as a credit.",
          code: "lesson_ended",
        });
        return;
      }
      if (row.date === date && row.time === time) {
        res.status(400).json({ error: "That's the day and time it's already on." });
        return;
      }

      const availability = await getAvailability();
      const mins = durationFor(row.type);
      const focus = normalizeFocus(req.body.focus || row.focus || "Fielding", row.type);
      // The coach can move a lesson outside posted hours on purpose (make-up
      // sessions), but double-booking is always refused.
      const outsideHours = !allowedTimes(date, availability, mins).includes(time);
      if (outsideHours && !req.body.force) {
        res.status(409).json({
          error: `${time} on ${date} is outside your open hours. Move it anyway?`,
          code: "outside_hours",
        });
        return;
      }
      if (key) {
        try {
          const taken = await bookedTimes(key, date, {
            ignoreSourceId: row.source === "stripe" ? row.sourceId : row.id,
          });
          const movePrivacy = row.privacy || privacyForPurchaseType(row.type);
          if (
            slotBlocked(taken, time, mins, focus, {
              seats: seatsOnLesson(row),
              exclusive: isExclusiveBooking({ type: row.type, focus, privacy: movePrivacy }),
              privacy: movePrivacy,
            })
          ) {
            res.status(409).json({ error: "Something else is already on that time. Pick another." });
            return;
          }
        } catch {
          res.status(503).json({
            error: "Couldn't confirm that time is still available. Try again shortly.",
            code: "schedule_unavailable",
          });
          return;
        }
      }

      let result = null;
      if (bookingWritesEnabled()) {
        const movedSave = await dbReschedule({
          bookingId: row.id,
          newDate: date,
          newTime: time,
          newFocus: focus,
        });
        if (!movedSave.ok) {
          res.status(movedSave.code === "slot_unavailable" ? 409 : 503).json({
            error: movedSave.error || "Couldn't save the move. Refresh and try again in a moment.",
            code: movedSave.code,
          });
          return;
        }
        result = {
          ok: true,
          moved: { date, time, focus, movedAt: Date.now() },
          clearStripe:
            row.source === "stripe" ? { sourceId: row.sourceId || "", lessonId: row.id } : null,
        };
        if (result.clearStripe) {
          await clearStripeSlot(key, result.clearStripe.sourceId, result.clearStripe.lessonId);
        }
        let notified = false;
        if (row.email) {
          notified = await sendLessonMovedEmail({
            to: row.email,
            oldLesson: row,
            newLesson: { ...row, ...result.moved },
            movedBy: "coach",
            extraLine: req.body.message || "",
          });
        }
        res.status(200).json({ ok: true, moved: result.moved, notified, ...(await dashboard()) });
        return;
      }
      if (row.source === "manual") {
        const movedSave = await mutateManualBookings(async (manual) => {
          // Peer occupancy from authoritative reads (Postgres + dual-period bridge).
          const { loadAuthoritativeLessons } = await import("../lib/bookingReads.js");
          const stored = await loadAuthoritativeLessons();
          result = moveLesson({ row, stored, manual, date, time, focus, availability });
          if (!result.ok) return { ok: false, error: result.error, status: 404 };
          return { ok: true, moved: result.moved };
        });
        if (!movedSave.ok) {
          res.status(movedSave.status || 503).json({
            error: movedSave.error || "Couldn't save the move. Refresh and try again in a moment.",
            code: movedSave.code,
          });
          return;
        }
        result = { ok: true, moved: movedSave.moved, changed: ["manual"] };
      } else {
        const movedSave = await mutateLessons(async (stored) => {
          const { loadAuthoritativeManual } = await import("../lib/bookingReads.js");
          const manual = await loadAuthoritativeManual();
          if (key) {
            try {
              const taken = await bookedTimes(key, date, {
                ignoreSourceId: row.source === "stripe" ? row.sourceId : row.id,
              });
              const movePrivacy = row.privacy || privacyForPurchaseType(row.type);
              if (
                slotBlocked(taken, time, mins, focus, {
                  seats: seatsOnLesson(row),
                  exclusive: isExclusiveBooking({ type: row.type, focus, privacy: movePrivacy }),
                  privacy: movePrivacy,
                })
              ) {
                return {
                  ok: false,
                  error: "Something else is already on that time. Pick another.",
                  status: 409,
                  code: "slot_taken",
                };
              }
            } catch {
              return {
                ok: false,
                error: "Couldn't confirm that time is still available. Try again shortly.",
                status: 503,
                code: "schedule_unavailable",
              };
            }
          }
          result = moveLesson({ row, stored, manual, date, time, focus, availability });
          if (!result.ok) return { ok: false, error: result.error, status: 404 };
          return { ok: true, moved: result.moved, clearStripe: result.clearStripe };
        });
        if (!movedSave.ok) {
          res.status(movedSave.status || 503).json({
            error: movedSave.error || "Couldn't save the move. Refresh and try again in a moment.",
            code: movedSave.code,
          });
          return;
        }
        result = {
          ok: true,
          moved: movedSave.moved,
          changed: ["lessons"],
          clearStripe: movedSave.clearStripe,
        };
      }
      if (result.clearStripe) {
        await clearStripeSlot(key, result.clearStripe.sourceId, result.clearStripe.lessonId);
      }

      let notified = false;
      if (row.email) {
        notified = await sendLessonMovedEmail({
          to: row.email,
          oldLesson: row,
          newLesson: { ...row, ...result.moved },
          movedBy: "coach",
          extraLine: req.body.message || "",
        });
      }
      res.status(200).json({ ok: true, moved: result.moved, notified, ...(await dashboard()) });
      return;
    }

    // Cancel any lesson: cash/manual bookings are marked cancelled, member
    // lessons are removed, and checkout slots are voided so the time reopens.
    if (action === "cancel_booking") {
      const id = String(req.body?.id || "");
      if (bookingWritesEnabled()) {
        const sessions = await fetchBookings(key);
        const row = sessions.find((s) => s.id === id);
        if (!row) {
          res.status(404).json({ error: "That lesson isn't on the schedule anymore." });
          return;
        }
        if (lessonHasEnded(row)) {
          res.status(400).json({
            error: "That lesson has already ended, so it cannot be cancelled or returned as a credit.",
            code: "lesson_ended",
          });
          return;
        }
        const cancelled = await dbCancelBooking(id, {
          restoreCredit:
            row.source === "member" || isMembershipType(row.type),
        });
        if (!cancelled.ok) {
          res.status(cancelled.code === "not_found" ? 404 : 503).json({
            error: cancelled.error || "Couldn't cancel that lesson. Refresh and try again.",
            code: cancelled.code,
          });
          return;
        }
        if (row.source === "stripe") await clearStripeSlot(key, row.sourceId, row.id);
        const notified = await sendLessonCancelledEmail({
          to: row.email,
          lesson: row,
          cancelledBy: "coach",
          extraLine: [
            isMembershipType(row.type) ? "That lesson credit has been returned to the membership." : "",
            req.body.message || "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
        res.status(200).json({ ok: true, notified, ...(await dashboard()) });
        return;
      }
      const manualCancel = await mutateManualBookings((store) => {
        const b = findBooking(store, id);
        if (!b) return { ok: true, skipSave: true, missing: true };
        if (lessonHasEnded(b)) {
          return {
            ok: false,
            error: "That lesson has already ended, so it cannot be cancelled or returned as a credit.",
            status: 400,
            code: "lesson_ended",
          };
        }
        if (b.status === "cancelled") {
          return { ok: true, skipSave: true, cancelledLesson: { ...b } };
        }
        const cancelledLesson = { ...b };
        b.status = "cancelled";
        b.cancelledAt = Date.now();
        return { ok: true, cancelledLesson };
      });
      if (!manualCancel.ok) {
        res.status(manualCancel.status || 503).json({
          error: manualCancel.error || "Couldn't cancel that lesson. Refresh and try again.",
          code: manualCancel.code,
        });
        return;
      }
      if (!manualCancel.missing) {
        const cancelledLesson = manualCancel.cancelledLesson;
        const notified = await sendLessonCancelledEmail({
          to: cancelledLesson.email,
          lesson: cancelledLesson,
          cancelledBy: "coach",
          extraLine: [
            isMembershipType(cancelledLesson.type)
              ? "That lesson credit has been returned to the membership."
              : "",
            req.body.message || "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
        res.status(200).json({ ok: true, notified, ...(await dashboard()) });
        return;
      }

      const sessions = await fetchBookings(key);
      const row = sessions.find((s) => s.id === id);
      if (!row) {
        res.status(404).json({ error: "That lesson isn't on the schedule anymore." });
        return;
      }
      if (lessonHasEnded(row)) {
        res.status(400).json({
          error: "That lesson has already ended, so it cannot be cancelled or returned as a credit.",
          code: "lesson_ended",
        });
        return;
      }
      const cancelled = await mutateLessons((stored) => {
        if (row.source === "stripe") {
          voidStripeLesson(stored, {
            email: row.email,
            date: row.date,
            time: row.time,
            sourceId: row.sourceId,
          });
          removeLesson(stored, row.id, row.email);
          return { ok: true };
        }
        if (!removeLesson(stored, row.id, row.email)) {
          return { ok: false, error: "That lesson isn't on file anymore.", status: 404 };
        }
        return { ok: true };
      });
      if (!cancelled.ok) {
        res.status(cancelled.status || 503).json({
          error: cancelled.error || "Couldn't cancel that lesson. Refresh and try again.",
          code: cancelled.code,
        });
        return;
      }
      if (row.source === "stripe") await clearStripeSlot(key, row.sourceId, row.id);
      const notified = await sendLessonCancelledEmail({
        to: row.email,
        lesson: row,
        cancelledBy: "coach",
        extraLine: [
          isMembershipType(row.type) ? "That lesson credit has been returned to the membership." : "",
          req.body.message || "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      res.status(200).json({ ok: true, notified, ...(await dashboard()) });
      return;
    }

    if (action === "create_booking") {
      const settings = await loadSettings();
      const type = BOOKING_TYPES.includes(req.body.type) ? req.body.type : "single";
      const date = String(req.body.date || "");
      const player = String(req.body.player || "").trim();
      const player2 = String(req.body.player2 || "").trim();
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!player) {
        res.status(400).json({ error: "Enter an athlete name.", code: "missing_player" });
        return;
      }
      if (!DATE_RE.test(date)) {
        res.status(400).json({ error: "Select a lesson date.", code: "missing_date" });
        return;
      }
      const resolved = resolveCoachTime(req.body?.time, req.body?.meridiem);
      if (!resolved.ok) {
        res.status(resolved.status).json({
          error: resolved.error,
          code: resolved.code,
          hour: resolved.hour,
          minute: resolved.minute,
        });
        return;
      }
      const time = resolved.label;
      const focus = normalizeFocus(req.body.focus || "Fielding", type);
      if (type === "private" && player2) {
        res.status(400).json({
          error: "Private lessons are one athlete only. Remove the second athlete or pick a regular lesson.",
        });
        return;
      }
      const athletes = canPair(type) && player2 ? 2 : 1;
      const privacy = privacyForPurchaseType(type);
      const exclusive = isExclusiveBooking({ type, focus, privacy });
      const seats = exclusive ? SLOT_CAPACITY : seatsFor(type, athletes);
      const availability = await getAvailability();
      if (!allowedTimes(date, availability, durationFor(type)).includes(time) && !req.body.force) {
        res.status(409).json({ error: "That time isn't in your open hours. Save anyway?", code: "outside_hours" });
        return;
      }
      if (key) {
        const taken = await bookedTimes(key, date);
        if (slotBlocked(taken, time, durationFor(type), focus, { seats, exclusive, privacy })) {
          res.status(409).json({ error: "That slot is already taken." });
          return;
        }
      }
      // prepaid_external = coach already collected a private-training package
      // outside this form. Zero amount, no ledger revenue, no membership credits.
      const payMethod =
        req.body.paymentMethod === "prepaid_external"
          ? "prepaid_external"
          : req.body.paymentMethod === "card"
          ? "card"
          : req.body.paymentMethod === "comp"
          ? "comp"
          : "cash";
      const isPrepaid = payMethod === "prepaid_external";
      if (isPrepaid && isMembershipType(type)) {
        res.status(400).json({
          error:
            "Prepaid package lessons are private drop-ins only — they do not use four-credit memberships.",
        });
        return;
      }
      if (isPrepaid && type !== "private") {
        res.status(400).json({
          error: "Prepaid package lessons must be Private (exclusive hour).",
        });
        return;
      }
      const listPrice = unitPriceFor(type, athletes, settings.prices) * athletes;
      const total = isPrepaid
        ? 0
        : req.body.amountCents != null
        ? Number(req.body.amountCents)
        : listPrice;
      const paid = isPrepaid
        ? 0
        : req.body.markPaid || payMethod === "card"
        ? total
        : payMethod === "comp"
        ? 0
        : 0;
      const due = isPrepaid ? 0 : Math.max(0, total - paid);
      const paymentStatus = isPrepaid
        ? "prepaid_external"
        : due > 0
        ? "unpaid"
        : payMethod === "comp"
        ? "waived"
        : "paid";
      const booking = makeManualBooking({
        type,
        player,
        player2,
        athletes,
        parent: req.body.parent || "",
        phone: req.body.phone || "",
        email,
        focus,
        privacy,
        date,
        time,
        availability,
        paymentMethod: payMethod,
        paymentStatus,
        amountCents: total,
        amountPaidCents: paid,
        amountDueCents: due,
        note: req.body.note || "",
        createdBy: "coach",
      });
      if (bookingWritesEnabled()) {
        const saved = await dbManualBook({
          id: booking.id,
          date,
          time,
          focus,
          type,
          privacy,
          seats,
          athletes,
          email,
          player,
          player2,
          parent: booking.parent || "",
          phone: booking.phone || "",
          // Never attach prepaid package lessons to membership credit ledgers.
          membershipId: !isPrepaid && isMembershipType(type) && email ? `cash_${email}` : null,
          payload: {
            paymentMethod: payMethod,
            paymentStatus: booking.paymentStatus,
            amountCents: total,
            amountPaidCents: paid,
            amountDueCents: due,
            note: booking.note || "",
            createdBy: "coach",
          },
        });
        if (!saved.ok) {
          res.status(saved.code === "slot_unavailable" ? 409 : 503).json({
            error: saved.error || "Couldn't safely reserve that lesson. Refresh and try again.",
            code: saved.code || "schedule_unavailable",
          });
          return;
        }
        if (!isPrepaid && isMembershipType(type) && email) {
          const members = await loadMembersState();
          const start = Math.floor(Date.now() / 1000);
          upsertMember(members, email, {
            cashMembership: true,
            cashMembershipStart: start,
            cashMembershipEnd: start + MEMBER_PERIOD_DAYS * 86400,
            membershipType: type,
            type,
            privacy,
            player,
            parent: req.body.parent || "",
            phone: req.body.phone || "",
            amountDueCents: due,
            amountPaidCents: paid,
            paymentMethod: payMethod,
          });
          await saveMembersState(members);
        }
        if (paid > 0) {
          const fin = await loadFinance();
          addFinanceEntry(fin, {
            amountCents: paid,
            method: payMethod === "card" ? "card" : "cash",
            type,
            player,
            email,
            bookingId: booking.id,
            date,
            note: "Coach booked lesson",
          });
          await saveFinance(fin);
        }
        res.status(200).json({ ok: true, booking, ...(await dashboard()) });
        return;
      }
      const saved = await mutateManualBookings(async (store) => {
        if (store.bookings.some((existing) => existing.id === booking.id)) {
          return { ok: true, skipSave: true };
        }
        if (key) {
          try {
            const taken = await bookedTimes(key, date);
            if (slotBlocked(taken, time, durationFor(type), focus, { seats, exclusive, privacy })) {
              return {
                ok: false,
                error: "That time was just taken, became full, or has a different training focus.",
                status: 409,
                code: "slot_taken",
              };
            }
          } catch {
            return {
              ok: false,
              error: "Couldn't confirm that time is still available. Try again shortly.",
              status: 503,
              code: "schedule_unavailable",
            };
          }
        }
        store.bookings.push(booking);
        return { ok: true };
      });
      if (!saved.ok) {
        res.status(saved.status || 503).json({
          error: saved.error || "Couldn't safely reserve that lesson. Refresh and try again.",
          code: saved.code || "schedule_unavailable",
        });
        return;
      }
      if (!isPrepaid && isMembershipType(type) && email) {
        const members = await loadMembersState();
        const start = Math.floor(Date.now() / 1000);
        upsertMember(members, email, {
          cashMembership: true,
          cashMembershipStart: start,
          cashMembershipEnd: start + MEMBER_PERIOD_DAYS * 86400,
          membershipType: type,
          type,
          privacy,
          player,
          amountDueCents: due,
          amountPaidCents: paid,
          paymentMethod: payMethod,
        });
        await saveMembersState(members);
      }
      if (paid > 0) {
        const fin = await loadFinance();
        addFinanceEntry(fin, {
          amountCents: paid,
          method: payMethod === "card" ? "card" : "cash",
          type,
          player,
          email,
          bookingId: booking.id,
          date,
          note: "Coach booked lesson",
        });
        await saveFinance(fin);
      }
      res.status(200).json({ ok: true, booking, ...(await dashboard()) });
      return;
    }

    if (action === "freeze_one") {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const frozen = Boolean(req.body?.frozen);
      const reason = String(req.body?.reason || "");
      if (!email) {
        res.status(400).json({ error: "Email required." });
        return;
      }
      const members = await loadMembersState();
      const prev = memberRecord(members, email) || {};
      const patch = { frozen, reason: frozen ? reason : "", player: req.body.player || prev.player || "" };
      if (frozen) patch.frozenAt = Date.now();
      else if (prev.frozenAt) {
        const days = Math.ceil((Date.now() - prev.frozenAt) / 86400000);
        patch.periodBonusDays = (Number(prev.periodBonusDays) || 0) + Math.max(0, days);
        patch.frozenAt = null;
        if (prev.cashMembershipEnd) {
          patch.cashMembershipEnd = Number(prev.cashMembershipEnd) + Math.max(0, days) * 86400;
        }
      }
      upsertMember(members, email, patch);
      await saveMembersState(members);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    // Take a card off the members list — the fix for one athlete signed up under
    // two emails. The record stays on file, so this is reversible.
    if (action === "remove_member") {
      const email = String(req.body?.email || "").trim().toLowerCase();
      if (!email) {
        res.status(400).json({ error: "Email required." });
        return;
      }
      const members = await loadMembersState();
      const owed = Math.max(0, Number(memberRecord(members, email)?.amountDueCents) || 0);
      if (owed > 0 && !req.body?.force) {
        res.status(409).json({
          error:
            `This card still shows $${(owed / 100).toFixed(2)} owed, and removing it takes ` +
            `that off your Money tab. Remove it anyway?`,
          code: "owes_money",
          amountDueCents: owed,
        });
        return;
      }
      removeMember(members, email);
      const saved = await saveMembersState(members);
      if (!saved) {
        res.status(500).json({ error: "Could not remove that card. Refresh and try again." });
        return;
      }
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "restore_member") {
      const email = String(req.body?.email || "").trim().toLowerCase();
      if (!email) {
        res.status(400).json({ error: "Email required." });
        return;
      }
      const members = await loadMembersState();
      restoreMember(members, email);
      const saved = await saveMembersState(members);
      if (!saved) {
        res.status(500).json({ error: "Could not put that card back. Refresh and try again." });
        return;
      }
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "freeze_all") {
      const frozen = Boolean(req.body?.frozen);
      const reason = String(req.body?.reason || (frozen ? "Paused by coach" : ""));
      const members = await loadMembersState();
      if (frozen) {
        members.freezeAll = true;
        members.freezeAllAt = Date.now();
        members.freezeAllReason = reason;
      } else {
        const days = members.freezeAllAt ? Math.ceil((Date.now() - members.freezeAllAt) / 86400000) : 0;
        if (days > 0) {
          Object.keys(members.byEmail || {}).forEach((email) => {
            const row = members.byEmail[email];
            row.periodBonusDays = (Number(row.periodBonusDays) || 0) + days;
            if (row.cashMembershipEnd) row.cashMembershipEnd = Number(row.cashMembershipEnd) + days * 86400;
          });
        }
        members.freezeAll = false;
        members.freezeAllAt = null;
        members.freezeAllReason = "";
      }
      await saveMembersState(members);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "save_site_status") {
      const cur = await loadCoachStatus();
      const next = {
        ...cur,
        siteStatusVersion: SITE_STATUS_VERSION,
        blockNewMemberships:
          typeof req.body.blockNewMemberships === "boolean" ? req.body.blockNewMemberships : cur.blockNewMemberships,
        membershipFrozen:
          typeof req.body.membershipFrozen === "boolean" ? req.body.membershipFrozen : cur.membershipFrozen,
        fieldingOnly: typeof req.body.fieldingOnly === "boolean" ? req.body.fieldingOnly : cur.fieldingOnly,
      };
      if (req.body.membershipFrozen === true && !cur.membershipFreezeSince) {
        next.membershipFreezeSince = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      }
      if (req.body.membershipFrozen === false) {
        next.membershipFreezeSince = null;
      }
      await saveCoachStatus(next);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "save_settings") {
      const cur = await loadSettings();
      const saved = await saveSettings({ ...cur, ...(req.body.settings || {}) });
      if (!saved) {
        res.status(500).json({ error: "Could not save settings. Refresh and try again." });
        return;
      }
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "add_finance") {
      const amount = Number(req.body?.amountCents) || 0;
      if (!amount) {
        res.status(400).json({ error: "Enter an amount." });
        return;
      }
      const fin = await loadFinance();
      addFinanceEntry(fin, {
        amountCents: amount,
        method: req.body?.method === "card" ? "card" : "cash",
        type: req.body?.type || "other",
        player: req.body?.player || "",
        note: req.body?.note || "Manual entry",
      });
      await saveFinance(fin);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    const code = e?.code || (e?.name === "StorageUnavailableError" ? "schedule_unavailable" : "");
    res.status(code === "schedule_unavailable" ? 503 : 500).json({
      error: e?.message || "Coach action failed.",
      ...(code ? { code } : {}),
    });
  }
}
