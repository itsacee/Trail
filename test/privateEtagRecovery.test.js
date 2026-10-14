// Private capacity ETag safety: head-bookended CAS.
// put(ifMatch) uses Blob-API head() ETags; get() download ETags are ignored for CAS.
import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  blobCompareAndSet,
  blobReadVersioned,
  seedMemoryPrivateCapacity,
  setPrivateHeadForTests,
  setPrivateGetForTests,
  setPrivatePutForTests,
  etagFromGetResult,
  PRIVATE_CAPACITY_BOOKEND_ATTEMPTS,
} from "../lib/store.js";
import { loadLessons, mutateLessons, commitLessons, upsertStripeLessons } from "../lib/lessons.js";
import { placeHold, releaseHold, loadHolds } from "../lib/holds.js";
import { mutateManualBookings, loadManualBookings } from "../lib/manualBookings.js";
import { deliverConfirmation } from "../api/confirm.js";

const DATE = "2026-11-20";
const TIME = "6:00 PM";

const KEPT_LESSONS = {
  lessons: [
    {
      id: "kept",
      date: DATE,
      time: "5:00 PM",
      focus: "Hitting",
      privacy: "standard",
      seats: 1,
      type: "single",
    },
  ],
  voids: [],
};

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

test("etagFromGetResult only accepts etag from the same get() result", () => {
  assert.equal(etagFromGetResult(null), "");
  assert.equal(etagFromGetResult({ statusCode: 304, blob: { etag: '"x"' } }), "");
  assert.equal(
    etagFromGetResult({
      statusCode: 200,
      blob: { etag: '"from-blob"' },
      headers: { get: () => '"from-header"' },
    }),
    '"from-blob"'
  );
  assert.equal(
    etagFromGetResult({
      statusCode: 200,
      blob: {},
      headers: { get: (n) => (n === "etag" ? '"from-header"' : "") },
    }),
    '"from-header"'
  );
});

test("stable head bookend allows successful conditional lesson write", async () => {
  const body = JSON.stringify(KEPT_LESSONS);
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"v-agree"' });

  setPrivateGetForTests(async () => ({ text: body, etag: '"v-agree"' }));
  setPrivateHeadForTests(async () => ({ etag: '"v-agree"' }));

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, true);
  assert.equal(read.etag, '"v-agree"');
  assert.match(read.text, /"kept"/);

  setPrivateGetForTests(null);
  setPrivateHeadForTests(null);

  const mirrored = await mutateLessons((stored) => {
    upsertStripeLessons(stored, "pi_new", {
      type: "single",
      focus: "Both",
      privacy: "standard",
      seats: "1",
      player: "Sam",
      email: "sam@example.com",
      date1: DATE,
      time1: TIME,
    });
    return { ok: true };
  });
  assert.equal(mirrored.ok, true);

  const after = await loadLessons();
  assert.ok(after.lessons.some((l) => l.id === "kept"));
  assert.ok(after.lessons.some((l) => l.id === "pi_new-1"));
});

test("download get ETag differing from head API ETag still allows CAS when bookend is stable", async () => {
  // Live Preview symptom: get() download ETag != head()/put() API ETag.
  const body = JSON.stringify(KEPT_LESSONS);
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"api-v2"' });

  setPrivateGetForTests(async () => ({ text: body, etag: '"download-v1"' }));
  setPrivateHeadForTests(async () => ({ etag: '"api-v2"' }));

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, true);
  assert.equal(read.etag, '"api-v2"');
  assert.match(read.text, /"kept"/);

  const mirrored = await mutateLessons((stored) => {
    upsertStripeLessons(stored, "pi_channel", {
      type: "single",
      focus: "Hitting",
      privacy: "standard",
      seats: "1",
      player: "Chan",
      email: "chan@example.com",
      date1: DATE,
      time1: TIME,
    });
    return { ok: true };
  });
  assert.equal(mirrored.ok, true);

  setPrivateGetForTests(null);
  setPrivateHeadForTests(null);
  const after = await loadLessons();
  assert.ok(after.lessons.some((l) => l.id === "kept"));
  assert.ok(after.lessons.some((l) => l.id === "pi_channel-1"));
});

test("missing get download ETag does not block CAS when head bookend is stable", async () => {
  const body = JSON.stringify(KEPT_LESSONS);
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"head-only"' });
  setPrivateGetForTests(async () => ({ text: body, etag: "" }));
  setPrivateHeadForTests(async () => ({ etag: '"head-only"' }));

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, true);
  assert.equal(read.etag, '"head-only"');

  const mirrored = await mutateLessons((stored) => {
    upsertStripeLessons(stored, "pi_no_get_etag", {
      type: "single",
      focus: "Fielding",
      privacy: "standard",
      seats: "1",
      date1: DATE,
      time1: TIME,
      email: "n@example.com",
      player: "NoGet",
    });
    return { ok: true };
  });
  assert.equal(mirrored.ok, true);
});

test("missing head ETag fails closed even when get has a download ETag", async () => {
  const body = JSON.stringify(KEPT_LESSONS);
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"get-only"' });
  setPrivateGetForTests(async () => ({ text: body, etag: '"get-only"' }));
  setPrivateHeadForTests(async () => ({ etag: "" }));

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, false);
  assert.equal(read.etag, "");

  const refused = await mutateLessons((data) => {
    data.lessons.push({ id: "nope" });
    return { ok: true };
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.unsafe, true);
});

test("head bookend mismatch fails closed and never clobbers existing lessons", async () => {
  const body = JSON.stringify(KEPT_LESSONS);
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"v-final"' });

  let heads = 0;
  setPrivateGetForTests(async () => ({ text: body, etag: '"ignored-download"' }));
  setPrivateHeadForTests(async () => {
    heads += 1;
    // Alternate so every bookend attempt sees H1 !== H2.
    return { etag: heads % 2 === 1 ? '"v-before"' : '"v-after"' };
  });

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, false);
  assert.equal(read.etag, "");
  assert.equal(read.text, body);
  assert.ok(heads >= PRIVATE_CAPACITY_BOOKEND_ATTEMPTS * 2);

  const refused = await mutateLessons((data) => {
    data.lessons.push({ id: "bookend-write" });
    return { ok: true };
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.unsafe, true);

  setPrivateGetForTests(null);
  setPrivateHeadForTests(null);
  const again = await blobReadVersioned("lessons.json");
  assert.match(again.text, /"kept"/);
  assert.equal(again.text.includes("bookend-write"), false);
});

test("transient head bookend mismatch recovers on a later stable attempt", async () => {
  const body = JSON.stringify(KEPT_LESSONS);
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"stable"' });

  let heads = 0;
  setPrivateGetForTests(async () => ({ text: body, etag: '"download"' }));
  setPrivateHeadForTests(async () => {
    heads += 1;
    // First bookend unstable (H1!=H2), second bookend stable.
    if (heads <= 2) {
      return { etag: heads === 1 ? '"t1"' : '"t2"' };
    }
    return { etag: '"stable"' };
  });

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, true);
  assert.equal(read.etag, '"stable"');
  assert.ok(heads >= 4);
});

test("concurrent modification between agreed read and put surfaces conflict without clobber", async () => {
  assert.equal(
    await placeHold("cs_a", [{ date: DATE, time: TIME }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    true
  );
  const snap = await loadHolds();
  const stale = snap._etag;
  assert.ok(stale);

  assert.equal(
    await placeHold("cs_b", [{ date: DATE, time: "7:00 PM" }], 60, "Fielding", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    true
  );

  const conflict = await blobCompareAndSet("holds.json", { holds: [{ sessionId: "cs_stale" }] }, stale);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);

  const final = await loadHolds();
  assert.equal(final.holds.length, 2);
  assert.ok(final.holds.some((h) => h.sessionId === "cs_a"));
  assert.ok(final.holds.some((h) => h.sessionId === "cs_b"));
  assert.ok(!final.holds.some((h) => h.sessionId === "cs_stale"));
});

test("repeated cas_precondition_failed preserves existing lessons across mutate retries", async () => {
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"v1"' });

  let putCalls = 0;
  setPrivatePutForTests(async () => {
    putCalls += 1;
    const err = new Error("Precondition failed: ETag mismatch.");
    err.name = "BlobPreconditionFailedError";
    throw err;
  });

  const result = await mutateLessons((stored) => {
    upsertStripeLessons(stored, "pi_blocked", {
      type: "single",
      focus: "Hitting",
      privacy: "standard",
      seats: "1",
      date1: DATE,
      time1: TIME,
      email: "x@example.com",
      player: "X",
    });
    return { ok: true };
  });

  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(result.exhausted, true);
  assert.ok(putCalls >= 5);

  setPrivatePutForTests(null);
  const after = await loadLessons();
  assert.equal(after.lessons.length, 1);
  assert.equal(after.lessons[0].id, "kept");
  assert.equal(after.lessons.some((l) => String(l.id).startsWith("pi_blocked")), false);
});

test("holds and manual-booking updates preserve existing rows under CAS", async () => {
  assert.equal(
    await placeHold("cs_hold", [{ date: DATE, time: TIME }], 60, "Both", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    true
  );

  const manual = await mutateManualBookings((data) => {
    data.bookings.push({
      id: "mb_1",
      date: DATE,
      time: "5:00 PM",
      focus: "Hitting",
      privacy: "standard",
      seats: 1,
      type: "single",
      player: "Cash",
      status: "active",
    });
    return { ok: true };
  });
  assert.equal(manual.ok, true);

  assert.equal(await releaseHold("cs_hold"), true);
  assert.equal((await loadHolds()).holds.length, 0);

  const again = await mutateManualBookings((data) => {
    data.bookings.push({
      id: "mb_2",
      date: DATE,
      time: "7:00 PM",
      focus: "Fielding",
      privacy: "standard",
      seats: 1,
      type: "single",
      player: "Two",
      status: "active",
    });
    return { ok: true };
  });
  assert.equal(again.ok, true);
  const bookings = await loadManualBookings();
  assert.deepEqual(
    bookings.bookings.map((b) => b.id).sort(),
    ["mb_1", "mb_2"]
  );
});

test("holds fail closed when head bookend is unstable", async () => {
  seedMemoryPrivateCapacity("holds.json", { holds: [] }, { etag: '"hold-origin"' });
  let heads = 0;
  setPrivateGetForTests(async () => ({ text: JSON.stringify({ holds: [] }), etag: '"hold-download"' }));
  setPrivateHeadForTests(async () => {
    heads += 1;
    return { etag: heads % 2 === 1 ? '"h1"' : '"h2"' };
  });

  assert.equal(
    await placeHold("cs_recover", [{ date: DATE, time: TIME }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    false
  );

  setPrivateGetForTests(null);
  setPrivateHeadForTests(null);
  const holds = await loadHolds();
  assert.equal(holds.holds.length, 0);
});

test("manual bookings fail closed when head bookend is unstable", async () => {
  seedMemoryPrivateCapacity("manual-bookings.json", { bookings: [{ id: "mb_old" }] }, { etag: '"mb-origin"' });
  let heads = 0;
  setPrivateGetForTests(async () => ({
    text: JSON.stringify({ bookings: [{ id: "mb_old" }] }),
    etag: '"mb-download"',
  }));
  setPrivateHeadForTests(async () => {
    heads += 1;
    return { etag: heads % 2 === 1 ? '"m1"' : '"m2"' };
  });

  const saved = await mutateManualBookings((data) => {
    data.bookings.push({
      id: "mb_new",
      date: DATE,
      time: TIME,
      focus: "Both",
      privacy: "standard",
      seats: 1,
      type: "single",
      status: "active",
    });
    return { ok: true };
  });
  assert.equal(saved.ok, false);
  assert.equal(saved.unsafe, true);

  setPrivateGetForTests(null);
  setPrivateHeadForTests(null);
  const rows = await loadManualBookings();
  assert.deepEqual(
    rows.bookings.map((b) => b.id),
    ["mb_old"]
  );
});

test("successful lesson mirroring and hold release preserve prior lessons", async () => {
  assert.equal(
    await placeHold("cs_pay", [{ date: DATE, time: TIME }], 60, "Both", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    true
  );
  const prior = await mutateLessons((data) => {
    data.lessons = [
      {
        id: "prior-1",
        date: DATE,
        time: "5:00 PM",
        focus: "Hitting",
        privacy: "standard",
        seats: 1,
        type: "single",
        source: "stripe",
        sourceId: "pi_prior",
      },
    ];
    return { ok: true };
  });
  assert.equal(prior.ok, true);

  mock.method(globalThis, "fetch", async (url) => {
    const path = String(url);
    if (path.includes("/checkout/sessions/cs_pay")) {
      return {
        ok: true,
        json: async () => ({
          id: "cs_pay",
          payment_status: "paid",
          payment_intent: "pi_pay",
          amount_total: 8000,
          created: Math.floor(Date.now() / 1000),
          customer_details: { email: "pay@example.com" },
          metadata: {
            type: "single",
            focus: "Both",
            privacy: "standard",
            seats: "1",
            player: "Pat",
            email: "pay@example.com",
            date1: DATE,
            time1: TIME,
            loc1: "mustang",
          },
        }),
      };
    }
    if (path.includes("/payment_intents/pi_pay")) {
      return {
        ok: true,
        json: async () => ({
          id: "pi_pay",
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

  const result = await deliverConfirmation({
    key: "sk_test",
    sessionId: "cs_pay",
    origin: "https://preview.example",
  });
  assert.equal(result.status, 200);
  assert.notEqual(result.body.bookingMirrorFailed, true);
  assert.equal((await loadHolds()).holds.length, 0);

  const lessons = await loadLessons();
  assert.ok(lessons.lessons.some((l) => l.id === "prior-1"));
  assert.ok(lessons.lessons.some((l) => l.id === "pi_pay-1" && l.focus === "Both" && l.privacy === "standard"));
});

test("channel-mismatch bookend still mirrors paid Stripe lesson via confirm path", async () => {
  // Simulate live Preview: get download ETag differs from head API ETag, bookend stable.
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"api-stable"' });
  setPrivateGetForTests(async (_filename, entry) => ({
    text: entry?.body || JSON.stringify(KEPT_LESSONS),
    etag: '"download-other"',
  }));
  setPrivateHeadForTests(async () => ({ etag: '"api-stable"' }));

  mock.method(globalThis, "fetch", async (url) => {
    const path = String(url);
    if (path.includes("/checkout/sessions/cs_channel")) {
      return {
        ok: true,
        json: async () => ({
          id: "cs_channel",
          payment_status: "paid",
          payment_intent: "pi_channel_pay",
          amount_total: 8000,
          created: Math.floor(Date.now() / 1000),
          customer_details: { email: "c@example.com" },
          metadata: {
            type: "single",
            focus: "Hitting",
            privacy: "standard",
            seats: "1",
            player: "Cy",
            email: "c@example.com",
            date1: DATE,
            time1: TIME,
            loc1: "mustang",
          },
        }),
      };
    }
    if (path.includes("/payment_intents/pi_channel_pay")) {
      return {
        ok: true,
        json: async () => ({
          id: "pi_channel_pay",
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

  const result = await deliverConfirmation({
    key: "sk_test",
    sessionId: "cs_channel",
    origin: "https://preview.example",
  });
  assert.equal(result.status, 200);
  assert.notEqual(result.body.bookingMirrorFailed, true);

  setPrivateGetForTests(null);
  setPrivateHeadForTests(null);
  const lessons = await loadLessons();
  assert.ok(lessons.lessons.some((l) => l.id === "kept"));
  assert.ok(lessons.lessons.some((l) => l.id === "pi_channel_pay-1"));
});

test("memory store without hooks still allows CAS when head bookend agrees by construction", async () => {
  const seeded = await mutateLessons((data) => {
    data.lessons = [
      {
        id: "seed-1",
        date: DATE,
        time: "5:00 PM",
        focus: "Hitting",
        privacy: "standard",
        seats: 1,
        type: "single",
        source: "stripe",
        sourceId: "pi_seed",
      },
    ];
    data.voids = [];
    return { ok: true };
  });
  assert.equal(seeded.ok, true);

  const before = await loadLessons();
  assert.ok(before._etag);
  assert.equal(before._conditional, true);

  const mirrored = await mutateLessons((stored) => {
    upsertStripeLessons(stored, "pi_mem", {
      type: "single",
      focus: "Fielding",
      privacy: "standard",
      seats: "1",
      date1: DATE,
      time1: TIME,
      email: "m@example.com",
      player: "Mem",
    });
    return { ok: true };
  });
  assert.equal(mirrored.ok, true);
  const after = await loadLessons();
  assert.ok(after.lessons.some((l) => l.id === "seed-1"));
  assert.ok(after.lessons.some((l) => l.id === "pi_mem-1"));
});

test("commitLessons refuses unconditional overwrite when bookend cannot authorize", async () => {
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"v1"' });
  setPrivateGetForTests(async () => ({ text: JSON.stringify(KEPT_LESSONS), etag: '"d"' }));
  let heads = 0;
  setPrivateHeadForTests(async () => {
    heads += 1;
    return { etag: heads % 2 === 1 ? '"a"' : '"b"' };
  });

  const loaded = await loadLessons();
  assert.equal(loaded._conditional, false);
  const refused = await commitLessons(loaded);
  assert.equal(refused.ok, false);
  assert.equal(refused.unsafe, true);
});
