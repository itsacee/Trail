import { getMembershipCapacity, MEMBERSHIP_LIMIT } from "../lib/membershipCapacity.js";
import { membershipBlockedMessage } from "../lib/siteStatus.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(503).json({
      error: "Membership availability is temporarily unavailable.",
      limit: MEMBERSHIP_LIMIT,
      spotsAvailable: 0,
      available: false,
    });
    return;
  }

  try {
    const { summary } = await getMembershipCapacity(key);
    const paused = membershipBlockedMessage();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ...summary,
      ...(paused
        ? { available: false, salesPaused: true, paused: true, message: paused }
        : {}),
    });
  } catch {
    // Fail closed: if Stripe cannot confirm the count, do not risk selling
    // membership number 16.
    res.status(503).json({
      error: "Membership availability is temporarily unavailable.",
      limit: MEMBERSHIP_LIMIT,
      spotsAvailable: 0,
      available: false,
    });
  }
}
