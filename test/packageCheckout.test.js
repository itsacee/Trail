import { test, mock } from "node:test";
import assert from "node:assert/strict";

import packageCheckout from "../api/package-checkout.js";

function responseRecorder() {
  return {
    statusCode: 0,
    body: null,
    redirectStatus: 0,
    redirectUrl: "",
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(code, url) {
      this.redirectStatus = code;
      this.redirectUrl = url;
      return this;
    },
  };
}

async function checkoutFor(plan) {
  let stripeBody;
  mock.method(globalThis, "fetch", async (_url, options) => {
    stripeBody = new URLSearchParams(options.body);
    return {
      ok: true,
      json: async () => ({ url: `https://checkout.stripe.com/c/pay_${plan}` }),
    };
  });
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_packages";
  try {
    const res = responseRecorder();
    await packageCheckout(
      { method: "GET", query: { plan }, headers: { host: "www.apacademybsb.com" } },
      res
    );
    return { res, stripeBody };
  } finally {
    previous === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = previous);
    mock.restoreAll();
  }
}

test("8-lesson sendable link creates a one-time $560 Stripe Checkout", async () => {
  const { res, stripeBody } = await checkoutFor("8");
  assert.equal(res.redirectStatus, 303);
  assert.match(res.redirectUrl, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(stripeBody.get("mode"), "payment");
  assert.equal(stripeBody.get("line_items[0][price_data][unit_amount]"), "56000");
  assert.equal(stripeBody.get("payment_intent_data[metadata][lessons]"), "8");
  assert.equal(stripeBody.get("payment_intent_data[metadata][weekly]"), "2");
  assert.equal(stripeBody.get("payment_intent_data[metadata][price_per_lesson]"), "70");
  assert.equal(stripeBody.get("custom_fields[0][label][custom]"), "Player's name");
  assert.equal(stripeBody.get("phone_number_collection[enabled]"), "true");
});

test("12-lesson sendable link creates a one-time $840 Stripe Checkout", async () => {
  const { res, stripeBody } = await checkoutFor("12");
  assert.equal(res.redirectStatus, 303);
  assert.equal(stripeBody.get("mode"), "payment");
  assert.equal(stripeBody.get("line_items[0][price_data][unit_amount]"), "84000");
  assert.equal(stripeBody.get("payment_intent_data[metadata][lessons]"), "12");
  assert.equal(stripeBody.get("payment_intent_data[metadata][weekly]"), "3");
});

test("unknown package does not create a Stripe Checkout", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("Stripe should not be called");
  });
  const res = responseRecorder();
  await packageCheckout(
    { method: "GET", query: { plan: "10" }, headers: { host: "www.apacademybsb.com" } },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /8-lesson or 12-lesson/);
  assert.equal(fetchMock.mock.callCount(), 0);
  mock.restoreAll();
});
