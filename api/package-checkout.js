// Coach-shared one-time package Checkout links (not memberships).
// Visiting either URL creates a fresh Stripe Checkout session:
//   /api/package-checkout?plan=8   → $640 · 8 private lessons
//   /api/package-checkout?plan=12  → $960 · 12 private lessons
//
// Metadata type is private_training_package so webhooks never treat these as
// Standard/Private four-lesson memberships and never auto-book lessons.

import { rejectIfPublicBookingClosed } from "../lib/publicBooking.js";
import {
  PRIVATE_TRAINING_PACKAGE_TYPE,
  packagePlan,
} from "../lib/privateTrainingPackages.js";

function originFor(req) {
  const host = String(req.headers?.host || "www.apacademybsb.com");
  return `https://${host}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Same public gate as /api/checkout — packages are only sold while booking is open.
  if (rejectIfPublicBookingClosed(res)) return;

  const plan = packagePlan(req.query?.plan);
  if (!plan) {
    res.status(400).json({ error: "Choose the 2-day or 3-day private training package." });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(503).json({ error: "Stripe is not connected yet. Please contact Elijah." });
    return;
  }

  // Preview must use Stripe TEST keys only (sk_test_…). Refuse live keys here
  // when the deployment is a Vercel Preview so we never mint live package links
  // from a Preview deploy by accident.
  const vercelEnv = String(process.env.VERCEL_ENV || "");
  if (vercelEnv === "preview" && !String(key).startsWith("sk_test_")) {
    res.status(503).json({
      error: "Preview package checkout requires a Stripe TEST key (sk_test_…). Live keys are blocked here.",
    });
    return;
  }

  const origin = originFor(req);
  const description =
    `${plan.weekly} private one-hour lessons per week · ${plan.lessons} total over 4 weeks · ` +
    "one-time payment · schedule arranged with Coach Elijah";
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", `${origin}/package-status.html?paid=1&plan=${plan.planId}`);
  params.append("cancel_url", `${origin}/package-status.html?paid=0&plan=${plan.planId}`);
  params.append("submit_type", "pay");
  params.append("phone_number_collection[enabled]", "true");
  params.append("line_items[0][quantity]", "1");
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][unit_amount]", String(plan.amount));
  params.append("line_items[0][price_data][product_data][name]", plan.name);
  params.append("line_items[0][price_data][product_data][description]", description);
  params.append("custom_fields[0][key]", "player_name");
  params.append("custom_fields[0][label][type]", "custom");
  params.append("custom_fields[0][label][custom]", "Player's name");
  params.append("custom_fields[0][type]", "text");
  params.append("custom_fields[0][optional]", "false");

  const metadata = {
    type: PRIVATE_TRAINING_PACKAGE_TYPE,
    package: plan.planId,
    lessons: String(plan.lessons),
    weekly: String(plan.weekly),
  };
  Object.entries(metadata).forEach(([name, value]) => {
    params.append(`metadata[${name}]`, value);
    params.append(`payment_intent_data[metadata][${name}]`, value);
  });
  params.append(
    "payment_intent_data[description]",
    `${plan.name}: ${plan.lessons} private lessons (one-time payment)`
  );

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.url) {
    res.status(502).json({ error: data.error?.message || "Payment setup failed. Please try again." });
    return;
  }

  res.redirect(303, data.url);
}
