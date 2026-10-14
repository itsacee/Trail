// HTTP gate for the isolated Preview private Blob CAS probe.
//
// Reuses scripts/probe-private-cas.mjs (preflight + runProbe). Adds
// Preview-only kill switches and a dedicated bearer secret so the probe cannot
// run from normal traffic, Production, or an unauthenticated caller.
//
// Never logs or returns tokens, store ids, ETags, or blob bodies.

import { timingSafeEqual } from "node:crypto";
import {
  preflight,
  runProbe,
  allCriticalPassed,
} from "../scripts/probe-private-cas.mjs";

export const PROBE_CONFIRM = "RUN-PREVIEW-CAS-PROBE";
export const MIN_PROBE_SECRET_LEN = 16;

function secretsEqual(expected, provided) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(provided || ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(req) {
  const auth = String(req?.headers?.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : "";
}

/**
 * Server-side authorization + environment gates (no Blob I/O).
 * @returns {{ ok: boolean, status: number, reason: string, results: object }}
 */
export function evaluateHttpGates(req, env = process.env) {
  const results = {
    probe_flag_set: env.PROBE_PRIVATE_CAS === "1",
    preview_env: String(env.VERCEL_ENV || "") === "preview",
    production_blocked: String(env.VERCEL_ENV || "") === "production",
    run_secret_configured: false,
    run_secret_authorized: false,
    git_branch_allowlist_present: false,
    git_branch_matched: false,
    method_ok: false,
  };

  // Absent kill-switch → look like the route does not exist.
  if (!results.probe_flag_set) {
    return { ok: false, status: 404, reason: "probe_disabled", results };
  }
  if (results.production_blocked || !results.preview_env) {
    return { ok: false, status: 404, reason: "env_blocked", results };
  }

  const secret = String(env.PROBE_RUN_SECRET || "");
  results.run_secret_configured = secret.length >= MIN_PROBE_SECRET_LEN;
  if (!results.run_secret_configured) {
    return { ok: false, status: 503, reason: "run_secret_required", results };
  }

  results.run_secret_authorized = secretsEqual(secret, bearerToken(req));
  if (!results.run_secret_authorized) {
    return { ok: false, status: 401, reason: "unauthorized", results };
  }

  const allowBranch = String(env.PROBE_PREVIEW_GIT_BRANCH || "").trim();
  results.git_branch_allowlist_present = Boolean(allowBranch);
  if (!allowBranch) {
    return { ok: false, status: 503, reason: "git_branch_allowlist_required", results };
  }
  const deployBranch = String(env.VERCEL_GIT_COMMIT_REF || "").trim();
  results.git_branch_matched = allowBranch === deployBranch;
  if (!results.git_branch_matched) {
    return { ok: false, status: 409, reason: "git_branch_mismatch", results };
  }

  const method = String(req?.method || "GET").toUpperCase();
  results.method_ok = method === "GET" || method === "POST";
  if (!results.method_ok) {
    return { ok: false, status: 405, reason: "method_not_allowed", results };
  }

  return { ok: true, status: 200, reason: "http_gates_ok", results };
}

/** Safe readiness snapshot — booleans/labels only. */
export function readinessReport(env = process.env) {
  const gate = preflight({
    ...env,
    // preflight requires the flag; readiness is only called after HTTP gates.
    PROBE_PRIVATE_CAS: "1",
    VERCEL_ENV: "preview",
  });
  return {
    ready: gate.ok,
    stop_reason: gate.ok ? "ready" : gate.reason,
    results: {
      probe_flag_set: true,
      preview_env: true,
      stores_isolated: Boolean(gate.results?.stores_isolated),
      public_store_id_ok: Boolean(gate.results?.public_store_id_ok),
      private_store_id_ok: Boolean(gate.results?.private_store_id_ok),
      preview_allowlist_present: Boolean(gate.results?.preview_allowlist_present),
      preview_store_allowlist_matched: Boolean(gate.results?.preview_store_allowlist_matched),
      private_token_present: Boolean(gate.results?.private_token_present),
      public_token_present: Boolean(gate.results?.public_token_present),
      git_branch_allowlist_present: Boolean(String(env.PROBE_PREVIEW_GIT_BRANCH || "").trim()),
      git_branch_matched:
        String(env.PROBE_PREVIEW_GIT_BRANCH || "").trim() ===
        String(env.VERCEL_GIT_COMMIT_REF || "").trim(),
    },
  };
}

/**
 * Handle an authorized probe HTTP request.
 * GET → readiness only. POST + confirm → one runProbe invocation.
 */
export async function handleProbeHttp(req, env = process.env, deps = {}) {
  const run = deps.runProbe || runProbe;
  const gates = evaluateHttpGates(req, env);
  if (!gates.ok) {
    return {
      status: gates.status,
      body: { ok: false, reason: gates.reason },
    };
  }

  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET") {
    const ready = readinessReport(env);
    return {
      status: ready.ready ? 200 : 503,
      body: { ok: ready.ready, mode: "readiness", ...ready },
    };
  }

  const confirm = String(req.body?.confirm || req.query?.confirm || "");
  if (confirm !== PROBE_CONFIRM) {
    return {
      status: 400,
      body: { ok: false, reason: "confirm_required" },
    };
  }

  const report = await run({ env });
  const ok = !report.stopped && allCriticalPassed(report.results || {});
  return {
    status: ok ? 200 : 409,
    body: {
      ok,
      mode: "run",
      stop_reason: report.stop_reason,
      run_id: report.run_id,
      pathname_prefix: report.pathname_prefix,
      results: report.results,
    },
  };
}
