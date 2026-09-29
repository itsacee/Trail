// Coach-only endpoint: returns all upcoming booked lessons, read straight
// from Stripe (paid payments + active memberships). Protected by a passcode
// set in the COACH_PASS environment variable in Vercel.

import { fetchBookings } from "../lib/bookings.js";
import { requireCoach } from "../lib/coachAuth.js";

export default async function handler(req, res) {
  if (!requireCoach(req, res)) return;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(500).json({ error: "Stripe is not connected yet." });
    return;
  }

  let sessions = [];
  try {
    sessions = await fetchBookings(key);
  } catch {
    sessions = [];
  }

  // Whether each integration is configured — booleans only, never the values
  const status = {
    payments: Boolean(process.env.STRIPE_SECRET_KEY),
    email: Boolean(process.env.RESEND_API_KEY),
  };

  res.status(200).json({ sessions, status });
}
