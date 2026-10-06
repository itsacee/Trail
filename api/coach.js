// Coach admin: schedule moves, finances, collect cash, freeze members, facility
// pause toggles, prices and hours.

import { fetchBookings } from "../lib/bookings.js";
import {
  loadManualBookings,
  saveManualBookings,
  makeManualBooking,
  findBooking,
  activeBookings,
} from "../lib/manualBookings.js";
import { loadLessons, saveLessons, removeLesson, voidStripeLesson } from "../lib/lessons.js";
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
  isExclusiveType,
  canPair,
  SLOT_CAPACITY,
} from "../lib/schedule.js";
import { bookedTimes } from "./slots.js";
import { lessonHasEnded, MEMBER_PERIOD_DAYS } from "../lib/members.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2} (AM|PM)$/;
const BOOKING_TYPES = ["single", "thirty", "private", "membership"];

async function listOutstanding() {
  const manual = await loadManualBookings();
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
  let sessions = [];
  try {
    sessions = await fetchBookings(key);
    sessions = sessions.map((session) => ({
      ...session,
      canChange: !lessonHasEnded(session),
    }));
  } catch {
    sessions = [];
  }
  const membersState = await loadMembersState();
  const finance = await loadFinance();
  const outstanding = await listOutstanding();
  const settings = await loadSettings();
  const siteStatus = getSiteStatus();
  const availability = await getAvailability();

  const members = Object.values(membersState.byEmail || {})
    .filter((m) => !m.removed)
    .map((m) => ({
      email: m.email,
      player: m.player || "",
      parent: m.parent || "",
      phone: m.phone || "",
      frozen: isMemberFrozen(membersState, m.email).frozen,
      amountDueCents: m.amountDueCents || 0,
      cashMembership: Boolean(m.cashMembership),
      note: m.note || "",
    }));

  // Also surface emails from upcoming membership lessons
  sessions
    .filter((s) => s.type === "membership" && s.email)
    .forEach((s) => {
      const e = String(s.email).toLowerCase();
      if (members.some((m) => m.email === e)) return;
      // Stripe is the source of this one, so a removed card would otherwise
      // reappear here on the next load.
      if (isMemberRemoved(membersState, e)) return;
      members.push({
        email: e,
        player: s.player || "",
        parent: s.parent || "",
        phone: s.phone || "",
        frozen: isMemberFrozen(membersState, e).frozen,
        amountDueCents: 0,
        cashMembership: false,
        note: "",
      });
    });

  return {
    sessions,
    members: members.sort((a, b) => (a.player || a.email).localeCompare(b.player || b.email)),
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
      res.status(500).json({ error: e?.message || "Couldn't load coach data." });
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
      const id = String(req.body?.id || "");
      const amount = Math.max(0, Number(req.body?.amountCents) || 0);
      const method = req.body?.method === "card" ? "card" : "cash";
      if (!amount) {
        res.status(400).json({ error: "Enter an amount." });
        return;
      }

      if (id.startsWith("mem_")) {
        const email = id.slice(4);
        const members = await loadMembersState();
        const row = memberRecord(members, email) || { email };
        const due = Math.max(0, Number(row.amountDueCents) || 0);
        const take = Math.min(amount, due || amount);
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
          note: "Membership balance collected",
        });
        await saveFinance(fin);
        res.status(200).json({ ok: true, ...(await dashboard()) });
        return;
      }

      const store = await loadManualBookings();
      const b = findBooking(store, id);
      if (!b) {
        res.status(404).json({ error: "Booking not found (only cash/manual bookings can be collected here)." });
        return;
      }
      const take = Math.min(amount, b.amountDueCents || amount);
      b.amountPaidCents = (b.amountPaidCents || 0) + take;
      b.amountDueCents = Math.max(0, (b.amountDueCents || 0) - take);
      b.paymentStatus = b.amountDueCents > 0 ? "deposit_paid" : "paid";
      await saveManualBookings(store);
      if (b.email && b.type === "membership") {
        const members = await loadMembersState();
        const row = memberRecord(members, b.email);
        if (row) {
          row.amountPaidCents = (Number(row.amountPaidCents) || 0) + take;
          row.amountDueCents = Math.max(0, (Number(row.amountDueCents) || 0) - take);
          upsertMember(members, b.email, row);
          await saveMembersState(members);
        }
      }
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
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    // Move any lesson on the schedule — cash/manual, member-portal, or the slot
    // a parent picked at checkout — to a new day and time, and tell them.
    if (action === "move_booking") {
      const id = String(req.body?.id || "");
      const date = String(req.body?.date || "");
      const time = String(req.body?.time || "");
      if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
        res.status(400).json({ error: "Pick the new day and time (e.g. 6:00 PM)." });
        return;
      }

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
          if (
            slotBlocked(taken, time, mins, focus, {
              seats: seatsOnLesson(row),
              exclusive: isExclusiveType(row.type),
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

      const stored = await loadLessons();
      const manual = await loadManualBookings();
      const result = moveLesson({ row, stored, manual, date, time, focus, availability });
      if (!result.ok) {
        res.status(404).json({ error: result.error });
        return;
      }
      if (result.changed.includes("lessons") && !(await saveLessons(stored))) {
        res.status(500).json({ error: "Couldn't save the move (check Blob)." });
        return;
      }
      if (result.changed.includes("manual") && !(await saveManualBookings(manual))) {
        res.status(500).json({ error: "Couldn't save the move (check Blob)." });
        return;
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
      const store = await loadManualBookings();
      const b = findBooking(store, id);
      if (b) {
        if (lessonHasEnded(b)) {
          res.status(400).json({
            error: "That lesson has already ended, so it cannot be cancelled or returned as a credit.",
            code: "lesson_ended",
          });
          return;
        }
        const cancelledLesson = { ...b };
        b.status = "cancelled";
        b.cancelledAt = Date.now();
        if (!(await saveManualBookings(store))) {
          res.status(500).json({ error: "Couldn't cancel that lesson (check Blob)." });
          return;
        }
        const notified = await sendLessonCancelledEmail({
          to: cancelledLesson.email,
          lesson: cancelledLesson,
          cancelledBy: "coach",
          extraLine: [
            cancelledLesson.type === "membership"
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
      const stored = await loadLessons();
      if (row.source === "stripe") {
        voidStripeLesson(stored, { email: row.email, date: row.date, time: row.time, sourceId: row.sourceId });
        removeLesson(stored, row.id, row.email);
      } else if (!removeLesson(stored, row.id, row.email)) {
        res.status(404).json({ error: "That lesson isn't on file anymore." });
        return;
      }
      if (!(await saveLessons(stored))) {
        res.status(500).json({ error: "Couldn't cancel that lesson (check Blob)." });
        return;
      }
      if (row.source === "stripe") await clearStripeSlot(key, row.sourceId, row.id);
      const notified = await sendLessonCancelledEmail({
        to: row.email,
        lesson: row,
        cancelledBy: "coach",
        extraLine: [
          row.type === "membership" ? "That lesson credit has been returned to the membership." : "",
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
      const time = String(req.body.time || "");
      const player = String(req.body.player || "").trim();
      const player2 = String(req.body.player2 || "").trim();
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!player || !DATE_RE.test(date) || !TIME_RE.test(time)) {
        res.status(400).json({ error: "Need athlete, day, and time." });
        return;
      }
      const athletes = canPair(type) && player2 ? 2 : 1;
      const seats = isExclusiveType(type) ? SLOT_CAPACITY : seatsFor(type, athletes);
      const focus = normalizeFocus(req.body.focus || "Fielding", type);
      const availability = await getAvailability();
      if (!allowedTimes(date, availability, durationFor(type)).includes(time) && !req.body.force) {
        res.status(409).json({ error: "That time isn't in your open hours. Save anyway?", code: "outside_hours" });
        return;
      }
      if (key) {
        const taken = await bookedTimes(key, date);
        if (slotBlocked(taken, time, durationFor(type), focus, { seats, exclusive: isExclusiveType(type) })) {
          res.status(409).json({ error: "That slot is already taken." });
          return;
        }
      }
      const payMethod = req.body.paymentMethod === "card" ? "card" : req.body.paymentMethod === "comp" ? "comp" : "cash";
      const listPrice = unitPriceFor(type, athletes, settings.prices) * athletes;
      const total = req.body.amountCents != null ? Number(req.body.amountCents) : listPrice;
      const paid = req.body.markPaid || payMethod === "card" ? total : payMethod === "comp" ? 0 : 0;
      const due = Math.max(0, total - paid);
      const booking = makeManualBooking({
        type,
        player,
        player2,
        athletes,
        parent: req.body.parent || "",
        phone: req.body.phone || "",
        email,
        focus,
        date,
        time,
        availability,
        paymentMethod: payMethod,
        paymentStatus: due > 0 ? "unpaid" : payMethod === "comp" ? "waived" : "paid",
        amountCents: total,
        amountPaidCents: paid,
        amountDueCents: due,
        note: req.body.note || "",
        createdBy: "coach",
      });
      if (type === "membership" && email) {
        const members = await loadMembersState();
        const start = Math.floor(Date.now() / 1000);
        upsertMember(members, email, {
          cashMembership: true,
          cashMembershipStart: start,
          cashMembershipEnd: start + MEMBER_PERIOD_DAYS * 86400,
          player,
          amountDueCents: due,
          amountPaidCents: paid,
          paymentMethod: payMethod,
        });
        await saveMembersState(members);
      }
      const store = await loadManualBookings();
      store.bookings.push(booking);
      await saveManualBookings(store);
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
        res.status(500).json({ error: "Could not remove that card (check Blob)." });
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
        res.status(500).json({ error: "Could not put that card back (check Blob)." });
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
        res.status(500).json({ error: "Could not save settings (check Blob)." });
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
    res.status(500).json({ error: e?.message || "Coach action failed." });
  }
}
