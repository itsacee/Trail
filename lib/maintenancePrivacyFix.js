// One-time Production privacy correction for two allowlisted Oct 15 5pm bookings.
// Disabled unless MAINTENANCE_PRIVACY_FIX=1. Uses runtime Blob credentials only.
// Does NOT enable CAPACITY_WRITES_ENABLED for normal writers.

import { createHash } from "node:crypto";
import { put, get, head, BlobPreconditionFailedError } from "@vercel/blob";
import { CAPACITY_FILES } from "./store.js";
import { resolvePrivacy, slotBlocked } from "./schedule.js";
import { isActiveLesson } from "./lessons.js";
import { activeBookings } from "./manualBookings.js";

export const LESSON_ID = "lsn_mv3zgqy2_zos8on";
export const MANUAL_ID = "mb_muvxcb7c_1656bd";
export const CONFIRM_EXECUTE = "PRIVACY-FIX-OCT15-2026-STANDARD";
export const CONFIRM_RESTORE = "PRIVACY-FIX-RESTORE";
export const LOCK_PATH = "maintenance/privacy-fix-oct15-2026.lock";
export const BACKUP_PREFIX = "backup/privacy-fix";

const TARGET_DATE = "2026-10-15";
const TARGET_TIME = "5:00 PM";
const TARGET_FOCUS = "Both";

function sha256Text(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function stableStringify(value) {
  return JSON.stringify(value);
}

function publicAccessToken(env = process.env) {
  return String(env.BLOB_READ_WRITE_TOKEN || "").trim();
}

/** Default or injected Blob SDK surface (tests inject a memory mock). */
export function createBlobOps(overrides = {}) {
  return {
    put: overrides.put || put,
    get: overrides.get || get,
    head: overrides.head || head,
    BlobPreconditionFailedError:
      overrides.BlobPreconditionFailedError || BlobPreconditionFailedError,
  };
}

function isPreconditionFailed(error, BlobPreconditionFailedErrorCls) {
  return (
    error instanceof BlobPreconditionFailedErrorCls ||
    error?.name === "BlobPreconditionFailedError" ||
    /precondition failed|etag mismatch/i.test(String(error?.message || ""))
  );
}

function isAlreadyExistsError(error) {
  const msg = String(error?.message || error || "");
  return (
    error?.name === "BlobAlreadyExistsError" ||
    /already exists|cannot be overwritten|overwrite/i.test(msg)
  );
}

/** Sanitize for logs/responses — never etags, tokens, bodies, or PII values. */
export function fingerprintLesson(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    time: row.time,
    focus: row.focus || "",
    type: row.type || "",
    source: row.source || "",
    privacy: row.privacy ?? "(absent)",
    privacy_resolved: resolvePrivacy(row),
    active: isActiveLesson(row),
    has_email: Boolean(row.email),
    has_player: Boolean(row.player),
    has_subId: Boolean(row.subId),
    has_sourceId: Boolean(row.sourceId),
  };
}

export function fingerprintManual(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    time: row.time,
    focus: row.focus || "",
    type: row.type || "",
    source: row.source || "manual",
    status: row.status || "",
    privacy: row.privacy ?? "(absent)",
    privacy_resolved: resolvePrivacy(row),
    paymentStatus: row.paymentStatus || "",
    has_email: Boolean(row.email),
    has_player: Boolean(row.player),
  };
}

export function assertWriteFreeze(env = process.env) {
  // Explicit Production flags only. Do not use capacityWritesEnabled() here:
  // memory-store tests treat unset CAPACITY_WRITES_ENABLED as enabled.
  const reasons = [];
  if (String(env.CAPACITY_WRITES_ENABLED || "") === "1") {
    reasons.push("capacity_writes_enabled");
  }
  if (String(env.BOOKING_WRITES_ENABLED || "") === "1") {
    reasons.push("booking_writes_enabled");
  }
  return {
    ok: reasons.length === 0,
    frozen: reasons.length === 0,
    reasons,
    capacity_writes_enabled: String(env.CAPACITY_WRITES_ENABLED || "") === "1",
    booking_writes_enabled: String(env.BOOKING_WRITES_ENABLED || "") === "1",
  };
}

export function maintenanceEnabled(env = process.env) {
  return env.MAINTENANCE_PRIVACY_FIX === "1";
}

export function assertProductionOnly(env = process.env) {
  // Tests may set MAINTENANCE_ALLOW_TEST=1 with VERCEL_ENV=production mock.
  if (env.MAINTENANCE_ALLOW_TEST === "1") return { ok: true, test: true };
  return {
    ok: String(env.VERCEL_ENV || "") === "production",
    vercel_env: String(env.VERCEL_ENV || "") || "(unset)",
  };
}

export function authorizeRequest({ env = process.env, bearer = "", coachKey = "", confirm = "", mode = "dry_run" }) {
  if (!maintenanceEnabled(env)) {
    return { ok: false, code: "disabled", status: 404 };
  }
  const prod = assertProductionOnly(env);
  if (!prod.ok) {
    return { ok: false, code: "env_blocked", status: 403 };
  }
  const secret = String(env.MAINTENANCE_PRIVACY_FIX_SECRET || "");
  if (!secret || secret.length < 24) {
    return { ok: false, code: "secret_not_configured", status: 403 };
  }
  if (String(bearer || "") !== secret) {
    return { ok: false, code: "unauthorized", status: 401 };
  }
  const coach = String(env.COACH_PASS || "").trim();
  const dryrunKey = String(env.MAINTENANCE_DRYRUN_KEY || "").trim();
  const provided = String(coachKey || "");
  // Prefer COACH_PASS. Optional MAINTENANCE_DRYRUN_KEY is dry_run-only so a
  // Sensitive COACH_PASS need not be exported to the operator environment.
  const coachOk = Boolean(coach) && provided === coach;
  const dryrunOk =
    mode === "dry_run" && dryrunKey.length >= 24 && provided === dryrunKey;
  if (!coachOk && !dryrunOk) {
    return { ok: false, code: "coach_unauthorized", status: 401 };
  }
  if (mode === "execute" && String(confirm || "") !== CONFIRM_EXECUTE) {
    return { ok: false, code: "confirm_required", status: 403 };
  }
  if (mode === "restore" && String(confirm || "") !== CONFIRM_RESTORE) {
    return { ok: false, code: "restore_confirm_required", status: 403 };
  }
  return { ok: true };
}

function lessonIdentityOk(row) {
  return (
    row &&
    row.id === LESSON_ID &&
    row.date === TARGET_DATE &&
    row.time === TARGET_TIME &&
    row.focus === TARGET_FOCUS &&
    isActiveLesson(row) &&
    (row.privacy === undefined || row.privacy === null || row.privacy === "")
  );
}

function manualIdentityOk(row) {
  return (
    row &&
    row.id === MANUAL_ID &&
    row.date === TARGET_DATE &&
    row.time === TARGET_TIME &&
    row.focus === TARGET_FOCUS &&
    String(row.status || "").toLowerCase() !== "cancelled" &&
    (row.privacy === undefined || row.privacy === null || row.privacy === "")
  );
}

function deepEqualSansPrivacy(a, b) {
  const strip = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    const out = { ...obj };
    delete out.privacy;
    return out;
  };
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

export function applyPrivacyStandardPatch(lessonsData, manualData) {
  const lessons = structuredClone(lessonsData);
  const manual = structuredClone(manualData);
  const lesson = (lessons.lessons || []).find((l) => l.id === LESSON_ID);
  const booking = (manual.bookings || []).find((b) => b.id === MANUAL_ID);
  if (!lessonIdentityOk(lesson)) {
    return { ok: false, code: "lesson_identity_mismatch", lesson: fingerprintLesson(lesson) };
  }
  if (!manualIdentityOk(booking)) {
    return { ok: false, code: "manual_identity_mismatch", manual: fingerprintManual(booking) };
  }
  const lessonBefore = structuredClone(lesson);
  const manualBefore = structuredClone(booking);
  lesson.privacy = "standard";
  booking.privacy = "standard";
  if (!deepEqualSansPrivacy(lessonBefore, lesson) || !deepEqualSansPrivacy(manualBefore, booking)) {
    return { ok: false, code: "unexpected_field_drift" };
  }
  if (lesson.privacy !== "standard" || booking.privacy !== "standard") {
    return { ok: false, code: "patch_failed" };
  }
  return {
    ok: true,
    lessons,
    manual,
    lesson_fp: fingerprintLesson(lesson),
    manual_fp: fingerprintManual(booking),
  };
}

/** Occupancy expectation after correction: 2 standard Both seats, not exclusive. */
export function evaluateTargetSlotOccupancy(lessonsData, manualData, { now = Date.now() } = {}) {
  const rows = [];
  for (const l of lessonsData.lessons || []) {
    if (!isActiveLesson(l) || l.date !== TARGET_DATE || l.time !== TARGET_TIME) continue;
    rows.push({
      id: l.id,
      time: l.time,
      mins: 60,
      focus: l.focus || "",
      focuses: [l.focus || ""],
      privacy: resolvePrivacy(l),
      exclusive: resolvePrivacy(l) === "private",
      seats: resolvePrivacy(l) === "private" ? 2 : 1,
      count: 1,
    });
  }
  for (const b of activeBookings(manualData || { bookings: [] })) {
    if (b.date !== TARGET_DATE || b.time !== TARGET_TIME) continue;
    rows.push({
      id: b.id,
      time: b.time,
      mins: 60,
      focus: b.focus || "",
      focuses: [b.focus || ""],
      privacy: resolvePrivacy(b),
      exclusive: resolvePrivacy(b) === "private",
      seats: Number(b.seats) || (resolvePrivacy(b) === "private" ? 2 : 1),
      count: 1,
    });
  }
  const standards = rows.filter((r) => r.privacy === "standard");
  const privates = rows.filter((r) => r.privacy === "private");
  const seatSum = standards.reduce((a, r) => a + (Number(r.seats) || 1), 0);
  const focuses = new Set(standards.map((r) => r.focus));
  const ok =
    rows.length === 2 &&
    privates.length === 0 &&
    standards.length === 2 &&
    seatSum === 2 &&
    focuses.size === 1 &&
    focuses.has(TARGET_FOCUS) &&
    !rows.some((r) => r.exclusive);

  // Also: a third standard Both must be blocked (Full).
  const full =
    ok &&
    slotBlocked(rows, TARGET_TIME, 60, TARGET_FOCUS, {
      seats: 1,
      exclusive: false,
      privacy: "standard",
    });

  return {
    ok: ok && full,
    occupant_count: rows.length,
    standard_count: standards.length,
    private_count: privates.length,
    seats_used: seatSum,
    seats_capacity: 2,
    exclusive: privates.length > 0 || rows.some((r) => r.exclusive),
    focus: TARGET_FOCUS,
    full: Boolean(full),
    ids: rows.map((r) => r.id),
  };
}

async function originHeadEtag(pathname, token, blob) {
  const meta = await blob.head(pathname, { access: "public", token });
  return String(meta?.etag || "");
}

async function originGetText(pathname, token, blob) {
  const result = await blob.get(pathname, { access: "public", token, useCache: false });
  if (!result || result.statusCode === 404) return null;
  const text = await result.text();
  return text;
}

/**
 * Origin head-bookended read for CAS. Returns raw text + API etag when stable.
 * Never returns token values.
 */
export async function readOriginBookended(pathname, { token, attempts = 3, blob = createBlobOps() } = {}) {
  let lastText = null;
  for (let i = 0; i < attempts; i++) {
    let h1 = "";
    try {
      h1 = await originHeadEtag(pathname, token, blob);
    } catch {
      return { ok: false, code: "head_failed", text: lastText, etag: "", conditional: false };
    }
    let text;
    try {
      text = await originGetText(pathname, token, blob);
    } catch {
      return { ok: false, code: "get_failed", text: lastText, etag: "", conditional: false };
    }
    if (text == null) {
      return { ok: true, missing: true, text: null, etag: "", conditional: false, sha256: null };
    }
    lastText = text;
    let h2 = "";
    try {
      h2 = await originHeadEtag(pathname, token, blob);
    } catch {
      return { ok: false, code: "head_failed", text, etag: "", conditional: false };
    }
    if (!h1 || !h2) {
      return { ok: false, code: "missing_etag", text, etag: "", conditional: false };
    }
    if (h1 !== h2) continue;
    return {
      ok: true,
      missing: false,
      text,
      etag: h1,
      conditional: true,
      sha256: sha256Text(text),
    };
  }
  return { ok: false, code: "bookend_exhausted", text: lastText, etag: "", conditional: false };
}

async function putIfMatch(pathname, body, etag, token, blob) {
  try {
    await blob.put(pathname, body, {
      access: "public",
      token,
      contentType: "application/json",
      ifMatch: etag,
      addRandomSuffix: false,
    });
    return { ok: true };
  } catch (error) {
    if (isPreconditionFailed(error, blob.BlobPreconditionFailedError)) {
      return { ok: false, conflict: true, code: "cas_conflict" };
    }
    return { ok: false, code: "put_failed" };
  }
}

/** Create-only put: fail if object already exists (distributed once-lock / backups). */
export async function putCreateOnly(pathname, body, token, blob = createBlobOps()) {
  try {
    await blob.put(pathname, body, {
      access: "public",
      token,
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return { ok: true };
  } catch (error) {
    if (
      isAlreadyExistsError(error) ||
      isPreconditionFailed(error, blob.BlobPreconditionFailedError)
    ) {
      return { ok: false, code: "already_exists", conflict: true };
    }
    return { ok: false, code: "put_failed" };
  }
}

function parseLessons(text) {
  const data = JSON.parse(text);
  return {
    lessons: Array.isArray(data?.lessons) ? data.lessons : [],
    voids: Array.isArray(data?.voids) ? data.voids : [],
  };
}

function parseManual(text) {
  const data = JSON.parse(text);
  return { bookings: Array.isArray(data?.bookings) ? data.bookings : [] };
}

/**
 * Core maintenance runner. Modes: dry_run | execute | restore
 * Never logs secrets/etags/bodies.
 */
export async function runMaintenancePrivacyFix(options = {}) {
  const env = options.env || process.env;
  const mode = String(options.mode || "dry_run");
  const blob = options.blob || createBlobOps();
  const report = {
    ok: false,
    mode,
    state: "aborted_before_writes",
    gates: {},
  };

  const auth = authorizeRequest({
    env,
    bearer: options.bearer,
    coachKey: options.coachKey,
    confirm: options.confirm,
    mode,
  });
  report.gates.auth = { ok: auth.ok, code: auth.code || null };
  if (!auth.ok) {
    report.code = auth.code;
    report.status = auth.status;
    return report;
  }

  const freeze = assertWriteFreeze(env);
  report.gates.write_freeze = {
    ok: freeze.ok,
    capacity_writes_enabled: freeze.capacity_writes_enabled,
    booking_writes_enabled: freeze.booking_writes_enabled,
  };
  if (!freeze.ok) {
    report.code = "write_freeze_required";
    report.status = 409;
    report.state = "aborted_before_writes";
    return report;
  }

  const token = publicAccessToken(env);
  if (!token) {
    report.code = "missing_blob_token";
    report.status = 503;
    return report;
  }

  // Fresh origin reads
  const lessonsRead = await readOriginBookended("lessons.json", { token, blob });
  const manualRead = await readOriginBookended("manual-bookings.json", { token, blob });
  report.gates.origin_read = {
    lessons_ok: Boolean(lessonsRead.ok && !lessonsRead.missing),
    manual_ok: Boolean(manualRead.ok && !manualRead.missing),
    lessons_code: lessonsRead.code || null,
    manual_code: manualRead.code || null,
  };
  if (!lessonsRead.ok || lessonsRead.missing || !manualRead.ok || manualRead.missing) {
    report.code = "origin_read_failed";
    report.status = 503;
    return report;
  }

  const beforeLessonsSha = lessonsRead.sha256;
  const beforeManualSha = manualRead.sha256;
  report.before = {
    lessons_sha256: beforeLessonsSha,
    manual_sha256: beforeManualSha,
    // etags intentionally omitted from report
    conditional: Boolean(lessonsRead.conditional && manualRead.conditional),
  };

  if (!lessonsRead.conditional || !manualRead.conditional) {
    report.code = "cas_not_safe";
    report.status = 409;
    return report;
  }

  // Restore must not require pre-patch identity (privacy may already be stamped).
  if (mode === "restore") {
    return runRestore({
      env,
      token,
      blob,
      options,
      report,
      lessonsRead,
      manualRead,
      beforeLessonsSha,
      beforeManualSha,
    });
  }

  let lessonsData;
  let manualData;
  try {
    lessonsData = parseLessons(lessonsRead.text);
    manualData = parseManual(manualRead.text);
  } catch {
    report.code = "parse_failed";
    report.status = 500;
    return report;
  }

  const patched = applyPrivacyStandardPatch(lessonsData, manualData);
  if (!patched.ok) {
    report.code = patched.code;
    report.status = 409;
    report.lesson = patched.lesson || null;
    report.manual = patched.manual || null;
    return report;
  }

  const afterLessonsBody = stableStringify(patched.lessons);
  const afterManualBody = stableStringify(patched.manual);
  const afterLessonsSha = sha256Text(afterLessonsBody);
  const afterManualSha = sha256Text(afterManualBody);
  const occupancy = evaluateTargetSlotOccupancy(patched.lessons, patched.manual);

  report.expected_after = {
    lessons_sha256: afterLessonsSha,
    manual_sha256: afterManualSha,
  };
  report.targets = {
    lesson: patched.lesson_fp,
    manual: patched.manual_fp,
  };
  report.occupancy_expected = occupancy;

  if (mode === "dry_run") {
    report.ok = occupancy.ok;
    report.code = occupancy.ok ? "dry_run_ok" : "occupancy_expectation_failed";
    report.status = 200;
    report.state = "dry_run";
    return report;
  }

  if (mode !== "execute") {
    report.code = "unknown_mode";
    report.status = 400;
    return report;
  }

  // Exact expected source hashes from caller (from prior dry_run).
  const expectL = String(options.expected_lessons_sha256 || "");
  const expectM = String(options.expected_manual_sha256 || "");
  if (!expectL || !expectM) {
    report.code = "expected_hashes_required";
    report.status = 400;
    return report;
  }
  if (expectL !== beforeLessonsSha || expectM !== beforeManualSha) {
    report.code = "hash_mismatch";
    report.status = 409;
    report.state = "aborted_before_writes";
    report.hash_check = {
      lessons_match: expectL === beforeLessonsSha,
      manual_match: expectM === beforeManualSha,
    };
    return report;
  }

  if (!occupancy.ok) {
    report.code = "occupancy_expectation_failed";
    report.status = 409;
    report.state = "aborted_before_writes";
    return report;
  }

  const runId = String(options.runId || `run_${Date.now().toString(36)}`);
  const backupLessonsPath = `${BACKUP_PREFIX}/${runId}/lessons.json`;
  const backupManualPath = `${BACKUP_PREFIX}/${runId}/manual-bookings.json`;

  // Immutable backups (create-only)
  const bakL = await putCreateOnly(backupLessonsPath, lessonsRead.text, token, blob);
  if (!bakL.ok) {
    report.code = "backup_lessons_failed";
    report.status = 409;
    report.state = "aborted_before_writes";
    report.backup = { lessons: bakL.code, manual: null };
    return report;
  }
  const bakM = await putCreateOnly(backupManualPath, manualRead.text, token, blob);
  if (!bakM.ok) {
    report.code = "backup_manual_failed";
    report.status = 409;
    report.state = "aborted_before_writes";
    report.backup = { lessons: "ok", manual: bakM.code };
    // Do not delete lessons backup automatically.
    return report;
  }
  report.backup = {
    ok: true,
    lessons_path: backupLessonsPath,
    manual_path: backupManualPath,
  };

  // Atomic one-time lock
  const lockBody = stableStringify({
    runId,
    at: new Date().toISOString(),
    before_lessons_sha256: beforeLessonsSha,
    before_manual_sha256: beforeManualSha,
    after_lessons_sha256: afterLessonsSha,
    after_manual_sha256: afterManualSha,
  });
  const lock = await putCreateOnly(LOCK_PATH, lockBody, token, blob);
  if (!lock.ok) {
    report.code = "lock_held";
    report.status = 409;
    report.state = "aborted_before_writes";
    return report;
  }
  report.lock = { acquired: true, path: LOCK_PATH };

  // Serial writes — lessons then manual. Never auto-overwrite the other on failure.
  const writeL = await putIfMatch("lessons.json", afterLessonsBody, lessonsRead.etag, token, blob);
  if (!writeL.ok) {
    report.ok = false;
    report.code = writeL.code || "lessons_write_failed";
    report.status = 409;
    report.state = "partial_none_committed_or_lessons_failed";
    report.files = { lessons: "failed", manual: "not_attempted" };
    return report;
  }

  // Verify lessons before touching manual
  const lessonsVerify = await readOriginBookended("lessons.json", { token, blob });
  if (
    !lessonsVerify.ok ||
    lessonsVerify.sha256 !== afterLessonsSha ||
    !parseLessons(lessonsVerify.text).lessons.find((l) => l.id === LESSON_ID && l.privacy === "standard")
  ) {
    report.ok = false;
    report.code = "lessons_postverify_failed";
    report.status = 500;
    report.state = "partial_lessons_ok_manual_not_attempted";
    report.files = { lessons: "written_unverified_or_mismatch", manual: "not_attempted" };
    report.recovery =
      "Owner-approved restore of lessons.json from backup required before retry. Do not auto-overwrite.";
    return report;
  }

  const writeM = await putIfMatch(
    "manual-bookings.json",
    afterManualBody,
    manualRead.etag,
    token,
    blob
  );
  if (!writeM.ok) {
    report.ok = false;
    report.code = writeM.code || "manual_write_failed";
    report.status = 409;
    report.state = "partial_lessons_ok_manual_failed";
    report.files = { lessons: "ok", manual: "failed" };
    report.recovery =
      "STOP. Do not auto-overwrite lessons.json. Owner may approve restore of lessons from backup after fresh verification, or retry manual only with new dry_run hashes.";
    return report;
  }

  const manualVerify = await readOriginBookended("manual-bookings.json", { token, blob });
  if (
    !manualVerify.ok ||
    manualVerify.sha256 !== afterManualSha ||
    !parseManual(manualVerify.text).bookings.find((b) => b.id === MANUAL_ID && b.privacy === "standard")
  ) {
    report.ok = false;
    report.code = "manual_postverify_failed";
    report.status = 500;
    report.state = "partial_both_written_manual_unverified";
    report.files = { lessons: "ok", manual: "written_unverified_or_mismatch" };
    report.recovery =
      "STOP. Owner-approved restore may be required after fresh verification. Do not auto-overwrite.";
    return report;
  }

  const finalLessons = parseLessons(lessonsVerify.text);
  const finalManual = parseManual(manualVerify.text);
  const occ = evaluateTargetSlotOccupancy(finalLessons, finalManual);
  report.occupancy = occ;
  report.targets = {
    lesson: fingerprintLesson(finalLessons.lessons.find((l) => l.id === LESSON_ID)),
    manual: fingerprintManual(finalManual.bookings.find((b) => b.id === MANUAL_ID)),
  };
  report.after = {
    lessons_sha256: lessonsVerify.sha256,
    manual_sha256: manualVerify.sha256,
  };
  report.files = { lessons: "ok", manual: "ok" };
  report.state = occ.ok ? "complete" : "complete_occupancy_unexpected";
  report.ok = occ.ok;
  report.code = occ.ok ? "execute_ok" : "occupancy_unexpected";
  report.status = 200;
  return report;
}

async function runRestore({
  env,
  token,
  blob,
  options,
  report,
  lessonsRead,
  manualRead,
  beforeLessonsSha,
  beforeManualSha,
}) {
  // Restore requires owner confirm + which file + backup runId + expected current hashes.
  // Never restores automatically from execute failures.
  const which = String(options.restore_file || "");
  const runId = String(options.runId || "");
  if (!runId || (which !== "lessons" && which !== "manual")) {
    report.code = "restore_args_required";
    report.status = 400;
    return report;
  }

  const expectCurrent = String(options.expected_current_sha256 || "");
  const liveSha = which === "lessons" ? beforeLessonsSha : beforeManualSha;
  const liveEtag = which === "lessons" ? lessonsRead.etag : manualRead.etag;
  if (!expectCurrent || expectCurrent !== liveSha) {
    report.code = "restore_hash_mismatch";
    report.status = 409;
    report.state = "restore_refused";
    return report;
  }

  const backupPath =
    which === "lessons"
      ? `${BACKUP_PREFIX}/${runId}/lessons.json`
      : `${BACKUP_PREFIX}/${runId}/manual-bookings.json`;
  const bak = await readOriginBookended(backupPath, { token, blob });
  if (!bak.ok || bak.missing) {
    report.code = "backup_missing";
    report.status = 404;
    report.state = "restore_refused";
    return report;
  }

  // Refuse restore if allowlisted sibling file changed unexpectedly when restoring one side:
  // caller must pass expected_other_sha256 matching the other live file.
  const otherExpect = String(options.expected_other_sha256 || "");
  const otherLive = which === "lessons" ? beforeManualSha : beforeLessonsSha;
  if (!otherExpect || otherExpect !== otherLive) {
    report.code = "restore_other_file_drift";
    report.status = 409;
    report.state = "restore_refused";
    return report;
  }

  const putRes = await putIfMatch(
    which === "lessons" ? "lessons.json" : "manual-bookings.json",
    bak.text,
    liveEtag,
    token,
    blob
  );
  if (!putRes.ok) {
    report.code = putRes.code || "restore_put_failed";
    report.status = 409;
    report.state = "restore_failed";
    return report;
  }
  report.ok = true;
  report.code = "restore_ok";
  report.status = 200;
  report.state = "restored";
  report.restored = { file: which, from: backupPath };
  return report;
}

/** Strip credentials, etags, bodies, and PII-bearing fields before HTTP/log output. */
export function sanitizeMaintenanceReport(report) {
  if (!report || typeof report !== "object") return report;
  const banned = /etag|token|authorization|bearer|secret|password|body|email|player|phone|raw/i;
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (banned.test(k)) continue;
      out[k] = walk(v);
    }
    return out;
  };
  return walk(report);
}

// Re-export for tests / handler docs
export const MAINTENANCE_CAPACITY_FILES = CAPACITY_FILES;
