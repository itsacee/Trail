// Disposable staging readiness for the dual-store successor (no production Blob).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  clearCutoverCache,
  seedMemoryPublicCapacity,
  blobCompareAndSet,
  blobReadVersioned,
  capacityWritesEnabled,
  readCutoverMarker,
  readPrivateCapacityFile,
} from "../lib/store.js";
import {
  planCapacityMigration,
  runCapacityMigration,
  rollbackCapacityCutover,
} from "../lib/capacityMigration.js";
import { placeHold, loadHolds } from "../lib/holds.js";
import { loadLessons, mutateLessons, upsertStripeLessons, scheduledFor } from "../lib/lessons.js";
import { membershipSummary } from "../lib/members.js";
import { unitPriceFor, DEFAULT_SETTINGS } from "../lib/settings.js";
import {
  SLOT_CAPACITY,
  slotBlocked,
  seatsFor,
  isExclusiveBooking,
} from "../lib/schedule.js";

before(() => useMemoryBlobStore(true));
after(() => useMemoryBlobStore(false));
beforeEach(() => {
  clearMemoryBlobStore();
  clearCutoverCache();
  process.env.CAPACITY_BLOB_CUTOVER = "1";
  process.env.CAPACITY_WRITES_ENABLED = "1";
  delete process.env.CAPACITY_MIGRATION_PAUSE;
});

test("four checkout products keep $80 / $100 / $280 / $360", () => {
  const p = DEFAULT_SETTINGS.prices;
  assert.equal(unitPriceFor("single", 1, p), 8000);
  assert.equal(unitPriceFor("private", 1, p), 10000);
  assert.equal(unitPriceFor("membership", 1, p), 28000);
  assert.equal(unitPriceFor("membership_private", 1, p), 36000);
});

test("standard share of 2 and private exclusive hour", () => {
  assert.equal(SLOT_CAPACITY, 2);
  assert.equal(seatsFor("single", 1), 1);
  assert.equal(seatsFor("private", 1), SLOT_CAPACITY);
  assert.equal(isExclusiveBooking({ type: "private", privacy: "private" }), true);
  const one = [{ time: "5:00 PM", mins: 60, seats: 1, focuses: ["Fielding"], privacy: "standard" }];
  assert.equal(
    slotBlocked(one, "5:00 PM", 60, "Fielding", { seats: 1, exclusive: false, privacy: "standard" }),
    false
  );
  assert.equal(
    slotBlocked(one, "5:00 PM", 60, "Hitting", { seats: 1, exclusive: false, privacy: "standard" }),
    true
  );
  assert.equal(
    slotBlocked(one, "5:00 PM", 60, "Fielding", {
      seats: SLOT_CAPACITY,
      exclusive: true,
      privacy: "private",
    }),
    true
  );
});

test("disposable migration preserves lesson + manual + hold ids then rolls back", async () => {
  delete process.env.CAPACITY_BLOB_CUTOVER;
  process.env.CAPACITY_MIGRATION_PAUSE = "1";
  clearCutoverCache();

  seedMemoryPublicCapacity("holds.json", {
    holds: [{ sessionId: "cs_stage", date: "2026-12-01", time: "5:00 PM", expiresAt: Date.now() + 60000 }],
  });
  seedMemoryPublicCapacity("lessons.json", {
    lessons: [
      {
        id: "pi_stage-0",
        sourceId: "pi_stage",
        date: "2026-12-01",
        time: "6:00 PM",
        email: "stage@example.com",
        type: "single",
      },
    ],
    voids: [],
  });
  seedMemoryPublicCapacity("manual-bookings.json", {
    bookings: [{ id: "mb_stage", date: "2026-12-01", time: "7:00 PM", player: "Stage Kid" }],
  });

  const plan = await planCapacityMigration();
  assert.equal(plan.prereqs.ok, true);
  assert.equal(plan.files["lessons.json"].summary.count, 1);

  const migrated = await runCapacityMigration({ confirm: "MIGRATE-CAPACITY" });
  assert.equal(migrated.ok, true);
  assert.deepEqual(migrated.results["lessons.json"].summary.ids, ["pi_stage-0"]);
  assert.deepEqual(migrated.results["manual-bookings.json"].summary.ids, ["mb_stage"]);
  assert.deepEqual(migrated.results["holds.json"].summary.ids, ["cs_stage"]);

  delete process.env.CAPACITY_MIGRATION_PAUSE;
  process.env.CAPACITY_BLOB_CUTOVER = "1";
  clearCutoverCache();
  const lessons = await loadLessons();
  assert.equal(lessons.lessons[0].sourceId, "pi_stage");

  // New disposable booking after cutover
  assert.equal(
    await placeHold("cs_new_stage", [{ date: "2026-12-02", time: "5:00 PM" }], 60, "Hitting"),
    true
  );
  assert.equal((await loadHolds()).holds.some((h) => h.sessionId === "cs_new_stage"), true);

  // Rollback cutover; public snapshots remain; private backups remain.
  process.env.CAPACITY_MIGRATION_PAUSE = "1";
  delete process.env.CAPACITY_BLOB_CUTOVER;
  clearCutoverCache();
  const rolled = await rollbackCapacityCutover({ confirm: "ROLLBACK-CAPACITY" });
  assert.equal(rolled.ok, true);
  clearCutoverCache();
  assert.equal((await readCutoverMarker()).active, false);

  // Public lessons still present after rollback (not overwritten).
  const pub = await blobReadVersioned("lessons.json");
  assert.ok(JSON.parse(pub.text).lessons.some((l) => l.id === "pi_stage-0"));

  // Private copy still has the post-cutover hold for recovery if needed.
  const privHolds = await readPrivateCapacityFile("holds.json");
  assert.equal(privHolds.found, true);
  assert.ok(JSON.parse(privHolds.text).holds.some((h) => h.sessionId === "cs_new_stage"));
});

test("membership credits stay purchase-scoped after disposable cutover", async () => {
  const now = Math.floor(Date.now() / 1000);
  const sub = {
    id: "pi_mem_stage",
    kind: "payment",
    email: "member-stage@example.com",
    current_period_start: now - 86400,
    current_period_end: now + 28 * 86400,
    metadata: {
      type: "membership",
      email: "member-stage@example.com",
      player: "Stage",
      privacy: "standard",
    },
  };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  await blobCompareAndSet(
    "lessons.json",
    {
      lessons: [
        {
          id: "pi_mem_stage-1",
          sourceId: "pi_mem_stage",
          date: today,
          time: "5:00 PM",
          email: "member-stage@example.com",
          type: "membership",
          seats: 1,
          privacy: "standard",
        },
      ],
      voids: [],
    },
    ""
  );
  const lessons = await loadLessons();
  const scheduled = scheduledFor(sub, lessons);
  const summary = membershipSummary(sub, scheduled, { now });
  assert.equal(summary.credits, 4);
  assert.equal(summary.remaining, 3);
  assert.ok(summary.effectivePeriodEnd > now);
});

test("Stripe lesson upsert is idempotent (webhook retry safety)", async () => {
  const stored = { lessons: [], voids: [] };
  const meta = {
    type: "single",
    email: "retry@example.com",
    player: "Retry",
    focus: "Hitting",
    privacy: "standard",
    date1: "2026-12-05",
    time1: "5:00 PM",
  };
  assert.equal(upsertStripeLessons(stored, "pi_retry", meta), true);
  assert.equal(stored.lessons.length, 1);
  upsertStripeLessons(stored, "pi_retry", meta);
  assert.equal(stored.lessons.length, 1);
  assert.equal(stored.lessons[0].id, "pi_retry-1");
  assert.equal(stored.lessons[0].sourceId, "pi_retry");
});

test("PR #65 fail-closed markers remain in confirm/webhook sources", async () => {
  const confirm = await readFile(new URL("../api/confirm.js", import.meta.url), "utf8");
  const webhook = await readFile(new URL("../api/webhook.js", import.meta.url), "utf8");
  assert.match(confirm, /bookingMirrorFailed/);
  assert.match(confirm, /recorded:\s*false/);
  assert.match(webhook, /bookingMirrorFailed/);
  assert.match(webhook, /res\.status\(503\)/);
});

test("CAPACITY_WRITES_ENABLED default-off still pauses CAS", async () => {
  process.env.CAPACITY_WRITES_ENABLED = "0";
  assert.equal(capacityWritesEnabled(), false);
  const result = await blobCompareAndSet("lessons.json", { lessons: [], voids: [] }, "");
  assert.equal(result.ok, false);
  assert.equal(result.paused, true);
});

test("private-store CAS conflict does not overwrite", async () => {
  assert.equal((await blobCompareAndSet("holds.json", { holds: [] }, "")).ok, true);
  const first = await loadHolds();
  assert.equal(
    (await blobCompareAndSet("holds.json", { holds: [{ sessionId: "keep" }] }, first._etag)).ok,
    true
  );
  const stale = await blobCompareAndSet("holds.json", { holds: [{ sessionId: "stale" }] }, first._etag);
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal((await loadHolds()).holds[0].sessionId, "keep");
});

test("scheduledFor still attributes Stripe source ids after mutate", async () => {
  const result = await mutateLessons((data) => {
    upsertStripeLessons(data, "pi_attr", {
      type: "membership",
      email: "attr@example.com",
      player: "Attr",
      focus: "Fielding",
      privacy: "standard",
      date1: "2026-12-06",
      time1: "6:00 PM",
    });
    return { ok: true };
  });
  assert.equal(result.ok, true);
  const loaded = await loadLessons();
  const sub = {
    id: "pi_attr",
    email: "attr@example.com",
    metadata: { type: "membership", email: "attr@example.com", player: "Attr" },
    current_period_start: Math.floor(Date.now() / 1000) - 86400,
    current_period_end: Math.floor(Date.now() / 1000) + 28 * 86400,
  };
  const mine = scheduledFor(sub, loaded);
  assert.ok(mine.some((l) => l.sourceId === "pi_attr" || String(l.id).startsWith("pi_attr")));
});
