import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  clearCutoverCache,
  blobAccessFor,
  isCapacityFile,
  storeConfigured,
  capacityStoreConfigured,
  capacityMigrationPaused,
  previewCapacityIsolationOk,
  storeIdFromToken,
  seedMemoryPublicCapacity,
  blobReadVersioned,
  blobCompareAndSet,
  writeCutoverMarker,
  clearCutoverMarker,
  readCutoverMarker,
} from "../lib/store.js";
import {
  planCapacityMigration,
  runCapacityMigration,
  rollbackCapacityCutover,
  capacityBookingBlockedMessage,
} from "../lib/capacityMigration.js";
import { placeHold, loadHolds } from "../lib/holds.js";
import { loadLessons, mutateLessons } from "../lib/lessons.js";

before(() => {
  useMemoryBlobStore(true);
});

after(() => {
  useMemoryBlobStore(false);
});

beforeEach(() => {
  clearMemoryBlobStore();
  clearCutoverCache();
  process.env.CAPACITY_BLOB_CUTOVER = "1";
  delete process.env.CAPACITY_MIGRATION_PAUSE;
  delete process.env.VERCEL_ENV;
  delete process.env.CAPACITY_ALLOW_SHARED_STORE;
  // Re-seed tokens after clearMemory (does not clear env).
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_mempublic_test";
  process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_memprivate_test";
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";
});

test("capacity files select private access; public files stay public", () => {
  assert.equal(isCapacityFile("holds.json"), true);
  assert.equal(blobAccessFor("holds.json"), "private");
  assert.equal(blobAccessFor("lessons.json"), "private");
  assert.equal(blobAccessFor("manual-bookings.json"), "private");
  assert.equal(blobAccessFor("availability.json"), "public");
  assert.equal(blobAccessFor("settings.json"), "public");
  assert.equal(blobAccessFor("members.json"), "public");
  assert.equal(blobAccessFor("finance.json"), "public");
});

test("store id parsing never requires logging secrets", () => {
  assert.equal(storeIdFromToken("vercel_blob_rw_storeABC_secretvalue"), "storeABC");
  assert.equal(storeIdFromToken(""), "");
});

test("missing private token fails capacity configuration", () => {
  const prev = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_MEMORY_STORE;
  try {
    assert.equal(capacityStoreConfigured(), false);
    assert.ok(capacityBookingBlockedMessage());
  } finally {
    process.env.BLOB_MEMORY_STORE = "1";
    process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = prev;
  }
});

test("preview rejects private token that matches public store id", () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_sameStore_aaa";
  process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_sameStore_bbb";
  const denied = previewCapacityIsolationOk();
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "private_token_matches_public_store");

  process.env.CAPACITY_ALLOW_SHARED_STORE = "1";
  assert.equal(previewCapacityIsolationOk().ok, true);
});

test("pre-cutover refuses empty invent when public still has lessons", async () => {
  delete process.env.CAPACITY_BLOB_CUTOVER;
  clearCutoverCache();
  seedMemoryPublicCapacity("lessons.json", {
    lessons: [{ id: "L1", date: "2026-11-20", time: "5:00 PM" }],
    voids: [],
  });
  const read = await blobReadVersioned("lessons.json");
  assert.equal(read.unreachable, true);
  assert.equal(read.text, null);

  const create = await blobCompareAndSet(
    "lessons.json",
    { lessons: [], voids: [] },
    ""
  );
  assert.equal(create.ok, false);
});

test("post-cutover placeHold uses private store", async () => {
  assert.equal(capacityStoreConfigured(), true);
  assert.equal(await placeHold("cs_dual_1", [{ date: "2026-11-21", time: "5:00 PM" }], 60, "Hitting"), true);
  const holds = await loadHolds();
  assert.equal(holds.holds.length, 1);
  assert.equal(holds.holds[0].sessionId, "cs_dual_1");
});

test("CAS conflict returns conflict without overwrite", async () => {
  assert.equal((await blobCompareAndSet("holds.json", { holds: [] }, "")).ok, true);
  const first = await loadHolds();
  assert.equal(
    (await blobCompareAndSet("holds.json", { holds: [{ sessionId: "a" }] }, first._etag)).ok,
    true
  );
  const stale = await blobCompareAndSet("holds.json", { holds: [{ sessionId: "stale" }] }, first._etag);
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  const final = await loadHolds();
  assert.equal(final.holds[0].sessionId, "a");
});

test("migration pause blocks capacity reads/writes", async () => {
  process.env.CAPACITY_MIGRATION_PAUSE = "1";
  assert.equal(capacityMigrationPaused(), true);
  assert.match(capacityBookingBlockedMessage(), /paused/i);
  const read = await blobReadVersioned("holds.json");
  assert.equal(read.unreachable, true);
  const write = await blobCompareAndSet("holds.json", { holds: [] }, "");
  assert.equal(write.ok, false);
});

test("explicit migration copies public snapshots and verifies ids", async () => {
  delete process.env.CAPACITY_BLOB_CUTOVER;
  process.env.CAPACITY_MIGRATION_PAUSE = "1";
  clearCutoverCache();

  seedMemoryPublicCapacity("holds.json", {
    holds: [{ sessionId: "cs_keep", date: "2026-11-22", time: "6:00 PM", expiresAt: Date.now() + 60000 }],
  });
  seedMemoryPublicCapacity("lessons.json", {
    lessons: [{ id: "lesson_1", date: "2026-11-22", time: "5:00 PM" }],
    voids: [],
  });
  seedMemoryPublicCapacity("manual-bookings.json", {
    bookings: [{ id: "mb_1", date: "2026-11-22", time: "7:00 PM" }],
  });

  const plan = await planCapacityMigration();
  assert.equal(plan.prereqs.ok, true);
  assert.equal(plan.files["lessons.json"].summary.count, 1);

  const denied = await runCapacityMigration({});
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "confirm_required");

  const migrated = await runCapacityMigration({ confirm: "MIGRATE-CAPACITY" });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.results["lessons.json"].summary.ids[0], "lesson_1");
  assert.equal(migrated.results["holds.json"].summary.ids[0], "cs_keep");
  assert.equal(migrated.results["manual-bookings.json"].summary.ids[0], "mb_1");

  const marker = await readCutoverMarker();
  assert.equal(marker.active, true);

  // After cutover marker, reads succeed from private even while pause is on
  // only once pause is cleared — pause still blocks runtime paths.
  delete process.env.CAPACITY_MIGRATION_PAUSE;
  process.env.CAPACITY_BLOB_CUTOVER = "1";
  clearCutoverCache();
  const lessons = await loadLessons();
  assert.equal(lessons.lessons.length, 1);
  assert.equal(lessons.lessons[0].id, "lesson_1");
});

test("incomplete migration without confirm does nothing", async () => {
  delete process.env.CAPACITY_BLOB_CUTOVER;
  process.env.CAPACITY_MIGRATION_PAUSE = "1";
  seedMemoryPublicCapacity("lessons.json", { lessons: [{ id: "x" }], voids: [] });
  const result = await runCapacityMigration({ confirm: "nope" });
  assert.equal(result.ok, false);
  const privateRead = await blobReadVersioned("lessons.json");
  assert.equal(privateRead.unreachable, true);
});

test("rollback clears cutover and keeps pause requirement", async () => {
  process.env.CAPACITY_MIGRATION_PAUSE = "1";
  delete process.env.CAPACITY_BLOB_CUTOVER;
  clearCutoverCache();
  await writeCutoverMarker({ active: true });
  const bad = await rollbackCapacityCutover({ confirm: "no" });
  assert.equal(bad.ok, false);
  const ok = await rollbackCapacityCutover({ confirm: "ROLLBACK-CAPACITY" });
  assert.equal(ok.ok, true);
  clearCutoverCache();
  const marker = await readCutoverMarker();
  assert.equal(marker.active, false);
});

test("lessons mutate still works on private memory store after cutover", async () => {
  const result = await mutateLessons((data) => {
    data.lessons.push({
      id: "L_new",
      date: "2026-11-23",
      time: "5:00 PM",
      focus: "Hitting",
      privacy: "standard",
      seats: 1,
      type: "single",
    });
    return { ok: true };
  });
  assert.equal(result.ok, true);
  const loaded = await loadLessons();
  assert.ok(loaded.lessons.some((l) => l.id === "L_new"));
});

test("public storeConfigured remains independent of private token", () => {
  assert.equal(storeConfigured(), true);
  const prev = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  // memory mode still counts as configured for both
  assert.equal(storeConfigured(), true);
  process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = prev;
});
