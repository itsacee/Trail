// Coach-only: record that a member used a credit (fielding walk-in, etc.)
//
// POST /api/record-lesson?key=COACH_PASS
// { "players": ["Easton", "Dylan"], "date": "2026-09-28", "time": "6:00 PM", "focus": "Fielding" }
//
// date/time optional — defaults to today (Chicago) and 6:00 PM.

import { recordMemberLessons } from "../lib/recordAttendance.js";
import { findMembership } from "../lib/members.js";
import { loadLessons, scheduledFor } from "../lib/lessons.js";
import { membershipSummary } from "../lib/members.js";

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const pass = process.env.COACH_PASS;

  if (!key || !pass) {
    res.status(500).json({ error: "Not set up yet." });
    return;
  }
  if (String(req.query?.key || req.body?.key || "") !== pass) {
    res.status(401).json({ error: "Wrong passcode." });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only." });
    return;
  }

  const players = req.body?.players || (req.body?.player ? [req.body.player] : []);
  const { date, time, focus } = req.body || {};

  try {
    const out = await recordMemberLessons(key, { players, date, time, focus });
    if (!out.ok) {
      res.status(out.results ? 502 : 400).json(out);
      return;
    }

    const stored = await loadLessons();
    const summaries = [];
    for (const row of out.results || []) {
      if (!row.ok) continue;
      const email = String(row.email || "").toLowerCase();
      if (!email) continue;
      const sub = await findMembership(key, email);
      if (!sub) continue;
      const summary = membershipSummary(sub, scheduledFor(sub, stored));
      summaries.push({
        player: summary.player,
        remaining: summary.remaining,
        used: summary.used,
        lastDayPretty: summary.lastDayPretty,
        skipped: Boolean(row.skipped),
      });
    }

    res.status(200).json({ ...out, summaries });
  } catch {
    res.status(502).json({ error: "Couldn't record those lessons." });
  }
}
