import { test, mock } from "node:test";
import assert from "node:assert/strict";

import packageCheckout from "../api/package-checkout.js";
import {
  PRIVATE_TRAINING_PACKAGE_TYPE,
  isPrivateTrainingPackageType,
  packagePlan,
} from "../lib/privateTrainingPackages.js";
import { isMembershipType } from "../lib/membershipTypes.js";

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

async function checkoutFor(plan, { key = "sk_test_packages", vercelEnv = "preview" } = {}) {
  let stripeBody;
  mock.method(globalThis, "fetch", async (_url, options) => {
    stripeBody = new URLSearchParams(options.body);
    return {
      ok: true,
      json: async () => ({ url: `https://checkout.stripe.com/c/pay_${plan}` }),
    };
  });
  const prevKey = process.env.STRIPE_SECRET_KEY;
  const prevEnv = process.env.VERCEL_ENV;
  const prevPublic = process.env.PUBLIC_BOOKING_ENABLED;
  const prevWrites = process.env.BOOKING_WRITES_ENABLED;
  const prevStore = process.env.BOOKING_STORE;
  process.env.STRIPE_SECRET_KEY = key;
  process.env.VERCEL_ENV = vercelEnv;
  process.env.PUBLIC_BOOKING_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "1";
  process.env.BOOKING_STORE = "postgres";
  try {
    const res = responseRecorder();
    await packageCheckout(
      { method: "GET", query: { plan }, headers: { host: "www.apacademybsb.com" } },
      res
    );
    return { res, stripeBody };
  } finally {
    prevKey === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = prevKey);
    prevEnv === undefined ? delete process.env.VERCEL_ENV : (process.env.VERCEL_ENV = prevEnv);
    prevPublic === undefined
      ? delete process.env.PUBLIC_BOOKING_ENABLED
      : (process.env.PUBLIC_BOOKING_ENABLED = prevPublic);
    prevWrites === undefined
      ? delete process.env.BOOKING_WRITES_ENABLED
      : (process.env.BOOKING_WRITES_ENABLED = prevWrites);
    prevStore === undefined
      ? delete process.env.BOOKING_STORE
      : (process.env.BOOKING_STORE = prevStore);
    mock.restoreAll();
  }
}

test("package helpers never classify packages as memberships", () => {
  assert.equal(isPrivateTrainingPackageType(PRIVATE_TRAINING_PACKAGE_TYPE), true);
  assert.equal(isPrivateTrainingPackageType("custom_player_package"), true);
  assert.equal(isMembershipType(PRIVATE_TRAINING_PACKAGE_TYPE), false);
  assert.equal(isMembershipType("custom_player_package"), false);
  assert.equal(packagePlan("8").amount, 64000);
  assert.equal(packagePlan("12").amount, 96000);
  assert.match(packagePlan("8").name, /2 Days Per Week Private Training/);
  assert.match(packagePlan("12").name, /3 Days Per Week Private Training/);
});

test("8-lesson sendable link creates a one-time $640 Stripe Checkout", async () => {
  const { res, stripeBody } = await checkoutFor("8");
  assert.equal(res.redirectStatus, 303);
  assert.match(res.redirectUrl, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(stripeBody.get("mode"), "payment");
  assert.equal(stripeBody.get("line_items[0][price_data][unit_amount]"), "64000");
  assert.equal(
    stripeBody.get("line_items[0][price_data][product_data][name]"),
    "AP Academy — 2 Days Per Week Private Training"
  );
  assert.equal(stripeBody.get("payment_intent_data[metadata][type]"), PRIVATE_TRAINING_PACKAGE_TYPE);
  assert.equal(stripeBody.get("payment_intent_data[metadata][lessons]"), "8");
  assert.equal(stripeBody.get("payment_intent_data[metadata][weekly]"), "2");
  assert.equal(stripeBody.get("custom_fields[0][label][custom]"), "Player's name");
  assert.equal(stripeBody.get("phone_number_collection[enabled]"), "true");
});

test("12-lesson sendable link creates a one-time $960 Stripe Checkout", async () => {
  const { res, stripeBody } = await checkoutFor("12");
  assert.equal(res.redirectStatus, 303);
  assert.equal(stripeBody.get("mode"), "payment");
  assert.equal(stripeBody.get("line_items[0][price_data][unit_amount]"), "96000");
  assert.equal(
    stripeBody.get("line_items[0][price_data][product_data][name]"),
    "AP Academy — 3 Days Per Week Private Training"
  );
  assert.equal(stripeBody.get("payment_intent_data[metadata][type]"), PRIVATE_TRAINING_PACKAGE_TYPE);
  assert.equal(stripeBody.get("payment_intent_data[metadata][lessons]"), "12");
  assert.equal(stripeBody.get("payment_intent_data[metadata][weekly]"), "3");
});

test("Preview rejects live Stripe keys for package checkout", async () => {
  const { res, stripeBody } = await checkoutFor("8", { key: "sk_live_fake", vercelEnv: "preview" });
  assert.equal(res.statusCode, 503);
  assert.match(String(res.body?.error || ""), /TEST key/i);
  assert.equal(stripeBody, undefined);
});

test("unknown package does not create a Stripe Checkout", async () => {
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Stripe should not be called");
  });
  const prevPublic = process.env.PUBLIC_BOOKING_ENABLED;
  const prevWrites = process.env.BOOKING_WRITES_ENABLED;
  const prevStore = process.env.BOOKING_STORE;
  process.env.PUBLIC_BOOKING_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "1";
  process.env.BOOKING_STORE = "postgres";
  try {
    const res = responseRecorder();
    await packageCheckout(
      { method: "GET", query: { plan: "99" }, headers: { host: "www.apacademybsb.com" } },
      res
    );
    assert.equal(res.statusCode, 400);
  } finally {
    prevPublic === undefined
      ? delete process.env.PUBLIC_BOOKING_ENABLED
      : (process.env.PUBLIC_BOOKING_ENABLED = prevPublic);
    prevWrites === undefined
      ? delete process.env.BOOKING_WRITES_ENABLED
      : (process.env.BOOKING_WRITES_ENABLED = prevWrites);
    prevStore === undefined
      ? delete process.env.BOOKING_STORE
      : (process.env.BOOKING_STORE = prevStore);
    mock.restoreAll();
  }
});
