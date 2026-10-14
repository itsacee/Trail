// HTTP gate for the isolated Preview private Blob CAS probe.
//
// Reuses scripts/probe-private-cas.mjs (preflight + runProbe). Adds
// Preview-only kill switches, a dedicated bearer secret, Git branch + commit
// SHA allowlists, and a private-Blob create-only once-lock so a successful
// claim permits exactly one POST run (including under concurrency).
//
// Never logs or returns tokens, Authorization headers, store ids, ETags,
// or blob bodies.

import { timingSafeEqual } from "node:crypto";
import { put as blobPut } from "@vercel/blob";
import {
  preflight,
  runProbe,
  allCriticalPassed,
  assertPathnameSafe,
} from "../scripts/probe-private-cas.mjs";

export const PROBE_CONFIRM = "RUN-PREVIEW-CAS-PROBE";
export const MIN_PROBE_SECRET_LEN = 16;
export const GIT_SHA_RE = /^[a-f0-9]{40}$/i;
export const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
export const PATH_PREFIX_RE = /^probe\/cas-verify\/[A-Za-z0-9._-]+\/$/;

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

export function isFullGitSha(value) {
  return GIT_SHA_RE.test(String(value || "").trim());
}

/** Fixed disposable once-lock path bound to the expected commit SHA. */
export function buildOnceLockPathname(commitSha) {
  const sha = String(commitSha || "").trim().toLowerCase();
  return `probe/cas-verify/http-once-${sha}/object.json`;
}

/**
 * Create-only claim on private Blob. Concurrent losers and repeat POSTs fail.
 * Uses allowOverwrite:false — not an in-memory flag.
 */
export async function claimHttpExecutionOnce({
  env = process.env,
  commitSha,
  blobPutFn = blobPut,
} = {}) {
  const sha = String(commitSha || "").trim().toLowerCase();
  if (!isFullGitSha(sha)) {
    return { ok: false, reason: "once_lock_sha_invalid" };
  }

  const pathname = buildOnceLockPathname(sha);
  const pathCheck = assertPathnameSafe(pathname);
  if (!pathCheck.ok) {
    return { ok: false, reason: "once_lock_pathname_invalid" };
  }

  const token = env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return { ok: false, reason: "missing_private_token" };
  }

  try {
    await blobPutFn(pathname, JSON.stringify({ v: "http-once-claimed" }), {
      access: "private",
      token,
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json",
    });
    return {
      ok: true,
      reason: "claimed",
      pathname_prefix: `probe/cas-verify/http-once-${sha}/`,
    };
  } catch {
    // Fail closed: any create-only conflict or Blob error blocks another run.
    // Never surface error messages (may contain URLs or metadata).
    return { ok: false, reason: "already_executed" };
  }
}

/**
 * Server-side authorization + environment gates (no Blob I/O).
 * Endpoint stays disabled unless every required security variable is set.
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
    git_sha_allowlist_present: false,
    git_sha_matched: false,
    preview_store_allowlist_present: false,
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

  const allowBranch = String(env.PROBE_PREVIEW_GIT_BRANCH || "").trim();
  results.git_branch_allowlist_present = Boolean(allowBranch);

  const allowSha = String(env.PROBE_PREVIEW_GIT_SHA || "").trim().toLowerCase();
  results.git_sha_allowlist_present = isFullGitSha(allowSha);

  const storeAllow = String(env.PROBE_PREVIEW_PRIVATE_STORE_ID || "").trim();
  results.preview_store_allowlist_present = Boolean(storeAllow);

  // Incomplete security configuration → not runnable (fail closed).
  if (
    !results.run_secret_configured ||
    !results.git_branch_allowlist_present ||
    !results.git_sha_allowlist_present ||
    !results.preview_store_allowlist_present
  ) {
    return { ok: false, status: 503, reason: "security_config_required", results };
  }

  results.run_secret_authorized = secretsEqual(secret, bearerToken(req));
  if (!results.run_secret_authorized) {
    return { ok: false, status: 401, reason: "unauthorized", results };
  }

  const deployBranch = String(env.VERCEL_GIT_COMMIT_REF || "").trim();
  results.git_branch_matched = allowBranch === deployBranch;
  if (!results.git_branch_matched) {
    return { ok: false, status: 409, reason: "git_branch_mismatch", results };
  }

  const deploySha = String(env.VERCEL_GIT_COMMIT_SHA || "").trim().toLowerCase();
  results.git_sha_matched = allowSha === deploySha && isFullGitSha(deploySha);
  if (!results.git_sha_matched) {
    return { ok: false, status: 409, reason: "git_sha_mismatch", results };
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
  const allowSha = String(env.PROBE_PREVIEW_GIT_SHA || "").trim().toLowerCase();
  const deploySha = String(env.VERCEL_GIT_COMMIT_SHA || "").trim().toLowerCase();
  return {
    ready: gate.ok && isFullGitSha(allowSha) && allowSha === deploySha,
    stop_reason: gate.ok
      ? allowSha === deploySha && isFullGitSha(deploySha)
        ? "ready"
        : "git_sha_mismatch"
      : gate.reason,
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
      git_sha_allowlist_present: isFullGitSha(allowSha),
      git_sha_matched: isFullGitSha(allowSha) && allowSha === deploySha && isFullGitSha(deploySha),
    },
  };
}

/** Strip anything that is not a safe boolean/label for HTTP responses. */
export function sanitizePublicBody(body) {
  const src = body && typeof body === "object" ? body : {};
  const out = {};

  if (typeof src.ok === "boolean") out.ok = src.ok;
  if (typeof src.ready === "boolean") out.ready = src.ready;
  if (typeof src.mode === "string" && (src.mode === "readiness" || src.mode === "run")) {
    out.mode = src.mode;
  }
  if (typeof src.reason === "string" && /^[a-z0-9_]{1,64}$/.test(src.reason)) {
    out.reason = src.reason;
  }
  if (typeof src.stop_reason === "string" && /^[a-z0-9_]{1,64}$/.test(src.stop_reason)) {
    out.stop_reason = src.stop_reason;
  }
  if (typeof src.run_id === "string" && RUN_ID_RE.test(src.run_id) && src.run_id.length <= 80) {
    out.run_id = src.run_id;
  }
  if (typeof src.pathname_prefix === "string" && PATH_PREFIX_RE.test(src.pathname_prefix)) {
    out.pathname_prefix = src.pathname_prefix;
  }

  if (src.results && typeof src.results === "object") {
    const results = {};
    for (const [key, value] of Object.entries(src.results)) {
      if (!/^[a-z0-9_]{1,64}$/.test(key)) continue;
      if (typeof value === "boolean") {
        results[key] = value;
      } else if (
        key === "exception_name" &&
        typeof value === "string" &&
        /^[A-Za-z0-9._-]{1,64}$/.test(value)
      ) {
        results[key] = value;
      }
    }
    out.results = results;
  }

  return out;
}

/**
 * Handle an authorized probe HTTP request.
 * GET → readiness only. POST + confirm → once-lock claim then one runProbe.
 */
export async function handleProbeHttp(req, env = process.env, deps = {}) {
  const run = deps.runProbe || runProbe;
  const claim = deps.claimHttpExecutionOnce || claimHttpExecutionOnce;

  const gates = evaluateHttpGates(req, env);
  if (!gates.ok) {
    return {
      status: gates.status,
      body: sanitizePublicBody({ ok: false, reason: gates.reason }),
    };
  }

  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET") {
    const ready = readinessReport(env);
    return {
      status: ready.ready ? 200 : 503,
      body: sanitizePublicBody({ ok: ready.ready, mode: "readiness", ...ready }),
    };
  }

  const confirm = String(req.body?.confirm || req.query?.confirm || "");
  if (confirm !== PROBE_CONFIRM) {
    return {
      status: 400,
      body: sanitizePublicBody({ ok: false, reason: "confirm_required" }),
    };
  }

  const commitSha = String(env.PROBE_PREVIEW_GIT_SHA || "").trim().toLowerCase();
  const claimResult = await claim({ env, commitSha });
  if (!claimResult.ok) {
    return {
      status: 409,
      body: sanitizePublicBody({
        ok: false,
        reason: claimResult.reason || "already_executed",
      }),
    };
  }

  const report = await run({ env });
  const ok = !report.stopped && allCriticalPassed(report.results || {});
  return {
    status: ok ? 200 : 409,
    body: sanitizePublicBody({
      ok,
      mode: "run",
      stop_reason: report.stop_reason,
      run_id: report.run_id,
      pathname_prefix: report.pathname_prefix,
      results: report.results,
    }),
  };
}
