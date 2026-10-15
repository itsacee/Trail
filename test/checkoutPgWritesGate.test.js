// Checkout reopen requires BOOKING_WRITES + PUBLIC_BOOKING_ENABLED.
// CAPACITY_WRITES alone must never reopen public checkout.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import checkoutHandler from "../api/checkout.js";
import { PUBLIC_BOOKING_PAUSED_CODE } from "../lib/publicBooking.js";

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
    "PUBLIC_BOOKING_ENABLED",
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
  process.env.STRIPE_SECRET_KEY = "sk_test_checkout_gate";
  delete process.env.CAPACITY_MIGRATION_PAUSE;
}

test("checkout stays paused when booking writes on but PUBLIC_BOOKING_ENABLED unset", async () => {
  configureStoreEnv();
  process.env.CAPACITY_WRITES_ENABLED = "0";
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_WRITES_ENABLED = "1";
  delete process.env.PUBLIC_BOOKING_ENABLED;

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
  assert.equal(res.body?.code, PUBLIC_BOOKING_PAUSED_CODE);
  assert.equal(res.body?.publicBookingPaused, true);
});

test("CAPACITY_WRITES_ENABLED cannot bypass the public booking gate", async () => {
  configureStoreEnv();
  process.env.CAPACITY_WRITES_ENABLED = "1";
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_WRITES_ENABLED = "1";
  delete process.env.PUBLIC_BOOKING_ENABLED;

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
  assert.equal(res.body?.code, PUBLIC_BOOKING_PAUSED_CODE);
});

test("checkout passes public gate when BOOKING_WRITES and PUBLIC_BOOKING are both 1", async () => {
  configureStoreEnv();
  process.env.CAPACITY_WRITES_ENABLED = "0";
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_WRITES_ENABLED = "1";
  process.env.PUBLIC_BOOKING_ENABLED = "1";

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
  assert.notEqual(res.body?.code, PUBLIC_BOOKING_PAUSED_CODE);
});
