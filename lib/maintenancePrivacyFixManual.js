// Manual-only completion for Cooper's Oct 15 booking after partial two-file execute.
// Never writes lessons.json. Never touches the original once-lock.
// Disabled unless MAINTENANCE_PRIVACY_FIX_MANUAL=1.

import { createHash } from "node:crypto";
import { put, get, head, BlobPreconditionFailedError } from "@vercel/blob";
import { resolvePrivacy, slotBlocked } from "./schedule.js";
import { isActiveLesson } from "./lessons.js";
import { activeBookings } from "./manualBookings.js";
import {
  LESSON_ID,
  MANUAL_ID,
  fingerprintLesson,
  fingerprintManual,
  assertWriteFreeze,
  sanitizeMaintenanceReport,
  createBlobOps,
} from "./maintenancePrivacyFix.js";

export const CONFIRM_EXECUTE_MANUAL = "PRIVACY-FIX-OCT15-2026-MANUAL-ONLY";
export const CONFIRM_RESTORE_MANUAL = "PRIVACY-FIX-MANUAL-RESTORE";
export const MANUAL_LOCK_PATH = "maintenance/privacy-fix-oct15-2026-manual.lock";
export const ORIGINAL_LOCK_PATH = "maintenance/privacy-fix-oct15-2026.lock";
export const MANUAL_BACKUP_PREFIX = "backup/privacy-fix-manual";

/** Production pins from partial-failure investigation (must match live before execute). */
export const EXPECTED_LESSONS_SHA_AFTER_DYLAN =
  "1b9a49724f00d5de7028fa0f20285eec5b2876673031284ba4b603ce6c549dfe";
export const EXPECTED_MANUAL_SHA_BEFORE =
  "8ab78033204966f117563e22b344986470a42f08b8fbe32e7df2bb43dd92180a";

const TARGET_DATE = "2026-10-15";
const TARGET_TIME = "5:00 PM";
const TARGET_FOCUS = "Both";

const DEFAULT_VERIFY_ATTEMPTS = 8;
const DEFAULT_VERIFY_DELAY_MS = 250;

function sha256Text(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function stableStringify(value) {
  return JSON.stringify(value);
}

function publicAccessToken(env = process.env) {
  return String(env.BLOB_READ_WRITE_TOKEN || "").trim();
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

function sleep(ms, sleeper) {
  if (typeof sleeper === "function") return sleeper(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function maintenanceManualEnabled(env = process.env) {
  return env.MAINTENANCE_PRIVACY_FIX_MANUAL === "1";
}

export function assertProductionOnly(env = process.env) {
  if (env.MAINTENANCE_ALLOW_TEST === "1") return { ok: true, test: true };
  return {
    ok: String(env.VERCEL_ENV || "") === "production",
    vercel_env: String(env.VERCEL_ENV || "") || "(unset)",
  };
}

export function authorizeManualRequest({
  env = process.env,
  bearer = "",
  coachKey = "",
  confirm = "",
  mode = "dry_run",
}) {
  if (!maintenanceManualEnabled(env)) {
    return { ok: false, code: "disabled", status: 404 };
  }
  const prod = assertProductionOnly(env);
  if (!prod.ok) {
    return { ok: false, code: "env_blocked", status: 403 };
  }
  const secret = String(env.MAINTENANCE_PRIVACY_FIX_MANUAL_SECRET || "");
  if (!secret || secret.length < 24) {
    return { ok: false, code: "secret_not_configured", status: 403 };
  }
  if (String(bearer || "") !== secret) {
    return { ok: false, code: "unauthorized", status: 401 };
  }
  const coach = String(env.COACH_PASS || "").trim();
  if (!coach || String(coachKey || "") !== coach) {
    return { ok: false, code: "coach_unauthorized", status: 401 };
  }
  if (mode === "execute" && String(confirm || "") !== CONFIRM_EXECUTE_MANUAL) {
    return { ok: false, code: "confirm_required", status: 403 };
  }
  if (mode === "restore" && String(confirm || "") !== CONFIRM_RESTORE_MANUAL) {
    return { ok: false, code: "restore_confirm_required", status: 403 };
  }
  return { ok: true };
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

function lessonSiblingOk(row) {
  return (
    row &&
    row.id === LESSON_ID &&
    row.date === TARGET_DATE &&
    row.time === TARGET_TIME &&
    row.focus === TARGET_FOCUS &&
    row.privacy === "standard" &&
    isActiveLesson(row)
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

export function applyManualPrivacyStandardPatch(manualData) {
  const manual = structuredClone(manualData);
  const booking = (manual.bookings || []).find((b) => b.id === MANUAL_ID);
  if (!manualIdentityOk(booking)) {
    return { ok: false, code: "manual_identity_mismatch", manual: fingerprintManual(booking) };
  }
  const before = structuredClone(booking);
  booking.privacy = "standard";
  if (!deepEqualSansPrivacy(before, booking)) {
    return { ok: false, code: "unexpected_field_drift" };
  }
  if (booking.privacy !== "standard") {
    return { ok: false, code: "patch_failed" };
  }
  return { ok: true, manual, manual_fp: fingerprintManual(booking) };
}

/** Occupancy after Cooper stamp + Dylan already standard. */
export function evaluateTargetSlotOccupancy(lessonsData, manualData) {
  const rows = [];
  for (const l of lessonsData.lessons || []) {
    if (!isActiveLesson(l) || l.date !== TARGET_DATE || l.time !== TARGET_TIME) continue;
    rows.push({
      id: l.id,
      time: l.time,
      mins: 60,
      focus: l.focus || "",
      privacy: resolvePrivacy(l),
      exclusive: resolvePrivacy(l) === "private",
      seats: resolvePrivacy(l) === "private" ? 2 : 1,
    });
  }
  for (const b of activeBookings(manualData || { bookings: [] })) {
    if (b.date !== TARGET_DATE || b.time !== TARGET_TIME) continue;
    rows.push({
      id: b.id,
      time: b.time,
      mins: 60,
      focus: b.focus || "",
      privacy: resolvePrivacy(b),
      exclusive: resolvePrivacy(b) === "private",
      seats: Number(b.seats) || (resolvePrivacy(b) === "private" ? 2 : 1),
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

/**
 * Origin-aware body read for capacity JSON.
 * Prefer SDK get stream. Optional allowPublicFallback (default false for verify).
 */
export async function originGetText(pathname, token, blob, { allowPublicFallback = false, env = process.env } = {}) {
  const result = await blob.get(pathname, { access: "public", token, useCache: false });
  if (!result || result.statusCode === 404) return null;
  if (result.stream) {
    return await new Response(result.stream).text();
  }
  if (typeof result.text === "function") {
    return await result.text();
  }
  if (!allowPublicFallback) {
    throw new Error("origin_get_no_stream");
  }
  const base = String(env.AVAILABILITY_URL || "").trim();
  if (!base) throw new Error("origin_get_no_fallback");
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/[^/]+$/, pathname);
  const r = await fetch(`${url.toString()}?t=${Date.now()}`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("public_get_failed");
  return await r.text();
}

/**
 * Head-bookended origin read. By default does NOT use CDN public URL fallback.
 */
export async function readOriginBookended(
  pathname,
  {
    token,
    attempts = 3,
    blob = createBlobOps(),
    allowPublicFallback = false,
    env = process.env,
  } = {}
) {
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
      text = await originGetText(pathname, token, blob, { allowPublicFallback, env });
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
 * Bounded post-write verification.
 * Distinguishes: verify_ok | verify_pending_stale_read | verify_content_mismatch
 * Never implies put failed when put already returned ok.
 */
export async function verifyManualAfterWrite({
  token,
  blob,
  env,
  expectedSha,
  expectedRowPreimage,
  attempts = DEFAULT_VERIFY_ATTEMPTS,
  delayMs = DEFAULT_VERIFY_DELAY_MS,
  sleeper,
}) {
  let last = null;
  let sawStale = false;
  let sawReadError = false;
  for (let i = 0; i < attempts; i++) {
    const read = await readOriginBookended("manual-bookings.json", {
      token,
      blob,
      env,
      allowPublicFallback: false,
    });
    last = read;
    if (!read.ok || read.missing) {
      sawReadError = true;
      await sleep(delayMs, sleeper);
      continue;
    }
    const row = parseManual(read.text).bookings.find((b) => b.id === MANUAL_ID);
    const rowOk =
      row &&
      row.privacy === "standard" &&
      deepEqualSansPrivacy(expectedRowPreimage, row);
    if (read.sha256 === expectedSha && rowOk) {
      return { ok: true, code: "verify_ok", read, attempts: i + 1 };
    }
    // Put succeeded path: wrong stable content vs not-yet-visible
    if (row && row.privacy === "standard" && !rowOk) {
      return { ok: false, code: "verify_content_mismatch", read, attempts: i + 1 };
    }
    if (read.sha256 !== expectedSha) {
      sawStale = true;
      await sleep(delayMs, sleeper);
      continue;
    }
    await sleep(delayMs, sleeper);
  }
  if (sawStale || sawReadError) {
    return {
      ok: false,
      code: "verify_pending_stale_read",
      read: last,
      attempts,
      note: "Put may have succeeded; reads not yet consistent. Do not auto-retry write or restore lessons.",
    };
  }
  return { ok: false, code: "verify_content_mismatch", read: last, attempts };
}

export async function runMaintenancePrivacyFixManual(options = {}) {
  const env = options.env || process.env;
  const mode = String(options.mode || "dry_run");
  const blob = options.blob || createBlobOps();
  const sleeper = options.sleeper;
  const report = {
    ok: false,
    mode,
    state: "aborted_before_writes",
    gates: {},
    scope: "manual_only",
    never_writes: ["lessons.json", ORIGINAL_LOCK_PATH],
  };

  const auth = authorizeManualRequest({
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
    return report;
  }

  const token = publicAccessToken(env);
  if (!token) {
    report.code = "missing_blob_token";
    report.status = 503;
    return report;
  }

  // Fresh origin reads — no CDN fallback for decisioning.
  const lessonsRead = await readOriginBookended("lessons.json", {
    token,
    blob,
    env,
    allowPublicFallback: false,
  });
  const manualRead = await readOriginBookended("manual-bookings.json", {
    token,
    blob,
    env,
    allowPublicFallback: false,
  });
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
  if (!lessonsRead.conditional || !manualRead.conditional) {
    report.code = "cas_not_safe";
    report.status = 409;
    return report;
  }

  const lessonsSha = lessonsRead.sha256;
  const manualSha = manualRead.sha256;
  report.before = {
    lessons_sha256: lessonsSha,
    manual_sha256: manualSha,
    conditional: true,
  };

  // Sibling pin: Dylan correction must still be present; never write lessons.
  // Manual pin: Cooper source must still match the unchanged pre-completion SHA.
  // Tests may override via options.expected_*_sha256 when live ≠ Production pins.
  if (lessonsSha !== EXPECTED_LESSONS_SHA_AFTER_DYLAN) {
    const expectLessons = String(options.expected_lessons_sha256 || EXPECTED_LESSONS_SHA_AFTER_DYLAN);
    if (lessonsSha !== expectLessons) {
      report.code = "lessons_sibling_hash_mismatch";
      report.status = 409;
      report.hash_check = {
        lessons_match: false,
        expected_lessons_sha256: expectLessons,
      };
      return report;
    }
  }
  // Before-SHA pin applies to dry_run/execute only. Restore validates
  // expected_current_sha256 against live after the sibling lessons pin.
  if (mode !== "restore" && manualSha !== EXPECTED_MANUAL_SHA_BEFORE) {
    const expectManualPin = String(options.expected_manual_sha256 || EXPECTED_MANUAL_SHA_BEFORE);
    if (manualSha !== expectManualPin) {
      report.code = "manual_source_hash_mismatch";
      report.status = 409;
      report.hash_check = {
        manual_match: false,
        expected_manual_sha256: expectManualPin,
      };
      return report;
    }
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

  const dylan = (lessonsData.lessons || []).find((l) => l.id === LESSON_ID);
  if (!lessonSiblingOk(dylan)) {
    report.code = "lessons_sibling_identity_mismatch";
    report.status = 409;
    report.lesson = fingerprintLesson(dylan);
    return report;
  }
  report.targets = { lesson: fingerprintLesson(dylan) };

  if (mode === "restore") {
    return runManualRestore({
      env,
      token,
      blob,
      options,
      report,
      manualRead,
      beforeManualSha: manualSha,
      lessonsSha,
    });
  }

  const patched = applyManualPrivacyStandardPatch(manualData);
  if (!patched.ok) {
    report.code = patched.code;
    report.status = 409;
    report.manual = patched.manual || null;
    return report;
  }

  const afterManualBody = stableStringify(patched.manual);
  const afterManualSha = sha256Text(afterManualBody);
  const occupancy = evaluateTargetSlotOccupancy(lessonsData, patched.manual);
  report.expected_after = { manual_sha256: afterManualSha, lessons_sha256: lessonsSha };
  report.targets.manual = patched.manual_fp;
  report.occupancy_expected = occupancy;

  if (mode === "dry_run") {
    report.ok = occupancy.ok;
    report.code = occupancy.ok ? "dry_run_ok" : "occupancy_expectation_failed";
    report.status = 200;
    report.state = "dry_run";
    report.writes = "none";
    return report;
  }

  if (mode !== "execute") {
    report.code = "unknown_mode";
    report.status = 400;
    return report;
  }

  const expectManual = String(options.expected_manual_sha256 || "");
  const expectLessons = String(options.expected_lessons_sha256 || EXPECTED_LESSONS_SHA_AFTER_DYLAN);
  if (!expectManual) {
    report.code = "expected_hashes_required";
    report.status = 400;
    return report;
  }
  if (expectManual !== manualSha || expectLessons !== lessonsSha) {
    report.code = "hash_mismatch";
    report.status = 409;
    report.hash_check = {
      manual_match: expectManual === manualSha,
      lessons_match: expectLessons === lessonsSha,
    };
    return report;
  }
  if (!occupancy.ok) {
    report.code = "occupancy_expectation_failed";
    report.status = 409;
    return report;
  }

  // Refuse if caller tries to point us at original lock path.
  if (String(options.lockPath || "") === ORIGINAL_LOCK_PATH) {
    report.code = "original_lock_reuse_forbidden";
    report.status = 400;
    return report;
  }

  const runId = String(options.runId || `manual_${Date.now().toString(36)}`);
  const backupPath = `${MANUAL_BACKUP_PREFIX}/${runId}/manual-bookings.json`;

  const bak = await putCreateOnly(backupPath, manualRead.text, token, blob);
  if (!bak.ok) {
    report.code = "backup_manual_failed";
    report.status = 409;
    report.backup = { manual: bak.code };
    return report;
  }
  report.backup = { ok: true, manual_path: backupPath };

  const lockBody = stableStringify({
    runId,
    at: new Date().toISOString(),
    scope: "manual_only",
    before_manual_sha256: manualSha,
    after_manual_sha256: afterManualSha,
    sibling_lessons_sha256: lessonsSha,
    original_lock_path: ORIGINAL_LOCK_PATH,
    original_lock_untouched: true,
  });
  const lock = await putCreateOnly(MANUAL_LOCK_PATH, lockBody, token, blob);
  if (!lock.ok) {
    report.code = "lock_held";
    report.status = 409;
    return report;
  }
  report.lock = { acquired: true, path: MANUAL_LOCK_PATH };

  const preimage = structuredClone(
    (manualData.bookings || []).find((b) => b.id === MANUAL_ID)
  );

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
    report.state = "manual_write_failed";
    report.files = { lessons: "untouched", manual: "failed" };
    report.put_outcome = "failed";
    report.recovery =
      "Write did not land. Dylan/lessons untouched. Do not auto-retry without fresh hashes. Do not restore lessons.";
    return report;
  }
  report.put_outcome = "ok";
  report.files = { lessons: "untouched", manual: "put_ok_verifying" };

  const verify = await verifyManualAfterWrite({
    token,
    blob,
    env,
    expectedSha: afterManualSha,
    expectedRowPreimage: preimage,
    attempts: options.verifyAttempts ?? DEFAULT_VERIFY_ATTEMPTS,
    delayMs: options.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS,
    sleeper,
  });

  if (verify.code === "verify_pending_stale_read") {
    report.ok = false;
    report.code = "verify_pending_stale_read";
    report.status = 202;
    report.state = "manual_put_ok_verify_unconfirmed";
    report.files = { lessons: "untouched", manual: "put_ok_unverified" };
    report.recovery =
      "STOP. Put returned OK but origin reads not yet consistent. Do NOT auto-retry write. Do NOT restore lessons. Re-read later; owner may confirm or authorize manual-only restore.";
    report.verify = { code: verify.code, attempts: verify.attempts };
    return report;
  }

  if (!verify.ok) {
    report.ok = false;
    report.code = verify.code || "manual_postverify_failed";
    report.status = 500;
    report.state = "manual_put_ok_content_unexpected";
    report.files = { lessons: "untouched", manual: "put_ok_content_mismatch" };
    report.recovery =
      "STOP. Put returned OK but verified content unexpected. Owner-approved restore of manual from backup only. Never overwrite lessons.json.";
    report.verify = { code: verify.code, attempts: verify.attempts };
    return report;
  }

  const finalManual = parseManual(verify.read.text);
  const finalLessons = parseLessons(lessonsRead.text);
  // Re-read lessons once more to ensure still untouched (SHA pin).
  const lessonsRecheck = await readOriginBookended("lessons.json", {
    token,
    blob,
    env,
    allowPublicFallback: false,
  });
  if (!lessonsRecheck.ok || lessonsRecheck.sha256 !== lessonsSha) {
    report.ok = false;
    report.code = "lessons_changed_during_manual_op";
    report.status = 409;
    report.state = "manual_ok_lessons_drift";
    report.files = { lessons: "drift_detected", manual: "ok" };
    report.recovery =
      "Manual correction verified, but lessons SHA drifted. Investigate before any further writes. Do not auto-restore.";
    return report;
  }

  const occ = evaluateTargetSlotOccupancy(finalLessons, finalManual);
  report.occupancy = occ;
  report.targets = {
    lesson: fingerprintLesson(finalLessons.lessons.find((l) => l.id === LESSON_ID)),
    manual: fingerprintManual(finalManual.bookings.find((b) => b.id === MANUAL_ID)),
  };
  report.after = {
    lessons_sha256: lessonsRecheck.sha256,
    manual_sha256: verify.read.sha256,
  };
  report.files = { lessons: "untouched", manual: "ok" };
  report.state = occ.ok ? "complete" : "complete_occupancy_unexpected";
  report.ok = occ.ok;
  report.code = occ.ok ? "execute_ok" : "occupancy_unexpected";
  report.status = 200;
  report.verify = { code: "verify_ok", attempts: verify.attempts };
  return report;
}

async function runManualRestore({
  env,
  token,
  blob,
  options,
  report,
  manualRead,
  beforeManualSha,
  lessonsSha,
}) {
  const runId = String(options.runId || "");
  if (!runId) {
    report.code = "restore_args_required";
    report.status = 400;
    return report;
  }
  const expectCurrent = String(options.expected_current_sha256 || "");
  if (!expectCurrent || expectCurrent !== beforeManualSha) {
    report.code = "restore_hash_mismatch";
    report.status = 409;
    report.state = "restore_refused";
    return report;
  }
  const expectLessons = String(options.expected_lessons_sha256 || EXPECTED_LESSONS_SHA_AFTER_DYLAN);
  if (expectLessons !== lessonsSha) {
    report.code = "restore_lessons_sibling_drift";
    report.status = 409;
    report.state = "restore_refused";
    return report;
  }
  const backupPath = `${MANUAL_BACKUP_PREFIX}/${runId}/manual-bookings.json`;
  const bak = await readOriginBookended(backupPath, {
    token,
    blob,
    env,
    allowPublicFallback: false,
  });
  if (!bak.ok || bak.missing) {
    report.code = "backup_missing";
    report.status = 404;
    report.state = "restore_refused";
    return report;
  }
  const putRes = await putIfMatch(
    "manual-bookings.json",
    bak.text,
    manualRead.etag,
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
  report.state = "restored_manual_only";
  report.restored = { file: "manual", from: backupPath };
  report.files = { lessons: "untouched", manual: "restored" };
  return report;
}

export { sanitizeMaintenanceReport, LESSON_ID, MANUAL_ID };
