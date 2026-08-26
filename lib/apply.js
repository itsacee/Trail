// 3-days-a-week intensive: not a checkout. Parents answer a few questions;
// the answers are emailed to Elijah so he can decide if it's a fit and reach out.

export const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export const FOCUS = ["Hitting", "Fielding", "Both"];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function trim(v) {
  return String(v ?? "").trim();
}

function uniqueDays(raw) {
  let days = raw;
  if (typeof days === "string") days = days.split(/[,|]/);
  if (!Array.isArray(days)) return [];
  return [...new Set(days.map(trim).filter((d) => DAYS.includes(d)))];
}

export function parseApply(body) {
  // Honeypot — bots fill hidden "company". Pretend it worked; don't email anyone.
  if (trim(body?.company)) return { ok: true, spam: true };

  const player = trim(body?.player);
  const age = trim(body?.age);
  const parent = trim(body?.parent);
  const phone = trim(body?.phone);
  const email = trim(body?.email).toLowerCase();
  const team = trim(body?.team);
  const focusRaw = trim(body?.focus);
  const focus = FOCUS.includes(focusRaw) ? focusRaw : "";
  const why = trim(body?.why);
  const time = trim(body?.time);
  const notes = trim(body?.notes);
  const days = uniqueDays(body?.days);

  const missing = [];
  if (!player) missing.push("the player's name");
  if (!age) missing.push("age or grade");
  if (!phone) missing.push("a phone number");
  if (!EMAIL_RE.test(email)) missing.push("a valid email");
  if (days.length !== 3) missing.push("exactly 3 days");
  if (!time) missing.push("a preferred time");
  if (!why) missing.push("why they want this month");

  if (missing.length) {
    return { ok: false, error: `Please include ${missing.join(", ")}.` };
  }

  return {
    ok: true,
    spam: false,
    data: { player, age, parent, phone, email, team, focus, why, days, time, notes },
  };
}

export function coachMail(data) {
  const who = data.player;
  const days = data.days.join(", ");
  const lines = [
    `${who} applied for the 3 days/week month ($700 · 12 lessons).`,
    "",
    `Player: ${who}`,
    `Age / grade: ${data.age}`,
    data.parent ? `Parent: ${data.parent}` : "",
    `Phone: ${data.phone}`,
    `Email: ${data.email}`,
    data.team ? `Team / school: ${data.team}` : "",
    data.focus ? `Work on: ${data.focus}` : "",
    `Days: ${days}`,
    `Time: ${data.time} (same time every week)`,
    "",
    "Why this month:",
    data.why,
    data.notes ? `\nAnything else:\n${data.notes}` : "",
    "",
    "This is not paid yet. Review it and reach out if you'll take them on.",
  ].filter((line) => line !== "");

  const htmlRows = [
    ["Player", who],
    ["Age / grade", data.age],
    data.parent ? ["Parent", data.parent] : null,
    ["Phone", `<a href="tel:${escAttr(telHref(data.phone))}" style="color:#cfd4da;text-decoration:none;font-weight:bold;">${esc(data.phone)}</a>`],
    ["Email", `<a href="mailto:${escAttr(data.email)}" style="color:#cfd4da;text-decoration:none;font-weight:bold;">${esc(data.email)}</a>`],
    data.team ? ["Team / school", data.team] : null,
    data.focus ? ["Work on", data.focus] : null,
    ["Days", days],
    ["Time", `${data.time} · same time every week`],
  ].filter(Boolean);

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#050505;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:28px 12px;">
<tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#111114;border:1px solid #26262b;border-radius:16px;padding:32px;font-family:Helvetica,Arial,sans-serif;">
    <tr><td>
      <div style="font-size:26px;font-weight:bold;color:#ffffff;letter-spacing:1px;">AP ACADEMY</div>
      <div style="font-size:11px;color:#a8adb6;letter-spacing:3px;text-transform:uppercase;">3 days / week application</div>
    </td></tr>
    <tr><td style="padding-top:22px;">
      <div style="font-size:21px;color:#ffffff;font-weight:bold;">${esc(who)} wants 12 lessons this month</div>
      <p style="color:#a8adb6;font-size:15px;line-height:1.6;margin:10px 0 0;">
        $700 · 3 days a week · same days, same time. Not paid yet — reply or call if you'll take them on.
      </p>
    </td></tr>
    <tr><td style="padding-top:22px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="color:#f5f6f8;font-size:15px;line-height:1.6;">
        ${htmlRows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:0 0 10px;"><span style="color:#a8adb6;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;">${esc(k)}</span><br />${v}</td></tr>`
          )
          .join("")}
      </table>
    </td></tr>
    <tr><td style="padding-top:8px;">
      <div style="font-size:12px;color:#a8adb6;text-transform:uppercase;letter-spacing:0.08em;font-weight:bold;">Why this month</div>
      <p style="color:#f5f6f8;font-size:15px;line-height:1.6;margin:8px 0 0;white-space:pre-wrap;">${esc(data.why)}</p>
    </td></tr>
    ${
      data.notes
        ? `<tr><td style="padding-top:18px;">
      <div style="font-size:12px;color:#a8adb6;text-transform:uppercase;letter-spacing:0.08em;font-weight:bold;">Anything else</div>
      <p style="color:#f5f6f8;font-size:15px;line-height:1.6;margin:8px 0 0;white-space:pre-wrap;">${esc(data.notes)}</p>
    </td></tr>`
        : ""
    }
  </table>
</td></tr>
</table>
</body></html>`;

  return {
    subject: `3x/week application — ${who} (${data.age})`,
    text: lines.join("\n"),
    html,
  };
}

export function parentMail(data) {
  const who = data.player;
  const days = data.days.join(", ");
  const text =
    `Got it — ${who}'s 3 days/week application is in.\n\n` +
    `That's 12 lessons over one month, same days and time each week ($700 if Elijah takes you on).\n` +
    `You asked for ${days} at ${data.time}.\n\n` +
    `Nothing is charged. Elijah will review this and reach out if it's a fit.\n\n` +
    `Questions in the meantime? Call or text (405) 819-4401.\n` +
    `Elijah Alexander, AP Academy`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#050505;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:28px 12px;">
<tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#111114;border:1px solid #26262b;border-radius:16px;padding:32px;font-family:Helvetica,Arial,sans-serif;">
    <tr><td>
      <div style="font-size:26px;font-weight:bold;color:#ffffff;letter-spacing:1px;">AP ACADEMY</div>
      <div style="font-size:11px;color:#a8adb6;letter-spacing:3px;text-transform:uppercase;">Ace Performance</div>
    </td></tr>
    <tr><td style="padding-top:22px;">
      <div style="font-size:21px;color:#ffffff;font-weight:bold;">Application received</div>
      <p style="color:#a8adb6;font-size:15px;line-height:1.6;margin:10px 0 0;">
        ${esc(who)}'s 3 days/week application is in. That's 12 lessons over one month —
        same days, same time each week. <strong style="color:#ffffff;">Nothing is charged today.</strong>
        Elijah will review it and reach out if it's a fit.
      </p>
      <p style="color:#f5f6f8;font-size:15px;line-height:1.6;margin:14px 0 0;">
        You asked for <strong>${esc(days)}</strong> at <strong>${esc(data.time)}</strong>.
      </p>
      <p style="color:#a8adb6;font-size:14px;line-height:1.6;margin:18px 0 0;">
        Questions? Call or text <a href="tel:+14058194401" style="color:#cfd4da;text-decoration:none;font-weight:bold;">(405) 819-4401</a>.
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  return {
    subject: `${who}'s AP Academy application is in`,
    text,
    html,
  };
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(s) {
  return esc(s).replace(/'/g, "&#39;");
}

function telHref(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(phone);
}
