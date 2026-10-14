import { bookedTimes } from "./slots.js";
import {
  allowedTimes,
  getAvailability,
  durationFor,
  slotBlocked,
  isExclusiveBooking,
  privacyForPurchaseType,
  LOCATIONS,
} from "../lib/schedule.js";
import {
  mutateLessons,
  makeMemberLesson,
  removeLesson,
  scheduledFor,
  scheduledAcrossMemberships,
  voidStripeLesson,
} from "../lib/lessons.js";
import {
  listMembershipsForEmail,
  pickPrimaryMembership,
  membershipSummary,
  publicMembershipCard,
  membershipOptsFromState,
  bookingBlocked,
  canCancelLesson,
  prettyDate,
  membershipTypeOf,
  membershipTierOf,
  todayChicago,
} from "../lib/members.js";
import { loadMembersState } from "../lib/membersStore.js";
import {
  mutateManualBookings,
  findBooking,
} from "../lib/manualBookings.js";
import { moveLesson, clearStripeSlot, seatsOnLesson } from "../lib/reschedule.js";
import { tokenFromRequest } from "../lib/memberAuth.js";
import { buildCalendar, stamp } from "../lib/ics.js";
import { bookingEvent } from "./calendar.js";
import { sendLessonCancelledEmail, sendLessonMovedEmail } from "../lib/lessonMail.js";
import { getSiteStatus, normalizeFocus, focusBlockedMessage } from "../lib/siteStatus.js";
import { bookingWritesEnabled } from "../lib/bookingDb/flags.js";
import { dbMemberBook, dbReschedule, dbCancelBooking } from "../lib/bookingStore.js";
import {
  loadAuthoritativeLessons,
  loadAuthoritativeManual,
  loadAuthoritativeBookingState,
} from "../lib/bookingReads.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2} (AM|PM)$/;
const FOCUS = { Hitting: true, Fielding: true, Both: true };
const REPLY_TO = "Apacademybsb@gmail.com";

function publicAccount(acct) {
  const loc = LOCATIONS.mustang || {};
  const membershipType = membershipTypeOf(acct.sub);
  const memberships = (acct.membershipCards || []).map(publicMembershipCard);
  const allLessons = (acct.allLessons || acct.summary.lessons || [])
    .filter((l) => l.date >= todayChicago())
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .map((l) => ({
      ...l,
      canChange: typeof l.canChange === "boolean" ? l.canChange : canCancelLesson(l.date, l.time),
    }));
  return {
    ...acct.summary,
    membershipId: acct.sub?.id || acct.summary.membershipId || "",
    membershipType,
    membershipTier: membershipTierOf(acct.sub),
    memberships,
    lessons: allLessons,
    siteStatus: getSiteStatus(),
    location: {
      name: loc.name || "Mustang High School",
      address: loc.address || "",
      note: loc.note || "",
      mapUrl: loc.address ? `https://maps.google.com/?q=${encodeURIComponent(loc.address)}` : "",
    },
  };
}

function purchaseBookingType(sub) {
  return membershipTypeOf(sub);
}

function purchasePrivacy(sub, lesson) {
  if (lesson?.privacy) return lesson.privacy;
  return privacyForPurchaseType(purchaseBookingType(sub));
}

function summarizePurchase(acct, sub, scheduled) {
  return membershipSummary(sub, scheduled, {
    ...(acct.memberOpts || {}),
    siblings: acct.subs,
  });
}

function rebuildMembershipViews(acct) {
  const siblings = acct.subs || [];
  acct.membershipCards = siblings.map((sub) => {
    const scheduled = scheduledFor(sub, acct.stored, acct.manual, siblings);
    return summarizePurchase(acct, sub, scheduled);
  });
  // Period still open (not calendar-expired). Used-up purchases stay listed
  // until their last day so parents can see 0 credits / buy again messaging.
  acct.activeCards = acct.membershipCards.filter((s) => s.periodOpen);
  const activeSubs = siblings.filter((sub) =>
    acct.activeCards.some((card) => card.membershipId === sub.id)
  );
  const primarySub =
    pickPrimaryMembership(activeSubs) || pickPrimaryMembership(siblings) || acct.sub;
  acct.sub = primarySub;
  acct.scheduled = scheduledFor(primarySub, acct.stored, acct.manual, siblings);
  acct.summary = summarizePurchase(acct, primarySub, acct.scheduled);
  acct.allLessons = scheduledAcrossMemberships(siblings, acct.stored, acct.manual).map((l) => ({
    ...l,
    canChange: canCancelLesson(l.date, l.time),
  }));
  return acct;
}

function resolvePurchase(acct, membershipId) {
  const id = String(membershipId || "").trim();
  const siblings = acct.subs || [];
  if (id) {
    const hit = siblings.find((s) => s.id === id);
    if (hit) return hit;
    return null;
  }
  // Single open membership → implicit selection (same portal behavior as before).
  const open = (acct.activeCards || []).filter((c) => !c.expired && c.remaining > 0);
  if (open.length === 1) {
    return siblings.find((s) => s.id === open[0].membershipId) || null;
  }
  if ((acct.activeCards || []).length === 1) {
    return siblings.find((s) => s.id === acct.activeCards[0].membershipId) || null;
  }
  if (siblings.length === 1) return siblings[0];
  return null;
}

function purchaseForLesson(acct, lesson) {
  const siblings = acct.subs || [];
  const bySub = String(lesson?.subId || "").trim();
  if (bySub) {
    const hit = siblings.find((s) => s.id === bySub);
    if (hit) return hit;
  }
  const bySource = String(lesson?.sourceId || "").trim();
  if (bySource && lesson?.source === "stripe") {
    const hit = siblings.find((s) => s.id === bySource);
    if (hit) return hit;
  }
  // Legacy fallback: unique belonging among siblings.
  const owners = siblings.filter((s) =>
    scheduledFor(s, acct.stored, acct.manual, siblings).some((l) => l.id === lesson.id)
  );
  if (owners.length === 1) return owners[0];
  return pickPrimaryMembership(owners) || acct.sub;
}

async function refreshScheduled(acct) {
  rebuildMembershipViews(acct);
  return acct;
}

async function emailMemberBooking(to, lesson, summary) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey || !to) return;
  const loc = LOCATIONS.mustang || {};
  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  // Same tap-to-add invite the paid confirmations carry — the coach is BCC'd,
  // so a member booking reaches their calendar immediately too.
  const events = bookingEvent(lesson, stamp());
  const invite = events.length
    ? {
        filename: "ap-academy-lesson.ics",
        content: Buffer.from(
          buildCalendar({ name: "AP Academy", events: [events] }),
          "utf8"
        ).toString("base64"),
        content_type: "text/calendar; charset=utf-8; method=PUBLISH",
      }
    : null;
  const when = `${prettyDate(lesson.date)} at ${lesson.time}`;
  const left = summary.remaining || 0;
  const player = lesson.player;
  const leftLine = left
    ? `You have ${left} lesson${left === 1 ? "" : "s"} left on this membership. ` +
      `They have to be used by ${summary.lastDayPretty} — book them anytime at apacademybsb.com/account.html.`
    : `That was the last of your ${summary.credits} lessons. This membership does not auto-renew — ` +
      `buy another month at apacademybsb.com/book.html?type=membership whenever you're ready for 4 more.`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        bcc: [REPLY_TO],
        reply_to: REPLY_TO,
        subject: `Lesson booked — ${when}`,
        text:
          `${player ? player + "'s" : "Your"} lesson is set for ${when}.\n\n` +
          (loc.address ? `WHERE\n${loc.name}\n${loc.address}\n${loc.note || ""}\n\n` : "") +
          `${leftLine}\n\n` +
          `Need to change it? Sign in at apacademybsb.com/account.html (12 hours notice).\n` +
          `Questions? Call or text (405) 819-4401.`,
        ...(invite ? { attachments: [invite] } : {}),
      }),
    });
  } catch {
    /* booking still stands */
  }
}

async function loadAccount(key, email) {
  const subs = await listMembershipsForEmail(key || "", email);
  if (!subs.length) return null;
  const [{ lessons: stored, manual }, membersState] = await Promise.all([
    loadAuthoritativeBookingState(),
    loadMembersState(),
  ]);
  const memberOpts = membershipOptsFromState(membersState, email);
  const acct = {
    subs,
    sub: pickPrimaryMembership(subs),
    stored,
    manual,
    membersState,
    memberOpts,
    scheduled: [],
    summary: null,
    membershipCards: [],
    activeCards: [],
    allLessons: [],
  };
  rebuildMembershipViews(acct);
  return acct;
}

async function refreshAccountBookings(acct) {
  const state = await loadAuthoritativeBookingState();
  acct.stored = state.lessons;
  acct.manual = state.manual;
  rebuildMembershipViews(acct);
}

// Drop a lesson the member currently holds. Portal-booked lessons live in the
// blob; the first day they picked at checkout lives on the Stripe payment, so
// those get voided (and we clear the Stripe metadata so the old slot opens up).
// Cash first lessons live in manual-bookings and are cancelled there.
async function releaseLesson(key, acct, lesson, email) {
  if (lesson.source === "manual") {
    const b = findBooking(acct.manual, lesson.id);
    if (!b || String(b.email || "").toLowerCase() !== String(email || "").toLowerCase()) {
      return false;
    }
    b.status = "cancelled";
    b.cancelledAt = Date.now();
    return true;
  }
  if (lesson.source === "stripe") {
    voidStripeLesson(acct.stored, { ...lesson, email });
    removeLesson(acct.stored, lesson.id, email);
    const id = lesson.sourceId || acct.sub?.id;
    if (id && key && !String(id).startsWith("cash_")) {
      const slot = String(lesson.id).match(/-([1-4])$/)?.[1] || "1";
      const path = String(id).startsWith("sub_") ? `subscriptions/${id}` : `payment_intents/${id}`;
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
        /* void still hides it on the member calendar */
      }
    }
    return true;
  }
  return removeLesson(acct.stored, lesson.id, email);
}

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY || "";
  const email = tokenFromRequest(req);
  if (!email) {
    res.status(401).json({ error: "Please sign in with the email on your membership." });
    return;
  }

  let acct;
  try {
    acct = await loadAccount(key, email);
  } catch (error) {
    const unavailable =
      error?.name === "StorageUnavailableError" || error?.code === "schedule_unavailable";
    if (unavailable) {
      res.status(503).json({
        error: "Couldn't read bookings from the database. Please try again shortly.",
        code: "schedule_unavailable",
      });
      return;
    }
    throw error;
  }
  if (!acct) {
    res.status(404).json({ error: "No active membership on that email. Call or text (405) 819-4401." });
    return;
  }

  if (req.method === "GET") {
    res.status(200).json(publicAccount(acct));
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const action = String(req.body?.action || "book");

  if (action === "cancel") {
    const id = String(req.body?.id || "");
    const lesson = (acct.allLessons || acct.scheduled).find((l) => l.id === id);
    if (!lesson) {
      res.status(404).json({ error: "Lesson not found." });
      return;
    }
    if (!canCancelLesson(lesson.date, lesson.time)) {
      res.status(400).json({ error: "Cancellations need 12 hours notice. Call or text (405) 819-4401." });
      return;
    }
    const owner = purchaseForLesson(acct, lesson);
    const ownerSummary = summarizePurchase(
      acct,
      owner,
      scheduledFor(owner, acct.stored, acct.manual, acct.subs)
    );

    if (bookingWritesEnabled()) {
      const restoreCredit =
        lesson.source === "member" || String(lesson.type || "").includes("membership");
      const cancelled = await dbCancelBooking(lesson.id, { restoreCredit });
      if (!cancelled.ok) {
        res.status(cancelled.code === "not_found" ? 404 : 503).json({
          error: cancelled.error || "Couldn't update that lesson. Call or text (405) 819-4401.",
          code: cancelled.code,
        });
        return;
      }
      if (lesson.source === "stripe") {
        const sourceId = lesson.sourceId || "";
        if (sourceId) await clearStripeSlot(key, sourceId, lesson.id);
      }
    } else if (lesson.source === "manual") {
      const cancelled = await mutateManualBookings((manual) => {
        const b = findBooking(manual, lesson.id);
        if (!b || String(b.email || "").toLowerCase() !== email) {
          return { ok: false, error: "Lesson not found.", status: 404 };
        }
        if (b.status === "cancelled") return { ok: true, skipSave: true };
        b.status = "cancelled";
        b.cancelledAt = Date.now();
        return { ok: true };
      });
      if (!cancelled.ok) {
        res.status(cancelled.status || 503).json({
          error: cancelled.error || "Couldn't update that lesson. Call or text (405) 819-4401.",
          code: cancelled.code,
        });
        return;
      }
    } else {
      const cancelled = await mutateLessons(async (stored) => {
        acct.stored = stored;
        if (!(await releaseLesson(key, acct, lesson, email))) {
          return { ok: false, error: "Lesson not found.", status: 404 };
        }
        return { ok: true };
      });
      if (!cancelled.ok) {
        res.status(cancelled.status || 503).json({
          error: cancelled.error || "Couldn't update that lesson. Call or text (405) 819-4401.",
          code: cancelled.code,
        });
        return;
      }
      acct.stored = cancelled.data;
    }

    await refreshAccountBookings(acct);
    await refreshScheduled(acct);
    const notified = await sendLessonCancelledEmail({
      to: email,
      lesson,
      cancelledBy: "parent",
      extraLine: `That lesson credit is available to book again through ${ownerSummary.lastDayPretty}.`,
    });
    res.status(200).json({ ok: true, notified, ...publicAccount(acct) });
    return;
  }

  if (action === "reschedule") {
    const id = String(req.body?.id || "");
    const lesson = (acct.allLessons || acct.scheduled).find((l) => l.id === id);
    if (!lesson) {
      res.status(404).json({ error: "Lesson not found." });
      return;
    }
    // The 12-hour window is measured from the lesson they currently hold.
    if (!canCancelLesson(lesson.date, lesson.time)) {
      res.status(400).json({ error: "Changes need 12 hours notice before your lesson. Call or text (405) 819-4401." });
      return;
    }

    // Reschedule keeps the original purchase — never switch tiers/credits mid-move.
    const owner = purchaseForLesson(acct, lesson);
    if (!owner) {
      res.status(400).json({ error: "Couldn't find the membership for that lesson. Call or text (405) 819-4401." });
      return;
    }

    const newDate = String(req.body?.date || "");
    const newTime = String(req.body?.time || "");
    const newFocusRaw = FOCUS[req.body?.focus] ? String(req.body.focus) : lesson.focus || "";
    const newFocusError = focusBlockedMessage(newFocusRaw);
    if (newFocusError) {
      res.status(400).json({ error: newFocusError });
      return;
    }
    const memberType = purchaseBookingType(owner);
    const newFocus = normalizeFocus(newFocusRaw, memberType);
    if (!DATE_RE.test(newDate) || !TIME_RE.test(newTime) || !newFocus) {
      res.status(400).json({ error: "Pick a training focus, day, and time." });
      return;
    }
    if (newDate === lesson.date && newTime === lesson.time) {
      res.status(400).json({ error: "That's the same day and time you already have. Pick a different slot." });
      return;
    }

    // Judge the new slot as if the lesson being moved weren't on the calendar,
    // so the one-per-day and remaining-credit rules don't count it twice.
    const ownerScheduled = scheduledFor(owner, acct.stored, acct.manual, acct.subs).filter(
      (l) => l.id !== id
    );
    const summaryWithout = summarizePurchase(acct, owner, ownerScheduled);
    const dayOthers = (acct.allLessons || []).filter((l) => l.id !== id);
    const blocked = bookingBlocked(summaryWithout, newDate, ownerScheduled, dayOthers);
    if (blocked) {
      res.status(400).json({ error: blocked });
      return;
    }

    const availability = await getAvailability();
    if (!allowedTimes(newDate, availability, durationFor(memberType)).includes(newTime)) {
      res.status(400).json({ error: "That time isn't open. Pick another slot." });
      return;
    }

    const movePrivacy = purchasePrivacy(owner, lesson);
    const moveExclusive = isExclusiveBooking({ type: memberType, focus: newFocus, privacy: movePrivacy });
    const moveSeats = seatsOnLesson({
      ...lesson,
      type: memberType,
      focus: newFocus,
      privacy: movePrivacy,
    });
    const ignoreSourceId =
      lesson.source === "stripe" ? lesson.sourceId || lesson.subId || lesson.id : lesson.id;
    const dur = durationFor(memberType);

    try {
      const taken = await bookedTimes(key, newDate, {
        ignoreSourceId: newDate === lesson.date ? ignoreSourceId : "",
      });
      if (
        slotBlocked(taken, newTime, dur, newFocus, {
          seats: moveSeats,
          exclusive: moveExclusive,
          privacy: movePrivacy,
        })
      ) {
        res.status(409).json({
          error: "Sorry — that time is full or has a different training focus. Pick another.",
        });
        return;
      }
    } catch {
      res.status(503).json({
        error: "Couldn't confirm that time is still available. Please try again shortly.",
        code: "schedule_unavailable",
      });
      return;
    }

    // Atomic move: release the original hour only inside the same CAS commit as
    // the replacement. Stripe metadata is cleared after Blob succeeds.
    const row = {
      id: lesson.id,
      sourceId: lesson.sourceId || lesson.subId || "",
      source: lesson.source || "member",
      type: memberType,
      player: lesson.player || "",
      player2: lesson.player2 || "",
      athletes: Number(lesson.athletes) || 1,
      seats: lesson.seats,
      parent: lesson.parent || "",
      phone: lesson.phone || "",
      email,
      focus: lesson.focus || "",
      privacy: movePrivacy,
      date: lesson.date,
      time: lesson.time,
    };

    async function revalidateMove(stored, manual) {
      const scheduled = scheduledFor(owner, stored, manual, acct.subs).filter((l) => l.id !== id);
      const summaryWithout = summarizePurchase(acct, owner, scheduled);
      const dayOthers = scheduledAcrossMemberships(acct.subs, stored, manual).filter((l) => l.id !== id);
      const retryBlocked = bookingBlocked(summaryWithout, newDate, scheduled, dayOthers);
      if (retryBlocked) {
        return { ok: false, error: retryBlocked, status: 400, code: "slot_taken" };
      }
      try {
        const taken = await bookedTimes(key, newDate, {
          ignoreSourceId: newDate === lesson.date ? ignoreSourceId : "",
        });
        if (
          slotBlocked(taken, newTime, dur, newFocus, {
            seats: moveSeats,
            exclusive: moveExclusive,
            privacy: movePrivacy,
          })
        ) {
          return {
            ok: false,
            error: "Sorry — that time is full or has a different training focus. Pick another.",
            status: 409,
            code: "slot_taken",
          };
        }
      } catch {
        return {
          ok: false,
          error: "Couldn't confirm that time is still available. Please try again shortly.",
          status: 503,
          code: "schedule_unavailable",
        };
      }
      return { ok: true };
    }

    let moved = null;
    let clearStripe = null;

    if (bookingWritesEnabled()) {
      const movedSave = await dbReschedule({
        bookingId: lesson.id,
        newDate,
        newTime,
        newFocus,
      });
      if (!movedSave.ok) {
        res.status(movedSave.code === "slot_unavailable" ? 409 : 503).json({
          error: movedSave.error || "Couldn't move that lesson. Call or text (405) 819-4401.",
          code: movedSave.code,
        });
        return;
      }
      moved = {
        ...lesson,
        date: newDate,
        time: newTime,
        focus: newFocus,
        movedAt: Date.now(),
      };
      if (row.source === "stripe") {
        clearStripe = { sourceId: row.sourceId || "", lessonId: row.id };
      }
      if (clearStripe) {
        await clearStripeSlot(key, clearStripe.sourceId, clearStripe.lessonId);
      }
      await refreshAccountBookings(acct);
      await refreshScheduled(acct);
      const ownerAfter = summarizePurchase(
        acct,
        owner,
        scheduledFor(owner, acct.stored, acct.manual, acct.subs)
      );
      const notified = await sendLessonMovedEmail({
        to: email,
        oldLesson: lesson,
        newLesson: moved,
        movedBy: "parent",
        extraLine: `You still have ${ownerAfter.remaining || 0} lesson${
          ownerAfter.remaining === 1 ? "" : "s"
        } left on that membership, good through ${ownerAfter.lastDayPretty}.`,
      });
      res.status(200).json({ ok: true, notified, lesson: moved, ...publicAccount(acct) });
      return;
    }

    if (row.source === "manual") {
      const movedSave = await mutateManualBookings(async (manual) => {
        const stored = await loadAuthoritativeLessons();
        const gate = await revalidateMove(stored, manual);
        if (!gate.ok) return gate;
        const result = moveLesson({
          row,
          stored,
          manual,
          date: newDate,
          time: newTime,
          focus: newFocus,
          availability,
        });
        if (!result.ok) return { ok: false, error: result.error, status: 404 };
        return { ok: true, moved: result.moved };
      });
      if (!movedSave.ok) {
        res.status(movedSave.status || 503).json({
          error: movedSave.error || "Couldn't move that lesson. Call or text (405) 819-4401.",
          code: movedSave.code,
        });
        return;
      }
      moved = movedSave.moved;
    } else {
      const movedSave = await mutateLessons(async (stored) => {
        acct.stored = stored;
        const manual = await loadAuthoritativeManual();
        acct.manual = manual;
        const gate = await revalidateMove(stored, manual);
        if (!gate.ok) return gate;
        const result = moveLesson({
          row,
          stored,
          manual,
          date: newDate,
          time: newTime,
          focus: newFocus,
          availability,
        });
        if (!result.ok) return { ok: false, error: result.error, status: 404 };
        return { ok: true, moved: result.moved, clearStripe: result.clearStripe };
      });
      if (!movedSave.ok) {
        res.status(movedSave.status || 503).json({
          error: movedSave.error || "Couldn't move that lesson. Call or text (405) 819-4401.",
          code: movedSave.code,
        });
        return;
      }
      moved = movedSave.moved;
      clearStripe = movedSave.clearStripe || null;
    }

    if (clearStripe) {
      await clearStripeSlot(key, clearStripe.sourceId, clearStripe.lessonId);
    }

    await refreshAccountBookings(acct);
    await refreshScheduled(acct);
    const ownerAfter = summarizePurchase(
      acct,
      owner,
      scheduledFor(owner, acct.stored, acct.manual, acct.subs)
    );
    const notified = await sendLessonMovedEmail({
      to: email,
      oldLesson: lesson,
      newLesson: moved,
      movedBy: "parent",
      extraLine: `You still have ${ownerAfter.remaining || 0} lesson${
        ownerAfter.remaining === 1 ? "" : "s"
      } left on that membership, good through ${ownerAfter.lastDayPretty}.`,
    });
    res.status(200).json({ ok: true, notified, lesson: moved, ...publicAccount(acct) });
    return;
  }

  const date = String(req.body?.date || "");
  const time = String(req.body?.time || "");
  const focusRaw = FOCUS[req.body?.focus] ? String(req.body.focus) : "";
  const focusError = focusBlockedMessage(focusRaw);
  if (focusError) {
    res.status(400).json({ error: focusError });
    return;
  }

  const selected = resolvePurchase(acct, req.body?.membershipId || req.body?.purchaseId);
  if (!selected) {
    res.status(400).json({
      error:
        (acct.activeCards || []).length > 1
          ? "Pick which membership to use for this lesson."
          : "No active membership credits available. Buy another month when you're ready.",
    });
    return;
  }

  const memberType = purchaseBookingType(selected);
  const focus = normalizeFocus(focusRaw, memberType);
  if (!DATE_RE.test(date) || !TIME_RE.test(time) || !focus) {
    res.status(400).json({ error: "Pick a training focus, day, and time." });
    return;
  }

  const selectedScheduled = scheduledFor(selected, acct.stored, acct.manual, acct.subs);
  const selectedSummary = summarizePurchase(acct, selected, selectedScheduled);
  const blocked = bookingBlocked(selectedSummary, date, selectedScheduled, acct.allLessons);
  if (blocked) {
    res.status(400).json({ error: blocked });
    return;
  }

  const availability = await getAvailability();
  if (!allowedTimes(date, availability, durationFor(memberType)).includes(time)) {
    res.status(400).json({ error: "That time isn't open. Pick another slot." });
    return;
  }

  const privacy = purchasePrivacy(selected);
  const exclusive = isExclusiveBooking({ type: memberType, focus, privacy });
  const seats = exclusive ? 2 : 1;
  try {
    const taken = await bookedTimes(key, date);
    const dur = durationFor(memberType);
    if (
      slotBlocked(taken, time, dur, focus, {
        seats,
        exclusive,
        privacy,
      })
    ) {
      res.status(409).json({
        error: "Sorry — that time is full or has a different training focus. Pick another.",
      });
      return;
    }
  } catch {
    res.status(503).json({
      error: "Couldn't confirm that time is still available. Please try again shortly.",
      code: "schedule_unavailable",
    });
    return;
  }

  const lesson = makeMemberLesson({
    sub: selected,
    date,
    time,
    focus,
    availability,
  });
  lesson.email = email;

  if (bookingWritesEnabled()) {
    const booked = await dbMemberBook({
      membershipId: selected.id,
      email,
      date,
      time,
      focus,
      type: memberType,
      privacy,
      player: lesson.player || "",
      parent: lesson.parent || "",
      phone: lesson.phone || "",
      creditsTotal: Number(selectedSummary?.credits) || 4,
    });
    if (!booked.ok) {
      res.status(booked.code === "slot_unavailable" ? 409 : booked.code === "no_credits" ? 400 : 503).json({
        error: booked.error || "Couldn't safely reserve that lesson. Please try again.",
        code: booked.code || "schedule_unavailable",
      });
      return;
    }
    lesson.id = booked.bookingId;
    await refreshAccountBookings(acct);
    await refreshScheduled(acct);
    const bookedSummary = summarizePurchase(
      acct,
      selected,
      scheduledFor(selected, acct.stored, acct.manual, acct.subs)
    );
    emailMemberBooking(email, lesson, bookedSummary);
    res.status(200).json({ ok: true, lesson, ...publicAccount(acct) });
    return;
  }

  const booked = await mutateLessons(async (stored) => {
    acct.stored = stored;
    acct.manual = await loadAuthoritativeManual();
    await refreshScheduled(acct);

    const liveScheduled = scheduledFor(selected, stored, acct.manual, acct.subs);
    const liveSummary = summarizePurchase(acct, selected, liveScheduled);
    const liveAll = scheduledAcrossMemberships(acct.subs, stored, acct.manual);
    const retryBlocked = bookingBlocked(liveSummary, date, liveScheduled, liveAll);
    if (retryBlocked) {
      return { ok: false, error: retryBlocked, status: 400, code: "slot_taken" };
    }

    try {
      const taken = await bookedTimes(key, date);
      if (
        slotBlocked(taken, time, durationFor(memberType), focus, {
          seats,
          exclusive,
          privacy,
        })
      ) {
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
        error: "Couldn't confirm that time is still available. Please try again shortly.",
        status: 503,
        code: "schedule_unavailable",
      };
    }

    if (stored.lessons.some((existing) => existing.id === lesson.id)) {
      return { ok: true, skipSave: true };
    }
    stored.lessons.push(lesson);
    return { ok: true };
  });

  if (!booked.ok) {
    res.status(booked.status || 503).json({
      error: booked.error || "Couldn't safely reserve that lesson. Please try again.",
      code: booked.code || "schedule_unavailable",
    });
    return;
  }

  await refreshAccountBookings(acct);
  await refreshScheduled(acct);
  const bookedSummary = summarizePurchase(
    acct,
    selected,
    scheduledFor(selected, acct.stored, acct.manual, acct.subs)
  );
  emailMemberBooking(email, lesson, bookedSummary);
  res.status(200).json({ ok: true, lesson, ...publicAccount(acct) });
}
