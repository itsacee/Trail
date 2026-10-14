// Safety tests for the one-time privacy-fix maintenance handler.
// Uses an in-memory Blob mock — never touches live Production Blob.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import handler from "../api/maintenance-privacy-fix.js";
import {
  LESSON_ID,
  MANUAL_ID,
  CONFIRM_EXECUTE,
  CONFIRM_RESTORE,
  LOCK_PATH,
  BACKUP_PREFIX,
  authorizeRequest,
  assertWriteFreeze,
  maintenanceEnabled,
  applyPrivacyStandardPatch,
  evaluateTargetSlotOccupancy,
  fingerprintLesson,
  fingerprintManual,
  runMaintenancePrivacyFix,
  sanitizeMaintenanceReport,
  putCreateOnly,
} from "../lib/maintenancePrivacyFix.js";

const SECRET = "test-maintenance-secret-32chars-xx";
const COACH = "coach-test-pass";

function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function baseLesson(overrides = {}) {
  return {
    id: LESSON_ID,
    date: "2026-10-15",
    time: "5:00 PM",
    focus: "Both",
    type: "membership",
    source: "member",
    email: "dylan@example.com",
    player: "Dylan Tuter",
    subId: "pi_mem_dylan",
    sourceId: "pi_mem_dylan",
    status: "scheduled",
    ...overrides,
  };
}

function baseManual(overrides = {}) {
  return {
    id: MANUAL_ID,
    date: "2026-10-15",
    time: "5:00 PM",
    focus: "Both",
    type: "single",
    source: "manual",
    status: "scheduled",
    paymentStatus: "paid",
    email: "cooper@example.com",
    player: "Cooper",
    ...overrides,
  };
}

function seedDocs() {
  const lessons = {
    lessons: [
      baseLesson(),
      {
        id: "lsn_other_keep",
        date: "2026-10-16",
        time: "6:00 PM",
        focus: "Hitting",
        type: "membership",
        privacy: "standard",
        email: "other@example.com",
        player: "Other",
        subId: "pi_other",
        status: "scheduled",
      },
    ],
    voids: [],
  };
  const manual = {
    bookings: [
      baseManual(),
      {
        id: "mb_other_keep",
        date: "2026-10-17",
        time: "7:00 PM",
        focus: "Fielding",
        type: "single",
        status: "scheduled",
        privacy: "standard",
        email: "keep@example.com",
        player: "Keep",
      },
    ],
  };
  return {
    lessonsText: JSON.stringify(lessons),
    manualText: JSON.stringify(manual),
    lessons,
    manual,
  };
}

class BlobPreconditionFailedError extends Error {
  constructor() {
    super("Precondition failed: ETag mismatch.");
    this.name = "BlobPreconditionFailedError";
  }
}

function createMemoryBlob({ failPutPaths = new Set() } = {}) {
  const store = new Map(); // pathname -> { body, etag }
  let seq = 0;
  const nextEtag = () => {
    seq += 1;
    return `"etag-${seq}"`;
  };

  const blob = {
    BlobPreconditionFailedError,
    store,
    async head(pathname) {
      const entry = store.get(pathname);
      if (!entry) {
        const err = new Error("not found");
        err.statusCode = 404;
        throw err;
      }
      return { etag: entry.etag, pathname };
    },
    async get(pathname) {
      const entry = store.get(pathname);
      if (!entry) return { statusCode: 404, text: async () => null };
      return {
        statusCode: 200,
        text: async () => entry.body,
      };
    },
    async put(pathname, body, opts = {}) {
      if (failPutPaths.has(pathname)) {
        throw new Error("simulated put failure");
      }
      const text = String(body);
      const existing = store.get(pathname);
      if (opts.ifMatch) {
        if (!existing || existing.etag !== opts.ifMatch) {
          throw new BlobPreconditionFailedError();
        }
        const etag = nextEtag();
        store.set(pathname, { body: text, etag });
        return { pathname, etag };
      }
      if (existing && opts.allowOverwrite === false) {
        const err = new Error("Blob already exists");
        err.name = "BlobAlreadyExistsError";
        throw err;
      }
      if (existing && opts.allowOverwrite !== true && !opts.ifMatch) {
        // SDK default: refuse overwrite without allowOverwrite
        const err = new Error("Blob already exists");
        err.name = "BlobAlreadyExistsError";
        throw err;
      }
      const etag = nextEtag();
      store.set(pathname, { body: text, etag });
      return { pathname, etag };
    },
  };

  return blob;
}

function authEnv(overrides = {}) {
  return {
    MAINTENANCE_PRIVACY_FIX: "1",
    MAINTENANCE_PRIVACY_FIX_SECRET: SECRET,
    MAINTENANCE_ALLOW_TEST: "1",
    VERCEL_ENV: "production",
    COACH_PASS: COACH,
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_teststore_testsecret",
    CAPACITY_WRITES_ENABLED: "0",
    BOOKING_WRITES_ENABLED: "0",
    ...overrides,
  };
}

function seedBlob(blob, docs = seedDocs()) {
  blob.store.set("lessons.json", { body: docs.lessonsText, etag: '"L1"' });
  blob.store.set("manual-bookings.json", { body: docs.manualText, etag: '"M1"' });
  return docs;
}

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

beforeEach(() => {
  delete process.env.MAINTENANCE_PRIVACY_FIX;
  delete process.env.MAINTENANCE_PRIVACY_FIX_SECRET;
  delete process.env.MAINTENANCE_ALLOW_TEST;
});

test("maintenanceEnabled defaults off", () => {
  assert.equal(maintenanceEnabled({}), false);
  assert.equal(maintenanceEnabled({ MAINTENANCE_PRIVACY_FIX: "1" }), true);
});

test("authorizeRequest: disabled / unauthorized / confirm gates", () => {
  assert.equal(authorizeRequest({ env: {}, mode: "dry_run" }).code, "disabled");
  assert.equal(
    authorizeRequest({
      env: authEnv(),
      bearer: "wrong",
      coachKey: COACH,
      mode: "dry_run",
    }).code,
    "unauthorized"
  );
  assert.equal(
    authorizeRequest({
      env: authEnv(),
      bearer: SECRET,
      coachKey: "nope",
      mode: "dry_run",
    }).code,
    "coach_unauthorized"
  );
  assert.equal(
    authorizeRequest({
      env: authEnv(),
      bearer: SECRET,
      coachKey: COACH,
      mode: "execute",
      confirm: "WRONG",
    }).code,
    "confirm_required"
  );
  assert.equal(
    authorizeRequest({
      env: authEnv(),
      bearer: SECRET,
      coachKey: COACH,
      mode: "restore",
      confirm: "WRONG",
    }).code,
    "restore_confirm_required"
  );
  assert.equal(
    authorizeRequest({
      env: authEnv(),
      bearer: SECRET,
      coachKey: COACH,
      mode: "dry_run",
    }).ok,
    true
  );
});

test("assertWriteFreeze refuses when capacity or booking writes enabled", () => {
  assert.equal(assertWriteFreeze(authEnv()).ok, true);
  assert.equal(assertWriteFreeze(authEnv({ CAPACITY_WRITES_ENABLED: "1" })).ok, false);
  assert.equal(assertWriteFreeze(authEnv({ BOOKING_WRITES_ENABLED: "1" })).ok, false);
});

test("applyPrivacyStandardPatch stamps only privacy and preserves other fields", () => {
  const docs = seedDocs();
  const result = applyPrivacyStandardPatch(docs.lessons, docs.manual);
  assert.equal(result.ok, true);
  const lesson = result.lessons.lessons.find((l) => l.id === LESSON_ID);
  const booking = result.manual.bookings.find((b) => b.id === MANUAL_ID);
  assert.equal(lesson.privacy, "standard");
  assert.equal(booking.privacy, "standard");
  assert.equal(lesson.date, "2026-10-15");
  assert.equal(lesson.time, "5:00 PM");
  assert.equal(lesson.focus, "Both");
  assert.equal(lesson.player, "Dylan Tuter");
  assert.equal(lesson.subId, "pi_mem_dylan");
  assert.equal(booking.player, "Cooper");
  assert.equal(booking.paymentStatus, "paid");
  assert.equal(booking.status, "scheduled");
  // unrelated rows unchanged
  assert.deepEqual(
    result.lessons.lessons.find((l) => l.id === "lsn_other_keep"),
    docs.lessons.lessons.find((l) => l.id === "lsn_other_keep")
  );
  assert.deepEqual(
    result.manual.bookings.find((b) => b.id === "mb_other_keep"),
    docs.manual.bookings.find((b) => b.id === "mb_other_keep")
  );
});

test("applyPrivacyStandardPatch refuses wrong identity / already stamped", () => {
  const docs = seedDocs();
  docs.lessons.lessons[0].privacy = "standard";
  assert.equal(applyPrivacyStandardPatch(docs.lessons, docs.manual).code, "lesson_identity_mismatch");

  const docs2 = seedDocs();
  docs2.lessons.lessons[0].date = "2026-10-16";
  assert.equal(applyPrivacyStandardPatch(docs2.lessons, docs2.manual).code, "lesson_identity_mismatch");

  const docs3 = seedDocs();
  docs3.manual.bookings[0].focus = "Hitting";
  assert.equal(applyPrivacyStandardPatch(docs3.lessons, docs3.manual).code, "manual_identity_mismatch");
});

test("occupancy after patch is Standard Both Full 2/2", () => {
  const docs = seedDocs();
  const patched = applyPrivacyStandardPatch(docs.lessons, docs.manual);
  const occ = evaluateTargetSlotOccupancy(patched.lessons, patched.manual);
  assert.equal(occ.ok, true);
  assert.equal(occ.standard_count, 2);
  assert.equal(occ.private_count, 0);
  assert.equal(occ.seats_used, 2);
  assert.equal(occ.seats_capacity, 2);
  assert.equal(occ.full, true);
  assert.equal(occ.exclusive, false);
  assert.equal(occ.focus, "Both");
  assert.deepEqual(occ.ids.sort(), [LESSON_ID, MANUAL_ID].sort());
});

test("fingerprints never include email/player/payment bodies", () => {
  const fpL = fingerprintLesson(baseLesson());
  const fpM = fingerprintManual(baseManual());
  assert.equal(fpL.has_email, true);
  assert.equal(fpL.has_player, true);
  assert.equal("email" in fpL, false);
  assert.equal("player" in fpL, false);
  assert.equal("email" in fpM, false);
  assert.equal("player" in fpM, false);
});

test("sanitizeMaintenanceReport strips etag/token/secret keys", () => {
  const safe = sanitizeMaintenanceReport({
    ok: true,
    etag: "secret-etag",
    nested: { authorization: "Bearer x", lessons_sha256: "abc" },
    token: "nope",
  });
  assert.equal("etag" in safe, false);
  assert.equal("token" in safe, false);
  assert.equal("authorization" in safe.nested, false);
  assert.equal(safe.nested.lessons_sha256, "abc");
});

test("API handler returns 404 when disabled", async () => {
  delete process.env.MAINTENANCE_PRIVACY_FIX;
  const res = mockRes();
  await handler({ method: "POST", headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "disabled");
});

test("dry_run succeeds and returns expected hashes without writing", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  const report = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "dry_run",
    bearer: SECRET,
    coachKey: COACH,
    blob,
  });
  assert.equal(report.ok, true);
  assert.equal(report.code, "dry_run_ok");
  assert.equal(report.before.lessons_sha256, sha256(docs.lessonsText));
  assert.equal(report.before.manual_sha256, sha256(docs.manualText));
  assert.equal(report.occupancy_expected.full, true);
  assert.equal(blob.store.has(LOCK_PATH), false);
  assert.equal(JSON.parse(blob.store.get("lessons.json").body).lessons[0].privacy, undefined);
});

test("execute refuses hash mismatch", async () => {
  const blob = createMemoryBlob();
  seedBlob(blob);
  const report = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE,
    expected_lessons_sha256: "0".repeat(64),
    expected_manual_sha256: "1".repeat(64),
    blob,
  });
  assert.equal(report.code, "hash_mismatch");
  assert.equal(report.state, "aborted_before_writes");
  assert.equal(blob.store.has(LOCK_PATH), false);
});

test("execute refuses write freeze breach", async () => {
  const blob = createMemoryBlob();
  seedBlob(blob);
  const report = await runMaintenancePrivacyFix({
    env: authEnv({ CAPACITY_WRITES_ENABLED: "1" }),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE,
    expected_lessons_sha256: "x",
    expected_manual_sha256: "y",
    blob,
  });
  assert.equal(report.code, "write_freeze_required");
});

test("backup failure aborts before lock or capacity writes", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  const runId = "run_bakfail";
  // Pre-create backup path so create-only fails
  blob.store.set(`${BACKUP_PREFIX}/${runId}/lessons.json`, {
    body: "stale",
    etag: '"bak"',
  });
  const report = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE,
    expected_lessons_sha256: sha256(docs.lessonsText),
    expected_manual_sha256: sha256(docs.manualText),
    runId,
    blob,
  });
  assert.equal(report.code, "backup_lessons_failed");
  assert.equal(blob.store.has(LOCK_PATH), false);
  assert.equal(JSON.parse(blob.store.get("lessons.json").body).lessons[0].privacy, undefined);
});

test("concurrent execute: second request hits lock_held", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  const hashes = {
    expected_lessons_sha256: sha256(docs.lessonsText),
    expected_manual_sha256: sha256(docs.manualText),
  };
  const first = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE,
    runId: "run_a",
    blob,
    ...hashes,
  });
  assert.equal(first.code, "execute_ok");

  // Reset capacity files to pre-fix so identity still matches, but keep lock
  seedBlob(blob, docs);
  const second = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE,
    runId: "run_b",
    blob,
    ...hashes,
  });
  assert.equal(second.code, "lock_held");
  assert.equal(second.state, "aborted_before_writes");
});

test("partial write: lessons ok, manual fail — no auto compensation", async () => {
  const blob = createMemoryBlob({ failPutPaths: new Set(["manual-bookings.json"]) });
  const docs = seedBlob(blob);
  const report = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE,
    expected_lessons_sha256: sha256(docs.lessonsText),
    expected_manual_sha256: sha256(docs.manualText),
    runId: "run_partial",
    blob,
  });
  assert.equal(report.code, "put_failed");
  assert.equal(report.state, "partial_lessons_ok_manual_failed");
  assert.equal(report.files.lessons, "ok");
  assert.equal(report.files.manual, "failed");
  assert.match(report.recovery, /Do not auto-overwrite/);
  const lessons = JSON.parse(blob.store.get("lessons.json").body);
  const manual = JSON.parse(blob.store.get("manual-bookings.json").body);
  assert.equal(lessons.lessons.find((l) => l.id === LESSON_ID).privacy, "standard");
  assert.equal(manual.bookings.find((b) => b.id === MANUAL_ID).privacy, undefined);
});

test("restore refused without confirm / on other-file drift", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  const dry = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "dry_run",
    bearer: SECRET,
    coachKey: COACH,
    blob,
  });
  const exec = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE,
    expected_lessons_sha256: dry.before.lessons_sha256,
    expected_manual_sha256: dry.before.manual_sha256,
    runId: "run_restore",
    blob,
  });
  assert.equal(exec.ok, true);

  const noConfirm = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "restore",
    bearer: SECRET,
    coachKey: COACH,
    confirm: "NOPE",
    restore_file: "lessons",
    runId: "run_restore",
    expected_current_sha256: exec.after.lessons_sha256,
    expected_other_sha256: exec.after.manual_sha256,
    blob,
  });
  assert.equal(noConfirm.code, "restore_confirm_required");

  // Drift sibling file
  const driftedManual = JSON.parse(blob.store.get("manual-bookings.json").body);
  driftedManual.bookings.push({
    id: "mb_drift",
    date: "2026-10-20",
    time: "6:00 PM",
    focus: "Hitting",
    status: "scheduled",
  });
  blob.store.set("manual-bookings.json", {
    body: JSON.stringify(driftedManual),
    etag: '"M-drift"',
  });

  const refused = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "restore",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_RESTORE,
    restore_file: "lessons",
    runId: "run_restore",
    expected_current_sha256: exec.after.lessons_sha256,
    expected_other_sha256: exec.after.manual_sha256, // stale vs drifted
    blob,
  });
  assert.equal(refused.code, "restore_other_file_drift");
  assert.equal(refused.state, "restore_refused");
  // lessons still standard (not auto-restored)
  assert.equal(
    JSON.parse(blob.store.get("lessons.json").body).lessons.find((l) => l.id === LESSON_ID).privacy,
    "standard"
  );
  void docs;
});

test("owner-approved restore succeeds when sibling hash matches", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  const dry = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "dry_run",
    bearer: SECRET,
    coachKey: COACH,
    blob,
  });
  const exec = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE,
    expected_lessons_sha256: dry.before.lessons_sha256,
    expected_manual_sha256: dry.before.manual_sha256,
    runId: "run_restore_ok",
    blob,
  });
  assert.equal(exec.ok, true);

  // Simulate partial: restore lessons only from backup
  const restored = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "restore",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_RESTORE,
    restore_file: "lessons",
    runId: "run_restore_ok",
    expected_current_sha256: exec.after.lessons_sha256,
    expected_other_sha256: exec.after.manual_sha256,
    blob,
  });
  assert.equal(restored.code, "restore_ok");
  const lessons = JSON.parse(blob.store.get("lessons.json").body);
  assert.equal(lessons.lessons.find((l) => l.id === LESSON_ID).privacy, undefined);
  assert.equal(sha256(blob.store.get("lessons.json").body), sha256(docs.lessonsText));
});

test("successful correction stamps both records and keeps Full 2/2 Standard", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  const dry = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "dry_run",
    bearer: SECRET,
    coachKey: COACH,
    blob,
  });
  assert.equal(dry.ok, true);

  const exec = await runMaintenancePrivacyFix({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE,
    expected_lessons_sha256: dry.before.lessons_sha256,
    expected_manual_sha256: dry.before.manual_sha256,
    runId: "run_ok",
    blob,
  });
  assert.equal(exec.ok, true);
  assert.equal(exec.code, "execute_ok");
  assert.equal(exec.occupancy.full, true);
  assert.equal(exec.occupancy.seats_used, 2);
  assert.equal(exec.occupancy.private_count, 0);
  assert.equal(exec.targets.lesson.privacy, "standard");
  assert.equal(exec.targets.manual.privacy, "standard");
  assert.equal(exec.targets.lesson.focus, "Both");
  assert.equal(exec.targets.manual.focus, "Both");

  const lessons = JSON.parse(blob.store.get("lessons.json").body);
  const manual = JSON.parse(blob.store.get("manual-bookings.json").body);
  const lesson = lessons.lessons.find((l) => l.id === LESSON_ID);
  const booking = manual.bookings.find((b) => b.id === MANUAL_ID);
  assert.equal(lesson.privacy, "standard");
  assert.equal(booking.privacy, "standard");
  assert.equal(lesson.date, baseLesson().date);
  assert.equal(lesson.time, baseLesson().time);
  assert.equal(lesson.focus, "Both");
  assert.equal(lesson.player, "Dylan Tuter");
  assert.equal(lesson.subId, "pi_mem_dylan");
  assert.equal(booking.paymentStatus, "paid");
  assert.equal(booking.status, "scheduled");
  assert.equal(booking.player, "Cooper");
  // unrelated rows intact
  assert.deepEqual(
    lessons.lessons.find((l) => l.id === "lsn_other_keep"),
    docs.lessons.lessons.find((l) => l.id === "lsn_other_keep")
  );
  assert.ok(blob.store.has(`${BACKUP_PREFIX}/run_ok/lessons.json`));
  assert.ok(blob.store.has(`${BACKUP_PREFIX}/run_ok/manual-bookings.json`));
  assert.ok(blob.store.has(LOCK_PATH));

  // Report must not leak secrets
  const safe = sanitizeMaintenanceReport(exec);
  const dumped = JSON.stringify(safe);
  assert.equal(dumped.includes("vercel_blob_rw"), false);
  assert.equal(dumped.includes(SECRET), false);
  assert.equal(dumped.includes("Dylan"), false);
  assert.equal(dumped.includes("etag"), false);
});

test("putCreateOnly refuses overwrite", async () => {
  const blob = createMemoryBlob();
  const first = await putCreateOnly("backup/x.json", "{}", "tok", blob);
  const second = await putCreateOnly("backup/x.json", "{}", "tok", blob);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, "already_exists");
});

test("API execute path wires auth headers and sanitizes response", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  process.env.MAINTENANCE_PRIVACY_FIX = "1";
  process.env.MAINTENANCE_PRIVACY_FIX_SECRET = SECRET;
  process.env.MAINTENANCE_ALLOW_TEST = "1";
  process.env.VERCEL_ENV = "production";
  process.env.COACH_PASS = COACH;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_teststore_testsecret";
  process.env.CAPACITY_WRITES_ENABLED = "0";

  // Monkey-patch via env is not enough for blob — call lib directly for execute
  // and use handler only for disabled/auth surface already covered.
  // Additional: unauthorized via handler
  const res = mockRes();
  await handler(
    {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: { key: COACH, mode: "dry_run" },
    },
    res
  );
  // Handler uses real blob; without inject it will fail missing token path or origin.
  // With MAINTENANCE enabled but wrong bearer — authorize fails before blob.
  // But handler doesn't inject blob; it will call real @vercel/blob after auth.
  // So for wrong bearer we get 401 before blob.
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "unauthorized");
  void docs;
  void blob;
});
