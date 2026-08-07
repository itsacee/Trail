// Coach-only endpoint: returns all upcoming booked lessons, read straight
// from Stripe (paid payments + active memberships). Protected by a passcode
// set in the COACH_PASS environment variable in Vercel.

import { fetchBookings } from "../lib/bookings.js";

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const pass = process.env.COACH_PASS;
  if (!key) {
    res.status(500).json({ error: "Stripe is not connected yet." });
    return;
  }
  if (!pass) {
    res.status(500).json({
      error: "Coach page isn't set up yet. In Vercel: Settings → Environment Variables → add COACH_PASS with a passcode you make up, then redeploy.",
    });
    return;
  }
  if (String(req.query?.key || "") !== pass) {
    res.status(401).json({ error: "Wrong passcode." });
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
