// Coach-only capacity store migration controls.
//
// GET  ?key=COACH_PASS           → plan / prereqs (dry)
// POST { key, action, confirm }  → migrate | rollback
//
// Never runs against production automatically. Requires
// CAPACITY_MIGRATION_PAUSE=1 for execute/rollback.

import { requireCoach } from "../lib/coachAuth.js";
import {
  planCapacityMigration,
  rollbackCapacityCutover,
  runCapacityMigration,
} from "../lib/capacityMigration.js";

export default async function handler(req, res) {
  if (!requireCoach(req, res)) return;

  if (req.method === "GET") {
    const plan = await planCapacityMigration();
    res.status(200).json(plan);
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const action = String(req.body?.action || "");
  const confirm = String(req.body?.confirm || "");

  if (action === "migrate") {
    const result = await runCapacityMigration({
      confirm,
      allowEmpty: Boolean(req.body?.allowEmpty),
    });
    res.status(result.ok ? 200 : 400).json(result);
    return;
  }

  if (action === "rollback") {
    const result = await rollbackCapacityCutover({ confirm });
    res.status(result.ok ? 200 : 400).json(result);
    return;
  }

  res.status(400).json({
    error: "Unknown action. Use action: 'migrate' or 'rollback'.",
  });
}
