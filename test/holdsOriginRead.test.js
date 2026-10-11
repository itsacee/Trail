// Emergency hotfix: capacity files stay on the EXISTING public Blob store.
// Private access / public→private migration is removed. CAS writes stay
// fail-closed (and paused unless CAPACITY_WRITES_ENABLED=1).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  blobAccessFor,
  blobCompareAndSet,
  capacityWritesEnabled,
  storeConfigured,
} from "../lib/store.js";
import { placeHold, releaseHold, loadHolds, saveHolds } from "../lib/holds.js";

test("installed @vercel/blob only applies useCache:false for private access", async () => {
  const src = await readFile(new URL("../node_modules/@vercel/blob/dist/index.js", import.meta.url), "utf8");
  assert.match(
    src,
    /useCache === false && access === ["']private["']/,
    "SDK must only cache-bust private gets; public useCache:false is a no-op"
  );
});

test("capacity-critical blobs stay public on the existing store (hotfix)", () => {
  assert.equal(blobAccessFor("holds.json"), "public");
  assert.equal(blobAccessFor("lessons.json"), "public");
  assert.equal(blobAccessFor("manual-bookings.json"), "public");
  assert.equal(blobAccessFor("availability.json"), "public");
  assert.equal(blobAccessFor("settings.json"), "public");
});

before(() => {
  useMemoryBlobStore(true);
});

after(() => {
  useMemoryBlobStore(false);
});

beforeEach(() => {
  clearMemoryBlobStore();
  process.env.CAPACITY_WRITES_ENABLED = "1";
});

test("placeHold creates a hold and releaseHold removes it", async () => {
  assert.equal(storeConfigured(), true);
  assert.equal(capacityWritesEnabled(), true);
  const ok = await placeHold("cs_test_1", [{ date: "2026-11-12", time: "5:00 PM" }], 60, "Hitting", {
    seats: 1,
    type: "single",
    privacy: "standard",
  });
  assert.equal(ok, true);
  const loaded = await loadHolds();
  assert.equal(loaded.holds.length, 1);
  assert.equal(loaded.holds[0].sessionId, "cs_test_1");
  assert.equal(loaded.holds[0].privacy, "standard");
  assert.ok(loaded._conditional);
  assert.ok(loaded._etag);

  assert.equal(await releaseHold("cs_test_1"), true);
  const after = await loadHolds();
  assert.equal(after.holds.length, 0);
});

test("private and standard membership holds can be placed for checkout amounts", async () => {
  assert.equal(
    await placeHold("cs_mem_std", [{ date: "2026-11-13", time: "6:00 PM" }], 60, "Hitting", {
      seats: 1,
      type: "membership",
      privacy: "standard",
    }),
    true
  );
  assert.equal(
    await placeHold("cs_drop_priv", [{ date: "2026-11-13", time: "7:00 PM" }], 60, "Fielding", {
      seats: 2,
      type: "private",
      privacy: "private",
    }),
    true
  );
  assert.equal(
    await placeHold("cs_mem_priv", [{ date: "2026-11-14", time: "5:00 PM" }], 60, "Both", {
      seats: 2,
      type: "membership_private",
      privacy: "private",
    }),
    true
  );
  const loaded = await loadHolds();
  assert.equal(loaded.holds.length, 3);
});

test("saveHolds create-only path conflicts when holds.json already exists", async () => {
  assert.equal((await blobCompareAndSet("holds.json", { holds: [] }, "")).ok, true);
  const loaded = await loadHolds();
  assert.equal(loaded._conditional, true);

  // Empty ifMatch must not clobber the existing file.
  const createAgain = await saveHolds({ holds: [{ sessionId: "cs_clobber", date: "2026-11-12", time: "5:00 PM", expiresAt: Date.now() + 60000 }] }, {
    etag: "",
    conditional: false,
  });
  assert.equal(createAgain.ok, false);
  assert.equal(createAgain.conflict, true);

  const again = await loadHolds();
  assert.equal(again.holds.length, 0);
});

test("placeHold retries through a conflicting concurrent writer", async () => {
  assert.equal(
    await placeHold("cs_a", [{ date: "2026-11-15", time: "5:00 PM" }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    true
  );

  const first = await loadHolds();
  // Simulate another checkout winning a CAS update with the same etag snapshot.
  assert.equal(
    (
      await blobCompareAndSet(
        "holds.json",
        {
          holds: [
            ...first.holds,
            {
              sessionId: "cs_other",
              date: "2026-11-15",
              time: "6:00 PM",
              mins: 60,
              focus: "Hitting",
              seats: 1,
              expiresAt: Date.now() + 60 * 60 * 1000,
            },
          ],
        },
        first._etag
      )
    ).ok,
    true
  );

  // placeHold reloads on conflict and still lands its own hold.
  assert.equal(
    await placeHold("cs_b", [{ date: "2026-11-15", time: "7:00 PM" }], 60, "Fielding", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    true
  );
  const final = await loadHolds();
  const ids = final.holds.map((h) => h.sessionId).sort();
  assert.deepEqual(ids, ["cs_a", "cs_b", "cs_other"]);
});

test("two simultaneous placeHold calls both persist (CAS retry)", async () => {
  const results = await Promise.all([
    placeHold("cs_race_1", [{ date: "2026-11-16", time: "5:00 PM" }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    placeHold("cs_race_2", [{ date: "2026-11-16", time: "5:00 PM" }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
  ]);
  assert.deepEqual(results.sort(), [true, true]);
  const loaded = await loadHolds();
  assert.equal(loaded.holds.length, 2);
  assert.deepEqual(loaded.holds.map((h) => h.sessionId).sort(), ["cs_race_1", "cs_race_2"]);
});

test("capacity writes pause blocks placeHold without inventing empty holds", async () => {
  process.env.CAPACITY_WRITES_ENABLED = "0";
  assert.equal(capacityWritesEnabled(), false);
  assert.equal(
    await placeHold("cs_paused", [{ date: "2026-11-17", time: "5:00 PM" }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    false
  );
  const cas = await blobCompareAndSet("holds.json", { holds: [] }, "");
  assert.equal(cas.ok, false);
  assert.equal(cas.paused, true);
});

test("missing Blob credentials fail CAS closed (no overwrite)", async () => {
  useMemoryBlobStore(false);
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevUrl = process.env.AVAILABILITY_URL;
  const prevWrites = process.env.CAPACITY_WRITES_ENABLED;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.AVAILABILITY_URL;
  delete process.env.BLOB_MEMORY_STORE;
  process.env.CAPACITY_WRITES_ENABLED = "1";

  try {
    assert.equal(storeConfigured(), false);
    const result = await blobCompareAndSet("holds.json", { holds: [{ sessionId: "cs_x" }] }, "");
    assert.equal(result.ok, false);
    assert.equal(result.conflict, false);
  } finally {
    if (prevToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevToken;
    if (prevUrl === undefined) delete process.env.AVAILABILITY_URL;
    else process.env.AVAILABILITY_URL = prevUrl;
    if (prevWrites === undefined) delete process.env.CAPACITY_WRITES_ENABLED;
    else process.env.CAPACITY_WRITES_ENABLED = prevWrites;
    useMemoryBlobStore(true);
  }
});
