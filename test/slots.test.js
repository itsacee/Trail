import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { bookedTimes } from "../api/slots.js";

function stripeResult(item) {
  return {
    ok: true,
    json: async () => ({ data: [item] }),
  };
}

test("bookedTimes exposes focus and counts one payment only once", async () => {
  const item = {
    id: "pi_same_booking",
    status: "succeeded",
    created: 100,
    metadata: {
      type: "single",
      player: "Sam",
      focus: "Hitting",
      date: "2026-09-28",
      time: "6:00 PM",
      date1: "2026-09-28",
      time1: "6:00 PM",
    },
  };
  mock.method(globalThis, "fetch", async () => stripeResult(item));
  try {
    const rows = await bookedTimes("sk_test", "2026-09-28");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].time, "6:00 PM");
    assert.equal(rows[0].count, 1);
    assert.deepEqual(rows[0].focuses, ["Hitting"]);
  } finally {
    mock.restoreAll();
  }
});

test("bookedTimes can exclude the lesson being rescheduled", async () => {
  const item = {
    id: "pi_moving",
    status: "succeeded",
    metadata: {
      type: "membership",
      focus: "Both",
      date1: "2026-09-28",
      time1: "6:00 PM",
    },
  };
  mock.method(globalThis, "fetch", async () => stripeResult(item));
  try {
    const rows = await bookedTimes("sk_test", "2026-09-28", {
      ignoreSourceId: "pi_moving",
    });
    assert.deepEqual(rows, []);
  } finally {
    mock.restoreAll();
  }
});
