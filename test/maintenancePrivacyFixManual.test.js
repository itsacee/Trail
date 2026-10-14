// Safety tests for manual-only privacy-fix completion (Cooper).
// In-memory Blob mock — never touches live Production Blob.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import handler from "../api/maintenance-privacy-fix-manual.js";
import {
  LESSON_ID,
  MANUAL_ID,
  CONFIRM_EXECUTE_MANUAL,
  CONFIRM_RESTORE_MANUAL,
  MANUAL_LOCK_PATH,
  ORIGINAL_LOCK_PATH,
  MANUAL_BACKUP_PREFIX,
  EXPECTED_LESSONS_SHA_AFTER_DYLAN,
  EXPECTED_MANUAL_SHA_BEFORE,
  authorizeManualRequest,
  maintenanceManualEnabled,
  applyManualPrivacyStandardPatch,
  evaluateTargetSlotOccupancy,
  originGetText,
  verifyManualAfterWrite,
  runMaintenancePrivacyFixManual,
  sanitizeMaintenanceReport,
  putCreateOnly,
} from "../lib/maintenancePrivacyFixManual.js";
import { assertWriteFreeze } from "../lib/maintenancePrivacyFix.js";

const SECRET = "test-manual-maintenance-secret-32c";
const COACH = "coach-test-pass";
/** Original two-file confirm — must NOT authorize the manual-only path. */
const CONFIRM_EXECUTE_ORIGINAL = "PRIVACY-FIX-OCT15-2026-STANDARD";

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
    privacy: "standard",
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

function createMemoryBlob({ failPutPaths = new Set(), putLog = [] } = {}) {
  const store = new Map();
  let seq = 0;
  const nextEtag = () => {
    seq += 1;
    return `"etag-${seq}"`;
  };

  const blob = {
    BlobPreconditionFailedError,
    store,
    putLog,
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
      putLog.push({ pathname, opts: { ...opts } });
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
    MAINTENANCE_PRIVACY_FIX_MANUAL: "1",
    MAINTENANCE_PRIVACY_FIX_MANUAL_SECRET: SECRET,
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
  // Original once-lock already held from partial execute — must remain untouched.
  blob.store.set(ORIGINAL_LOCK_PATH, {
    body: JSON.stringify({ runId: "run_oct15_prior", scope: "two_file" }),
    etag: '"OL1"',
  });
  return docs;
}

function hashPins(docs) {
  return {
    expected_lessons_sha256: sha256(docs.lessonsText),
    expected_manual_sha256: sha256(docs.manualText),
  };
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

function assertLessonsUntouched(blob, docs) {
  assert.equal(blob.store.get("lessons.json").body, docs.lessonsText);
  assert.equal(
    JSON.parse(blob.store.get("lessons.json").body).lessons.find((l) => l.id === LESSON_ID)
      .privacy,
    "standard"
  );
  const lessonPuts = blob.putLog.filter((p) => p.pathname === "lessons.json");
  assert.equal(lessonPuts.length, 0);
  assert.equal(blob.store.get(ORIGINAL_LOCK_PATH).body.includes("run_oct15_prior"), true);
}

beforeEach(() => {
  delete process.env.MAINTENANCE_PRIVACY_FIX_MANUAL;
  delete process.env.MAINTENANCE_PRIVACY_FIX_MANUAL_SECRET;
  delete process.env.MAINTENANCE_ALLOW_TEST;
});

test("maintenanceManualEnabled defaults off", () => {
  assert.equal(maintenanceManualEnabled({}), false);
  assert.equal(maintenanceManualEnabled({ MAINTENANCE_PRIVACY_FIX_MANUAL: "1" }), true);
});

test("authorizeManualRequest: disabled / unauthorized / confirm gates", () => {
  assert.equal(authorizeManualRequest({ env: {}, mode: "dry_run" }).code, "disabled");
  assert.equal(
    authorizeManualRequest({
      env: authEnv(),
      bearer: "wrong",
      coachKey: COACH,
      mode: "dry_run",
    }).code,
    "unauthorized"
  );
  assert.equal(
    authorizeManualRequest({
      env: authEnv(),
      bearer: SECRET,
      coachKey: "nope",
      mode: "dry_run",
    }).code,
    "coach_unauthorized"
  );
  assert.equal(
    authorizeManualRequest({
      env: authEnv(),
      bearer: SECRET,
      coachKey: COACH,
      mode: "execute",
      confirm: "WRONG",
    }).code,
    "confirm_required"
  );
  assert.equal(
    authorizeManualRequest({
      env: authEnv(),
      bearer: SECRET,
      coachKey: COACH,
      mode: "execute",
      confirm: CONFIRM_EXECUTE_ORIGINAL,
    }).code,
    "confirm_required"
  );
  assert.equal(
    authorizeManualRequest({
      env: authEnv(),
      bearer: SECRET,
      coachKey: COACH,
      mode: "restore",
      confirm: "WRONG",
    }).code,
    "restore_confirm_required"
  );
  assert.equal(
    authorizeManualRequest({
      env: authEnv(),
      bearer: SECRET,
      coachKey: COACH,
      mode: "dry_run",
    }).ok,
    true
  );
});

test("MAINTENANCE_DRYRUN_KEY authorizes dry_run only, never execute", () => {
  const DRY = "dryrun-only-key-32-characters-xx";
  const env = authEnv({ MAINTENANCE_DRYRUN_KEY: DRY });
  assert.equal(
    authorizeManualRequest({
      env,
      bearer: SECRET,
      coachKey: DRY,
      mode: "dry_run",
    }).ok,
    true
  );
  assert.equal(
    authorizeManualRequest({
      env,
      bearer: SECRET,
      coachKey: DRY,
      mode: "execute",
      confirm: CONFIRM_EXECUTE_MANUAL,
    }).code,
    "coach_unauthorized"
  );
});

test("assertWriteFreeze refuses when capacity or booking writes enabled", () => {
  assert.equal(assertWriteFreeze(authEnv()).ok, true);
  assert.equal(assertWriteFreeze(authEnv({ CAPACITY_WRITES_ENABLED: "1" })).ok, false);
  assert.equal(assertWriteFreeze(authEnv({ BOOKING_WRITES_ENABLED: "1" })).ok, false);
});

test("Production pins are the investigation SHAs", () => {
  assert.equal(
    EXPECTED_LESSONS_SHA_AFTER_DYLAN,
    "1b9a49724f00d5de7028fa0f20285eec5b2876673031284ba4b603ce6c549dfe"
  );
  assert.equal(
    EXPECTED_MANUAL_SHA_BEFORE,
    "8ab78033204966f117563e22b344986470a42f08b8fbe32e7df2bb43dd92180a"
  );
  assert.equal(MANUAL_LOCK_PATH, "maintenance/privacy-fix-oct15-2026-manual.lock");
  assert.equal(ORIGINAL_LOCK_PATH, "maintenance/privacy-fix-oct15-2026.lock");
});

test("applyManualPrivacyStandardPatch stamps only privacy and preserves other fields", () => {
  const docs = seedDocs();
  const result = applyManualPrivacyStandardPatch(docs.manual);
  assert.equal(result.ok, true);
  const booking = result.manual.bookings.find((b) => b.id === MANUAL_ID);
  assert.equal(booking.privacy, "standard");
  assert.equal(booking.date, "2026-10-15");
  assert.equal(booking.time, "5:00 PM");
  assert.equal(booking.focus, "Both");
  assert.equal(booking.player, "Cooper");
  assert.equal(booking.paymentStatus, "paid");
  assert.equal(booking.status, "scheduled");
  assert.deepEqual(
    result.manual.bookings.find((b) => b.id === "mb_other_keep"),
    docs.manual.bookings.find((b) => b.id === "mb_other_keep")
  );
});

test("applyManualPrivacyStandardPatch refuses wrong identity / already stamped", () => {
  const docs = seedDocs();
  docs.manual.bookings[0].privacy = "standard";
  assert.equal(applyManualPrivacyStandardPatch(docs.manual).code, "manual_identity_mismatch");

  const docs2 = seedDocs();
  docs2.manual.bookings[0].date = "2026-10-16";
  assert.equal(applyManualPrivacyStandardPatch(docs2.manual).code, "manual_identity_mismatch");

  const docs3 = seedDocs();
  docs3.manual.bookings[0].focus = "Hitting";
  assert.equal(applyManualPrivacyStandardPatch(docs3.manual).code, "manual_identity_mismatch");
});

test("occupancy after manual stamp is Standard Both Full 2/2 not Private", () => {
  const docs = seedDocs();
  const patched = applyManualPrivacyStandardPatch(docs.manual);
  const occ = evaluateTargetSlotOccupancy(docs.lessons, patched.manual);
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

test("API handler returns 404 when disabled", async () => {
  delete process.env.MAINTENANCE_PRIVACY_FIX_MANUAL;
  const res = mockRes();
  await handler({ method: "POST", headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "disabled");
});

test("dry_run succeeds with zero writes and expected occupancy", async () => {
  const putLog = [];
  const blob = createMemoryBlob({ putLog });
  const docs = seedBlob(blob);
  const pins = hashPins(docs);
  const report = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "dry_run",
    bearer: SECRET,
    coachKey: COACH,
    blob,
    ...pins,
  });
  assert.equal(report.ok, true);
  assert.equal(report.code, "dry_run_ok");
  assert.equal(report.writes, "none");
  assert.equal(report.before.lessons_sha256, pins.expected_lessons_sha256);
  assert.equal(report.before.manual_sha256, pins.expected_manual_sha256);
  assert.equal(report.occupancy_expected.full, true);
  assert.equal(report.occupancy_expected.private_count, 0);
  assert.equal(blob.store.has(MANUAL_LOCK_PATH), false);
  assert.equal(putLog.length, 0);
  assertLessonsUntouched(blob, docs);
});

test("execute refuses hash mismatch", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  const report = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    expected_lessons_sha256: sha256(docs.lessonsText),
    expected_manual_sha256: "1".repeat(64),
    blob,
  });
  // Pin check fires first when live ≠ EXPECTED_MANUAL and options pin wrong
  assert.ok(
    report.code === "manual_source_hash_mismatch" || report.code === "hash_mismatch"
  );
  assert.equal(report.state, "aborted_before_writes");
  assert.equal(blob.store.has(MANUAL_LOCK_PATH), false);
  assertLessonsUntouched(blob, docs);
});

test("execute refuses write freeze breach", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  const report = await runMaintenancePrivacyFixManual({
    env: authEnv({ CAPACITY_WRITES_ENABLED: "1" }),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    ...hashPins(docs),
    blob,
  });
  assert.equal(report.code, "write_freeze_required");
});

test("execute refuses lessons sibling identity drift (Dylan not standard)", async () => {
  const blob = createMemoryBlob();
  const docs = seedDocs();
  delete docs.lessons.lessons[0].privacy;
  docs.lessonsText = JSON.stringify(docs.lessons);
  seedBlob(blob, docs);
  const report = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "dry_run",
    bearer: SECRET,
    coachKey: COACH,
    ...hashPins(docs),
    blob,
  });
  assert.equal(report.code, "lessons_sibling_identity_mismatch");
  assert.equal(blob.putLog.filter((p) => p.pathname === "lessons.json").length, 0);
  assert.equal(blob.store.get("lessons.json").body, docs.lessonsText);
});

test("backup failure aborts before lock or capacity writes", async () => {
  const putLog = [];
  const blob = createMemoryBlob({ putLog });
  const docs = seedBlob(blob);
  const runId = "run_bakfail";
  blob.store.set(`${MANUAL_BACKUP_PREFIX}/${runId}/manual-bookings.json`, {
    body: "stale",
    etag: '"bak"',
  });
  const report = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    ...hashPins(docs),
    runId,
    blob,
  });
  assert.equal(report.code, "backup_manual_failed");
  assert.equal(blob.store.has(MANUAL_LOCK_PATH), false);
  assert.equal(
    JSON.parse(blob.store.get("manual-bookings.json").body).bookings.find(
      (b) => b.id === MANUAL_ID
    ).privacy,
    undefined
  );
  assertLessonsUntouched(blob, docs);
});

test("concurrent execute: second request hits lock_held", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  const pins = hashPins(docs);
  const first = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    runId: "run_a",
    blob,
    ...pins,
  });
  assert.equal(first.code, "execute_ok");

  // Reset manual to pre-fix so identity still matches, keep new lock + original lock
  blob.store.set("manual-bookings.json", { body: docs.manualText, etag: '"M-reset"' });
  const second = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    runId: "run_b",
    blob,
    ...pins,
  });
  assert.equal(second.code, "lock_held");
  assert.equal(second.state, "aborted_before_writes");
  assert.ok(blob.store.has(ORIGINAL_LOCK_PATH));
});

test("confirmed put failure does not touch lessons; put_outcome failed", async () => {
  const putLog = [];
  const blob = createMemoryBlob({
    failPutPaths: new Set(["manual-bookings.json"]),
    putLog,
  });
  const docs = seedBlob(blob);
  const report = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    ...hashPins(docs),
    runId: "run_putfail",
    blob,
  });
  assert.equal(report.code, "put_failed");
  assert.equal(report.put_outcome, "failed");
  assert.equal(report.state, "manual_write_failed");
  assert.equal(report.files.lessons, "untouched");
  assert.equal(report.files.manual, "failed");
  assert.match(report.recovery, /Do not auto-retry/);
  assert.match(report.recovery, /Do not restore lessons/);
  assertLessonsUntouched(blob, docs);
  assert.equal(
    JSON.parse(blob.store.get("manual-bookings.json").body).bookings.find(
      (b) => b.id === MANUAL_ID
    ).privacy,
    undefined
  );
});

test("delayed visibility after successful put → verify_pending_stale_read (not put_failed)", async () => {
  const putLog = [];
  const blob = createMemoryBlob({ putLog });
  const docs = seedBlob(blob);
  const pins = hashPins(docs);
  const beforeManual = docs.manualText;
  let manualGetCount = 0;

  const origGet = blob.get.bind(blob);
  blob.get = async (pathname, opts) => {
    const result = await origGet(pathname, opts);
    if (pathname === "manual-bookings.json") {
      manualGetCount += 1;
      // After put, keep returning the pre-write body (stale origin/CDN-like lag).
      const putDone = putLog.some(
        (p) => p.pathname === "manual-bookings.json" && p.opts?.ifMatch
      );
      if (putDone) {
        return {
          statusCode: 200,
          text: async () => beforeManual,
        };
      }
    }
    return result;
  };

  // Head must also look consistent with stale body so bookend succeeds with old SHA.
  const origHead = blob.head.bind(blob);
  blob.head = async (pathname) => {
    const putDone = putLog.some(
      (p) => p.pathname === "manual-bookings.json" && p.opts?.ifMatch
    );
    if (pathname === "manual-bookings.json" && putDone) {
      return { etag: '"M-stale"', pathname };
    }
    return origHead(pathname);
  };

  const report = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    ...pins,
    runId: "run_stale",
    blob,
    verifyAttempts: 3,
    verifyDelayMs: 1,
    sleeper: async () => {},
  });

  assert.equal(report.put_outcome, "ok");
  assert.equal(report.code, "verify_pending_stale_read");
  assert.equal(report.status, 202);
  assert.equal(report.state, "manual_put_ok_verify_unconfirmed");
  assert.equal(report.files.lessons, "untouched");
  assert.equal(report.files.manual, "put_ok_unverified");
  assert.match(report.recovery, /Do NOT auto-retry write/);
  assert.match(report.recovery, /Do NOT restore lessons/);
  // Put did land in store (CAS wrote), even though verify saw stale.
  assert.equal(
    JSON.parse(blob.store.get("manual-bookings.json").body).bookings.find(
      (b) => b.id === MANUAL_ID
    ).privacy,
    "standard"
  );
  assertLessonsUntouched(blob, docs);
  assert.ok(manualGetCount >= 3);
});

test("cached/public CDN fallback is not used for verify (origin-only)", async () => {
  let fetchCalled = false;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("CDN_STALE", { status: 200 });
  };
  try {
    const blob = {
      BlobPreconditionFailedError,
      async get() {
        // No stream, no text — would force fallback if allowed.
        return { statusCode: 200 };
      },
      async head() {
        return { etag: '"x"' };
      },
      async put() {
        throw new Error("put should not run");
      },
    };
    await assert.rejects(
      () => originGetText("manual-bookings.json", "tok", blob, { allowPublicFallback: false }),
      /origin_get_no_stream/
    );
    assert.equal(fetchCalled, false);

    const verify = await verifyManualAfterWrite({
      token: "tok",
      blob,
      env: { AVAILABILITY_URL: "https://cdn.example/availability.json" },
      expectedSha: "a".repeat(64),
      expectedRowPreimage: baseManual(),
      attempts: 2,
      delayMs: 1,
      sleeper: async () => {},
    });
    assert.equal(verify.code, "verify_pending_stale_read");
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("successful execute stamps only Cooper privacy; Full 2/2 Standard; lessons untouched", async () => {
  const putLog = [];
  const blob = createMemoryBlob({ putLog });
  const docs = seedBlob(blob);
  const pins = hashPins(docs);
  const dry = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "dry_run",
    bearer: SECRET,
    coachKey: COACH,
    blob,
    ...pins,
  });
  assert.equal(dry.ok, true);

  const exec = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    ...pins,
    runId: "run_ok",
    blob,
  });
  assert.equal(exec.ok, true);
  assert.equal(exec.code, "execute_ok");
  assert.equal(exec.put_outcome, "ok");
  assert.equal(exec.occupancy.full, true);
  assert.equal(exec.occupancy.seats_used, 2);
  assert.equal(exec.occupancy.private_count, 0);
  assert.equal(exec.occupancy.standard_count, 2);
  assert.equal(exec.targets.manual.privacy, "standard");
  assert.equal(exec.targets.lesson.privacy, "standard");
  assert.equal(exec.files.lessons, "untouched");
  assert.equal(exec.after.lessons_sha256, pins.expected_lessons_sha256);

  const lessons = JSON.parse(blob.store.get("lessons.json").body);
  const manual = JSON.parse(blob.store.get("manual-bookings.json").body);
  const lesson = lessons.lessons.find((l) => l.id === LESSON_ID);
  const booking = manual.bookings.find((b) => b.id === MANUAL_ID);
  assert.equal(lesson.privacy, "standard");
  assert.equal(booking.privacy, "standard");
  assert.equal(booking.player, "Cooper");
  assert.equal(booking.paymentStatus, "paid");
  assert.deepEqual(
    lessons.lessons.find((l) => l.id === "lsn_other_keep"),
    docs.lessons.lessons.find((l) => l.id === "lsn_other_keep")
  );
  assert.deepEqual(
    manual.bookings.find((b) => b.id === "mb_other_keep"),
    docs.manual.bookings.find((b) => b.id === "mb_other_keep")
  );
  assert.ok(blob.store.has(`${MANUAL_BACKUP_PREFIX}/run_ok/manual-bookings.json`));
  assert.ok(blob.store.has(MANUAL_LOCK_PATH));
  assert.ok(blob.store.has(ORIGINAL_LOCK_PATH));
  assert.equal(putLog.filter((p) => p.pathname === "lessons.json").length, 0);
  assert.equal(putLog.filter((p) => p.pathname === ORIGINAL_LOCK_PATH).length, 0);

  const safe = sanitizeMaintenanceReport(exec);
  const dumped = JSON.stringify(safe);
  assert.equal(dumped.includes("vercel_blob_rw"), false);
  assert.equal(dumped.includes(SECRET), false);
  assert.equal(dumped.includes("Cooper"), false);
  assert.equal(dumped.includes("etag"), false);
});

test("original lock path reuse is forbidden", async () => {
  const blob = createMemoryBlob();
  const docs = seedBlob(blob);
  const report = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    ...hashPins(docs),
    runId: "run_reuse",
    lockPath: ORIGINAL_LOCK_PATH,
    blob,
  });
  assert.equal(report.code, "original_lock_reuse_forbidden");
  assertLessonsUntouched(blob, docs);
});

test("partial-failure preservation: Dylan remains standard after manual path aborts", async () => {
  const blob = createMemoryBlob({ failPutPaths: new Set(["manual-bookings.json"]) });
  const docs = seedBlob(blob);
  const beforeLessonsSha = sha256(docs.lessonsText);
  await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    ...hashPins(docs),
    runId: "run_preserve",
    blob,
  });
  assert.equal(sha256(blob.store.get("lessons.json").body), beforeLessonsSha);
  assert.equal(
    JSON.parse(blob.store.get("lessons.json").body).lessons.find((l) => l.id === LESSON_ID)
      .privacy,
    "standard"
  );
});

test("owner-approved manual restore does not write lessons", async () => {
  const putLog = [];
  const blob = createMemoryBlob({ putLog });
  const docs = seedBlob(blob);
  const pins = hashPins(docs);
  const exec = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "execute",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_EXECUTE_MANUAL,
    ...pins,
    runId: "run_restore_ok",
    blob,
  });
  assert.equal(exec.ok, true);

  const restored = await runMaintenancePrivacyFixManual({
    env: authEnv(),
    mode: "restore",
    bearer: SECRET,
    coachKey: COACH,
    confirm: CONFIRM_RESTORE_MANUAL,
    runId: "run_restore_ok",
    expected_current_sha256: exec.after.manual_sha256,
    expected_lessons_sha256: exec.after.lessons_sha256,
    blob,
  });
  assert.equal(restored.code, "restore_ok");
  assert.equal(restored.files.lessons, "untouched");
  assert.equal(sha256(blob.store.get("manual-bookings.json").body), pins.expected_manual_sha256);
  assert.equal(sha256(blob.store.get("lessons.json").body), pins.expected_lessons_sha256);
  assert.equal(putLog.filter((p) => p.pathname === "lessons.json").length, 0);
});

test("putCreateOnly refuses overwrite", async () => {
  const blob = createMemoryBlob();
  const first = await putCreateOnly("backup/manual-x.json", "{}", "tok", blob);
  const second = await putCreateOnly("backup/manual-x.json", "{}", "tok", blob);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, "already_exists");
});

test("API unauthorized via handler before blob", async () => {
  process.env.MAINTENANCE_PRIVACY_FIX_MANUAL = "1";
  process.env.MAINTENANCE_PRIVACY_FIX_MANUAL_SECRET = SECRET;
  process.env.MAINTENANCE_ALLOW_TEST = "1";
  process.env.VERCEL_ENV = "production";
  process.env.COACH_PASS = COACH;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_teststore_testsecret";
  process.env.CAPACITY_WRITES_ENABLED = "0";

  const res = mockRes();
  await handler(
    {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: { key: COACH, mode: "dry_run" },
    },
    res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "unauthorized");
});
