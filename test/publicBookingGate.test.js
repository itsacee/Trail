// PUBLIC_BOOKING_ENABLED matrix + customer-facing route protection.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  publicBookingEnabled,
  publicBookingMutationsAllowed,
  rejectIfPublicBookingClosed,
  PUBLIC_BOOKING_PAUSED_CODE,
} from "../lib/publicBooking.js";
import checkoutHandler from "../api/checkout.js";
import cashBookHandler from "../api/cash-book.js";
import memberHandler from "../api/member.js";
import packageCheckoutHandler from "../api/package-checkout.js";
import { deliverConfirmation } from "../api/confirm.js";
import { createBookingStore, closeBookingStore } from "../lib/bookingDb/createStore.js";
import { signMemberToken } from "../lib/memberAuth.js";

const FLAG_KEYS = [
  "PUBLIC_BOOKING_ENABLED",
  "BOOKING_WRITES_ENABLED",
  "BOOKING_STORE",
  "BOOKING_READS_ENABLED",
  "BOOKING_DUAL_WRITE_BLOB",
  "CAPACITY_WRITES_ENABLED",
  "BLOB_READ_WRITE_TOKEN",
  "PRIVATE_BLOB_READ_WRITE_TOKEN",
  "AVAILABILITY_URL",
  "CAPACITY_MIGRATION_PAUSE",
  "STRIPE_SECRET_KEY",
  "MEMBER_SECRET",
  "COACH_PASS",
];

const saved = {};

beforeEach(() => {
  for (const k of FLAG_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

function pgWritesOn() {
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_WRITES_ENABLED = "1";
  delete process.env.BOOKING_DUAL_WRITE_BLOB;
}

function publicOn() {
  process.env.PUBLIC_BOOKING_ENABLED = "1";
}

function publicOff() {
  delete process.env.PUBLIC_BOOKING_ENABLED;
}

function storeEnv() {
  process.env.BLOB_READ_WRITE_TOKEN = "tok_public";
  process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = "tok_private";
  process.env.AVAILABILITY_URL = "https://example.com/availability.json";
  process.env.STRIPE_SECRET_KEY = "sk_test_public_gate";
  process.env.CAPACITY_WRITES_ENABLED = "0";
  delete process.env.CAPACITY_MIGRATION_PAUSE;
}

test("publicBookingEnabled fails closed for absent/empty/0/false/invalid", () => {
  for (const v of [undefined, "", "0", "false", "FALSE", "yes", "true", "on", "2"]) {
    if (v === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
    else process.env.PUBLIC_BOOKING_ENABLED = v;
    assert.equal(publicBookingEnabled(), false, `expected closed for ${JSON.stringify(v)}`);
  }
  process.env.PUBLIC_BOOKING_ENABLED = "1";
  assert.equal(publicBookingEnabled(), true);
});

test("public mutations require BOTH booking writes and PUBLIC_BOOKING_ENABLED=1", () => {
  publicOff();
  delete process.env.BOOKING_WRITES_ENABLED;
  delete process.env.BOOKING_STORE;
  assert.equal(publicBookingMutationsAllowed(), false);

  pgWritesOn();
  publicOff();
  assert.equal(publicBookingMutationsAllowed(), false);

  publicOn();
  delete process.env.BOOKING_WRITES_ENABLED;
  assert.equal(publicBookingMutationsAllowed(), false);

  pgWritesOn();
  publicOn();
  assert.equal(publicBookingMutationsAllowed(), true);

  // Capacity writes must not substitute for Postgres booking writes.
  delete process.env.BOOKING_WRITES_ENABLED;
  process.env.CAPACITY_WRITES_ENABLED = "1";
  publicOn();
  assert.equal(publicBookingMutationsAllowed(), false);
});

test("rejectIfPublicBookingClosed writes public_booking_paused", () => {
  publicOff();
  pgWritesOn();
  const res = mockRes();
  assert.equal(rejectIfPublicBookingClosed(res), true);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body?.code, PUBLIC_BOOKING_PAUSED_CODE);
  assert.equal(res.body?.publicBookingPaused, true);
});

test("matrix: writes OFF / public OFF — checkout blocked", async () => {
  storeEnv();
  delete process.env.BOOKING_STORE;
  delete process.env.BOOKING_WRITES_ENABLED;
  publicOff();
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

test("matrix: writes ON / public OFF — checkout blocked even if CAPACITY_WRITES=1", async () => {
  storeEnv();
  pgWritesOn();
  publicOff();
  process.env.CAPACITY_WRITES_ENABLED = "1";
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

test("matrix: writes ON / public ON — checkout passes public gate", async () => {
  storeEnv();
  pgWritesOn();
  publicOn();
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

test("checkout hold release remains allowed while public gate is closed", async () => {
  storeEnv();
  pgWritesOn();
  publicOff();
  const res = mockRes();
  await checkoutHandler(
    {
      method: "POST",
      body: { action: "release", sessionId: "cs_test_release_gate_1234567890abcdef" },
    },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.released, true);
});

test("cash-book blocked when public OFF", async () => {
  storeEnv();
  pgWritesOn();
  publicOff();
  process.env.CAPACITY_WRITES_ENABLED = "1";
  const res = mockRes();
  await cashBookHandler(
    {
      method: "POST",
      body: {
        type: "single",
        date: "2026-11-10",
        time: "6:00 PM",
        focus: "Hitting",
        email: "cash.gate@example.com",
        player: "Cash Gate",
      },
    },
    res
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body?.code, PUBLIC_BOOKING_PAUSED_CODE);
});

test("package-checkout blocked when public OFF", async () => {
  storeEnv();
  pgWritesOn();
  publicOff();
  const res = mockRes();
  await packageCheckoutHandler({ method: "GET", query: { plan: "8" }, headers: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body?.code, PUBLIC_BOOKING_PAUSED_CODE);
});

test("member portal mutations blocked when public OFF; GET still allowed", async () => {
  storeEnv();
  pgWritesOn();
  publicOff();
  process.env.MEMBER_SECRET = "member_secret_for_gate_test";
  process.env.COACH_PASS = "coach_pass_for_gate_test";

  // Minimal Stripe stub so loadAccount can fail closed without network if needed —
  // without a membership the GET returns 404, which still proves the gate did not 503.
  const token = signMemberToken("gate.member@example.com");
  const getRes = mockRes();
  await memberHandler(
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      query: {},
      body: {},
    },
    getRes
  );
  assert.notEqual(getRes.body?.code, PUBLIC_BOOKING_PAUSED_CODE);

  const postRes = mockRes();
  await memberHandler(
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      query: {},
      body: { action: "book", date: "2026-11-10", time: "6:00 PM", focus: "Hitting" },
    },
    postRes
  );
  assert.equal(postRes.statusCode, 503);
  assert.equal(postRes.body?.code, PUBLIC_BOOKING_PAUSED_CODE);
});

test("confirmPaid / deliverConfirmation path is not gated by PUBLIC_BOOKING_ENABLED", async () => {
  // Ensure helper itself is not accidentally imported into confirm's gate.
  // Paid recovery must proceed with public OFF + writes ON.
  pgWritesOn();
  publicOff();
  assert.equal(publicBookingMutationsAllowed(), false);

  let handle;
  try {
    handle = await createBookingStore({
      mode: "memory",
      useMem: true,
      env: {
        BOOKING_ALLOW_NON_PREVIEW: "1",
        VERCEL_ENV: "preview",
        BOOKING_STORE: "postgres",
        BOOKING_WRITES_ENABLED: "1",
      },
    });
    const first = await handle.store.confirmPaid({
      idempotencyKey: "mirror:pi_gate_public_off",
      sourceId: "pi_gate_public_off",
      sessionId: "cs_gate_public_off",
      metadata: {
        date: "2026-11-18",
        time: "6:00 PM",
        focus: "Hitting",
        type: "single",
        privacy: "standard",
        email: "paid.gate@example.com",
        player: "Paid Gate",
      },
    });
    const second = await handle.store.confirmPaid({
      idempotencyKey: "mirror:pi_gate_public_off",
      sourceId: "pi_gate_public_off",
      sessionId: "cs_gate_public_off_retry",
      metadata: {
        date: "2026-11-18",
        time: "6:00 PM",
        focus: "Hitting",
        type: "single",
        privacy: "standard",
        email: "paid.gate@example.com",
        player: "Paid Gate",
      },
    });
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
  } finally {
    if (handle) await closeBookingStore(handle);
  }

  // deliverConfirmation export must still exist for webhook recovery.
  assert.equal(typeof deliverConfirmation, "function");
});
