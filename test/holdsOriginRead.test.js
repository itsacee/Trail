// Holds / CAS against the private capacity store (dual-store architecture).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  blobAccessFor,
  blobCompareAndSet,
  capacityStoreConfigured,
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

test("capacity-critical blobs select private access; public schedule files stay public", () => {
  assert.equal(blobAccessFor("holds.json"), "private");
  assert.equal(blobAccessFor("lessons.json"), "private");
  assert.equal(blobAccessFor("manual-bookings.json"), "private");
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
  process.env.CAPACITY_BLOB_CUTOVER = "1";
  delete process.env.CAPACITY_MIGRATION_PAUSE;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_mempublic_test";
  process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_memprivate_test";
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";
});

test("placeHold creates a hold and releaseHold removes it", async () => {
  assert.equal(capacityStoreConfigured(), true);
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

  const createAgain = await saveHolds(
    { holds: [{ sessionId: "cs_clobber", date: "2026-11-12", time: "5:00 PM", expiresAt: Date.now() + 60000 }] },
    { etag: "", conditional: false }
  );
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

test("missing private Blob credentials fail CAS closed (no overwrite)", async () => {
  useMemoryBlobStore(false);
  const prevPublic = process.env.BLOB_READ_WRITE_TOKEN;
  const prevPrivate = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  const prevUrl = process.env.AVAILABILITY_URL;
  delete process.env.BLOB_MEMORY_STORE;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  delete process.env.AVAILABILITY_URL;

  try {
    assert.equal(storeConfigured(), false);
    assert.equal(capacityStoreConfigured(), false);
    const result = await blobCompareAndSet("holds.json", { holds: [{ sessionId: "cs_x" }] }, "");
    assert.equal(result.ok, false);
    assert.equal(result.conflict, false);
  } finally {
    if (prevPublic === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevPublic;
    if (prevPrivate === undefined) delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
    else process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = prevPrivate;
    if (prevUrl === undefined) delete process.env.AVAILABILITY_URL;
    else process.env.AVAILABILITY_URL = prevUrl;
    useMemoryBlobStore(true);
  }
});
