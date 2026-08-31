// Twilio texts for the same two follow-ups as the emails.
//
// Env (Vercel → Settings → Environment Variables):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM          — the Twilio number in E.164, e.g. +14055550199
//
// Until those three are set, follow-ups are email-only. The field address
// is never included. US 10-digit numbers are assumed to be +1.

import { prettyDate } from "./members.js";
import { signMemberToken } from "./memberAuth.js";

export function toE164(phone) {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function smsConfigured(env = process.env) {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
}

export function membershipPitchSms(item, origin) {
  const who = item.player || "your player";
  const hi = item.parent ? `Hey ${item.parent} — ` : "";
  const when = item.date ? prettyDate(item.date) : "the other day";
  const link = `${origin}/book.html?type=membership`;
  return (
    `${hi}hope ${who}'s lesson on ${when} went well. ` +
    `4 singles are $280; a month of 4 hour lessons is $240 and nothing auto-renews. ` +
    `Start a month: ${link} — Elijah, AP Academy`
  );
}

export function bookAgainSms(item, origin) {
  const who = item.player || "your player";
  const hi = item.parent ? `Hey ${item.parent} — ` : "";
  const n = Number(item.remaining) || 0;
  const lessons = `${n} lesson${n === 1 ? "" : "s"}`;
  const token = signMemberToken(item.email);
  const link = `${origin}/account.html?k=${encodeURIComponent(token)}`;
  const until = item.lastDayPretty ? ` Use them by ${item.lastDayPretty}.` : "";
  return (
    `${hi}${who}'s lesson is done. ${lessons} left on the membership.${until} ` +
    `Unused don't roll. Book the next one: ${link} — Elijah, AP Academy`
  );
}

export async function sendSms({ sid, token, from, to, body }) {
  const dest = toE164(to);
  const fromNum = toE164(from) || String(from || "").trim();
  if (!sid || !token || !fromNum || !dest || !body) {
    return { ok: false, error: "Missing Twilio settings or phone number." };
  }
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: dest, From: fromNum, Body: body }),
  });
  if (r.ok) return { ok: true };
  const err = await r.json().catch(() => ({}));
  return { ok: false, error: err.message || `Twilio returned ${r.status}` };
}
