// Booking persistence under head-bookended private CAS.
// Covers product mirrors, concurrency, failed writes, and webhook retry signaling.
import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  seedMemoryPrivateCapacity,
  setPrivateHeadForTests,
  setPrivateGetForTests,
  setPrivatePutForTests,
} from "../lib/store.js";
import { loadLessons, mutateLessons, upsertStripeLessons, makeMemberLesson } from "../lib/lessons.js";
import { deliverConfirmation } from "../api/confirm.js";
import webhookHandler from "../api/webhook.js";

const DATE = "2026-12-10";

before(() => {
  useMemoryBlobStore(true);
});

after(() => {
  useMemoryBlobStore(false);
  setPrivateHeadForTests(null);
  setPrivateGetForTests(null);
  setPrivatePutForTests(null);
});

beforeEach(() => {
  clearMemoryBlobStore();
  setPrivateHeadForTests(null);
  setPrivateGetForTests(null);
  setPrivatePutForTests(null);
  process.env.CAPACITY_BLOB_CUTOVER = "1";
  process.env.CAPACITY_WRITES_ENABLED = "1";
  delete process.env.CAPACITY_MIGRATION_PAUSE;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_mempublic_test";
  process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_memprivate_test";
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";
  mock.restoreAll();
});

function mirrorMeta(overrides) {
  return {
    type: "single",
    focus: "Hitting",
    privacy: "standard",
    seats: "1",
    player: "Pat",
    email: "pat@example.com",
    date1: DATE,
    time1: "5:00 PM",
    loc1: "mustang",
    ...overrides,
  };
}

async function mirrorPaid(sourceId, meta) {
  return mutateLessons((stored) => {
    const changed = upsertStripeLessons(stored, sourceId, meta);
    if (!changed) return { ok: true, skipSave: true };
    return { ok: true };
  });
}

test("Standard Hitting / Fielding / Both mirrors persist under channel-mismatch get ETags", async () => {
  seedMemoryPrivateCapacity("lessons.json", { lessons: [], voids: [] }, { etag: '"api-0"' });
  setPrivateGetForTests(async (_f, entry) => ({
    text: entry?.body || JSON.stringify({ lessons: [], voids: [] }),
    etag: '"download-x"',
  }));
  setPrivateHeadForTests(async () => ({ etag: '"api-0"' }));

  for (const [id, focus] of [
    ["pi_hit", "Hitting"],
    ["pi_field", "Fielding"],
    ["pi_both", "Both"],
  ]) {
    // Reset head/memory etag alignment for each single-write attempt.
    setPrivateGetForTests(null);
    setPrivateHeadForTests(null);
    const current = await loadLessons();
    seedMemoryPrivateCapacity(
      "lessons.json",
      { lessons: current.lessons, voids: current.voids },
      { etag: `"api-${id}"` }
    );
    setPrivateGetForTests(async (_f, entry) => ({
      text: entry?.body || JSON.stringify({ lessons: [], voids: [] }),
      etag: '"download-x"',
    }));
    setPrivateHeadForTests(async () => ({ etag: `"api-${id}"` }));

    const saved = await mirrorPaid(id, mirrorMeta({ focus, time1: "5:00 PM" }));
    assert.equal(saved.ok, true, focus);
  }

  setPrivateGetForTests(null);
  setPrivateHeadForTests(null);
  const lessons = await loadLessons();
  assert.ok(lessons.lessons.some((l) => l.id === "pi_hit-1" && l.focus === "Hitting"));
  assert.ok(lessons.lessons.some((l) => l.id === "pi_field-1" && l.focus === "Fielding"));
  assert.ok(lessons.lessons.some((l) => l.id === "pi_both-1" && l.focus === "Both"));
});

test("Private lesson mirror persists with privacy=private", async () => {
  const saved = await mirrorPaid(
    "pi_priv",
    mirrorMeta({
      type: "private",
      focus: "Hitting",
      privacy: "private",
      seats: "2",
      time1: "6:00 PM",
    })
  );
  assert.equal(saved.ok, true);
  const row = (await loadLessons()).lessons.find((l) => l.id === "pi_priv-1");
  assert.ok(row);
  assert.equal(row.privacy, "private");
});

test("Membership package lesson rows upsert idempotently", async () => {
  const meta = mirrorMeta({
    type: "membership",
    focus: "Both",
    privacy: "standard",
    time1: "4:00 PM",
  });
  assert.equal((await mirrorPaid("pi_mem_pkg", meta)).ok, true);
  assert.equal((await mirrorPaid("pi_mem_pkg", meta)).ok, true);
  const rows = (await loadLessons()).lessons.filter((l) => String(l.id).startsWith("pi_mem_pkg"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "membership");
});

test("Drop-in / single lesson concurrent mirrors keep both seats without clobber", async () => {
  await mirrorPaid("pi_seed", mirrorMeta({ focus: "Hitting", time1: "3:00 PM" }));

  const [a, b] = await Promise.all([
    mirrorPaid(
      "pi_drop_a",
      mirrorMeta({ focus: "Hitting", time1: "5:00 PM", player: "A", email: "a@example.com" })
    ),
    mirrorPaid(
      "pi_drop_b",
      mirrorMeta({ focus: "Fielding", time1: "6:00 PM", player: "B", email: "b@example.com" })
    ),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const lessons = await loadLessons();
  assert.ok(lessons.lessons.some((l) => l.id === "pi_seed-1"));
  assert.ok(lessons.lessons.some((l) => l.id === "pi_drop_a-1"));
  assert.ok(lessons.lessons.some((l) => l.id === "pi_drop_b-1"));
});

test("Member desk booking via makeMemberLesson persists under CAS", async () => {
  const sub = {
    id: "sub_1",
    email: "member@example.com",
    metadata: { player: "Member", email: "member@example.com" },
    type: "membership",
    credits: 8,
  };
  const saved = await mutateLessons((stored) => {
    stored.lessons.push(
      makeMemberLesson({
        sub,
        date: DATE,
        time: "7:00 PM",
        focus: "Hitting",
        availability: null,
      })
    );
    return { ok: true };
  });
  assert.equal(saved.ok, true);
  const lessons = await loadLessons();
  assert.ok(lessons.lessons.some((l) => l.email === "member@example.com" && l.focus === "Hitting"));
});

test("failed Blob write after paid session reports bookingMirrorFailed (not recorded)", async () => {
  seedMemoryPrivateCapacity("lessons.json", { lessons: [], voids: [] }, { etag: '"v1"' });
  setPrivatePutForTests(async () => {
    const err = new Error("Precondition failed");
    err.name = "BlobPreconditionFailedError";
    throw err;
  });

  mock.method(globalThis, "fetch", async (url) => {
    const path = String(url);
    if (path.includes("/checkout/sessions/cs_fail")) {
      return {
        ok: true,
        json: async () => ({
          id: "cs_fail",
          payment_status: "paid",
          payment_intent: "pi_fail",
          amount_total: 8000,
          created: Math.floor(Date.now() / 1000),
          customer_details: { email: "fail@example.com" },
          metadata: mirrorMeta({ email: "fail@example.com", player: "Fail" }),
        }),
      };
    }
    if (path.includes("/payment_intents/pi_fail")) {
      return {
        ok: true,
        json: async () => ({ id: "pi_fail", created: Math.floor(Date.now() / 1000), metadata: {} }),
      };
    }
    if (path.includes("/checkout/sessions?") || path.includes("/search?")) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    throw new Error(`Unexpected fetch: ${path}`);
  });

  const result = await deliverConfirmation({
    key: "sk_test",
    sessionId: "cs_fail",
    origin: "https://preview.example",
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.bookingMirrorFailed, true);
  assert.equal(result.body.recorded, false);

  setPrivatePutForTests(null);
  const lessons = await loadLessons();
  assert.equal(lessons.lessons.some((l) => String(l.id).startsWith("pi_fail")), false);
});

test("webhook returns 503 on mirror failure so Stripe can retry", async () => {
  seedMemoryPrivateCapacity("lessons.json", { lessons: [], voids: [] }, { etag: '"v1"' });
  setPrivatePutForTests(async () => {
    const err = new Error("Precondition failed");
    err.name = "BlobPreconditionFailedError";
    throw err;
  });

  mock.method(globalThis, "fetch", async (url) => {
    const path = String(url);
    if (path.includes("/checkout/sessions/cs_wh")) {
      return {
        ok: true,
        json: async () => ({
          id: "cs_wh",
          payment_status: "paid",
          payment_intent: "pi_wh",
          amount_total: 8000,
          created: Math.floor(Date.now() / 1000),
          customer_details: { email: "wh@example.com" },
          metadata: mirrorMeta({ email: "wh@example.com", player: "Wh" }),
        }),
      };
    }
    if (path.includes("/payment_intents/pi_wh")) {
      return {
        ok: true,
        json: async () => ({ id: "pi_wh", created: Math.floor(Date.now() / 1000), metadata: {} }),
      };
    }
    if (path.includes("/checkout/sessions?") || path.includes("/search?")) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    throw new Error(`Unexpected fetch: ${path}`);
  });

  delete process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test";

  let statusCode = 0;
  let body = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  await webhookHandler(
    {
      method: "POST",
      headers: { host: "preview.example" },
      body: {
        type: "checkout.session.completed",
        data: { object: { object: "checkout.session", id: "cs_wh" } },
      },
      readableEnded: true,
      bodyUsed: true,
    },
    res
  );

  assert.equal(statusCode, 503);
  assert.equal(body.bookingMirrorFailed, true);
  assert.equal(body.recorded, false);
});

test("webhook retry after recovered writes is idempotent and records once", async () => {
  seedMemoryPrivateCapacity("lessons.json", { lessons: [], voids: [] }, { etag: '"ok"' });

  mock.method(globalThis, "fetch", async (url) => {
    const path = String(url);
    if (path.includes("/checkout/sessions/cs_retry")) {
      return {
        ok: true,
        json: async () => ({
          id: "cs_retry",
          payment_status: "paid",
          payment_intent: "pi_retry_live",
          amount_total: 8000,
          created: Math.floor(Date.now() / 1000),
          customer_details: { email: "retry@example.com" },
          metadata: mirrorMeta({
            email: "retry@example.com",
            player: "Retry",
            focus: "Both",
          }),
        }),
      };
    }
    if (path.includes("/payment_intents/pi_retry_live")) {
      return {
        ok: true,
        json: async () => ({
          id: "pi_retry_live",
          created: Math.floor(Date.now() / 1000),
          metadata: {},
        }),
      };
    }
    if (path.includes("/checkout/sessions?") || path.includes("/search?")) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    throw new Error(`Unexpected fetch: ${path}`);
  });

  const first = await deliverConfirmation({
    key: "sk_test",
    sessionId: "cs_retry",
    origin: "https://preview.example",
  });
  assert.equal(first.status, 200);
  assert.notEqual(first.body.bookingMirrorFailed, true);

  const second = await deliverConfirmation({
    key: "sk_test",
    sessionId: "cs_retry",
    origin: "https://preview.example",
  });
  assert.equal(second.status, 200);

  const lessons = await loadLessons();
  assert.equal(lessons.lessons.filter((l) => l.id === "pi_retry_live-1").length, 1);
});
