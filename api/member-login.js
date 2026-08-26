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

  // If email isn't wired up we can't send anything — say so plainly instead of
  // telling them to watch an inbox nothing will ever arrive in. Answered before
  // the membership lookup so it reads the same either way and doesn't reveal
  // whether an address has a membership.
  if (!resendKey) {
    res.status(200).json({
      sent: false,
      message:
        "Sign-in links are down right now. Text (405) 819-4401 and I'll send your booking link straight over.",
    });
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
        `Sign in to book ${player}'s next lesson:\n\n${link}\n\n` +
        `This link works for 30 days. Your membership page shows how many lessons\n` +
        `you have left and the date they expire.\n\n` +
        `Questions? Call or text (405) 819-4401.`,
      html: `<p>Sign in to book ${player}'s next lesson:</p>
        <p><a href="${link}" style="display:inline-block;background:#cfd4da;color:#06121c;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:99px;">Open my membership</a></p>
        <p style="color:#555;font-size:13px;">This link works for 30 days. Your membership page shows how many lessons you have left and the date they expire.</p>
        <p>Questions? Call or text (405) 819-4401.</p>`,
    }),
  });

  if (!mail.ok) {
    // Keep the provider's reason — "domain not verified", a bad from-address —
    // out of the member's way but visible to us. The page only renders
    // `message`; without this a send failure is impossible to diagnose.
    const err = await mail.json().catch(() => ({}));
    console.error("Resend rejected the sign-in email:", mail.status, err);
    res.status(200).json({
      sent: false,
      message: "Couldn't send the email. Call or text (405) 819-4401.",
      error: err.message || err.name || `Resend returned ${mail.status}`,
    });
    return;
  }

  res.status(200).json({ sent: true, message: okMsg });
}
