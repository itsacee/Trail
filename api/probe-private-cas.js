// Preview-only HTTP entry for the isolated private Blob CAS probe.
//
// Disabled unless PROBE_PRIVATE_CAS=1. Production always 404s.
// Requires Authorization: Bearer $PROBE_RUN_SECRET (min 16 chars) and a matching
// PROBE_PREVIEW_GIT_BRANCH. POST also requires confirm: RUN-PREVIEW-CAS-PROBE.
//
// Not registered in vercel.json crons. Importing this module never runs the probe.
// Responses contain booleans/labels only — never tokens, ETags, or blob bodies.

import { handleProbeHttp } from "../lib/probePrivateCasHttp.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { status, body } = await handleProbeHttp(req, process.env);
    res.status(status).json(body);
  } catch {
    res.status(500).json({ ok: false, reason: "probe_handler_error" });
  }
}
