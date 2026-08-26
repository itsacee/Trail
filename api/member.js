import { bookedTimes } from "./slots.js";
import { allowedTimes, getAvailability, durationFor, labelToMin, LOCATIONS } from "../lib/schedule.js";
import {
  loadLessons,
  saveLessons,
  makeMemberLesson,
  removeLesson,
  scheduledFor,
} from "../lib/lessons.js";
import {
  findMembership,
  membershipSummary,
  bookingBlocked,
  canCancelLesson,
  prettyDate,
} from "../lib/members.js";
import { tokenFromRequest } from "../lib/memberAuth.js";
import { buildCalendar, stamp } from "../lib/ics.js";
import { bookingEvent } from "./calendar.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2} (AM|PM)$/;
const FOCUS = { Hitting: true, Fielding: true, Both: true };
const REPLY_TO = "Apacademybsb@gmail.com";

function publicAccount(acct) {
  const loc = LOCATIONS.mustang || {};
  return {
    ...acct.summary,
    location: {
      name: loc.name || "Mustang High School",
      address: loc.address || "",
      note: loc.note || "",
      mapUrl: loc.address ? `https://maps.google.com/?q=${encodeURIComponent(loc.address)}` : "",
    },
  };
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

async function emailMemberReschedule(to, oldLesson, newLesson, summary) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey || !to) return;
  const loc = LOCATIONS.mustang || {};
  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  // Fresh calendar invite for the new time — the coach is BCC'd, so their
  // calendar picks up the moved lesson in one tap, same as a new booking.
  const events = bookingEvent(newLesson, stamp());
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
  const was = `${prettyDate(oldLesson.date)} at ${oldLesson.time}`;
  const now = `${prettyDate(newLesson.date)} at ${newLesson.time}`;
  const player = newLesson.player;
  const left = summary.remaining || 0;
  const leftLine = left
    ? `You still have ${left} lesson${left === 1 ? "" : "s"} left on this membership, good through ${summary.lastDayPretty}.`
    : `That's all ${summary.credits} lessons spent for this membership.`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        bcc: [REPLY_TO],
        reply_to: REPLY_TO,
        subject: `Lesson moved — now ${now}`,
        text:
          `${player ? player + "'s" : "Your"} lesson has been moved.\n\n` +
          `WAS: ${was}\nNOW: ${now}\n\n` +
          (loc.address ? `WHERE\n${loc.name}\n${loc.address}\n${loc.note || ""}\n\n` : "") +
          `${leftLine}\n\n` +
          `Need to change it again? Sign in at apacademybsb.com/account.html (12 hours notice).\n` +
          `Questions? Call or text (405) 819-4401.`,
        ...(invite ? { attachments: [invite] } : {}),
      }),
    });
  } catch {
    /* the move still stands */
  }
}

async function loadAccount(key, email) {
  const sub = await findMembership(key, email);
  if (!sub) return null;
  const stored = await loadLessons();
  const scheduled = scheduledFor(sub, stored);
  return { sub, stored, scheduled, summary: membershipSummary(sub, scheduled) };
}

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const email = tokenFromRequest(req);
  if (!key) {
    res.status(500).json({ error: "Online membership isn't connected yet." });
    return;
  }
  if (!email) {
    res.status(401).json({ error: "Please sign in with the email on your membership." });
    return;
  }

  const acct = await loadAccount(key, email);
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
    const lesson = acct.scheduled.find((l) => l.id === id);
    if (!lesson) {
      res.status(404).json({ error: "Lesson not found." });
      return;
    }
    if (lesson.source === "stripe") {
      res.status(400).json({
        error: "That lesson was booked at signup. Call or text (405) 819-4401 and I'll move it.",
      });
      return;
    }
    if (!canCancelLesson(lesson.date, lesson.time)) {
      res.status(400).json({ error: "Cancellations need 12 hours notice. Call or text (405) 819-4401." });
      return;
    }
    if (!removeLesson(acct.stored, id, email)) {
      res.status(404).json({ error: "Lesson not found." });
      return;
    }
    const saved = await saveLessons(acct.stored);
    if (!saved) {
      res.status(500).json({ error: "Couldn't update that lesson. Call or text (405) 819-4401." });
      return;
    }
    acct.scheduled = scheduledFor(acct.sub, acct.stored);
    acct.summary = membershipSummary(acct.sub, acct.scheduled);
    res.status(200).json({ ok: true, ...publicAccount(acct) });
    return;
  }

  if (action === "reschedule") {
    const id = String(req.body?.id || "");
    const lesson = acct.scheduled.find((l) => l.id === id);
    if (!lesson) {
      res.status(404).json({ error: "Lesson not found." });
      return;
    }
    if (lesson.source === "stripe") {
      res.status(400).json({
        error: "That lesson was booked at signup. Call or text (405) 819-4401 and I'll move it.",
      });
      return;
    }
    // The 12-hour window is measured from the lesson they currently hold.
    if (!canCancelLesson(lesson.date, lesson.time)) {
      res.status(400).json({ error: "Changes need 12 hours notice before your lesson. Call or text (405) 819-4401." });
      return;
    }

    const newDate = String(req.body?.date || "");
    const newTime = String(req.body?.time || "");
    const newFocus = FOCUS[req.body?.focus] ? String(req.body.focus) : lesson.focus || "";
    if (!DATE_RE.test(newDate) || !TIME_RE.test(newTime)) {
      res.status(400).json({ error: "Pick a new day and time." });
      return;
    }
    if (newDate === lesson.date && newTime === lesson.time) {
      res.status(400).json({ error: "That's the same day and time you already have. Pick a different slot." });
      return;
    }

    // Judge the new slot as if the lesson being moved weren't on the calendar,
    // so the one-per-day and remaining-credit rules don't count it twice.
    const others = acct.scheduled.filter((l) => l.id !== id);
    const summaryWithout = membershipSummary(acct.sub, others);
    const blocked = bookingBlocked(summaryWithout, newDate, others);
    if (blocked) {
      res.status(400).json({ error: blocked });
      return;
    }

    const availability = await getAvailability();
    if (!allowedTimes(newDate, availability, durationFor("membership")).includes(newTime)) {
      res.status(400).json({ error: "That time isn't open. Pick another slot." });
      return;
    }

    try {
      const taken = await bookedTimes(key, newDate);
      const start = labelToMin(newTime);
      const dur = durationFor("membership");
      const conflict = start !== null && taken.some((b) => {
        // Don't collide with the slot we're moving away from.
        if (newDate === lesson.date && b.time === lesson.time) return false;
        const bStart = labelToMin(b.time);
        return bStart !== null && start < bStart + b.mins && bStart < start + dur;
      });
      if (conflict) {
        res.status(409).json({ error: "Sorry — that time was just booked. Pick another." });
        return;
      }
    } catch {
      /* continue */
    }

    if (!removeLesson(acct.stored, id, email)) {
      res.status(404).json({ error: "Lesson not found." });
      return;
    }
    const moved = makeMemberLesson({ sub: acct.sub, date: newDate, time: newTime, focus: newFocus, availability });
    moved.email = email;
    acct.stored.lessons.push(moved);
    const saved = await saveLessons(acct.stored);
    if (!saved) {
      res.status(500).json({ error: "Couldn't move that lesson. Call or text (405) 819-4401." });
      return;
    }

    acct.scheduled = scheduledFor(acct.sub, acct.stored);
    acct.summary = membershipSummary(acct.sub, acct.scheduled);
    emailMemberReschedule(email, lesson, moved, acct.summary);
    res.status(200).json({ ok: true, lesson: moved, ...publicAccount(acct) });
    return;
  }

  const date = String(req.body?.date || "");
  const time = String(req.body?.time || "");
  const focus = FOCUS[req.body?.focus] ? String(req.body.focus) : "";
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
    res.status(400).json({ error: "Pick a day and time." });
    return;
  }

  const blocked = bookingBlocked(acct.summary, date, acct.scheduled);
  if (blocked) {
    res.status(400).json({ error: blocked });
    return;
  }

  const availability = await getAvailability();
  if (!allowedTimes(date, availability, durationFor("membership")).includes(time)) {
    res.status(400).json({ error: "That time isn't open. Pick another slot." });
    return;
  }

  try {
    const taken = await bookedTimes(key, date);
    const start = labelToMin(time);
    const dur = durationFor("membership");
    const conflict = start !== null && taken.some((b) => {
      const bStart = labelToMin(b.time);
      return bStart !== null && start < bStart + b.mins && bStart < start + dur;
    });
    if (conflict) {
      res.status(409).json({ error: "Sorry — that time was just booked. Pick another." });
      return;
    }
  } catch {
    /* continue */
  }

  const lesson = makeMemberLesson({
    sub: acct.sub,
    date,
    time,
    focus,
    availability,
  });
  lesson.email = email;
  acct.stored.lessons.push(lesson);
  const saved = await saveLessons(acct.stored);
  if (!saved) {
    res.status(500).json({ error: "Couldn't save that lesson. Call or text (405) 819-4401." });
    return;
  }

  acct.scheduled = scheduledFor(acct.sub, acct.stored);
  acct.summary = membershipSummary(acct.sub, acct.scheduled);
  emailMemberBooking(email, lesson, acct.summary);
  res.status(200).json({ ok: true, lesson, ...publicAccount(acct) });
}
