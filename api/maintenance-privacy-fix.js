// TEMPORARY one-time Production privacy correction endpoint.
// Disabled unless MAINTENANCE_PRIVACY_FIX=1. Remove after successful use.
//
// POST /api/maintenance-privacy-fix
//   Authorization: Bearer <MAINTENANCE_PRIVACY_FIX_SECRET>
//   Body: {
//     key: COACH_PASS,
//     mode: "dry_run" | "execute" | "restore",
//     confirm?: "PRIVACY-FIX-OCT15-2026-STANDARD" | "PRIVACY-FIX-RESTORE",
//     expected_lessons_sha256?, expected_manual_sha256?,   // execute
//     runId?, restore_file?, expected_current_sha256?, expected_other_sha256? // restore
//   }
//
// Never enables CAPACITY_WRITES_ENABLED. Never logs secrets/etags/bodies.

import {
  runMaintenancePrivacyFix,
  sanitizeMaintenanceReport,
} from "../lib/maintenancePrivacyFix.js";

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
  if (process.env.MAINTENANCE_PRIVACY_FIX !== "1") {
    res.status(404).json({ ok: false, code: "disabled" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const mode = String(body.mode || "dry_run");

  try {
    const report = await runMaintenancePrivacyFix({
      mode,
      bearer: bearerFrom(req),
      coachKey: body.key || body.coachKey || "",
      confirm: body.confirm || "",
      expected_lessons_sha256: body.expected_lessons_sha256 || "",
      expected_manual_sha256: body.expected_manual_sha256 || "",
      runId: body.runId || "",
      restore_file: body.restore_file || "",
      expected_current_sha256: body.expected_current_sha256 || "",
      expected_other_sha256: body.expected_other_sha256 || "",
    });
    const safe = sanitizeMaintenanceReport(report);
    res.status(Number(safe.status) || (safe.ok ? 200 : 400)).json(safe);
  } catch {
    res.status(500).json({ ok: false, code: "internal_error" });
  }
}
