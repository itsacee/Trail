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

const ADDRESS = "3701 S Bryant Ave, Del City, OK 73115";
const MAP_URL = "https://maps.google.com/?q=3701+S+Bryant+Ave,+Del+City,+OK+73115";
const PHONE = "(405) 819-4401";
const REPLY_TO = "Apacademybsb@gmail.com";

const TYPE_NAMES = {
  single: "Private Lesson (1 hour)",
  group: "Group Session (2 players, 30 minutes each)",
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
    if (meta[`date${i}`] && meta[`time${i}`]) out.push({ date: meta[`date${i}`], time: meta[`time${i}`] });
  }
  if (!out.length && meta.date && meta.time) out.push({ date: meta.date, time: meta.time });
  return out;
}

function emailHtml(meta, sessions) {
  const rows = sessions
    .map(
      (s) => `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #26262b;color:#f5f6f8;font-size:15px;">
          <strong>${prettyDate(s.date)}</strong>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #26262b;color:#8fd6ff;font-size:15px;text-align:right;font-weight:bold;">
          ${s.time}
        </td>
      </tr>`
    )
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
      <div style="font-size:21px;color:#ffffff;font-weight:bold;">You're booked!</div>
      <p style="color:#a8adb6;font-size:15px;line-height:1.6;margin:10px 0 0;">
        Thanks${meta.parent ? ` ${meta.parent}` : ""} — ${meta.player}'s ${plural} confirmed.
        Here's everything you need.
      </p>
    </td></tr>

    <tr><td style="padding-top:24px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:6px;">
        ${sessions.length > 1 ? "Your Lessons" : "Your Lesson"}
      </div>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      <p style="color:#a8adb6;font-size:14px;margin:12px 0 0;">${TYPE_NAMES[meta.type] || ""}</p>
    </td></tr>

    <tr><td style="padding-top:26px;">
      <div style="background:#050505;border:2px solid #8fd6ff;border-radius:12px;padding:20px;">
        <div style="font-size:11px;color:#8fd6ff;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">
          Training Location
        </div>
        <div style="font-size:17px;color:#ffffff;font-weight:bold;padding-top:8px;line-height:1.5;">
          ${ADDRESS}
        </div>
        <a href="${MAP_URL}" style="display:inline-block;margin-top:14px;background:#8fd6ff;color:#06121c;
           text-decoration:none;font-weight:bold;font-size:14px;padding:11px 22px;border-radius:99px;">
          Get Directions
        </a>
      </div>
    </td></tr>

    <tr><td style="padding-top:26px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:8px;">
        What to Bring
      </div>
      <p style="color:#f5f6f8;font-size:15px;margin:0;">Bat, glove, turfs, and a water bottle.</p>
    </td></tr>

    <tr><td style="padding-top:22px;">
      <p style="color:#a8adb6;font-size:13px;line-height:1.7;margin:0;">
        Need to cancel or reschedule? Please give at least 12 hours notice — later than that
        is subject to a cancellation fee. Call or text <strong style="color:#f5f6f8;">${PHONE}</strong>.
      </p>
    </td></tr>

    <tr><td style="padding-top:26px;border-top:1px solid #26262b;">
      <p style="color:#a8adb6;font-size:13px;line-height:1.7;margin:14px 0 0;">
        See you at training,<br />
        <strong style="color:#f5f6f8;">Coach Elijah Alexander</strong><br />
        AP Academy · ${PHONE}<br />
        <a href="https://www.apacademybsb.com" style="color:#8fd6ff;text-decoration:none;">apacademybsb.com</a>
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

function emailText(meta, sessions) {
  const lines = sessions.map((s) => `  ${prettyDate(s.date)} at ${s.time}`).join("\n");
  return `AP ACADEMY — You're booked!

Thanks${meta.parent ? ` ${meta.parent}` : ""} — ${meta.player}'s lesson is confirmed.

${TYPE_NAMES[meta.type] || ""}
${lines}

TRAINING LOCATION
${ADDRESS}
Directions: ${MAP_URL}

WHAT TO BRING
Bat, glove, turfs, and a water bottle.

Need to cancel or reschedule? Please give at least 12 hours notice —
later than that is subject to a cancellation fee. Call or text ${PHONE}.

See you at training,
Coach Elijah Alexander
AP Academy · ${PHONE}
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
    const summary = { player: meta.player || "", sessions, email: to, address: ADDRESS, mapUrl: MAP_URL };

    // 2. Don't send twice if they refresh the success page
    const target = session.subscription
      ? { path: `subscriptions/${session.subscription}`, id: session.subscription }
      : session.payment_intent
      ? { path: `payment_intents/${session.payment_intent}`, id: session.payment_intent }
      : null;

    if (target) {
      const tRes = await stripe(target.path);
      if (tRes.ok) {
        const obj = await tRes.json();
        if (obj.metadata?.confirmation_sent === "1") {
          res.status(200).json({ sent: true, alreadySent: true, ...summary });
          return;
        }
      }
    }

    if (!resendKey || !to || !sessions.length) {
      res.status(200).json({ sent: false, ...summary });
      return;
    }

    // 3. Send it
    const mail = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        bcc: [REPLY_TO],
        reply_to: REPLY_TO,
        subject: `You're booked — ${prettyDate(sessions[0].date)} at ${sessions[0].time} | AP Academy`,
        html: emailHtml(meta, sessions),
        text: emailText(meta, sessions),
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
