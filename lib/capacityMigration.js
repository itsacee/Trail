// Explicit public → private capacity-store migration.
//
// NEVER runs automatically on booking reads. Coach/CLI must invoke with an
// explicit confirm token. Production execution is out of band — this module
// only provides the procedure for a controlled staging/production cutover.
//
// Steps:
//  1. Require CAPACITY_MIGRATION_PAUSE=1 (booking writes fail closed).
//  2. Snapshot each public capacity file.
//  3. Write verified backups under backup/capacity-<ts>/ in the private store.
//  4. Copy into private holds.json / lessons.json / manual-bookings.json.
//  5. Re-read private copies and verify counts / identifiers.
//  6. Write capacity-cutover.json marker (and optionally set CAPACITY_BLOB_CUTOVER=1).
//  7. Clear CAPACITY_MIGRATION_PAUSE after smoke tests.
//
// Rollback:
//  - Delete/overwrite cutover marker (clearCutoverMarker) and unset
//    CAPACITY_BLOB_CUTOVER. Keep CAPACITY_MIGRATION_PAUSE until public store is
//    confirmed authoritative again. Private copies remain as backups.

import {
  CAPACITY_FILES,
  capacityMigrationPaused,
  capacityStoreConfigured,
  clearCutoverCache,
  clearCutoverMarker,
  previewCapacityIsolationOk,
  privateStoreId,
  publicStoreId,
  readCutoverMarker,
  readPrivateCapacityFile,
  readPublicCapacitySnapshot,
  storeConfigured,
  writeCutoverMarker,
  writePrivateCapacityFile,
} from "./store.js";

const FILES = [...CAPACITY_FILES];

function summarize(filename, text) {
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return { ok: false, error: "invalid_json", count: 0, ids: [] };
  }
  if (filename === "holds.json") {
    const holds = Array.isArray(parsed?.holds) ? parsed.holds : [];
    return {
      ok: true,
      count: holds.length,
      ids: holds.map((h) => h.sessionId || `${h.date}|${h.time}`).filter(Boolean).sort(),
      empty: holds.length === 0,
    };
  }
  if (filename === "lessons.json") {
    const lessons = Array.isArray(parsed?.lessons) ? parsed.lessons : [];
    const voids = Array.isArray(parsed?.voids) ? parsed.voids : [];
    return {
      ok: true,
      count: lessons.length,
      voidCount: voids.length,
      ids: lessons.map((l) => l.id).filter(Boolean).sort(),
      empty: lessons.length === 0 && voids.length === 0,
    };
  }
  if (filename === "manual-bookings.json") {
    const bookings = Array.isArray(parsed?.bookings) ? parsed.bookings : [];
    return {
      ok: true,
      count: bookings.length,
      ids: bookings.map((b) => b.id).filter(Boolean).sort(),
      empty: bookings.length === 0,
    };
  }
  return { ok: false, error: "unknown_file", count: 0, ids: [] };
}

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function migrationPrereqs() {
  const issues = [];
  if (!storeConfigured()) issues.push("public_store_not_configured");
  if (!capacityStoreConfigured()) issues.push("private_store_not_configured");
  if (!capacityMigrationPaused()) issues.push("CAPACITY_MIGRATION_PAUSE_required");
  const isolation = previewCapacityIsolationOk();
  if (!isolation.ok) issues.push(`preview_isolation:${isolation.reason}`);
  const pub = publicStoreId();
  const priv = privateStoreId();
  if (pub && priv && pub === priv) issues.push("public_and_private_tokens_same_store");
  return { ok: issues.length === 0, issues, publicStoreId: pub || null, privateStoreId: priv || null };
}

export async function planCapacityMigration() {
  const prereqs = migrationPrereqs();
  const files = {};
  for (const filename of FILES) {
    const snap = await readPublicCapacitySnapshot(filename);
    const summary = snap.found ? summarize(filename, snap.text) : { ok: true, count: 0, ids: [], empty: true, missing: true };
    files[filename] = {
      found: Boolean(snap.found),
      etag: snap.etag || "",
      bytes: snap.text ? Buffer.byteLength(snap.text) : 0,
      summary,
      error: snap.error || null,
    };
  }
  const marker = await readCutoverMarker();
  return {
    prereqs,
    cutover: marker,
    files,
    note:
      "Dry plan only. Call runCapacityMigration({ confirm: 'MIGRATE-CAPACITY' }) after pause is set.",
  };
}

/**
 * @param {{ confirm?: string, allowEmpty?: boolean }} opts
 */
export async function runCapacityMigration(opts = {}) {
  if (opts.confirm !== "MIGRATE-CAPACITY") {
    return {
      ok: false,
      error: "confirm_required",
      message: "Pass confirm: 'MIGRATE-CAPACITY' to execute. Use planCapacityMigration() first.",
    };
  }

  const prereqs = migrationPrereqs();
  if (!prereqs.ok) {
    return { ok: false, error: "prereqs_failed", prereqs };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPrefix = `backup/capacity-${ts}`;
  const results = {};

  for (const filename of FILES) {
    const snap = await readPublicCapacitySnapshot(filename);
    if (!snap.found || !snap.text) {
      // Empty/missing public file → write empty private skeleton only if allowed.
      const emptyPayload =
        filename === "holds.json"
          ? { holds: [] }
          : filename === "lessons.json"
            ? { lessons: [], voids: [] }
            : { bookings: [] };
      const emptyText = JSON.stringify(emptyPayload);
      if (!opts.allowEmpty && snap.found === false) {
        // Still create empty private files for greenfield staging.
      }
      const backup = await writePrivateCapacityFile(`${backupPrefix}/${filename}`, emptyText);
      const written = await writePrivateCapacityFile(filename, emptyText);
      const verify = await readPrivateCapacityFile(filename);
      const summary = summarize(filename, verify.text || emptyText);
      results[filename] = {
        source: "empty",
        backupOk: backup.ok,
        writeOk: written.ok,
        verifyOk: verify.found,
        summary,
      };
      continue;
    }

    const sourceSummary = summarize(filename, snap.text);
    if (!sourceSummary.ok) {
      return { ok: false, error: "source_invalid", filename, detail: sourceSummary };
    }

    const backupPath = `${backupPrefix}/${filename}`;
    const backup = await writePrivateCapacityFile(backupPath, snap.text);
    if (!backup.ok) {
      return { ok: false, error: "backup_failed", filename, backup };
    }

    const written = await writePrivateCapacityFile(filename, snap.text);
    if (!written.ok) {
      return { ok: false, error: "private_write_failed", filename, written };
    }

    const verify = await readPrivateCapacityFile(filename);
    if (!verify.found || verify.text !== snap.text) {
      return {
        ok: false,
        error: "verify_mismatch",
        filename,
        message: "Private copy does not exactly match public snapshot.",
      };
    }
    const verifySummary = summarize(filename, verify.text);
    if (
      verifySummary.count !== sourceSummary.count ||
      !sameIds(verifySummary.ids, sourceSummary.ids) ||
      (verifySummary.voidCount || 0) !== (sourceSummary.voidCount || 0)
    ) {
      return {
        ok: false,
        error: "verify_counts_failed",
        filename,
        sourceSummary,
        verifySummary,
      };
    }

    results[filename] = {
      source: "public",
      backupPath,
      backupOk: true,
      writeOk: true,
      verifyOk: true,
      sourceEtag: snap.etag || "",
      summary: verifySummary,
    };
  }

  const marker = await writeCutoverMarker({
    active: true,
    backupPrefix,
    publicStoreId: prereqs.publicStoreId,
    privateStoreId: prereqs.privateStoreId,
    files: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [
        k,
        { count: v.summary?.count || 0, ids: v.summary?.ids || [], source: v.source },
      ])
    ),
  });
  if (!marker.ok) {
    return { ok: false, error: "cutover_marker_failed", marker, results };
  }
  clearCutoverCache();

  return {
    ok: true,
    backupPrefix,
    results,
    nextSteps: [
      "Keep CAPACITY_MIGRATION_PAUSE=1 until smoke tests pass.",
      "Set CAPACITY_BLOB_CUTOVER=1 in Vercel (Preview/Production as appropriate).",
      "Smoke-test holds + slots + member book against the private store.",
      "Clear CAPACITY_MIGRATION_PAUSE=1 only after verification.",
      "Leave public capacity files untouched as a cold backup until stable.",
    ],
  };
}

export async function rollbackCapacityCutover(opts = {}) {
  if (opts.confirm !== "ROLLBACK-CAPACITY") {
    return {
      ok: false,
      error: "confirm_required",
      message: "Pass confirm: 'ROLLBACK-CAPACITY'. Keep CAPACITY_MIGRATION_PAUSE=1.",
    };
  }
  if (!capacityMigrationPaused()) {
    return {
      ok: false,
      error: "pause_required",
      message: "Set CAPACITY_MIGRATION_PAUSE=1 before rollback.",
    };
  }
  const cleared = await clearCutoverMarker();
  clearCutoverCache();
  return {
    ok: Boolean(cleared.ok),
    cleared,
    nextSteps: [
      "Unset CAPACITY_BLOB_CUTOVER in Vercel.",
      "Keep CAPACITY_MIGRATION_PAUSE=1 until public store is confirmed authoritative.",
      "Do not delete private backups under backup/capacity-*.",
      "Booking writes remain paused until you clear CAPACITY_MIGRATION_PAUSE.",
    ],
  };
}

export function capacityBookingBlockedMessage() {
  if (capacityMigrationPaused()) {
    return "Booking is briefly paused for a storage upgrade. Please try again in a few minutes, or call (405) 819-4401.";
  }
  const isolation = previewCapacityIsolationOk();
  if (!isolation.ok) {
    return "I couldn't safely hold that time. No payment was taken — please try again.";
  }
  // After cutover, private store is required. Pre-cutover keeps public reads
  // (PR #64) and relies on CAPACITY_WRITES_ENABLED for write pause.
  if (process.env.CAPACITY_BLOB_CUTOVER === "1" && !capacityStoreConfigured()) {
    return "I couldn't safely hold that time. No payment was taken — please try again.";
  }
  return "";
}
