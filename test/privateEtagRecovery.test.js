// Private capacity ETag safety: conditional writes only when get() and head()
// ETags agree exactly. Never pair a disagreeing get() body with a head() ETag.
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

test("matching get/head ETags allow successful conditional lesson write", async () => {
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

test("different get/head ETags refuse conditional writes (fail closed)", async () => {
  const body = JSON.stringify(KEPT_LESSONS);
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"origin-v2"' });

  setPrivateGetForTests(async () => ({ text: body, etag: '"download-v1"' }));
  setPrivateHeadForTests(async () => ({ etag: '"origin-v2"' }));

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, false);
  assert.equal(read.etag, "");
  assert.match(read.text, /"kept"/);

  const refused = await mutateLessons((data) => {
    data.lessons.push({ id: "should-not-persist", date: DATE, time: TIME });
    return { ok: true };
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.unsafe, true);

  setPrivateGetForTests(null);
  setPrivateHeadForTests(null);
  const again = await blobReadVersioned("lessons.json");
  assert.match(again.text, /"kept"/);
  assert.equal(again.text.includes("should-not-persist"), false);
});

test("missing get ETag fails closed even when head has an ETag", async () => {
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: "" });
  setPrivateGetForTests(async (filename, entry) => ({
    text: entry?.body || JSON.stringify(KEPT_LESSONS),
    etag: "",
  }));
  setPrivateHeadForTests(async () => ({ etag: '"head-only"' }));

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, false);
  assert.equal(read.etag, "");

  const loaded = await loadLessons();
  assert.equal(loaded._conditional, false);
  const refused = await commitLessons(loaded);
  assert.equal(refused.ok, false);
  assert.equal(refused.unsafe, true);
});

test("missing head ETag fails closed when get has an ETag", async () => {
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

test("ABA get/head disagreement never authorizes pairing restored bytes with a newer ETag", async () => {
  // A → B → A: get still reports old download etag; head reports post-ABA version.
  const bodyA = JSON.stringify(KEPT_LESSONS);
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: '"etag-after-aba"' });

  setPrivateGetForTests(async () => ({ text: bodyA, etag: '"etag-before-aba"' }));
  setPrivateHeadForTests(async () => ({ etag: '"etag-after-aba"' }));

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.etag, "");
  assert.equal(read.conditional, false);
  // Body may be readable, but must not become a conditional CAS base.
  assert.equal(read.text, bodyA);

  const refused = await mutateLessons((data) => {
    data.lessons.push({ id: "aba-write" });
    return { ok: true };
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.unsafe, true);

  setPrivateGetForTests(null);
  setPrivateHeadForTests(null);
  const again = await blobReadVersioned("lessons.json");
  assert.match(again.text, /"kept"/);
  assert.equal(again.text.includes("aba-write"), false);
});

test("retry get recovers only when the retried get ETag also matches head", async () => {
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: "" });

  let gets = 0;
  setPrivateGetForTests(async (filename, entry) => {
    gets += 1;
    if (gets === 1) return { text: entry.body, etag: "" };
    seedMemoryPrivateCapacity(filename, KEPT_LESSONS, { etag: '"retry-ok"' });
    return { text: entry.body, etag: '"retry-ok"' };
  });
  setPrivateHeadForTests(async () => ({ etag: '"retry-ok"' }));

  const read = await blobReadVersioned("lessons.json");
  assert.equal(gets, 2);
  assert.equal(read.conditional, true);
  assert.equal(read.etag, '"retry-ok"');

  setPrivateGetForTests(null);
  setPrivateHeadForTests(null);
  const mirrored = await mutateLessons((stored) => {
    upsertStripeLessons(stored, "pi_both", {
      type: "single",
      focus: "Both",
      privacy: "standard",
      seats: "1",
      date1: DATE,
      time1: TIME,
      email: "a@example.com",
      player: "Alex",
    });
    return { ok: true };
  });
  assert.equal(mirrored.ok, true);
  const after = await loadLessons();
  assert.ok(after.lessons.some((l) => l.id === "kept"));
  assert.ok(after.lessons.some((l) => l.id === "pi_both-1"));
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

test("holds fail closed when get/head ETags disagree", async () => {
  seedMemoryPrivateCapacity("holds.json", { holds: [] }, { etag: '"hold-origin"' });
  setPrivateGetForTests(async () => ({ text: JSON.stringify({ holds: [] }), etag: '"hold-download"' }));
  setPrivateHeadForTests(async () => ({ etag: '"hold-origin"' }));

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

test("manual bookings fail closed when get/head ETags disagree", async () => {
  seedMemoryPrivateCapacity("manual-bookings.json", { bookings: [{ id: "mb_old" }] }, { etag: '"mb-origin"' });
  setPrivateGetForTests(async () => ({
    text: JSON.stringify({ bookings: [{ id: "mb_old" }] }),
    etag: '"mb-download"',
  }));
  setPrivateHeadForTests(async () => ({ etag: '"mb-origin"' }));

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

test("memory store without hooks still allows CAS when get/head agree by construction", async () => {
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
