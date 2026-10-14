#!/usr/bin/env node
/**
 * Isolated Preview private Blob CAS probe.
 *
 * SAFETY:
 * - Does nothing unless PROBE_PRIVATE_CAS=1.
 * - Requires VERCEL_ENV=preview exactly (production and all others blocked).
 * - Requires both private and public Blob tokens with distinct, parseable store IDs.
 * - Requires PROBE_PREVIEW_PRIVATE_STORE_ID to match the private token's store ID
 *   (independent Preview allowlist — never logged).
 * - Uses PRIVATE_BLOB_READ_WRITE_TOKEN only for get/head/put (never public fallback).
 * - Writes only probe/cas-verify/<RUN_ID>/object.json
 * - Never touches capacity/customer files.
 * - Reports booleans/labels only — never tokens, store IDs, ETags, URLs, or bodies.
 * - Does not delete artifacts.
 *
 * Live execution requires separate operator approval and Preview credentials.
 * Preview-runtime entry (authorized HTTP) lives at api/probe-private-cas.js and
 * reuses preflight/runProbe from this module — never auto-invoked on deploy.
 */

import { put, get, head, BlobPreconditionFailedError } from "@vercel/blob";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Capacity / customer pathnames this probe must never touch. */
export const FORBIDDEN_PATHNAMES = new Set([
  "lessons.json",
  "holds.json",
  "manual-bookings.json",
  "members.json",
  "availability.json",
  "capacity-cutover.json",
  "settings.json",
  "finance.json",
]);

export const PATHNAME_RE = /^probe\/cas-verify\/[A-Za-z0-9._-]+\/object\.json$/;

/** Extract store id from vercel_blob_rw_<storeId>_<secret…> — never log the token. */
export function storeIdFromToken(token) {
  if (!token || typeof token !== "string") return "";
  const parts = token.split("_");
  return parts.length >= 4 ? parts[3] : "";
}

/** Store ids must be non-empty and free of whitespace/control characters. Never log the value. */
export function isWellFormedStoreId(storeId) {
  if (!storeId || typeof storeId !== "string") return false;
  if (storeId !== storeId.trim()) return false;
  if (!/^[A-Za-z0-9]+$/.test(storeId)) return false;
  return storeId.length >= 4;
}

export function buildRunId(now = new Date(), entropy = randomBytes(3).toString("hex")) {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${iso}-${entropy}`;
}

export function buildPathname(runId) {
  return `probe/cas-verify/${runId}/object.json`;
}

/**
 * @returns {{ ok: boolean, reason: string }}
 */
export function assertPathnameSafe(pathname) {
  if (typeof pathname !== "string" || !pathname) {
    return { ok: false, reason: "pathname_empty" };
  }
  if (FORBIDDEN_PATHNAMES.has(pathname)) {
    return { ok: false, reason: "pathname_forbidden_capacity" };
  }
  if (pathname.includes("..") || pathname.startsWith("/") || pathname.includes("\\")) {
    return { ok: false, reason: "pathname_traversal" };
  }
  if (!PATHNAME_RE.test(pathname)) {
    return { ok: false, reason: "pathname_pattern_mismatch" };
  }
  return { ok: true, reason: "pathname_safe" };
}

/**
 * Preflight gates. Never returns token values or store id strings.
 * @param {NodeJS.ProcessEnv} env
 */
export function preflight(env = process.env) {
  const vercelEnv = String(env.VERCEL_ENV || "");
  const results = {
    probe_flag_set: env.PROBE_PRIVATE_CAS === "1",
    production_blocked: vercelEnv === "production",
    env_ok: false,
    private_token_present: Boolean(env.PRIVATE_BLOB_READ_WRITE_TOKEN),
    public_token_present: Boolean(env.BLOB_READ_WRITE_TOKEN),
    public_store_id_ok: false,
    private_store_id_ok: false,
    stores_isolated: false,
    preview_allowlist_present: false,
    preview_store_allowlist_matched: false,
    pathname_safe: false,
    gates_untouched: true,
  };

  if (!results.probe_flag_set) {
    return { ok: false, reason: "probe_flag_required", results };
  }
  if (results.production_blocked) {
    return { ok: false, reason: "production_blocked", results };
  }

  // Exact Preview only — no local bypass flag.
  results.env_ok = vercelEnv === "preview";
  if (!results.env_ok) {
    return { ok: false, reason: "env_blocked", results };
  }

  if (!results.private_token_present) {
    return { ok: false, reason: "missing_private_token", results };
  }
  if (!results.public_token_present) {
    return { ok: false, reason: "missing_public_token", results };
  }

  const pub = storeIdFromToken(env.BLOB_READ_WRITE_TOKEN || "");
  const priv = storeIdFromToken(env.PRIVATE_BLOB_READ_WRITE_TOKEN || "");
  results.public_store_id_ok = isWellFormedStoreId(pub);
  results.private_store_id_ok = isWellFormedStoreId(priv);

  if (!results.public_store_id_ok) {
    return { ok: false, reason: "public_store_id_malformed", results };
  }
  if (!results.private_store_id_ok) {
    return { ok: false, reason: "private_store_id_malformed", results };
  }
  if (pub === priv) {
    results.stores_isolated = false;
    return { ok: false, reason: "shared_store_blocked", results };
  }
  results.stores_isolated = true;

  // Independent Preview private-store allowlist (operator-approved). Never log the value.
  const allowlist = String(env.PROBE_PREVIEW_PRIVATE_STORE_ID || "").trim();
  results.preview_allowlist_present = Boolean(allowlist);
  if (!allowlist) {
    return { ok: false, reason: "missing_preview_store_allowlist", results };
  }
  if (!isWellFormedStoreId(allowlist)) {
    return { ok: false, reason: "preview_store_allowlist_malformed", results };
  }
  results.preview_store_allowlist_matched = allowlist === priv;
  if (!results.preview_store_allowlist_matched) {
    return { ok: false, reason: "preview_store_allowlist_mismatch", results };
  }

  return { ok: true, reason: "preflight_ok", results };
}

async function streamToText(stream) {
  return new Response(stream).text();
}

async function readVersionLabel(blobApi, pathname, token) {
  const result = await blobApi.get(pathname, {
    access: "private",
    token,
    useCache: false,
  });
  if (!(result && result.statusCode === 200 && result.stream)) {
    return { ok: false, label: null };
  }
  const text = await streamToText(result.stream);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, label: null };
  }
  const label = parsed && typeof parsed.v === "string" ? parsed.v : null;
  return { ok: Boolean(label), label };
}

/**
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {{ put: Function, get: Function, head: Function, BlobPreconditionFailedError: Function }} [opts.blobApi]
 * @param {string} [opts.runId]
 */
export async function runProbe({
  env = process.env,
  blobApi = { put, get, head, BlobPreconditionFailedError },
  runId = buildRunId(),
} = {}) {
  const report = {
    run_id: runId,
    pathname_prefix: `probe/cas-verify/${runId}/`,
    stopped: false,
    stop_reason: "",
    results: {},
  };

  const gate = preflight(env);
  Object.assign(report.results, gate.results);

  if (!gate.ok) {
    report.stopped = true;
    report.stop_reason = gate.reason;
    report.results.probe_completed = false;
    return report;
  }

  const pathname = buildPathname(runId);
  const pathCheck = assertPathnameSafe(pathname);
  report.results.pathname_safe = pathCheck.ok;
  if (!pathCheck.ok) {
    report.stopped = true;
    report.stop_reason = pathCheck.reason;
    report.results.probe_completed = false;
    return report;
  }

  const token = env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  const PreconditionError = blobApi.BlobPreconditionFailedError;

  const putPrivate = (body, extra = {}) =>
    blobApi.put(pathname, JSON.stringify(body), {
      access: "private",
      token,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      ...extra,
    });

  const headEtag = async () => {
    const meta = await blobApi.head(pathname, { token });
    return String(meta?.etag || "");
  };

  try {
    // Step 1 — create A
    await putPrivate({ v: "A" });
    report.results.create_a_ok = true;

    const afterA = await readVersionLabel(blobApi, pathname, token);
    report.results.fresh_after_a = afterA.ok && afterA.label === "A";
    const etagA = await headEtag();
    report.results.head_a_present = Boolean(etagA);
    if (!report.results.fresh_after_a || !etagA) {
      report.stopped = true;
      report.stop_reason = "fresh_after_a_failed";
      report.results.probe_completed = false;
      return report;
    }

    // Step 2/3 — A → B → A
    await putPrivate({ v: "B" }, { ifMatch: etagA });
    report.results.write_b_ok = true;
    const etagB = await headEtag();
    report.results.head_b_present = Boolean(etagB);

    await putPrivate({ v: "A" }, { ifMatch: etagB });
    report.results.write_a2_ok = true;
    const etagA2 = await headEtag();
    report.results.head_a2_present = Boolean(etagA2);

    report.results.etag_a_ne_b = Boolean(etagA && etagB && etagA !== etagB);
    report.results.etag_b_ne_a2 = Boolean(etagB && etagA2 && etagB !== etagA2);
    report.results.etag_a_ne_a2 = Boolean(etagA && etagA2 && etagA !== etagA2);

    const afterA2 = await readVersionLabel(blobApi, pathname, token);
    report.results.fresh_after_a2 = afterA2.ok && afterA2.label === "A";

    // Step 4 — stale ifMatch must reject
    let staleRejected = false;
    try {
      await putPrivate({ v: "STALE" }, { ifMatch: etagA });
      // Unexpected success — hard stop
      report.results.stale_ifmatch_rejected = false;
      report.results.cas_integrity_failure = true;
      report.stopped = true;
      report.stop_reason = "stale_ifmatch_unexpected_success";
      report.results.probe_completed = false;
      return report;
    } catch (error) {
      staleRejected =
        error instanceof PreconditionError || error?.name === "BlobPreconditionFailedError";
      report.results.stale_ifmatch_rejected = staleRejected;
      if (!staleRejected) {
        report.stopped = true;
        report.stop_reason = "stale_ifmatch_unexpected_error";
        report.results.probe_completed = false;
        return report;
      }
    }

    const afterStale = await readVersionLabel(blobApi, pathname, token);
    report.results.stale_write_did_not_mutate = afterStale.ok && afterStale.label === "A";
    const etagAfterStale = await headEtag();
    report.results.stale_etag_unchanged = Boolean(etagAfterStale && etagAfterStale === etagA2);

    // Step 5 — correct conditional put
    await putPrivate({ v: "C" }, { ifMatch: etagA2 });
    report.results.conditional_put_ok = true;
    const afterC = await readVersionLabel(blobApi, pathname, token);
    report.results.fresh_after_c = afterC.ok && afterC.label === "C";
    const etagC = await headEtag();
    report.results.etag_changed_after_c = Boolean(etagC && etagC !== etagA2);

    // Step 6 — same store / pathname
    report.results.same_pathname = true;
    report.results.private_token_only = true;
    report.results.artifact_left = true;
    report.results.probe_completed = true;
    report.stop_reason = "completed";
    return report;
  } catch (error) {
    report.stopped = true;
    report.stop_reason = "probe_exception";
    report.results.probe_completed = false;
    report.results.exception_name = typeof error?.name === "string" ? error.name : "Error";
    return report;
  }
}

export function allCriticalPassed(results) {
  const required = [
    "env_ok",
    "stores_isolated",
    "public_store_id_ok",
    "private_store_id_ok",
    "preview_allowlist_present",
    "preview_store_allowlist_matched",
    "pathname_safe",
    "create_a_ok",
    "fresh_after_a",
    "write_b_ok",
    "write_a2_ok",
    "etag_a_ne_b",
    "etag_b_ne_a2",
    "etag_a_ne_a2",
    "fresh_after_a2",
    "stale_ifmatch_rejected",
    "stale_write_did_not_mutate",
    "stale_etag_unchanged",
    "conditional_put_ok",
    "fresh_after_c",
    "etag_changed_after_c",
    "same_pathname",
    "private_token_only",
    "probe_completed",
  ];
  return required.every((k) => results[k] === true);
}

async function main() {
  if (process.env.PROBE_PRIVATE_CAS !== "1") {
    console.error(
      JSON.stringify({
        ok: false,
        reason: "probe_flag_required",
        hint: "Set PROBE_PRIVATE_CAS=1 only for an approved Preview live run.",
      })
    );
    process.exitCode = 2;
    return;
  }

  const report = await runProbe();
  const ok = !report.stopped && allCriticalPassed(report.results);
  // Safe output only — report already excludes secrets/ETags/bodies.
  console.log(
    JSON.stringify({
      ok,
      stop_reason: report.stop_reason,
      run_id: report.run_id,
      pathname_prefix: report.pathname_prefix,
      results: report.results,
    })
  );
  process.exitCode = ok ? 0 : 1;
}

// Never auto-run on import (unit tests import this module).
const launchedDirectly =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (launchedDirectly) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        reason: "fatal",
        exception_name: error?.name || "Error",
      })
    );
    process.exitCode = 1;
  });
}
