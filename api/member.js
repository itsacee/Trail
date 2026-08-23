import { bookedTimes } from "./slots.js";
import { allowedTimes, getAvailability, durationFor, labelToMin, LOCATIONS } from "../lib/schedule.js";
import {
  loadLessons,
  saveLessons,
  lessonsForEmail,
  makeMemberLesson,
  removeLesson,
  lessonFromStripeMeta,
} from "../lib/lessons.js";
import {
  findMembership,
  membershipSummary,
  bookingBlocked,
  canCancelLesson,
} from "../lib/members.js";
import { tokenFromRequest } from "../lib/memberAuth.js";

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

async function emailWeeklyBook(to, lesson, player, summary) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey || !to) return;
  const loc = LOCATIONS.mustang || {};
  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  const when = `${lesson.date} at ${lesson.time}`;
  const left = summary?.remaining ?? "";
  const end = summary?.periodEndDate || "";
  const creditLine =
    left !== ""
      ? `\nLessons left: ${left} of ${summary?.credits || 4}` +
        (end ? ` · credits end ${end}` : "") +
        "\n"
      : "";
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
          `${player ? player + "'s" : "Your"} lesson is set for ${when}.\n` +
          creditLine +
          (loc.address ? `\nWhere: ${loc.address}\n${loc.note || ""}\n` : "") +
          `\nNeed to change it? Sign in at apacademybsb.com/account.html (12 hours notice).\n` +
          `Questions? (405) 819-4401`,
      }),
    });
  } catch {
    /* booking still stands */
  }
}

function scheduledFor(sub, stored) {
  const email = String(sub.metadata?.email || "").toLowerCase();
  const fromBlob = lessonsForEmail(stored, email);
  const fromStripe = lessonFromStripeMeta(sub.id, sub.metadata || {}, "membership");
  const seen = new Set(fromBlob.map((l) => `${l.date}|${l.time}`));
  const merged = [...fromBlob];
  fromStripe.forEach((l) => {
    const k = `${l.date}|${l.time}`;
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(l);
    }
  });
  return merged;
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
  emailWeeklyBook(email, lesson, lesson.player, acct.summary);
  res.status(200).json({ ok: true, lesson, ...publicAccount(acct) });
}
