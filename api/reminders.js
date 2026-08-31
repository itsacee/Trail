// Daily emails:
//   - memberships that expire soon, or just ended
//   - after a drop-in (single) lesson: pitch the $240 month
//   - after a membership lesson: remind them to book the next one
//
// Runs once a day from Vercel Cron (see vercel.json).
//
// Expiring / ended sends are flagged on the Stripe payment. Lesson follow-ups
// are recorded in followups.json so a re-run can't email anyone twice.
//
//   Cron:   Vercel sends Authorization: Bearer $CRON_SECRET
//   Manual: /api/reminders?key=COACH_PASS          (sends for real)
//           /api/reminders?key=COACH_PASS&dry=1    (shows what it would send)

import {
  MEMBER_PERIOD_DAYS,
  MEMBER_CREDITS,
  membershipSummary,
  todayChicago,
} from "../lib/members.js";
import { loadLessons, scheduledFor } from "../lib/lessons.js";
import { signMemberToken } from "../lib/memberAuth.js";
import { LOCATIONS, LOCATION_KEY } from "../lib/schedule.js";
import {
  KIND_PITCH,
  bookAgainMail,
  loadFollowups,
  markSent,
  membershipPitchMail,
  pickBookAgainNudges,
  pickMembershipPitches,
  saveFollowups,
} from "../lib/followups.js";

const PHONE = "(405) 819-4401";
const REPLY_TO = "Apacademybsb@gmail.com";
const COACH = "Elijah Alexander";

// Warn once when this many days or fewer remain.
const WARN_WITHIN_DAYS = 5;
// Only nudge memberships that ended in the last week — older ones are stale.
const NUDGE_WITHIN_DAYS = 7;

async function stripeGet(key, path) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return null;
  return r.json();
}

async function flagPayment(key, id, flag) {
  await fetch(`https://api.stripe.com/v1/payment_intents/${id}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ [`metadata[${flag}]`]: "1" }),
  });
}

function subFromPayment(pi) {
  const start = Number(pi.created) || 0;
  return {
    id: pi.id,
    metadata: pi.metadata || {},
    email: String(pi.metadata?.email || "").toLowerCase(),
    current_period_start: start,
    current_period_end: start + MEMBER_PERIOD_DAYS * 86400,
  };
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

function expiringMail(s, origin) {
  const n = s.remaining;
  const lessons = `${n} lesson${n === 1 ? "" : "s"}`;
  const days = s.daysLeft === 0 ? "today" : s.daysLeft === 1 ? "tomorrow" : `in ${s.daysLeft} days`;
  const who = s.player || "your player";
  const link = `${origin}/account.html?k=${encodeURIComponent(signMemberToken(s.email))}`;
  const loc = LOCATIONS[LOCATION_KEY] || {};
  return {
    subject: `${lessons} left on ${who}'s membership — expires ${s.lastDayPretty}`,
    html: shell(
      `${who} still has ${lessons} to use`,
      [
        `${s.parent ? `Hi ${s.parent} — ` : ""}your membership ends <strong style="color:#ffffff;">${s.lastDayPretty}</strong>, which is ${days}.`,
        `You've got <strong style="color:#ffffff;">${lessons}</strong> left. Unused lessons don't roll over, so grab a day that works while there's still room.`,
        `Training is at ${loc.name || "Mustang High School"}${loc.address ? ` — ${loc.address}` : ""}.`,
      ],
      "Book my lesson",
      link
    ),
    text:
      `${s.parent ? `Hi ${s.parent} — ` : ""}${who}'s AP Academy membership ends ${s.lastDayPretty} (${days}).\n\n` +
      `You have ${lessons} left. Unused lessons don't roll over.\n\n` +
      `Book here: ${link}\n\n` +
      `Where: ${loc.name || "Mustang High School"}${loc.address ? `, ${loc.address}` : ""}\n\n` +
      `Questions? Call or text ${PHONE}.\n${COACH}, AP Academy`,
  };
}

function endedMail(s, origin) {
  const who = s.player || "your player";
  const link = `${origin}/book.html?type=membership`;
  const unused = s.remaining > 0;
  return {
    subject: `${who}'s membership has ended — want another month?`,
    html: shell(
      `${who}'s membership has ended`,
      [
        `${s.parent ? `Hi ${s.parent} — ` : ""}the month is up as of ${s.lastDayPretty}, so that membership is finished.`,
        unused
          ? `You had ${s.remaining} lesson${s.remaining === 1 ? "" : "s"} left over. Those don't carry across, but I'd love to keep the work going.`
          : `${who} used all ${MEMBER_CREDITS} lessons — great month of work.`,
        `Nothing auto-renews and you haven't been charged. Whenever you're ready for another ${MEMBER_CREDITS}, just grab a new membership.`,
      ],
      "Start another month",
      link
    ),
    text:
      `${s.parent ? `Hi ${s.parent} — ` : ""}${who}'s AP Academy membership ended ${s.lastDayPretty}.\n\n` +
      (unused
        ? `You had ${s.remaining} lesson(s) left over; those don't carry across.\n\n`
        : `${who} used all ${MEMBER_CREDITS} lessons — great month of work.\n\n`) +
      `Nothing auto-renews and you have not been charged. Ready for another ${MEMBER_CREDITS}?\n${link}\n\n` +
      `Questions? Call or text ${PHONE}.\n${COACH}, AP Academy`,
  };
}

async function send(resendKey, from, to, mail) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], bcc: [REPLY_TO], reply_to: REPLY_TO, ...mail }),
  });
  if (r.ok) return { ok: true };
  const err = await r.json().catch(() => ({}));
  return { ok: false, error: err.message || `Resend returned ${r.status}` };
}

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers?.authorization || "");
  if (secret && auth === `Bearer ${secret}`) return true;

  // Vercel only sends that Authorization header when CRON_SECRET is set, so
  // without this the scheduled run would 401 every day and nobody would know.
  // Vercel strips inbound x-vercel-* headers from outside traffic, so this is
  // only present on genuine cron invocations. Setting CRON_SECRET is still
  // better, and takes precedence above.
  if (req.headers?.["x-vercel-cron"]) return true;

  const pass = process.env.COACH_PASS;
  return Boolean(pass && String(req.query?.key || "") === pass);
}

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>";

  if (!authorised(req)) {
    res.status(401).json({ error: "Not authorised." });
    return;
  }
  if (!key) {
    res.status(500).json({ error: "Stripe isn't configured." });
    return;
  }

  const dry = String(req.query?.dry || "") === "1";
  const origin = `https://${req.headers.host || "www.apacademybsb.com"}`;
  const since = Math.floor(Date.now() / 1000) - (MEMBER_PERIOD_DAYS + NUDGE_WITHIN_DAYS + 2) * 86400;

  const list = await stripeGet(key, `payment_intents?limit=100&created[gte]=${since}`);
  const allPaid = (list?.data || []).filter((p) => p.status === "succeeded");
  const payments = allPaid
    .filter((p) => String(p.metadata?.type || "") === "membership")
    .sort((a, b) => b.created - a.created);

  const stored = await loadLessons();

  // Newest payment per email is their current membership; older ones are past.
  const seen = new Set();
  const actions = [];
  const memberEmails = new Set();
  const memberRows = [];

  for (const pi of payments) {
    const email = String(pi.metadata?.email || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);

    const sub = subFromPayment(pi);
    const scheduled = scheduledFor(sub, stored);
    const summary = { ...membershipSummary(sub, scheduled), email };
    if (!summary.expired) memberEmails.add(email);
    memberRows.push({
      email,
      player: summary.player,
      parent: summary.parent,
      remaining: summary.remaining,
      lastDayPretty: summary.lastDayPretty,
      expired: summary.expired,
      scheduled,
    });

    const meta = pi.metadata || {};
    const endedDaysAgo = summary.expired
      ? Math.round(
          (new Date(`${new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })}T12:00:00`) -
            new Date(`${summary.lastDay}T12:00:00`)) /
            86400000
        )
      : 0;

    let kind = null;
    if (!summary.expired && summary.remaining > 0 && summary.daysLeft <= WARN_WITHIN_DAYS) {
      if (meta.reminder_sent !== "1") kind = "expiring";
    } else if (summary.expired && endedDaysAgo <= NUDGE_WITHIN_DAYS) {
      if (meta.renewal_sent !== "1") kind = "ended";
    }

    if (!kind) continue;

    const mail = kind === "expiring" ? expiringMail(summary, origin) : endedMail(summary, origin);
    const record = {
      kind,
      player: summary.player,
      email,
      remaining: summary.remaining,
      lastDay: summary.lastDay,
      daysLeft: summary.daysLeft,
      subject: mail.subject,
    };

    if (dry) {
      actions.push({ ...record, dryRun: true });
      continue;
    }
    if (!resendKey) {
      actions.push({ ...record, skipped: "email not configured" });
      continue;
    }

    const result = await send(resendKey, from, email, mail);
    if (result.ok) {
      await flagPayment(key, pi.id, kind === "expiring" ? "reminder_sent" : "renewal_sent");
      actions.push({ ...record, sent: true });
    } else {
      console.error("Reminder failed for", email, result.error);
      actions.push({ ...record, sent: false, error: result.error });
    }
  }

  const followups = await loadFollowups();
  const today = todayChicago();
  const now = Date.now();
  const followupItems = [
    ...pickMembershipPitches({
      payments: allPaid,
      memberEmails,
      followups,
      today,
      now,
    }),
    ...pickBookAgainNudges({
      members: memberRows,
      followups,
      today,
      now,
    }),
  ];
  const followupActions = [];
  let followupsDirty = false;

  for (const item of followupItems) {
    const mail =
      item.kind === KIND_PITCH ? membershipPitchMail(item, origin) : bookAgainMail(item, origin);
    const record = {
      kind: item.kind,
      player: item.player,
      email: item.email,
      remaining: item.remaining,
      date: item.date,
      subject: mail.subject,
    };

    if (dry) {
      followupActions.push({ ...record, dryRun: true });
      continue;
    }
    if (!resendKey) {
      followupActions.push({ ...record, skipped: "email not configured" });
      continue;
    }

    const result = await send(resendKey, from, item.email, mail);
    if (result.ok) {
      const ids = item.alsoMark?.length ? item.alsoMark : [item.id];
      ids.forEach((id) => markSent(followups, { kind: item.kind, id, email: item.email }));
      followupsDirty = true;
      followupActions.push({ ...record, sent: true });
    } else {
      console.error("Follow-up failed for", item.email, result.error);
      followupActions.push({ ...record, sent: false, error: result.error });
    }
  }

  if (followupsDirty) {
    const saved = await saveFollowups(followups);
    if (!saved) console.error("Could not persist follow-up send flags");
  }

  res.status(200).json({
    ok: true,
    dryRun: dry,
    memberships: seen.size,
    actioned: actions.length,
    actions,
    followups: followupActions,
  });
}
