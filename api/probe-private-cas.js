// Preview-only HTTP entry for the isolated private Blob CAS probe.
//
// Disabled unless PROBE_PRIVATE_CAS=1 and all required security vars are set.
// Production always 404s. Requires:
//   Authorization: Bearer $PROBE_RUN_SECRET (min 16 chars)
//   PROBE_PREVIEW_GIT_BRANCH === VERCEL_GIT_COMMIT_REF
//   PROBE_PREVIEW_GIT_SHA === VERCEL_GIT_COMMIT_SHA (full 40-char SHA)
//   PROBE_PREVIEW_PRIVATE_STORE_ID (Preview private store allowlist)
// POST also requires confirm: RUN-PREVIEW-CAS-PROBE and wins a create-only
// private Blob once-lock (probe/cas-verify/http-once-<SHA>/object.json) so
// only one authorized execution can proceed, including under concurrency.
//
// Not registered in vercel.json crons. Importing this module never runs the probe.
// Responses contain booleans/labels only — never tokens, ETags, or blob bodies.
// Immediate disable: unset Preview PROBE_PRIVATE_CAS (and PROBE_RUN_SECRET).

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
