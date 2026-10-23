// Occasional private training packages (coach-shared payment links).
// Not memberships — no credits, no auto-scheduling, no player cards.

export const PRIVATE_TRAINING_PACKAGE_TYPE = "private_training_package";
/** Legacy metadata type from the earlier $560/$840 sendable links. */
export const LEGACY_PACKAGE_TYPE = "custom_player_package";

export const PRIVATE_TRAINING_PACKAGES = {
  8: {
    planId: "8",
    amount: 64000,
    lessons: 8,
    weekly: 2,
    name: "AP Academy — 2 Days Per Week Private Training",
    shortLabel: "2 Days / Week — $640 — 8 Private Lessons",
    priceLabel: "$640",
  },
  12: {
    planId: "12",
    amount: 96000,
    lessons: 12,
    weekly: 3,
    name: "AP Academy — 3 Days Per Week Private Training",
    shortLabel: "3 Days / Week — $960 — 12 Private Lessons",
    priceLabel: "$960",
  },
};

export function isPrivateTrainingPackageType(type) {
  const t = String(type || "");
  return t === PRIVATE_TRAINING_PACKAGE_TYPE || t === LEGACY_PACKAGE_TYPE;
}

export function packagePlan(planId) {
  return PRIVATE_TRAINING_PACKAGES[String(planId || "")] || null;
}

/** Shareable checkout entry URL on this host (creates a fresh Stripe Checkout). */
export function packageCheckoutPath(planId) {
  const plan = packagePlan(planId);
  if (!plan) return "";
  return `/api/package-checkout?plan=${plan.planId}`;
}
