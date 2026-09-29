// Availability endpoint.
//   GET  → the current weekly hours + blocked dates (public; the booking form
//          reads this to build the day/time pickers).
//   POST → save new availability. Protected by the COACH_PASS passcode, the
//          same one the coach page uses. Requires the KV store to be set up.

import { getAvailability, normalizeAvailability } from "../lib/schedule.js";
import { requireCoach } from "../lib/coachAuth.js";
import { kvSet, storeConfigured } from "../lib/store.js";
import { getSiteStatus } from "../lib/siteStatus.js";
import { loadCoachStatus } from "../lib/coachStatus.js";
import { bookingWindow, todayChicago } from "../lib/members.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    await loadCoachStatus();
    const availability = await getAvailability();
    const today = todayChicago();
    const window = bookingWindow(today);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      availability,
      editable: storeConfigured(),
      siteStatus: getSiteStatus(),
      bookingWindow: { today, start: window.startKey, end: window.endKey, dates: window.dates },
    });
    return;
  }

  if (req.method === "POST") {
    if (!requireCoach(req, res)) return;
    if (!storeConfigured()) {
      res.status(503).json({
        error:
          "Saving isn't turned on yet. Connect an Upstash (KV) store to this Vercel project, then redeploy.",
      });
      return;
    }

    const incoming = req.body?.availability ?? req.body;
    const clean = normalizeAvailability(incoming);

    // Guard against a totally empty week (would silently disable all booking).
    const anyOpen = Object.values(clean.days).some((d) => d.open);
    if (!anyOpen) {
      res.status(400).json({ error: "At least one day needs to be open." });
      return;
    }
    // Every open day needs end after start by at least one slot.
    const badDay = Object.entries(clean.days).find(
      ([, d]) => d.open && d.end <= d.start
    );
    if (badDay) {
      res.status(400).json({ error: "Each open day's end time must be after its start time." });
      return;
    }

    const ok = await kvSet("availability", JSON.stringify(clean));
    if (!ok) {
      res.status(502).json({ error: "Couldn't save — the store didn't accept the write." });
      return;
    }
    res.status(200).json({ availability: clean });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
