// TEMPORARY one-time Production privacy correction — MANUAL ONLY (Cooper).
// Completes the partial Oct 15 fix. Never writes lessons.json.
// Never touches maintenance/privacy-fix-oct15-2026.lock.
// Disabled unless MAINTENANCE_PRIVACY_FIX_MANUAL=1. Remove after successful use.
//
// POST /api/maintenance-privacy-fix-manual
//   Authorization: Bearer <MAINTENANCE_PRIVACY_FIX_MANUAL_SECRET>
//   Body: {
//     key: COACH_PASS,
//     mode: "dry_run" | "execute" | "restore",
//     confirm?: "PRIVACY-FIX-OCT15-2026-MANUAL-ONLY" | "PRIVACY-FIX-MANUAL-RESTORE",
//     expected_lessons_sha256?, expected_manual_sha256?,   // execute (required)
//     runId?, expected_current_sha256?                     // restore
//   }
//
// Never enables CAPACITY_WRITES_ENABLED. Never logs secrets/etags/bodies.

import {
  runMaintenancePrivacyFixManual,
  sanitizeMaintenanceReport,
} from "../lib/maintenancePrivacyFixManual.js";

function bearerFrom(req) {
  const header = String(req.headers?.authorization || req.headers?.Authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, code: "method_not_allowed" });
    return;
  }

  // Fail closed when flag unset — appear as missing route.
  if (process.env.MAINTENANCE_PRIVACY_FIX_MANUAL !== "1") {
    res.status(404).json({ ok: false, code: "disabled" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const mode = String(body.mode || "dry_run");

  try {
    const report = await runMaintenancePrivacyFixManual({
      mode,
      bearer: bearerFrom(req),
      coachKey: body.key || body.coachKey || "",
      confirm: body.confirm || "",
      expected_lessons_sha256: body.expected_lessons_sha256 || "",
      expected_manual_sha256: body.expected_manual_sha256 || "",
      runId: body.runId || "",
      expected_current_sha256: body.expected_current_sha256 || "",
      lockPath: body.lockPath || "",
    });
    const safe = sanitizeMaintenanceReport(report);
    res.status(Number(safe.status) || (safe.ok ? 200 : 400)).json(safe);
  } catch {
    res.status(500).json({ ok: false, code: "internal_error" });
  }
}
