// College Track applications.
//
// No payment and no account — this only starts a conversation. The coach gets
// the details as an email he can reply to directly, and the applicant gets an
// acknowledgement so they aren't left wondering whether it sent.
//
// Deliberately does not touch Stripe: nothing is charged until the coach has
// spoken to them and agreed the three days.

const COACH = "Elijah Alexander";
const PHONE = "(405) 819-4401";
const REPLY_TO = "Apacademybsb@gmail.com";

const POSITIONS = ["Pitcher", "Catcher", "Infield", "Outfield", "Two-way", "Utility"];
const AGES = ["13 or under", "14", "15", "16", "17", "18", "19+"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const esc = (v) =>
  String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const clean = (v, max = 200) => String(v == null ? "" : v).trim().slice(0, max);

function coachEmail(a) {
  const row = (label, value) =>
    `<tr>
      <td style="padding:8px 12px 8px 0;color:#a8adb6;font-size:13px;white-space:nowrap;vertical-align:top;">${label}</td>
      <td style="padding:8px 0;color:#f5f6f8;font-size:15px;font-weight:600;">${value}</td>
    </tr>`;
  const tel = a.phone.replace(/[^\d+]/g, "");
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#050505;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:28px 12px;">
<tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#111114;border:1px solid #26262b;border-radius:16px;padding:28px;font-family:Helvetica,Arial,sans-serif;">
    <tr><td>
      <div style="font-size:11px;color:#e0b457;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">College Track application</div>
      <div style="font-size:24px;font-weight:bold;color:#ffffff;padding-top:6px;">${esc(a.player)}</div>
      <div style="color:#a8adb6;font-size:14px;">Age ${esc(a.age)} &middot; ${esc(a.position)} &middot; ${esc(a.team)}</div>
    </td></tr>

    <tr><td style="padding-top:22px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${row("Parent", esc(a.parent))}
        ${row("Phone", `<a href="tel:${esc(tel)}" style="color:#cfd4da;text-decoration:none;">${esc(a.phone)}</a>`)}
        ${row("Email", `<a href="mailto:${esc(a.email)}" style="color:#cfd4da;text-decoration:none;">${esc(a.email)}</a>`)}
        ${row("Can train", esc(a.days.join(", ")))}
      </table>
    </td></tr>

    <tr><td style="padding-top:22px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:8px;">Working toward</div>
      <div style="background:#050505;border:1px solid #26262b;border-radius:12px;padding:14px 16px;color:#f5f6f8;font-size:15px;line-height:1.6;white-space:pre-wrap;">${esc(a.goals)}</div>
    </td></tr>

    <tr><td style="padding-top:22px;">
      <a href="tel:${esc(tel)}" style="display:inline-block;background:#cfd4da;color:#06121c;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 22px;border-radius:99px;margin-right:8px;">Call ${esc(a.parent.split(" ")[0] || "them")}</a>
      <a href="sms:${esc(tel)}" style="display:inline-block;background:transparent;border:1px solid #3a3a41;color:#cfd4da;text-decoration:none;font-weight:bold;font-size:14px;padding:11px 22px;border-radius:99px;">Text</a>
    </td></tr>

    <tr><td style="padding-top:20px;">
      <p style="color:#a8adb6;font-size:13px;line-height:1.6;margin:0;">
        Reply to this email and it goes straight to ${esc(a.parent)}.
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

function coachText(a) {
  return `COLLEGE TRACK APPLICATION

${a.player} — age ${a.age}, ${a.position}, ${a.team}

Parent:    ${a.parent}
Phone:     ${a.phone}
Email:     ${a.email}
Can train: ${a.days.join(", ")}

WORKING TOWARD
${a.goals}

Reply to this email to reach ${a.parent} directly.`;
}

function applicantEmail(a) {
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
      <div style="font-size:21px;color:#ffffff;font-weight:bold;">Thanks — I've got your application</div>
      <p style="color:#a8adb6;font-size:15px;line-height:1.6;margin:10px 0 0;">
        ${esc(a.parent)}, thanks for putting ${esc(a.player)} forward for College Track.
      </p>
      <p style="color:#a8adb6;font-size:15px;line-height:1.6;margin:12px 0 0;">
        I read every application myself, so this isn't an automated screening. I'll call or text you on
        <strong style="color:#ffffff;">${esc(a.phone)}</strong> within a couple of days to talk through whether
        it's the right fit and, if it is, which three days suit you.
      </p>
      <p style="color:#a8adb6;font-size:15px;line-height:1.6;margin:12px 0 0;">
        <strong style="color:#ffffff;">Nothing has been charged.</strong> Payment only comes up once we've
        spoken and agreed the schedule.
      </p>
    </td></tr>
    <tr><td style="padding-top:24px;">
      <div style="font-size:11px;color:#a8adb6;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding-bottom:8px;">What you sent me</div>
      <div style="background:#050505;border:1px solid #26262b;border-radius:12px;padding:14px 16px;color:#cfd4da;font-size:14px;line-height:1.7;">
        ${esc(a.player)} &middot; age ${esc(a.age)} &middot; ${esc(a.position)}<br />
        ${esc(a.team)}<br />
        Available: ${esc(a.days.join(", "))}
      </div>
    </td></tr>
    <tr><td style="padding-top:26px;border-top:1px solid #26262b;">
      <p style="color:#a8adb6;font-size:14px;line-height:1.8;margin:16px 0 0;">
        In a hurry? Call or text ${PHONE}.<br />
        <strong style="color:#ffffff;font-size:16px;">${COACH}</strong><br />
        <span style="color:#a8adb6;">Founder &amp; Head Trainer, AP Academy</span>
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

function applicantText(a) {
  return `AP ACADEMY — thanks, I've got your application

${a.parent}, thanks for putting ${a.player} forward for College Track.

I read every application myself. I'll call or text you on ${a.phone} within a
couple of days to talk through whether it's the right fit and, if it is, which
three days suit you.

Nothing has been charged. Payment only comes up once we've spoken and agreed
the schedule.

WHAT YOU SENT ME
${a.player} - age ${a.age} - ${a.position}
${a.team}
Available: ${a.days.join(", ")}

In a hurry? Call or text ${PHONE}.

${COACH}
Founder & Head Trainer, AP Academy`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const b = req.body || {};
  const a = {
    player: clean(b.player, 80),
    age: clean(b.age, 20),
    parent: clean(b.parent, 80),
    phone: clean(b.phone, 40),
    email: clean(b.email, 120).toLowerCase(),
    position: clean(b.position, 30),
    team: clean(b.team, 120),
    goals: clean(b.goals, 2000),
    days: Array.isArray(b.days) ? b.days.filter((d) => DAYS.includes(d)) : [],
  };

  const invalid =
    !a.player ||
    !a.parent ||
    !a.team ||
    !a.goals ||
    !AGES.includes(a.age) ||
    !POSITIONS.includes(a.position) ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email) ||
    a.phone.replace(/\D/g, "").length < 10 ||
    a.days.length < 3;

  if (invalid) {
    res.status(400).json({
      error: "Some details are missing. Fill in every field marked * and pick at least three days.",
    });
    return;
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    // Don't pretend it went through — an application nobody receives is worse
    // than an honest failure.
    res.status(503).json({
      error: "Applications aren't connected yet. Please call or text (405) 819-4401.",
    });
    return;
  }

  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";
  const send = (payload) =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, ...payload }),
    });

  try {
    // The coach's copy is the one that matters — if it fails, the application
    // is lost, so its result decides the response.
    const toCoach = await send({
      to: [REPLY_TO],
      reply_to: a.email,
      subject: `College Track application — ${a.player} (age ${a.age}, ${a.position})`,
      html: coachEmail(a),
      text: coachText(a),
    });

    if (!toCoach.ok) {
      const err = await toCoach.json().catch(() => ({}));
      console.error("College Track application failed to send:", toCoach.status, err);
      res.status(502).json({
        error: "Couldn't send that. Please call or text (405) 819-4401.",
        detail: err.message || `Resend returned ${toCoach.status}`,
      });
      return;
    }

    // Acknowledgement is a nicety — a failure here shouldn't tell the parent
    // their application didn't arrive, because it did.
    send({
      to: [a.email],
      bcc: [REPLY_TO],
      reply_to: REPLY_TO,
      subject: "Got your College Track application — AP Academy",
      html: applicantEmail(a),
      text: applicantText(a),
    }).catch(() => {});

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("College Track application error:", e);
    res.status(500).json({ error: "Something went wrong. Please call or text (405) 819-4401." });
  }
}
