// What the parent is actually charged. These drive api/checkout.js with a
// mocked Stripe so the amount on the Checkout line item is asserted end to end.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import checkout from "../api/checkout.js";
import { bookingWindow } from "../lib/members.js";
import { getAvailability, allowedTimes, durationFor } from "../lib/schedule.js";

function responseRecorder() {
  return {
    statusCode: 0,
    body: null,
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

// A day and time the booking form would really offer, found from the live
// availability and booking window so this doesn't rot as the calendar moves.
async function bookableSlot(type) {
  const availability = await getAvailability();
  for (const date of bookingWindow().dates) {
    const times = allowedTimes(date, availability, durationFor(type));
    if (times.length) return { date, time: times[0] };
  }
  throw new Error("no bookable slot in the current window");
}

async function checkoutWith(body) {
  let stripeBody;
  mock.method(globalThis, "fetch", async (url, options) => {
    const target = String(url);
    // Only the POST creates the Checkout session; the GET of the same path is
    // the membership-capacity lookup for open checkouts.
    if (target.includes("/v1/checkout/sessions") && options?.method === "POST") {
      stripeBody = new URLSearchParams(options.body);
      return {
        ok: true,
        json: async () => ({ id: "cs_test_private", url: "https://checkout.stripe.com/c/pay_test" }),
      };
    }
    // Slot lookups and anything else: nothing is on the books.
    return { ok: true, json: async () => ({ data: [] }) };
  });
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_checkout";
  try {
    const res = responseRecorder();
    await checkout({ method: "POST", body, headers: { host: "www.apacademybsb.com" } }, res);
    return { res, stripeBody };
  } finally {
    previous === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = previous);
    mock.restoreAll();
  }
}

const base = {
  player: "Sam Boyd",
  email: "boyd@example.com",
  phone: "4055550199",
  focus: "Fielding",
};

test("a solo private hour charges the $100 premium", async () => {
  const slot = await bookableSlot("private");
  const { res, stripeBody } = await checkoutWith({ ...base, type: "private", sessions: [slot] });

  assert.equal(res.statusCode, 200);
  assert.equal(stripeBody.get("line_items[0][price_data][unit_amount]"), "10000");
  assert.equal(stripeBody.get("metadata[athletes]"), "1");
  // Solo or not, a private hour owns both seats.
  assert.equal(stripeBody.get("metadata[seats]"), "2");
});

test("a private hour for two of your own athletes charges $80 each, not the premium", async () => {
  const slot = await bookableSlot("private");
  const { res, stripeBody } = await checkoutWith({
    ...base,
    type: "private",
    player2: "Max Boyd",
    sessions: [slot],
  });

  assert.equal(res.statusCode, 200);
  assert.equal(stripeBody.get("line_items[0][price_data][unit_amount]"), "16000");
  assert.equal(stripeBody.get("metadata[athletes]"), "2");
  assert.equal(stripeBody.get("metadata[seats]"), "2");
  assert.equal(stripeBody.get("metadata[player2]"), "Max Boyd");
  assert.match(
    stripeBody.get("line_items[0][price_data][product_data][name]"),
    /just your two athletes/
  );
});

test("a regular hour still charges per athlete", async () => {
  const slot = await bookableSlot("single");
  const solo = await checkoutWith({ ...base, type: "single", sessions: [slot] });
  assert.equal(solo.stripeBody.get("line_items[0][price_data][unit_amount]"), "8000");
  assert.equal(solo.stripeBody.get("metadata[seats]"), "1");

  const pair = await checkoutWith({ ...base, type: "single", player2: "Max Boyd", sessions: [slot] });
  assert.equal(pair.stripeBody.get("line_items[0][price_data][unit_amount]"), "16000");
  // Two names fill the hour, so nobody else can join it.
  assert.equal(pair.stripeBody.get("metadata[seats]"), "2");
});

test("a 30-minute pair charges per athlete too", async () => {
  const slot = await bookableSlot("thirty");
  const { stripeBody } = await checkoutWith({
    ...base,
    type: "thirty",
    player2: "Max Boyd",
    sessions: [slot],
  });
  assert.equal(stripeBody.get("line_items[0][price_data][unit_amount]"), "12000");
  assert.equal(stripeBody.get("metadata[athletes]"), "2");
});
