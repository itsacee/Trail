// Preview-only BookingStore admin: status, dry import plan, import, reconcile.
// Never mutates Blob. Never allowed in Production Vercel env.
// Writes to DB only when BOOKING_STORE is postgres/memory and operator confirms.

import { isCoachPass } from "../lib/coachAuth.js";
import { assertPreviewDbAllowed, bookingStoreMode, bookingReadsEnabled, bookingWritesEnabled } from "../lib/bookingDb/flags.js";
import { createBookingStore, closeBookingStore } from "../lib/bookingDb/createStore.js";
import { importBlobSnapshots } from "../lib/bookingDb/importFromBlob.js";
import { reconcileBlobToDb } from "../lib/bookingDb/reconcile.js";
import { loadLessons } from "../lib/lessons.js";
import { loadHolds } from "../lib/holds.js";
import { loadManualBookings } from "../lib/manualBookings.js";

function unauthorized(res) {
  res.status(401).json({ ok: false, reason: "unauthorized" });
}

function blocked(res, reason) {
  res.status(403).json({ ok: false, reason });
}

async function readBlobSnapshots() {
  const [lessons, holds, manual] = await Promise.all([
    loadLessons(),
    loadHolds(),
    loadManualBookings(),
  ]);
  return { lessons, holds, manual };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!isCoachPass(req.method === "GET" ? req.query?.key : req.body?.key)) {
    unauthorized(res);
    return;
  }

  const preview = assertPreviewDbAllowed(process.env);
  if (!preview.ok) {
    blocked(res, preview.reason);
    return;
  }

  const mode = bookingStoreMode();
  if (mode === "blob") {
    res.status(200).json({
      ok: true,
      mode: "blob",
      reads: false,
      writes: false,
      message: "BookingStore is inert. Set BOOKING_STORE=postgres (Preview DB) when approved.",
    });
    return;
  }

  const action = String(req.method === "GET" ? req.query?.action || "status" : req.body?.action || "status");

  if (action === "status") {
    res.status(200).json({
      ok: true,
      mode,
      reads: bookingReadsEnabled(),
      writes: bookingWritesEnabled(),
      vercel_env: process.env.VERCEL_ENV || "",
      dual_write_blob: process.env.BOOKING_DUAL_WRITE_BLOB === "1",
    });
    return;
  }

  if (action === "reconcile" || action === "import") {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "POST_required" });
      return;
    }
    if (action === "import" && req.body?.confirm !== "IMPORT-BLOB-TO-BOOKING-DB") {
      res.status(400).json({ ok: false, reason: "confirm_required" });
      return;
    }

    let handle;
    try {
      handle = await createBookingStore({
        env: process.env,
        mode: mode === "postgres" ? "postgres" : "memory",
        useMem: mode === "memory",
      });
      const snapshots = await readBlobSnapshots();
      // Never mutate Blob — only read.
      if (action === "import") {
        const imported = await importBlobSnapshots(snapshots, handle.store);
        if (imported.stopped) {
          res.status(409).json({
            ok: false,
            reason: imported.stop_reason || "source_incomplete",
            details: imported.details || {},
            note: "Import aborted. Blob records were not modified.",
          });
          return;
        }
        const reconciliation = await reconcileBlobToDb(snapshots, handle.store);
        res.status(200).json({
          ok: reconciliation.ok && imported.ok,
          imported: {
            lessons_imported: imported.lessons_imported,
            lessons_already_present: imported.lessons_already_present,
            holds_imported: imported.holds_imported,
            holds_already_present: imported.holds_already_present,
            manual_imported: imported.manual_imported,
            manual_already_present: imported.manual_already_present,
            credits_upserted: imported.credits_upserted,
            errors: imported.errors.length,
          },
          reconciliation: reconciliation.summary,
          missingInDb: reconciliation.missingInDb.length,
          missingInBlob: reconciliation.missingInBlob.length,
          slotMismatches: reconciliation.slotCountMismatches.length,
          note: "Blob records were not modified.",
        });
        return;
      }
      const reconciliation = await reconcileBlobToDb(snapshots, handle.store);
      res.status(200).json({
        ok: reconciliation.ok,
        summary: reconciliation.summary,
        missingInDb: reconciliation.missingInDb.slice(0, 50),
        missingInBlob: reconciliation.missingInBlob.slice(0, 50),
        slotCountMismatches: reconciliation.slotCountMismatches.slice(0, 50),
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        reason: error?.code || "booking_db_error",
        error: "Booking database unavailable.",
      });
    } finally {
      if (handle) await closeBookingStore(handle);
    }
    return;
  }

  res.status(400).json({ ok: false, reason: "unknown_action" });
}
