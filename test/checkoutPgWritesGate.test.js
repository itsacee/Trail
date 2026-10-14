// Checkout may reopen when BOOKING_WRITES_ENABLED is on without CAPACITY_WRITES.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import checkoutHandler from "../api/checkout.js";

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const saved = {};

beforeEach(() => {
  for (const k of [
    "CAPACITY_WRITES_ENABLED",
    "BOOKING_WRITES_ENABLED",
    "BOOKING_STORE",
    "BOOKING_READS_ENABLED",
    "BLOB_READ_WRITE_TOKEN",
    "PRIVATE_BLOB_READ_WRITE_TOKEN",
    "AVAILABILITY_URL",
    "CAPACITY_MIGRATION_PAUSE",
    "STRIPE_SECRET_KEY",
  ]) {
    saved[k] = process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function configureStoreEnv() {
  process.env.BLOB_READ_WRITE_TOKEN = "tok_public";
  process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = "tok_private";
  process.env.AVAILABILITY_URL = "https://example.com/availability.json";
  // Stripe is checked before the capacity pause gate.
  process.env.STRIPE_SECRET_KEY = "sk_test_checkout_gate";
  delete process.env.CAPACITY_MIGRATION_PAUSE;
}

test("checkout stays paused when store configured and both write flags off", async () => {
  configureStoreEnv();
  // Explicit 0 — memory store treats unset CAPACITY_WRITES as enabled.
  process.env.CAPACITY_WRITES_ENABLED = "0";
  delete process.env.BOOKING_WRITES_ENABLED;
  delete process.env.BOOKING_STORE;

  const res = mockRes();
  await checkoutHandler(
    {
      method: "POST",
      body: {
        type: "single",
        date: "2026-11-10",
        time: "6:00 PM",
        focus: "Hitting",
        email: "gate@example.com",
        player: "Gate",
      },
    },
    res
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body?.code, "schedule_unavailable");
  assert.equal(res.body?.capacityWritesPaused, true);
  assert.match(String(res.body?.error || ""), /restore the calendar/);
});

test("checkout is not paused by capacity gate when BOOKING_WRITES_ENABLED=1", async () => {
  configureStoreEnv();
  process.env.CAPACITY_WRITES_ENABLED = "0";
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_WRITES_ENABLED = "1";
  // Invalid date fails later validation — proves we passed the capacity pause gate.
  const res = mockRes();
  await checkoutHandler(
    {
      method: "POST",
      body: {
        type: "single",
        date: "not-a-date",
        time: "6:00 PM",
        focus: "Hitting",
        email: "gate@example.com",
        player: "Gate",
      },
    },
    res
  );
  const pausedByCapacity =
    res.statusCode === 503 &&
    res.body?.code === "schedule_unavailable" &&
    res.body?.capacityWritesPaused === true &&
    String(res.body?.error || "").includes("restore the calendar");
  assert.equal(pausedByCapacity, false);
});
