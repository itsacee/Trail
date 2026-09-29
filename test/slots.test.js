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

test("bookedTimes reports seats, so one athlete leaves the hour joinable", async () => {
  const item = {
    id: "pi_one_athlete",
    status: "succeeded",
    metadata: { type: "single", player: "Sam", focus: "Fielding", date1: "2026-09-28", time1: "6:00 PM" },
  };
  mock.method(globalThis, "fetch", async () => stripeResult(item));
  try {
    const rows = await bookedTimes("sk_test", "2026-09-28");
    assert.equal(rows[0].seats, 1);
    assert.equal(rows[0].exclusive, false);
  } finally {
    mock.restoreAll();
  }
});

test("bookedTimes marks a sibling pair and a private hour as exclusive", async () => {
  const pair = {
    id: "pi_two_athletes",
    status: "succeeded",
    metadata: {
      type: "single",
      player: "Sam",
      player2: "Max",
      athletes: "2",
      seats: "2",
      focus: "Fielding",
      date1: "2026-09-28",
      time1: "6:00 PM",
    },
  };
  mock.method(globalThis, "fetch", async () => stripeResult(pair));
  try {
    const rows = await bookedTimes("sk_test", "2026-09-28");
    assert.equal(rows[0].seats, 2);
    assert.equal(rows[0].exclusive, true);
  } finally {
    mock.restoreAll();
  }

  // A private lesson owns the hour even without a seat count on the metadata.
  const priv = {
    id: "pi_private",
    status: "succeeded",
    metadata: { type: "private", player: "Sam", focus: "Fielding", date1: "2026-09-28", time1: "6:00 PM" },
  };
  mock.method(globalThis, "fetch", async () => stripeResult(priv));
  try {
    const rows = await bookedTimes("sk_test", "2026-09-28");
    assert.equal(rows[0].seats, 2);
    assert.equal(rows[0].exclusive, true);
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
