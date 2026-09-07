import { test, mock } from "node:test";
import assert from "node:assert/strict";

import capacityHandler from "../api/membership-capacity.js";
import checkoutHandler from "../api/checkout.js";

function activePayments(count) {
  const created = Math.floor(Date.now() / 1000);
  return Array.from({ length: count }, (_, i) => ({
    id: `pi_member_${i}`,
    status: "succeeded",
    created,
    metadata: { type: "membership", email: `member${i}@example.com` },
  }));
}

function stripeResponse(data) {
  return { ok: true, json: async () => data };
}

function responseRecorder() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function mockFullStripe() {
  mock.method(globalThis, "fetch", async (url) => {
    const value = String(url);
    if (value.includes("/payment_intents?")) {
      return stripeResponse({ data: activePayments(15), has_more: false });
    }
    if (value.includes("/checkout/sessions?")) {
      return stripeResponse({ data: [], has_more: false });
    }
    throw new Error(`Unexpected Stripe request: ${value}`);
  });
}

test("public capacity endpoint reports zero spots at 15 active memberships", async () => {
  mockFullStripe();
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_capacity";
  try {
    const res = responseRecorder();
    await capacityHandler({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      {
        limit: res.body.limit,
        active: res.body.active,
        spotsAvailable: res.body.spotsAvailable,
        available: res.body.available,
      },
      { limit: 15, active: 15, spotsAvailable: 0, available: false }
    );
  } finally {
    previous === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = previous);
    mock.restoreAll();
  }
});

test("checkout API refuses membership number 16 before creating a payment", async () => {
  mockFullStripe();
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_capacity";
  try {
    const res = responseRecorder();
    await checkoutHandler(
      {
        method: "POST",
        headers: { host: "example.com" },
        body: {
          type: "membership",
          player: "New Player",
          email: "new@example.com",
          sessions: [{ date: "2099-01-01", time: "6:00 PM" }],
        },
      },
      res
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "membership_full");
    assert.match(res.body.error, /all 15 spots/i);
  } finally {
    previous === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = previous);
    mock.restoreAll();
  }
});
