// Private capacity ETag safety: body + ETag only from one get() response.
// Never pair get() body with head() ETag (TOCTOU / ABA). Fail closed otherwise.
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
});

beforeEach(() => {
  clearMemoryBlobStore();
  setPrivateHeadForTests(null);
  setPrivateGetForTests(null);
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

test("existing private Blob with valid ETag allows conditional lesson update", async () => {
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
  assert.equal(before.lessons.length, 1);

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
  assert.equal(after.lessons.length, 2);
  assert.ok(after.lessons.some((l) => l.id === "seed-1"));
  assert.ok(after.lessons.some((l) => l.id === "pi_new-1"));
});

test("missing ETag from get() fails closed (no unconditional overwrite)", async () => {
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: "" });

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, false);
  assert.equal(read.etag, "");
  assert.match(read.text, /"kept"/);

  const loaded = await loadLessons();
  assert.equal(loaded._conditional, false);
  loaded.lessons.push({ id: "should-not-persist", date: DATE, time: TIME });
  const refused = await commitLessons(loaded);
  assert.equal(refused.ok, false);
  assert.equal(refused.unsafe, true);

  const again = await blobReadVersioned("lessons.json");
  assert.match(again.text, /"kept"/);
  assert.equal(again.text.includes("should-not-persist"), false);
});

test("retry get() recovers only when the same response has body and ETag", async () => {
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: "" });

  let getCalls = 0;
  setPrivateGetForTests(async (filename, entry) => {
    getCalls += 1;
    assert.equal(filename, "lessons.json");
    if (getCalls === 1) {
      return { text: entry.body, etag: "" };
    }
    // Same-response recovery: body + etag from this get() only.
    seedMemoryPrivateCapacity(filename, KEPT_LESSONS, { etag: '"retry-etag-1"' });
    return { text: entry.body, etag: '"retry-etag-1"' };
  });

  const read = await blobReadVersioned("lessons.json");
  assert.equal(getCalls, 2);
  assert.equal(read.conditional, true);
  assert.equal(read.etag, '"retry-etag-1"');
  assert.match(read.text, /"kept"/);

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

test("concurrent update between get() and head() never pairs stale body with newer ETag", async () => {
  const staleBody = JSON.stringify(KEPT_LESSONS);
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: "" });

  let headCalls = 0;
  setPrivateGetForTests(async () => {
    // get() omits etag; body is the pre-update version.
    return { text: staleBody, etag: "" };
  });
  setPrivateHeadForTests(async () => {
    headCalls += 1;
    // Concurrent writer landed; head sees a newer object version.
    return { etag: '"newer-after-concurrent-write"' };
  });

  const read = await blobReadVersioned("lessons.json");
  assert.ok(headCalls >= 1);
  assert.equal(read.etag, "");
  assert.equal(read.conditional, false);
  assert.equal(read.text, staleBody);

  const refused = await mutateLessons((data) => {
    data.lessons.push({ id: "clobber", date: DATE, time: TIME });
    return { ok: true };
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.unsafe, true);

  const again = await blobReadVersioned("lessons.json");
  assert.match(again.text, /"kept"/);
  assert.equal(again.text.includes("clobber"), false);
});

test("concurrent update between head() and a subsequent get() is not used for CAS pairing", async () => {
  // Simulates the unsafe ordering head→get: head etag must never be attached
  // to a later get() body, even when bodies look related.
  const bodyA = JSON.stringify(KEPT_LESSONS);
  const bodyB = JSON.stringify({
    lessons: [...KEPT_LESSONS.lessons, { id: "concurrent", date: DATE, time: TIME }],
    voids: [],
  });
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: "" });

  let gets = 0;
  setPrivateGetForTests(async () => {
    gets += 1;
    // Both gets lack etag so recovery falls through to diagnostic head.
    if (gets === 1) return { text: bodyA, etag: "" };
    return { text: bodyB, etag: "" };
  });
  setPrivateHeadForTests(async () => ({ etag: '"head-only-etag"' }));

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, false);
  assert.equal(read.etag, "");
  // Readable body may be returned, but never with the unpaired head etag.
  assert.ok(read.text === bodyA || read.text === bodyB);

  const cas = await blobCompareAndSet(
    "lessons.json",
    { lessons: [{ id: "unsafe" }], voids: [] },
    '"head-only-etag"'
  );
  assert.equal(cas.ok, false);
  assert.equal(cas.conflict, true);
});

test("ABA content change cannot authorize pairing a body with a later ETag", async () => {
  // A → B → A: contents return to original bytes, but the object version (ETag)
  // is new. Matching bodies across reads is not a safe version check.
  const bodyA = JSON.stringify(KEPT_LESSONS);
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: "" });

  setPrivateGetForTests(async () => ({ text: bodyA, etag: "" }));
  setPrivateHeadForTests(async () => {
    // After ABA, head reports the restored-A version etag — still unpaired.
    return { etag: '"etag-after-aba-restore"' };
  });

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.text, bodyA);
  assert.equal(read.etag, "");
  assert.equal(read.conditional, false);

  const refused = await commitLessons({
    lessons: [...KEPT_LESSONS.lessons, { id: "aba-write" }],
    voids: [],
    _etag: '"etag-after-aba-restore"',
    _conditional: true,
  });
  // commitLessons only uses _etag when _conditional is set on a loaded object;
  // force the unsafe path via blobCompareAndSet with the unpaired ABA etag.
  assert.equal(refused.ok, false);

  const cas = await blobCompareAndSet(
    "lessons.json",
    { lessons: [...KEPT_LESSONS.lessons, { id: "aba-write" }], voids: [] },
    '"etag-after-aba-restore"'
  );
  assert.equal(cas.ok, false);
  assert.equal(cas.conflict, true);

  const again = await blobReadVersioned("lessons.json");
  assert.match(again.text, /"kept"/);
  assert.equal(again.text.includes("aba-write"), false);
});

test("missing ETag from both get() attempts stays fail-closed even if head has one", async () => {
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: "" });
  setPrivateHeadForTests(async () => ({ etag: '"present-but-unpaired"' }));

  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.conditional, false);
  assert.equal(read.etag, "");

  const result = await mutateLessons((data) => {
    data.lessons.push({ id: "intruder" });
    return { ok: true };
  });
  assert.equal(result.ok, false);
  assert.equal(result.unsafe, true);

  const again = await blobReadVersioned("lessons.json");
  assert.match(again.text, /"kept"/);
  assert.equal(again.text.includes("intruder"), false);
});

test("version-consistent retry get() after concurrent update uses the new body+etag together", async () => {
  seedMemoryPrivateCapacity("lessons.json", KEPT_LESSONS, { etag: "" });

  const updated = {
    lessons: [
      ...KEPT_LESSONS.lessons,
      {
        id: "from-concurrent",
        date: DATE,
        time: "7:00 PM",
        focus: "Fielding",
        privacy: "standard",
        seats: 1,
        type: "single",
      },
    ],
    voids: [],
  };

  let gets = 0;
  setPrivateGetForTests(async (filename) => {
    gets += 1;
    if (gets === 1) {
      return { text: JSON.stringify(KEPT_LESSONS), etag: "" };
    }
    seedMemoryPrivateCapacity(filename, updated, { etag: '"v-after-race"' });
    return { text: JSON.stringify(updated), etag: '"v-after-race"' };
  });

  const read = await blobReadVersioned("lessons.json");
  assert.equal(gets, 2);
  assert.equal(read.etag, '"v-after-race"');
  assert.equal(read.conditional, true);
  assert.match(read.text, /"from-concurrent"/);
  assert.match(read.text, /"kept"/);

  setPrivateGetForTests(null);
  const mirrored = await mutateLessons((stored) => {
    upsertStripeLessons(stored, "pi_after", {
      type: "single",
      focus: "Both",
      privacy: "standard",
      seats: "1",
      date1: DATE,
      time1: TIME,
      email: "b@example.com",
      player: "Bea",
    });
    return { ok: true };
  });
  assert.equal(mirrored.ok, true);

  const after = await loadLessons();
  assert.ok(after.lessons.some((l) => l.id === "kept"));
  assert.ok(after.lessons.some((l) => l.id === "from-concurrent"));
  assert.ok(after.lessons.some((l) => l.id === "pi_after-1"));
});

test("CAS conflict retries without clobbering sibling holds", async () => {
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

test("holds fail closed when get() cannot supply a version-consistent ETag", async () => {
  seedMemoryPrivateCapacity("holds.json", { holds: [] }, { etag: "" });
  setPrivateHeadForTests(async () => ({ etag: '"hold-head-unpaired"' }));

  assert.equal(
    await placeHold("cs_recover", [{ date: DATE, time: TIME }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    false
  );
  const holds = await loadHolds();
  assert.equal(holds.holds.length, 0);
});

test("manual bookings fail closed when get() cannot supply a version-consistent ETag", async () => {
  seedMemoryPrivateCapacity("manual-bookings.json", { bookings: [{ id: "mb_old" }] }, { etag: "" });
  setPrivateHeadForTests(async () => ({ etag: '"manual-head-unpaired"' }));

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
