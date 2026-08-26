// 3-days-a-week intensive application. No payment — answers go to Elijah.
import { parseApply, coachMail, parentMail } from "../lib/apply.js";

const COACH = "Apacademybsb@gmail.com";
const PHONE = "(405) 819-4401";

async function sendEmail(resendKey, payload) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    console.error("Resend rejected apply email:", r.status, err);
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const parsed = parseApply(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (parsed.spam) {
    res.status(200).json({ sent: true });
    return;
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    res.status(503).json({
      error: `The form isn't sending right now. Text ${PHONE} and I'll take it from there.`,
    });
    return;
  }

  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  const coach = coachMail(parsed.data);
  const parent = parentMail(parsed.data);

  const toCoach = await sendEmail(resendKey, {
    from,
    to: [COACH],
    reply_to: parsed.data.email,
    subject: coach.subject,
    text: coach.text,
    html: coach.html,
  });

  if (!toCoach) {
    res.status(500).json({
      error: `Couldn't send the application. Text ${PHONE} and I'll take it from there.`,
    });
    return;
  }

  // Nice-to-have for the parent. Ace already has the application if this fails.
  await sendEmail(resendKey, {
    from,
    to: [parsed.data.email],
    bcc: [COACH],
    reply_to: COACH,
    subject: parent.subject,
    text: parent.text,
    html: parent.html,
  });

  res.status(200).json({
    sent: true,
    message: "Got it. Elijah will review this and reach out if it's a fit.",
  });
}
