// The one place a "your lesson moved" email gets written, so a move made from
// Coach Desk reads the same as one a parent makes from the member portal.

import { LOCATIONS } from "./schedule.js";
import { lessonInvite } from "./ics.js";
import { prettyDate } from "./members.js";

const REPLY_TO = "Apacademybsb@gmail.com";
const PHONE = "(405) 819-4401";

export async function sendMail({ to, subject, text, attachments = [] }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey || !to) return false;
  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        bcc: [REPLY_TO],
        reply_to: REPLY_TO,
        subject,
        text,
        ...(attachments.length ? { attachments } : {}),
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export function whenText(lesson) {
  return `${prettyDate(lesson.date)} at ${lesson.time}`;
}

// `movedBy` is "coach" or "parent"; the note explains who changed it so nobody
// thinks their lesson moved on its own.
export async function sendLessonMovedEmail({ to, oldLesson, newLesson, movedBy = "coach", extraLine = "" }) {
  if (!to) return false;
  const loc = LOCATIONS.mustang || {};
  const invite = lessonInvite(newLesson);
  const who = newLesson.player2
    ? `${newLesson.player} & ${newLesson.player2}`
    : newLesson.player || "Your";
  const opener =
    movedBy === "coach"
      ? `I had to move ${who}'s lesson — here's the new time.`
      : `${who}'s lesson has been moved.`;
  return sendMail({
    to,
    subject: `Lesson moved — now ${whenText(newLesson)}`,
    text:
      `${opener}\n\n` +
      `WAS: ${whenText(oldLesson)}\n` +
      `NOW: ${whenText(newLesson)}\n\n` +
      (loc.address ? `WHERE\n${loc.name}\n${loc.address}\n${loc.note || ""}\n\n` : "") +
      (extraLine ? `${extraLine}\n\n` : "") +
      `The updated lesson is attached — tap it to fix your calendar.\n` +
      `Need a different time? Call or text ${PHONE}.`,
    attachments: invite ? [invite] : [],
  });
}
