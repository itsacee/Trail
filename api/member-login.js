import { findMembership } from "../lib/members.js";
import {
  signMemberToken,
  memberSessionCookie,
  clearMemberSessionCookie,
} from "../lib/memberAuth.js";
import { issueMemberOtp, verifyMemberOtp } from "../lib/memberOtp.js";

const REPLY_TO = "Apacademybsb@gmail.com";
const GENERIC_SENT =
  "If that email has a membership, we sent a sign-in code. Check your inbox.";
const GENERIC_LINK =
  "If that email has a membership, we sent a sign-in link. Check your inbox.";
const GENERIC_BAD_CODE = "That code didn't work. Try again or request a new one.";

function originFrom(req) {
  const host = req.headers?.host || "www.apacademybsb.com";
  return `https://${host}`;
}

async function sendResend({ to, subject, text, html }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return { ok: false, missing: true };
  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  const mail = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      bcc: [REPLY_TO],
      reply_to: REPLY_TO,
      subject,
      text,
      html,
    }),
  });
  if (!mail.ok) {
    const err = await mail.json().catch(() => ({}));
    console.error("Resend rejected member login email:", mail.status, err);
    return { ok: false, error: err.message || `Resend ${mail.status}` };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method === "DELETE" || (req.method === "POST" && req.body?.action === "logout")) {
    res.setHeader("Set-Cookie", clearMemberSessionCookie());
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();
  const action = String(req.body?.action || req.body?.mode || "otp").toLowerCase();

  if (action === "logout") {
    res.setHeader("Set-Cookie", clearMemberSessionCookie());
    res.status(200).json({ ok: true });
    return;
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Enter the email you used when you signed up." });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY || "";

  // ---------- Verify OTP ----------
  if (action === "verify" || action === "verify_otp") {
    const code = String(req.body?.code || "");
    const verified = await verifyMemberOtp(email, code);
    if (!verified.ok) {
      const msg =
        verified.error === "expired"
          ? "That code expired. Request a new one."
          : verified.error === "locked"
            ? "Too many tries. Request a new code in a minute."
            : GENERIC_BAD_CODE;
      res.status(400).json({ error: msg, code: verified.error });
      return;
    }
    // Only issue a session if the email still has a membership (anti-enumeration on verify is less critical once they have a valid code for that email).
    const sub = await findMembership(key, email);
    if (!sub) {
      res.status(400).json({ error: GENERIC_BAD_CODE, code: "invalid" });
      return;
    }
    const token = signMemberToken(email);
    res.setHeader("Set-Cookie", memberSessionCookie(token));
    res.status(200).json({
      ok: true,
      token,
      redirect: `/account.html`,
      player: sub.metadata?.player || "",
    });
    return;
  }

  // ---------- Issue OTP (default) ----------
  if (action === "otp" || action === "send_otp" || action === "code") {
    if (!process.env.RESEND_API_KEY) {
      res.status(200).json({
        sent: false,
        message:
          "Sign-in codes are down right now. Call (405) 819-4401 and I'll send your booking link straight over.",
      });
      return;
    }

    const sub = await findMembership(key, email);
    // Always look like a send succeeded to avoid email enumeration.
    if (!sub) {
      res.status(200).json({ sent: true, message: GENERIC_SENT, channel: "otp" });
      return;
    }

    const issued = await issueMemberOtp(email);
    if (!issued.ok) {
      if (issued.error === "cooldown" || issued.error === "rate_limited") {
        res.status(200).json({
          sent: true,
          message: GENERIC_SENT,
          channel: "otp",
          retryAfterSec: issued.retryAfterSec || 60,
        });
        return;
      }
      res.status(200).json({
        sent: false,
        message: "Couldn't send the code. Call or text (405) 819-4401.",
      });
      return;
    }

    const player = sub.metadata?.player || "your player";
    const mail = await sendResend({
      to: email,
      subject: "Your AP Academy sign-in code",
      text:
        `Your AP Academy sign-in code is ${issued.code}\n\n` +
        `It expires in 10 minutes. Enter it on the Members page to book ${player}'s next lesson.\n\n` +
        `If you didn't ask for this, you can ignore it.\n\n` +
        `Questions? Call or text (405) 819-4401.`,
      html: `<p style="font-family:system-ui,sans-serif;font-size:16px;color:#111">Your AP Academy sign-in code:</p>
        <p style="font-family:system-ui,sans-serif;font-size:32px;letter-spacing:0.35em;font-weight:700;color:#111">${issued.code}</p>
        <p style="font-family:system-ui,sans-serif;font-size:14px;color:#555">Expires in 10 minutes. Enter it on the Members page to book ${player}'s next lesson.</p>
        <p style="font-family:system-ui,sans-serif;font-size:13px;color:#777">Questions? Call or text (405) 819-4401.</p>`,
    });

    if (!mail.ok) {
      res.status(200).json({
        sent: false,
        message: "Couldn't send the code. Call or text (405) 819-4401.",
      });
      return;
    }

    res.status(200).json({ sent: true, message: GENERIC_SENT, channel: "otp" });
    return;
  }

  // ---------- Magic-link fallback (legacy) ----------
  if (!process.env.RESEND_API_KEY) {
    res.status(200).json({
      sent: false,
      message:
        "Sign-in links are down right now. Call (405) 819-4401 and I'll send your booking link straight over.",
    });
    return;
  }

  const sub = await findMembership(key, email);
  if (!sub) {
    res.status(200).json({ sent: true, message: GENERIC_LINK, channel: "magic" });
    return;
  }

  const token = signMemberToken(email);
  const link = `${originFrom(req)}/account.html?k=${encodeURIComponent(token)}`;
  const player = sub.metadata?.player || "your player";
  const mail = await sendResend({
    to: email,
    subject: "Your AP Academy member sign-in",
    text:
      `Sign in to book ${player}'s next lesson:\n\n${link}\n\n` +
      `This link works for 30 days. Your membership page shows how many lessons\n` +
      `you have left and the date they expire.\n\n` +
      `Questions? Call or text (405) 819-4401.`,
    html: `<p>Sign in to book ${player}'s next lesson:</p>
      <p><a href="${link}" style="display:inline-block;background:#c9a227;color:#0a0a0c;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:14px;">Open my membership</a></p>
      <p style="color:#555;font-size:13px;">This link works for 30 days.</p>
      <p>Questions? Call or text (405) 819-4401.</p>`,
  });

  if (!mail.ok) {
    res.status(200).json({
      sent: false,
      message: "Couldn't send the email. Call or text (405) 819-4401.",
    });
    return;
  }

  res.status(200).json({ sent: true, message: GENERIC_LINK, channel: "magic" });
}
