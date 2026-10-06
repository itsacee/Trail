import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { fetchBookings } from "../lib/bookings.js";

function response(data) {
  return { ok: true, json: async () => ({ data, has_more: false }) };
}

test("Coach Desk recovers a paid lesson from Checkout Session metadata", async () => {
  mock.method(globalThis, "fetch", async (url) => {
    const path = String(url);
    if (path.includes("/payment_intents?")) return response([]);
    if (path.includes("/subscriptions?")) return response([]);
    if (path.includes("/checkout/sessions?")) {
      return response([
        {
          id: "cs_cashin",
          payment_intent: "pi_cashin",
          payment_status: "paid",
          metadata: {
            player: "Cashin",
            email: "parent@example.com",
            type: "single",
            focus: "Both",
            date1: "2026-10-06",
            time1: "5:00 PM",
          },
        },
      ]);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  try {
    const rows = await fetchBookings("sk_test");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].player, "Cashin");
    assert.equal(rows[0].sourceId, "pi_cashin");
    assert.equal(rows[0].date, "2026-10-06");
  } finally {
    mock.restoreAll();
  }
});

test("Payment Intent and Checkout Session copies appear only once", async () => {
  const metadata = {
    player: "Cashin",
    email: "parent@example.com",
    type: "single",
    date1: "2026-10-06",
    time1: "5:00 PM",
  };
  mock.method(globalThis, "fetch", async (url) => {
    const path = String(url);
    if (path.includes("/payment_intents?")) {
      return response([{ id: "pi_cashin", status: "succeeded", metadata }]);
    }
    if (path.includes("/subscriptions?")) return response([]);
    if (path.includes("/checkout/sessions?")) {
      return response([
        {
          id: "cs_cashin",
          payment_intent: "pi_cashin",
          payment_status: "paid",
          metadata,
        },
      ]);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  try {
    const rows = await fetchBookings("sk_test");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "pi_cashin-1");
  } finally {
    mock.restoreAll();
  }
});
