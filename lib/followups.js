// Follow-up emails the daily reminder job sends after a lesson actually happens.
//
//   1. Drop-in (single) → membership pitch
//      Four singles are $280; the month is $240. Only after the hour lesson,
//      and only if that parent has not already bought a membership.
//
//   2. Membership lesson → book-the-next-one
//      After a membership lesson, if they still have credits and have not
//      booked the next day yet.
//
// Every send is recorded in followups.json so a re-run can't email or text
// twice. Email goes out via Resend; text goes out via Twilio when the three
// TWILIO_* env vars are set. The field address is never included.

import { blobRead, blobWrite } from "./store.js";
import { lessonStartMs, prettyDate } from "./members.js";
import { signMemberToken } from "./memberAuth.js";

const FILE = "followups.json";
const PHONE = "(405) 819-4401";
const COACH = "Elijah Alexander";

export const KIND_PITCH = "membership_pitch";
export const KIND_BOOK_AGAIN = "book_again";

// Lesson must be on a previous Chicago day, and not older than this.
export const LOOKBACK_DAYS = 4;
// Don't pitch the month to the same inbox more than once every few weeks.
export const PITCH_COOLDOWN_DAYS = 21;

export function emptyFollowups() {
  return { sent: [] };
}

export async function loadFollowups() {
  const raw = await blobRead(FILE);
  if (!raw) return emptyFollowups();
  try {
    const data = JSON.parse(raw);
    return { sent: Array.isArray(data?.sent) ? data.sent : [] };
  } catch {
    return emptyFollowups();
  }
}

export async function saveFollowups(data) {
  const cutoff = Date.now() - 120 * 86400 * 1000;
  const sent = (data.sent || [])
    .filter((s) => Number(s?.at) >= cutoff)
    .slice(-400);
  return blobWrite(FILE, { sent });
}

export function alreadySent(followups, kind, id) {
  return (followups.sent || []).some((s) => s.kind === kind && s.id === id);
}

export function markSent(followups, row) {
  followups.sent = Array.isArray(followups.sent) ? followups.sent : [];
  followups.sent.push({
    kind: row.kind,
    id: row.id,
    email: String(row.email || "").toLowerCase(),
    at: Number(row.at) || Date.now(),
  });
}

export function recentlyPitched(followups, email, now, withinDays = PITCH_COOLDOWN_DAYS) {
  const e = String(email || "").toLowerCase();
  const cutoff = now - withinDays * 86400 * 1000;
  return (followups.sent || []).some(
    (s) =>
      s.kind === KIND_PITCH &&
      String(s.email || "").toLowerCase() === e &&
      Number(s.at) >= cutoff
  );
}

export function sessionFromMeta(m) {
  if (!m) return null;
  if (m.date1 && m.time1) return { date: m.date1, time: m.time1 };
  if (m.date && m.time) return { date: m.date, time: m.time };
  return null;
}

function daysBetween(isoA, isoB) {
  const a = new Date(`${isoA}T12:00:00`);
  const b = new Date(`${isoB}T12:00:00`);
  return Math.round((b - a) / 86400000);
}

// True the morning after (Chicago) through LOOKBACK_DAYS, once the lesson
// start + duration is in the past. Same-day lessons wait for tomorrow's cron.
export function isRecentlyComplete(date, time, { today, now, durationMin = 60, lookback = LOOKBACK_DAYS } = {}) {
  if (!date || !time || !today) return false;
  if (date >= today) return false;
  const age = daysBetween(date, today);
  if (age < 1 || age > lookback) return false;
  const start = lessonStartMs(date, time);
  if (Number.isNaN(start)) return false;
  return now >= start + durationMin * 60 * 1000;
}

export function pickMembershipPitches({ payments, memberEmails, followups, today, now }) {
  const members = new Set([...memberEmails].map((e) => String(e || "").toLowerCase()));
  const seenEmail = new Set();
  const out = [];

  for (const pi of payments || []) {
    if (pi.status && pi.status !== "succeeded") continue;
    const meta = pi.metadata || {};
    if (String(meta.type || "") !== "single") continue;

    const email = String(meta.email || "").trim().toLowerCase();
    if (!email || members.has(email) || seenEmail.has(email)) continue;
    if (alreadySent(followups, KIND_PITCH, pi.id)) continue;
    if (recentlyPitched(followups, email, now)) continue;

    const sess = sessionFromMeta(meta);
    if (!sess || !isRecentlyComplete(sess.date, sess.time, { today, now, durationMin: 60 })) {
      continue;
    }

    seenEmail.add(email);
    out.push({
      kind: KIND_PITCH,
      id: pi.id,
      email,
      player: meta.player || "",
      parent: meta.parent || "",
      phone: meta.phone || "",
      date: sess.date,
      time: sess.time,
    });
  }
  return out;
}

export function pickBookAgainNudges({ members, followups, today, now }) {
  const out = [];
  const emailed = new Set();

  for (const m of members || []) {
    const email = String(m.email || "").trim().toLowerCase();
    if (!email || emailed.has(email)) continue;
    if (m.expired || Number(m.remaining) <= 0) continue;

    const scheduled = Array.isArray(m.scheduled) ? m.scheduled : [];
    if (scheduled.some((l) => l.date >= today)) continue;

    const pending = scheduled
      .filter((l) => isRecentlyComplete(l.date, l.time, { today, now }))
      .filter((l) => l.id && !alreadySent(followups, KIND_BOOK_AGAIN, l.id))
      .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));

    if (!pending.length) continue;

    emailed.add(email);
    const lesson = pending[0];
    out.push({
      kind: KIND_BOOK_AGAIN,
      id: lesson.id,
      alsoMark: pending.map((l) => l.id),
      email,
      player: m.player || "",
      parent: m.parent || "",
      phone: m.phone || "",
      remaining: m.remaining,
      lastDayPretty: m.lastDayPretty || "",
      date: lesson.date,
      time: lesson.time,
    });
  }
  return out;
}

function shell(heading, lines, cta, link) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#050505;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:28px 12px;">
<tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#111114;border:1px solid #26262b;border-radius:16px;padding:32px;font-family:Helvetica,Arial,sans-serif;">
    <tr><td>
      <div style="font-size:26px;font-weight:bold;color:#ffffff;letter-spacing:1px;">AP ACADEMY</div>
      <div style="font-size:11px;color:#a8adb6;letter-spacing:3px;text-transform:uppercase;">Ace Performance</div>
    </td></tr>
    <tr><td style="padding-top:22px;">
      <div style="font-size:21px;color:#ffffff;font-weight:bold;">${heading}</div>
      ${lines
        .map(
          (l) =>
            `<p style="color:#a8adb6;font-size:15px;line-height:1.6;margin:10px 0 0;">${l}</p>`
        )
        .join("")}
    </td></tr>
    <tr><td style="padding-top:22px;">
      <a href="${link}" style="display:inline-block;background:#cfd4da;color:#06121c;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 22px;border-radius:99px;">${cta}</a>
    </td></tr>
    <tr><td style="padding-top:26px;border-top:1px solid #26262b;">
      <p style="color:#a8adb6;font-size:14px;line-height:1.8;margin:16px 0 0;">
        Questions? Call or text ${PHONE}.<br />
        <strong style="color:#ffffff;font-size:16px;">${COACH}</strong><br />
        <span style="color:#a8adb6;">AP Academy</span>
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

export function membershipPitchMail(item, origin) {
  const who = item.player || "your player";
  const hi = item.parent ? `Hi ${item.parent} — ` : "";
  const when = item.date ? prettyDate(item.date) : "the other day";
  const link = `${origin}/book.html?type=membership`;
  return {
    subject: `Keep the work going — 4 lessons for $240`,
    html: shell(
      `Want the same time next week?`,
      [
        `${hi}hope ${who}'s lesson on <strong style="color:#ffffff;">${when}</strong> went well.`,
        `If you want to keep this going you've got two ways: book another single for $70, or start a month.`,
        `<strong style="color:#ffffff;">Four singles are $280. A month of four hour lessons is $240</strong> — so you save $40, and nothing auto-renews. You pay once and you're done.`,
      ],
      "Start a month",
      link
    ),
    text:
      `${hi}hope ${who}'s AP Academy lesson on ${when} went well.\n\n` +
      `If you want to keep this going you've got two ways: book another single for $70, or start a month.\n\n` +
      `Four singles are $280. A month of four hour lessons is $240 — so you save $40, and nothing auto-renews. You pay once and you're done.\n\n` +
      `Start a month: ${link}\n\n` +
      `Questions? Call or text ${PHONE}.\n${COACH}, AP Academy`,
  };
}

export function bookAgainMail(item, origin) {
  const who = item.player || "your player";
  const hi = item.parent ? `Hi ${item.parent} — ` : "";
  const n = Number(item.remaining) || 0;
  const lessons = `${n} lesson${n === 1 ? "" : "s"}`;
  const token = signMemberToken(item.email);
  const link = `${origin}/account.html?k=${encodeURIComponent(token)}`;
  const until = item.lastDayPretty
    ? ` These have to be used by ${item.lastDayPretty}. Unused lessons don't roll over.`
    : " Unused lessons don't roll over.";
  return {
    subject: `${who} has ${lessons} left — book the next one`,
    html: shell(
      `${who} still has ${lessons} to use`,
      [
        `${hi}${who}'s lesson is done. You've still got <strong style="color:#ffffff;">${lessons}</strong> on this membership.`,
        `Grab the next day when you know your week.${until}`,
      ],
      "Book my next lesson",
      link
    ),
    text:
      `${hi}${who}'s AP Academy lesson is done. You've still got ${lessons} on this membership.\n\n` +
      `Grab the next day when you know your week.${until}\n\n` +
      `Book here: ${link}\n\n` +
      `Questions? Call or text ${PHONE}.\n${COACH}, AP Academy`,
  };
}
