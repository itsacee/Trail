import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";

import capacityHandler from "../api/membership-capacity.js";
import checkoutHandler from "../api/checkout.js";
import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  blobCompareAndSet,
  blobWrite,
} from "../lib/store.js";

function activePayments(count, type = "membership") {
  const created = Math.floor(Date.now() / 1000);
  return Array.from({ length: count }, (_, i) => ({
    id: `pi_member_${type}_${i}`,
    status: "succeeded",
    created,
    metadata: { type, email: `${type === "membership_private" ? "priv" : "std"}${i}@example.com` },
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

afterEach(() => {
  if (process.env.BLOB_MEMORY_STORE === "1") {
    clearMemoryBlobStore();
    useMemoryBlobStore(false);
  }
});

async function mockStripe({
  standardCount = 0,
  privateCount = 0,
  storedLessons = null,
  membersState = null,
} = {}) {
  useMemoryBlobStore(true);
  clearMemoryBlobStore();
  if (storedLessons) {
    assert.equal((await blobCompareAndSet("lessons.json", storedLessons, "")).ok, true);
  }
  if (membersState) {
    assert.equal(await blobWrite("members.json", membersState), true);
  }
  const payments = [
    ...activePayments(standardCount, "membership"),
    ...activePayments(privateCount, "membership_private"),
  ];
  mock.method(globalThis, "fetch", async (url) => {
    const value = String(url);
    if (value.includes("/payment_intents?")) {
      return stripeResponse({ data: payments, has_more: false });
    }
    if (value.includes("/checkout/sessions?")) {
      return stripeResponse({ data: [], has_more: false });
    }
    throw new Error(`Unexpected Stripe request: ${value}`);
  });
}

test("public capacity endpoint reports separate Standard and Private pools", async () => {
  await mockStripe({ standardCount: 8, privateCount: 1 });
  const previous = process.env.STRIPE_SECRET_KEY;
  const previousNormal = process.env.AP_SITE_NORMAL;
  process.env.STRIPE_SECRET_KEY = "sk_test_capacity";
  process.env.AP_SITE_NORMAL = "1";
  try {
    const res = responseRecorder();
    await capacityHandler({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.standard.limit, 8);
    assert.equal(res.body.standard.active, 8);
    assert.equal(res.body.standard.spotsAvailable, 0);
    assert.equal(res.body.standard.available, false);
    assert.equal(res.body.private.limit, 4);
    assert.equal(res.body.private.active, 1);
    assert.equal(res.body.private.spotsAvailable, 3);
    assert.equal(res.body.private.available, true);
  } finally {
    previous === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = previous);
    previousNormal === undefined
      ? delete process.env.AP_SITE_NORMAL
      : (process.env.AP_SITE_NORMAL = previousNormal);
    mock.restoreAll();
  }
});

function withPublicBookingOpen() {
  const prev = {
    PUBLIC_BOOKING_ENABLED: process.env.PUBLIC_BOOKING_ENABLED,
    BOOKING_STORE: process.env.BOOKING_STORE,
    BOOKING_WRITES_ENABLED: process.env.BOOKING_WRITES_ENABLED,
  };
  process.env.PUBLIC_BOOKING_ENABLED = "1";
  process.env.BOOKING_STORE = "memory";
  process.env.BOOKING_WRITES_ENABLED = "1";
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test("checkout API refuses Standard membership number 9 before creating a payment", async () => {
  await mockStripe({ standardCount: 8, privateCount: 0 });
  const previous = process.env.STRIPE_SECRET_KEY;
  const previousNormal = process.env.AP_SITE_NORMAL;
  const restoreBooking = withPublicBookingOpen();
  process.env.STRIPE_SECRET_KEY = "sk_test_capacity";
  process.env.AP_SITE_NORMAL = "1";
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
          focus: "Both",
          sessions: [{ date: "2099-01-01", time: "6:00 PM" }],
        },
      },
      res
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "membership_full");
    assert.equal(res.body.membershipTier, "standard");
    assert.match(res.body.error, /standard/i);
    assert.match(res.body.error, /all 8 spots/i);
  } finally {
    previous === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = previous);
    previousNormal === undefined
      ? delete process.env.AP_SITE_NORMAL
      : (process.env.AP_SITE_NORMAL = previousNormal);
    restoreBooking();
    mock.restoreAll();
  }
});

test("Private checkout is not membership_full when only Standard is sold out", async () => {
  await mockStripe({ standardCount: 8, privateCount: 0 });
  const previous = process.env.STRIPE_SECRET_KEY;
  const previousNormal = process.env.AP_SITE_NORMAL;
  const restoreBooking = withPublicBookingOpen();
  process.env.STRIPE_SECRET_KEY = "sk_test_capacity";
  process.env.AP_SITE_NORMAL = "1";
  try {
    const res = responseRecorder();
    await checkoutHandler(
      {
        method: "POST",
        headers: { host: "example.com" },
        body: {
          type: "membership_private",
          player: "Private Player",
          email: "private.new@example.com",
          focus: "Hitting",
          sessions: [{ date: "2099-01-01", time: "6:00 PM" }],
        },
      },
      res
    );
    // Must clear the membership capacity gate; later schedule/hold may still fail.
    assert.notEqual(res.body?.code, "membership_full");
    assert.notEqual(res.statusCode, 409);
  } finally {
    previous === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = previous);
    previousNormal === undefined
      ? delete process.env.AP_SITE_NORMAL
      : (process.env.AP_SITE_NORMAL = previousNormal);
    restoreBooking();
    mock.restoreAll();
  }
});

test("checkout API refuses Private membership number 5", async () => {
  await mockStripe({ standardCount: 0, privateCount: 4 });
  const previous = process.env.STRIPE_SECRET_KEY;
  const previousNormal = process.env.AP_SITE_NORMAL;
  const restoreBooking = withPublicBookingOpen();
  process.env.STRIPE_SECRET_KEY = "sk_test_capacity";
  process.env.AP_SITE_NORMAL = "1";
  try {
    const res = responseRecorder();
    await checkoutHandler(
      {
        method: "POST",
        headers: { host: "example.com" },
        body: {
          type: "membership_private",
          player: "New Private",
          email: "newpriv@example.com",
          focus: "Hitting",
          sessions: [{ date: "2099-01-01", time: "6:00 PM" }],
        },
      },
      res
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "membership_full");
    assert.equal(res.body.membershipTier, "private");
    assert.match(res.body.error, /private/i);
    assert.match(res.body.error, /all 4 spots/i);
  } finally {
    previous === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = previous);
    previousNormal === undefined
      ? delete process.env.AP_SITE_NORMAL
      : (process.env.AP_SITE_NORMAL = previousNormal);
    restoreBooking();
    mock.restoreAll();
  }
});

test("cash memberships count toward their category cap", async () => {
  const now = Math.floor(Date.now() / 1000);
  await mockStripe({
    standardCount: 7,
    privateCount: 0,
    membersState: {
      freezeAll: false,
      byEmail: {
        "cash@example.com": {
          email: "cash@example.com",
          cashMembership: true,
          cashMembershipStart: now - 86400,
          cashMembershipEnd: now + 29 * 86400,
          membershipType: "membership",
          privacy: "standard",
        },
      },
    },
  });
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousNormal = process.env.AP_SITE_NORMAL;
  process.env.STRIPE_SECRET_KEY = "sk_test_capacity";
  process.env.AP_SITE_NORMAL = "1";
  try {
    const res = responseRecorder();
    await capacityHandler({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.standard.active, 8);
    assert.equal(res.body.standard.spotsAvailable, 0);
    assert.equal(res.body.standard.available, false);
    assert.equal(res.body.private.available, true);
  } finally {
    previousKey === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = previousKey);
    previousNormal === undefined
      ? delete process.env.AP_SITE_NORMAL
      : (process.env.AP_SITE_NORMAL = previousNormal);
    mock.restoreAll();
  }
});

test("a zero-credit Standard membership opens a Standard spot only", async () => {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  await mockStripe({
    standardCount: 8,
    privateCount: 4,
    storedLessons: {
      voids: [],
      lessons: Array.from({ length: 4 }, (_, i) => ({
        id: `used_${i}`,
        email: "std0@example.com",
        date: today,
        time: `${6 + i}:00 PM`,
        type: "membership",
      })),
    },
  });
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousNormal = process.env.AP_SITE_NORMAL;
  process.env.STRIPE_SECRET_KEY = "sk_test_capacity";
  process.env.AP_SITE_NORMAL = "1";
  try {
    const res = responseRecorder();
    await capacityHandler({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.standard.active, 7);
    assert.equal(res.body.standard.spotsAvailable, 1);
    assert.equal(res.body.standard.available, true);
    assert.equal(res.body.private.active, 4);
    assert.equal(res.body.private.spotsAvailable, 0);
    assert.equal(res.body.private.available, false);
  } finally {
    previousKey === undefined
      ? delete process.env.STRIPE_SECRET_KEY
      : (process.env.STRIPE_SECRET_KEY = previousKey);
    previousNormal === undefined
      ? delete process.env.AP_SITE_NORMAL
      : (process.env.AP_SITE_NORMAL = previousNormal);
    mock.restoreAll();
  }
});
