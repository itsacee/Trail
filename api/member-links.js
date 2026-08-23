// Coach-only rescue hatch: every active membership, with a ready-to-use
// sign-in link you can text or email by hand.
//
//   https://www.apacademybsb.com/api/member-links?key=YOUR_COACH_PASSCODE
//
// Useful when someone paid but never got their welcome email (e.g. they closed
// the tab before the success page loaded, or email wasn't connected yet).
// Each link signs that person in for 30 days — treat them like passwords.

import { fromPayment, membershipSummary, MEMBER_PERIOD_DAYS, prettyDate } from "../lib/members.js";
import { loadLessons, scheduledFor } from "../lib/lessons.js";
import { signMemberToken } from "../lib/memberAuth.js";

function esc(v) {
  return String(v == null ? "" : v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function stripeGet(key, path) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const pass = process.env.COACH_PASS;

  if (!key || !pass) {
    res.status(500).send("Not set up yet.");
    return;
  }
  if (String(req.query?.key || "") !== pass) {
    res.status(401).send("Wrong passcode.");
    return;
  }

  const origin = `https://${req.headers.host || "www.apacademybsb.com"}`;
  const since = Math.floor(Date.now() / 1000) - (MEMBER_PERIOD_DAYS + 7) * 86400;

  let payments = [];
  try {
    const list = await stripeGet(key, `payment_intents?limit=100&created[gte]=${since}`);
    payments = (list?.data || []).filter(
      (p) => p.status === "succeeded" && String(p.metadata?.type || "") === "membership"
    );
  } catch {
    payments = [];
  }

  const stored = await loadLessons();

  // Newest payment per email wins — that's their current membership.
  const byEmail = new Map();
  payments
    .sort((a, b) => b.created - a.created)
    .forEach((pi) => {
      const email = String(pi.metadata?.email || "").toLowerCase();
      if (!email || byEmail.has(email)) return;
      const sub = fromPayment(pi, email);
      if (!sub) return; // expired
      byEmail.set(email, sub);
    });

  const members = [...byEmail.values()]
    .map((sub) => {
      const summary = membershipSummary(sub, scheduledFor(sub, stored));
      return {
        ...summary,
        link: `${origin}/account.html?k=${encodeURIComponent(signMemberToken(summary.email))}`,
      };
    })
    .sort((a, b) => b.periodStart - a.periodStart);

  if (String(req.query?.format || "") === "json") {
    res.status(200).json({ members });
    return;
  }

  const cards = members
    .map((m) => {
      const lessons = m.lessons.length
        ? m.lessons.map((l) => `<li>${esc(prettyDate(l.date))} at ${esc(l.time)}</li>`).join("")
        : `<li class="none">Nothing booked yet</li>`;
      const sms = `Hey${m.parent ? ` ${m.parent}` : ""}! Here's your AP Academy membership link — it shows your lessons left and lets you book: ${m.link}`;
      return `<article class="card">
        <h2>${esc(m.player || "(no name)")}</h2>
        <p class="meta">${esc(m.parent || "")}${m.parent && m.phone ? " · " : ""}${esc(m.phone || "")}</p>
        <p class="meta"><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></p>
        <p class="pill">${m.remaining} of ${m.credits} lessons left · expires ${esc(m.lastDayPretty)}</p>
        <ul class="lessons">${lessons}</ul>
        <label>Sign-in link</label>
        <input readonly value="${esc(m.link)}" onclick="this.select()" />
        <div class="row">
          <a class="btn" href="sms:${esc(m.phone)}?&body=${encodeURIComponent(sms)}">Text it</a>
          <a class="btn" href="mailto:${esc(m.email)}?subject=${encodeURIComponent(
            "Your AP Academy membership link"
          )}&body=${encodeURIComponent(sms)}">Email it</a>
          <a class="btn btn--ghost" href="${esc(m.link)}" target="_blank" rel="noopener">Open as them</a>
        </div>
      </article>`;
    })
    .join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Member sign-in links | AP Academy</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:20px 14px 60px; background:#050505; color:#f5f6f8;
         font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:#a8adb6; font-size:14px; margin:0 0 22px; }
  .card { background:#111114; border:1px solid #26262b; border-radius:14px; padding:18px; margin:0 0 16px; }
  .card h2 { font-size:18px; margin:0 0 2px; }
  .meta { color:#a8adb6; font-size:13px; margin:0 0 2px; }
  .meta a { color:#cfd4da; }
  .pill { display:inline-block; background:#050505; border:1px solid #6b4d16; color:#e0b457;
          border-radius:99px; padding:5px 12px; font-size:12px; font-weight:700; margin:10px 0 0; }
  ul.lessons { margin:12px 0 0; padding-left:18px; color:#cfd4da; font-size:14px; }
  ul.lessons .none { color:#7a7f88; list-style:none; margin-left:-18px; }
  label { display:block; margin:14px 0 5px; font-size:11px; letter-spacing:2px;
          text-transform:uppercase; color:#a8adb6; font-weight:700; }
  input { width:100%; box-sizing:border-box; background:#050505; border:1px solid #26262b;
          border-radius:8px; color:#cfd4da; padding:10px; font-size:12px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .btn { background:#cfd4da; color:#06121c; text-decoration:none; font-weight:700; font-size:13px;
         padding:9px 16px; border-radius:99px; }
  .btn--ghost { background:transparent; color:#cfd4da; border:1px solid #3a3a41; }
  .empty { color:#a8adb6; }
</style></head><body>
<h1>Member sign-in links</h1>
<p class="sub">${members.length} active membership${members.length === 1 ? "" : "s"}.
Each link signs that person in for 30 days — only send it to them.</p>
${cards || `<p class="empty">No active memberships in the last ${MEMBER_PERIOD_DAYS + 7} days.</p>`}
</body></html>`);
}
