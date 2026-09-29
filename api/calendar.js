// Calendar feed of booked lessons, for subscribing from iPhone Calendar,
// Google Calendar, or Outlook. Protected by the same coach passcode:
//
//   webcal://www.apacademybsb.com/api/calendar?key=YOUR_PASSCODE
//
// Calendar apps can't send headers, so the passcode travels in the URL.
//
// Every booking lands here: lessons picked at checkout (from Stripe metadata)
// and the ones members book themselves later (from Vercel Blob). Cancelling
// removes the lesson, so it disappears on the next refresh.

import { fetchBookings } from "../lib/bookings.js";
import { buildCalendar, stamp, bookingEvent } from "../lib/ics.js";
import { isCoachPass } from "../lib/coachAuth.js";

// Kept here so existing imports (`api/member.js`) keep working.
export { bookingEvent };

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;

  if (!key) {
    res.status(500).send("Calendar feed is not set up yet.");
    return;
  }
  if (!isCoachPass(req.query?.key)) {
    res.status(401).send("Wrong passcode.");
    return;
  }

  let bookings = [];
  try {
    bookings = await fetchBookings(key);
  } catch {
    bookings = [];
  }

  const now = stamp();
  const body = buildCalendar({
    name: "AP Academy Lessons",
    // Ask subscribers to re-check every 15 minutes
    refreshMinutes: 15,
    events: bookings.map((b) => bookingEvent(b, now)),
  });

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="ap-academy-lessons.ics"');
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.status(200).send(body);
}
