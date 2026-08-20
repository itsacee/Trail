import { findMembership } from "../lib/members.js";
import { signMemberToken } from "../lib/memberAuth.js";

const REPLY_TO = "Apacademybsb@gmail.com";

function originFrom(req) {
  const host = req.headers?.host || "www.apacademybsb.com";
  return `https://${host}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();
  const okMsg = "If that email has a membership, we sent a sign-in link. Check your inbox.";

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Enter the email you used when you signed up." });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if (!key) {
    res.status(500).json({ error: "Online membership isn't connected yet. Call or text (405) 819-4401." });
    return;
  }

  const sub = await findMembership(key, email);
  if (!sub) {
    res.status(200).json({ sent: true, message: okMsg });
    return;
  }

  const token = signMemberToken(email);
  const link = `${originFrom(req)}/account.html?k=${encodeURIComponent(token)}`;
  const player = sub.metadata?.player || "your player";

  if (!resendKey) {
    res.status(200).json({ sent: false, message: "Email isn't connected yet. Call or text (405) 819-4401 and we'll get you in." });
    return;
  }

  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  const mail = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      bcc: [REPLY_TO],
      reply_to: REPLY_TO,
      subject: "Your AP Academy member sign-in",
      text:
        `Sign in to pick ${player}'s next lesson:\n\n${link}\n\n` +
        `This link works for 30 days. One lesson a week, 4 per month.\n\n` +
        `Questions? Call or text (405) 819-4401.`,
      html: `<p>Sign in to pick ${player}'s next lesson:</p>
        <p><a href="${link}" style="display:inline-block;background:#cfd4da;color:#06121c;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:99px;">Open my membership</a></p>
        <p style="color:#555;font-size:13px;">This link works for 30 days. One lesson a week, 4 per month.</p>
        <p>Questions? Call or text (405) 819-4401.</p>`,
    }),
  });

  if (!mail.ok) {
    res.status(200).json({ sent: false, message: "Couldn't send the email. Call or text (405) 819-4401." });
    return;
  }

  res.status(200).json({ sent: true, message: okMsg });
}
