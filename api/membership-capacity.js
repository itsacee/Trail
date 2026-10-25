import {
  getMembershipCapacity,
  STANDARD_MEMBERSHIP_CAP,
  PRIVATE_MEMBERSHIP_CAP,
  MEMBERSHIP_TOTAL_CAP,
} from "../lib/membershipCapacity.js";
import { membershipBlockedMessage } from "../lib/siteStatus.js";
import { loadCoachStatus } from "../lib/coachStatus.js";

function emptySummary() {
  return {
    standard: {
      tier: "standard",
      limit: STANDARD_MEMBERSHIP_CAP,
      active: 0,
      pending: 0,
      spotsAvailable: 0,
      available: false,
      requestedAdmitted: null,
      overCap: false,
    },
    private: {
      tier: "private",
      limit: PRIVATE_MEMBERSHIP_CAP,
      active: 0,
      pending: 0,
      spotsAvailable: 0,
      available: false,
      requestedAdmitted: null,
      overCap: false,
    },
    unverifiedActive: 0,
    limit: MEMBERSHIP_TOTAL_CAP,
    active: 0,
    pending: 0,
    spotsAvailable: 0,
    available: false,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(503).json({
      error: "Membership availability is temporarily unavailable.",
      ...emptySummary(),
    });
    return;
  }

  try {
    await loadCoachStatus();
    const { summary } = await getMembershipCapacity(key);
    const paused = membershipBlockedMessage();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ...summary,
      ...(paused
        ? {
            available: false,
            salesPaused: true,
            paused: true,
            message: paused,
            standard: { ...summary.standard, available: false },
            private: { ...summary.private, available: false },
          }
        : {}),
    });
  } catch {
    // Fail closed: if Stripe cannot confirm the count, do not risk overselling.
    res.status(503).json({
      error: "Membership availability is temporarily unavailable.",
      ...emptySummary(),
    });
  }
}
