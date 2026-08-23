// Sends the booking confirmation email (with the training address) after a
// payment succeeds. Called from the success page with the Checkout session id.
//
// The payment is verified with Stripe before anything is sent, and the booking
// is flagged once emailed so refreshing the page can't send duplicates.
//
// Requires in Vercel:
//   STRIPE_SECRET_KEY  — already set
//   RESEND_API_KEY     — from resend.com (free tier covers this easily)
//   FROM_EMAIL         — optional, defaults to bookings@apacademybsb.com

import { LOCATIONS, locationKeyFor, LOCATION_KEY } from "../lib/schedule.js";
import { signMemberToken } from "../lib/memberAuth.js";
import { MEMBER_CREDITS, MEMBER_PERIOD_DAYS, lastUsableDate } from "../lib/members.js";

const COACH = "Elijah Alexander";
const PHONE = "(405) 819-4401";
const PHONE_TEL = "+14058194401";
// Replies land in Elijah's Gmail, and he gets a copy of every confirmation
const REPLY_TO = "Apacademybsb@gmail.com";

const TYPE_NAMES = {
  single: "Private Lesson (1 hour)",
  thirty: "30-Minute Lesson",
  membership: "Membership — 4 lessons per month",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function prettyDate(iso) {
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d)) return iso;
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function sessionsFrom(meta) {
  const out = [];
  for (let i = 1; i <= 4; i++) {
    if (meta[`date${i}`] && meta[`time${i}`]) {
      out.push({
        date: meta[`date${i}`],
        time: meta[`time${i}`],
        loc: meta[`loc${i}`] || locationKeyFor(meta[`date${i}`]),
      });
    }
  }
  if (!out.length && meta.date && meta.time) {
    out.push({ date: meta.date, time: meta.time, loc: meta.loc || locationKeyFor(meta.date) });
  }
  return out;
}

function mapUrl(address) {
  return `https://maps.google.com/?q=${encodeURIComponent(address)}`;
}

// The distinct places this booking sends them to
function placesFor(sessions) {
  const keys = [...new Set(sessions.map((s) => s.loc).filter(Boolean))];
  return keys.map((k) => ({ key: k, ...(LOCATIONS[k] || {}) })).filter((p) => p.name);
}

function emailHtml(meta, sessions) {
  const places = placesFor(sessions);
  const showPlace = places.length > 1;

  const rows = sessions
    .map(
      (s) => `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #26262b;color:#f5f6f8;font-size:15px;">
          <strong>${prettyDate(s.date)}</strong>${
        showPlace ? `<br /><span style="color:#a8adb6;font-size:13px;">${LOCATIONS[s.loc]?.name || ""}</span>` : ""
      }
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #26262b;color:#cfd4da;font-size:15px;text-align:right;font-weight:bold;">
          ${s.time}
        </td>
      </tr>`
    )
    .join("");

  const placeBlocks = places
    .map((p) => {
      const hasAddress = Boolean(p.address);
      return `<div style="background:#050505;border:2px solid #cfd4da;border-radius:12px;padding:20px;margin-top:12px;">
        <div style="font-size:11px;color:#cfd4da;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">
          ${places.length > 1 ? `${p.name} Lessons` : "Where to Go"}
        </div>
        <div style="font-size:17px;color:#ffffff;font-weight:bold;padding-top:8px;line-height:1.5;">
          ${hasAddress ? p.address : p.name}
        </div>
        <p style="color:#a8adb6;font-size:13px;line-height:1.6;margin:8px 0 0;">
          ${
            hasAddress
              ? p.note || "Plan to arrive about 5 minutes early."
              : `I'll text you the exact address and directions before your first session — or call me at ${PHONE} anytime.`
          }
        </p>
        ${
          hasAddress
            ? `<a href="${mapUrl(p.address)}" style="display:inline-block;margin-top:14px;background:#cfd4da;color:#06121c;
               text-decoration:none;font-weight:bold;font-size:14px;padding:11px 22px;border-radius:99px;">Get Directions</a>`
            : ""
        }
      </div>`;
    })
    .join("");

  const plural = sessions.length > 1 ? "lessons are" : "lesson is";

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#050505;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:28px 12px;">
<tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#111114;border:1px solid #26262b;border-radius:16px;padding:32px;font-family:Helvetica,Arial,sans-serif;">
    <tr><td style="padding-bottom:8px;">
      <div style="font-size:26px;font-weight:bold;color:#ffffff;letter-spacing:1px;">AP ACADEMY</div>
      <div style="font-size:11px;color:#a8adb6;letter-spacing:3px;text-transform:uppercase;">Ace Performance</div>
    </td></tr>

    <tr><td style="padding-top:22px;">
      <div style="font-size:21px;color:#ffffff;font-weight:bold;">Thank you for choosing AP Academy!</div>
      <p style="color:#a8adb6;font-size:15px;line-height:1.6;margin:10px 0 0;">
        ${meta.parent ? `Hi ${meta.parent} — t` : "T"}hanks for booking with us. ${meta.player}'s ${plural}
        confirmed, and I'm looking forward to getting to work. Here's everything you need to know.
      </p>
    </td></tr>

    <tr><td style="padding-top:24px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:6px;">
        ${sessions.length > 1 ? "Your Lessons" : "Your Lesson"}
      </div>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      <p style="color:#a8adb6;font-size:14px;margin:12px 0 0;">${TYPE_NAMES[meta.type] || ""}</p>
    </td></tr>

    <tr><td style="padding-top:22px;">
      ${placeBlocks}
    </td></tr>

    <tr><td style="padding-top:26px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:8px;">
        What to Bring
      </div>
      <p style="color:#f5f6f8;font-size:15px;margin:0;">Bat, glove, turfs, and a water bottle.</p>
    </td></tr>

    <tr><td style="padding-top:26px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:8px;">
        Questions?
      </div>
      <p style="color:#f5f6f8;font-size:15px;line-height:1.7;margin:0;">
        Just hit reply to this email and it comes straight to me — or call or text
        <a href="tel:${PHONE_TEL}" style="color:#cfd4da;text-decoration:none;font-weight:bold;">${PHONE}</a>.
        Happy to answer anything before the first session.
      </p>
      <p style="color:#a8adb6;font-size:13px;line-height:1.7;margin:12px 0 0;">
        Need to cancel or reschedule? Please give at least 12 hours notice — later than that
        is subject to a cancellation fee.
      </p>
    </td></tr>

    <tr><td style="padding-top:26px;border-top:1px solid #26262b;">
      <p style="color:#a8adb6;font-size:14px;line-height:1.8;margin:16px 0 0;">
        See you at training,<br />
        <strong style="color:#ffffff;font-size:16px;">${COACH}</strong><br />
        <span style="color:#a8adb6;">Founder &amp; Head Trainer, AP Academy</span><br />
        <a href="tel:${PHONE_TEL}" style="color:#cfd4da;text-decoration:none;">${PHONE}</a><br />
        <a href="mailto:${REPLY_TO}" style="color:#cfd4da;text-decoration:none;">${REPLY_TO}</a><br />
        <a href="https://www.apacademybsb.com" style="color:#cfd4da;text-decoration:none;">apacademybsb.com</a>
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

function emailText(meta, sessions) {
  const places = placesFor(sessions);
  const showPlace = places.length > 1;
  const lines = sessions
    .map(
      (s) =>
        `  ${prettyDate(s.date)} at ${s.time}${showPlace ? ` (${LOCATIONS[s.loc]?.name || ""})` : ""}`
    )
    .join("\n");
  const where = places
    .map((p) =>
      p.address
        ? `${places.length > 1 ? p.name + ": " : ""}${p.address}\n${
            p.note ? p.note + "\n" : ""
          }Directions: ${mapUrl(p.address)}`
        : `${p.name} — I'll text you the exact address before your first session, or call ${PHONE}.`
    )
    .join("\n\n");
  return `AP ACADEMY — Thank you for choosing us!

${meta.parent ? `Hi ${meta.parent} — t` : "T"}hanks for booking with us. ${meta.player}'s ${
    sessions.length > 1 ? "lessons are" : "lesson is"
  } confirmed,
and I'm looking forward to getting to work.

${sessions.length > 1 ? "YOUR LESSONS" : "YOUR LESSON"}
${TYPE_NAMES[meta.type] || ""}
${lines}

WHERE TO GO
${where}

WHAT TO BRING
Bat, glove, turfs, and a water bottle.

QUESTIONS?
Just reply to this email and it comes straight to me — or call or text ${PHONE}.
Happy to answer anything before the first session.

Need to cancel or reschedule? Please give at least 12 hours notice —
later than that is subject to a cancellation fee.

See you at training,
${COACH}
Founder & Head Trainer, AP Academy
${PHONE}
${REPLY_TO}
apacademybsb.com`;
}

// The membership welcome. This is the one email that has to carry everything:
// thank you, the first lesson, where to go, how the 4-lesson month works, when
// the credits die, and — loudly — that nothing auto-renews.
function memberFacts(meta, sessions, startedAt) {
  const first = sessions[0] || null;
  const place = LOCATIONS[(first && first.loc) || LOCATION_KEY] || LOCATIONS[LOCATION_KEY];
  const periodEnd = (startedAt || Math.floor(Date.now() / 1000)) + MEMBER_PERIOD_DAYS * 86400;
  return {
    first,
    place,
    lastDayPretty: prettyDate(lastUsableDate(periodEnd)),
    left: Math.max(0, MEMBER_CREDITS - sessions.length),
    who: meta.player || "Your player",
  };
}

function memberEmailHtml(meta, origin, sessions, startedAt) {
  const f = memberFacts(meta, sessions, startedAt);
  const link = `${origin}/account.html`;
  const p = f.place || {};
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
      <div style="font-size:21px;color:#ffffff;font-weight:bold;">Thank you for joining AP Academy!</div>
      <p style="color:#a8adb6;font-size:15px;line-height:1.6;margin:10px 0 0;">
        ${meta.parent ? `Hi ${meta.parent} — ` : ""}${f.who}'s membership is active: <strong style="color:#ffffff;">${MEMBER_CREDITS} one-hour lessons</strong>
        to use over the next 4 weeks. I'm looking forward to getting to work.
      </p>
    </td></tr>

    ${
      f.first
        ? `<tr><td style="padding-top:24px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:6px;">Your First Lesson</div>
      <div style="background:#050505;border:1px solid #26262b;border-radius:12px;padding:16px 18px;">
        <div style="font-size:17px;color:#ffffff;font-weight:bold;">${prettyDate(f.first.date)} at ${f.first.time}</div>
        <div style="color:#a8adb6;font-size:13px;padding-top:4px;">Lesson 1 of ${MEMBER_CREDITS} · ${f.left} left to book</div>
      </div>
    </td></tr>`
        : ""
    }

    <tr><td style="padding-top:22px;">
      <div style="background:#050505;border:2px solid #cfd4da;border-radius:12px;padding:20px;">
        <div style="font-size:11px;color:#cfd4da;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">Where to Go</div>
        <div style="font-size:17px;color:#ffffff;font-weight:bold;padding-top:8px;line-height:1.5;">
          ${p.name || "Mustang High School"}${p.address ? `<br />${p.address}` : ""}
        </div>
        <p style="color:#a8adb6;font-size:13px;line-height:1.6;margin:8px 0 0;">
          ${p.note || "Plan to arrive about 5 minutes early."}
        </p>
        ${
          p.address
            ? `<a href="${mapUrl(p.address)}" style="display:inline-block;margin-top:14px;background:#cfd4da;color:#06121c;
               text-decoration:none;font-weight:bold;font-size:14px;padding:11px 22px;border-radius:99px;">Get Directions</a>`
            : ""
        }
      </div>
    </td></tr>

    <tr><td style="padding-top:26px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:8px;">
        How Your Membership Works
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="color:#f5f6f8;font-size:15px;line-height:1.6;">
        <tr><td style="padding:0 0 12px;">
          <strong style="color:#ffffff;">You get ${MEMBER_CREDITS} lessons — pick any ${MEMBER_CREDITS} days you want.</strong><br />
          <span style="color:#a8adb6;">No set weekly time. Book the days that actually work for you.</span>
        </td></tr>
        <tr><td style="padding:0 0 12px;">
          <strong style="color:#ffffff;">You don't have to book them all now.</strong><br />
          <span style="color:#a8adb6;">Your first one is set. Come back and book the other ${f.left} one at a time, whenever you know your schedule.</span>
        </td></tr>
        <tr><td style="padding:0 0 12px;">
          <strong style="color:#ffffff;">To book the rest, sign in with this email.</strong><br />
          <span style="color:#a8adb6;">Go to the Members page and enter this same email address. It'll show you how many lessons you have left and the exact date they expire.</span>
        </td></tr>
        <tr><td style="padding:0 0 12px;">
          <strong style="color:#ffffff;">Use them by ${f.lastDayPretty}.</strong><br />
          <span style="color:#a8adb6;">That's when this membership ends. Unused lessons don't roll over.</span>
        </td></tr>
      </table>
    </td></tr>

    <tr><td style="padding-top:8px;">
      <a href="${link}" style="display:inline-block;background:#cfd4da;color:#06121c;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 22px;border-radius:99px;">Book my next lesson</a>
    </td></tr>

    <tr><td style="padding-top:26px;">
      <div style="background:#1a1206;border:1px solid #6b4d16;border-radius:12px;padding:18px;">
        <div style="font-size:11px;color:#e0b457;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">Heads Up — This Does Not Auto-Renew</div>
        <p style="color:#f5f6f8;font-size:15px;line-height:1.6;margin:8px 0 0;">
          You will <strong>not</strong> be charged again. Nothing renews on its own, and there's no subscription to cancel.
          When your ${MEMBER_CREDITS} lessons are used up — or ${f.lastDayPretty} passes — the membership simply ends.
          If you want another month, just buy membership again at
          <a href="${origin}/book.html?type=membership" style="color:#e0b457;text-decoration:none;font-weight:bold;">apacademybsb.com</a>.
        </p>
      </div>
    </td></tr>

    <tr><td style="padding-top:26px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:8px;">What to Bring</div>
      <p style="color:#f5f6f8;font-size:15px;margin:0;">Bat, glove, turfs, and a water bottle.</p>
    </td></tr>

    <tr><td style="padding-top:26px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:8px;">Questions?</div>
      <p style="color:#f5f6f8;font-size:15px;line-height:1.7;margin:0;">
        Just hit reply to this email and it comes straight to me — or call or text
        <a href="tel:${PHONE_TEL}" style="color:#cfd4da;text-decoration:none;font-weight:bold;">${PHONE}</a>.
      </p>
      <p style="color:#a8adb6;font-size:13px;line-height:1.7;margin:12px 0 0;">
        Need to cancel or move a lesson? Please give at least 12 hours notice — later than that
        is subject to a cancellation fee.
      </p>
    </td></tr>

    <tr><td style="padding-top:26px;border-top:1px solid #26262b;">
      <p style="color:#a8adb6;font-size:14px;line-height:1.8;margin:16px 0 0;">
        See you at training,<br />
        <strong style="color:#ffffff;font-size:16px;">${COACH}</strong><br />
        <span style="color:#a8adb6;">Founder &amp; Head Trainer, AP Academy</span><br />
        <a href="tel:${PHONE_TEL}" style="color:#cfd4da;text-decoration:none;">${PHONE}</a><br />
        <a href="mailto:${REPLY_TO}" style="color:#cfd4da;text-decoration:none;">${REPLY_TO}</a><br />
        <a href="https://www.apacademybsb.com" style="color:#cfd4da;text-decoration:none;">apacademybsb.com</a>
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

function memberEmailText(meta, origin, sessions, startedAt) {
  const f = memberFacts(meta, sessions, startedAt);
  const p = f.place || {};
  return `AP ACADEMY — Thank you for joining!

${meta.parent ? `Hi ${meta.parent} — ` : ""}${f.who}'s membership is active: ${MEMBER_CREDITS} one-hour lessons
to use over the next 4 weeks.
${
  f.first
    ? `
YOUR FIRST LESSON
${prettyDate(f.first.date)} at ${f.first.time}
Lesson 1 of ${MEMBER_CREDITS} · ${f.left} left to book
`
    : ""
}
WHERE TO GO
${p.name || "Mustang High School"}${p.address ? `\n${p.address}` : ""}
${p.note || "Plan to arrive about 5 minutes early."}${p.address ? `\nDirections: ${mapUrl(p.address)}` : ""}

HOW YOUR MEMBERSHIP WORKS
* You get ${MEMBER_CREDITS} lessons — pick any ${MEMBER_CREDITS} days you want. No set weekly time.
* You don't have to book them all now. Your first one is set; book the other
  ${f.left} one at a time, whenever you know your schedule.
* To book the rest, sign in with this email at ${origin}/account.html
  It shows how many lessons you have left and the exact date they expire.
* Use them by ${f.lastDayPretty}. Unused lessons don't roll over.

HEADS UP — THIS DOES NOT AUTO-RENEW
You will NOT be charged again. Nothing renews on its own and there's no
subscription to cancel. When your ${MEMBER_CREDITS} lessons are used up — or ${f.lastDayPretty}
passes — the membership simply ends. Want another month? Buy membership
again at ${origin}/book.html?type=membership

WHAT TO BRING
Bat, glove, turfs, and a water bottle.

QUESTIONS?
Reply to this email or call/text ${PHONE}.
Need to cancel or move a lesson? Please give at least 12 hours notice.

See you at training,
${COACH}
Founder & Head Trainer, AP Academy
${PHONE}
${REPLY_TO}
apacademybsb.com`;
}

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  const id = String(req.query?.session_id || "");

  if (!key || !/^cs_[A-Za-z0-9_]+$/.test(id)) {
    res.status(400).json({ sent: false, error: "Invalid request." });
    return;
  }

  const stripe = (path, opts = {}) =>
    fetch(`https://api.stripe.com/v1/${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${key}`, ...(opts.headers || {}) },
    });

  try {
    // 1. Verify the payment actually went through
    const sRes = await stripe(`checkout/sessions/${id}`);
    if (!sRes.ok) {
      res.status(404).json({ sent: false, error: "Booking not found." });
      return;
    }
    const session = await sRes.json();
    if (session.payment_status !== "paid") {
      res.status(402).json({ sent: false, error: "Payment not completed." });
      return;
    }

    const meta = session.metadata || {};
    const sessions = sessionsFrom(meta);
    const to = session.customer_details?.email || meta.email || "";
    const places = placesFor(sessions).map((p) => ({
      name: p.name,
      address: p.address || "",
      mapUrl: p.address ? mapUrl(p.address) : "",
    }));
    const isMember = meta.type === "membership" || Boolean(session.subscription);
    const memberToken = isMember && to ? signMemberToken(to) : "";
    const origin = `https://${req.headers.host || "www.apacademybsb.com"}`;
    const summary = { player: meta.player || "", sessions, email: to, places, member: isMember, memberToken };

    // 2. Don't send twice if they refresh the success page
    const target = session.subscription
      ? { path: `subscriptions/${session.subscription}`, id: session.subscription }
      : session.payment_intent
      ? { path: `payment_intents/${session.payment_intent}`, id: session.payment_intent }
      : null;

    // When the membership month started — the clock the 4 lessons run on.
    let startedAt = session.created || Math.floor(Date.now() / 1000);

    if (target) {
      const tRes = await stripe(target.path);
      if (tRes.ok) {
        const obj = await tRes.json();
        if (obj.created) startedAt = obj.created;
        if (obj.metadata?.confirmation_sent === "1") {
          res.status(200).json({ sent: true, alreadySent: true, ...summary });
          return;
        }
      }
    }

    const canEmail = Boolean(resendKey && to && (sessions.length || isMember));
    if (!canEmail) {
      res.status(200).json({ sent: false, ...summary });
      return;
    }

    // 3. Send it
    // Members always get the membership welcome — it's the one that explains
    // the 4 lessons, the expiry date and the no-auto-renew rule.
    const mailBody = isMember
      ? {
          subject: "Thank you for joining AP Academy — here's how your membership works",
          html: memberEmailHtml(meta, origin, sessions, startedAt),
          text: memberEmailText(meta, origin, sessions, startedAt),
        }
      : {
          subject: `Thank you for booking with AP Academy — ${prettyDate(sessions[0].date)} at ${sessions[0].time}`,
          html: emailHtml(meta, sessions),
          text: emailText(meta, sessions),
        };

    const mail = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        bcc: [REPLY_TO],
        reply_to: REPLY_TO,
        ...mailBody,
      }),
    });

    if (!mail.ok) {
      const err = await mail.json().catch(() => ({}));
      res.status(200).json({ sent: false, error: err.message || "Email failed to send.", ...summary });
      return;
    }

    // 4. Flag it so refreshes don't re-send
    if (target) {
      await stripe(target.path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ "metadata[confirmation_sent]": "1" }),
      });
    }

    res.status(200).json({ sent: true, ...summary });
  } catch {
    res.status(200).json({ sent: false, error: "Could not send the confirmation email." });
  }
}
