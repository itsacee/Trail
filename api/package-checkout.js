// Private, sendable package links for Elijah's custom player plans.
// Visiting either URL creates a fresh one-time Stripe Checkout session:
//   /api/package-checkout?plan=8
//   /api/package-checkout?plan=12

const PACKAGES = {
  8: {
    amount: 56000,
    lessons: 8,
    weekly: 2,
    name: "AP Academy — 8-Lesson Player Package",
  },
  12: {
    amount: 84000,
    lessons: 12,
    weekly: 3,
    name: "AP Academy — 12-Lesson Player Package",
  },
};

function originFor(req) {
  const host = String(req.headers?.host || "www.apacademybsb.com");
  return `https://${host}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const planId = String(req.query?.plan || "");
  const plan = PACKAGES[planId];
  if (!plan) {
    res.status(400).json({ error: "Choose the 8-lesson or 12-lesson package." });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(503).json({ error: "Stripe is not connected yet. Please contact Elijah." });
    return;
  }

  const origin = originFor(req);
  const description =
    `${plan.weekly} lessons per week · ${plan.lessons} total lessons · ` +
    "$70 per lesson · hitting, fielding, and speed/agility · one-time payment";
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", `${origin}/package-status.html?paid=1&plan=${planId}`);
  params.append("cancel_url", `${origin}/package-status.html?paid=0&plan=${planId}`);
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
    type: "custom_player_package",
    package: planId,
    lessons: String(plan.lessons),
    weekly: String(plan.weekly),
    price_per_lesson: "70",
  };
  Object.entries(metadata).forEach(([name, value]) => {
    params.append(`metadata[${name}]`, value);
    params.append(`payment_intent_data[metadata][${name}]`, value);
  });
  params.append(
    "payment_intent_data[description]",
    `${plan.name}: ${plan.lessons} lessons at $70 each (one-time payment)`
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
