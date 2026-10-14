// Safety tests for the Preview-runtime CAS probe HTTP gate.
// No live Blob / network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PROBE_CONFIRM,
  MIN_PROBE_SECRET_LEN,
  evaluateHttpGates,
  readinessReport,
  handleProbeHttp,
} from "../lib/probePrivateCasHttp.js";

const SECRET = "preview-probe-secret-32chars!!";
assert.ok(SECRET.length >= MIN_PROBE_SECRET_LEN);

const BASE_ENV = {
  PROBE_PRIVATE_CAS: "1",
  VERCEL_ENV: "preview",
  PROBE_RUN_SECRET: SECRET,
  PROBE_PREVIEW_GIT_BRANCH: "cursor/preview-cas-probe-api-f621",
  VERCEL_GIT_COMMIT_REF: "cursor/preview-cas-probe-api-f621",
  PRIVATE_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_privStore_privsecret",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_pubStorexx_pubsecret",
  PROBE_PREVIEW_PRIVATE_STORE_ID: "privStore",
};

function req(method = "GET", { auth = `Bearer ${SECRET}`, body = null, query = {} } = {}) {
  return {
    method,
    headers: auth ? { authorization: auth } : {},
    body,
    query,
  };
}

beforeEach(() => {
  // Gates read env args; nothing to reset.
});

test("PROBE_CONFIRM and secret length constants are strict", () => {
  assert.equal(PROBE_CONFIRM, "RUN-PREVIEW-CAS-PROBE");
  assert.equal(MIN_PROBE_SECRET_LEN, 16);
});

test("disabled kill-switch returns 404 (route looks absent)", () => {
  const g = evaluateHttpGates(req("POST"), { ...BASE_ENV, PROBE_PRIVATE_CAS: "0" });
  assert.equal(g.ok, false);
  assert.equal(g.status, 404);
  assert.equal(g.reason, "probe_disabled");
});

test("production environment is blocked with 404", () => {
  const g = evaluateHttpGates(req("POST"), { ...BASE_ENV, VERCEL_ENV: "production" });
  assert.equal(g.ok, false);
  assert.equal(g.status, 404);
  assert.equal(g.reason, "env_blocked");
  assert.equal(g.results.production_blocked, true);
});

test("development / non-preview environments are blocked", () => {
  for (const envName of ["development", "staging", ""]) {
    const g = evaluateHttpGates(req("GET"), { ...BASE_ENV, VERCEL_ENV: envName });
    assert.equal(g.ok, false, envName);
    assert.equal(g.status, 404, envName);
  }
});

test("missing or short PROBE_RUN_SECRET refuses to run", () => {
  const missing = evaluateHttpGates(req("GET"), { ...BASE_ENV, PROBE_RUN_SECRET: "" });
  assert.equal(missing.status, 503);
  assert.equal(missing.reason, "run_secret_required");
  const short = evaluateHttpGates(req("GET"), { ...BASE_ENV, PROBE_RUN_SECRET: "too-short" });
  assert.equal(short.status, 503);
  assert.equal(short.reason, "run_secret_required");
});

test("wrong or missing bearer is unauthorized", () => {
  const wrong = evaluateHttpGates(req("GET", { auth: "Bearer wrong-secret-value!!!!" }), BASE_ENV);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.reason, "unauthorized");
  const none = evaluateHttpGates(req("GET", { auth: "" }), BASE_ENV);
  assert.equal(none.status, 401);
});

test("git branch allowlist is required and must match deploy ref", () => {
  const missing = evaluateHttpGates(req("GET"), {
    ...BASE_ENV,
    PROBE_PREVIEW_GIT_BRANCH: "",
  });
  assert.equal(missing.status, 503);
  assert.equal(missing.reason, "git_branch_allowlist_required");

  const mismatch = evaluateHttpGates(req("GET"), {
    ...BASE_ENV,
    VERCEL_GIT_COMMIT_REF: "main",
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.reason, "git_branch_mismatch");
});

test("HTTP gates pass for authorized Preview GET/POST", () => {
  for (const method of ["GET", "POST"]) {
    const g = evaluateHttpGates(req(method), BASE_ENV);
    assert.equal(g.ok, true, method);
    assert.equal(g.reason, "http_gates_ok", method);
  }
});

test("readiness never includes secrets or store ids", () => {
  const ready = readinessReport(BASE_ENV);
  assert.equal(ready.ready, true);
  const dumped = JSON.stringify(ready);
  assert.equal(dumped.includes(SECRET), false);
  assert.equal(dumped.includes("privStore"), false);
  assert.equal(dumped.includes("privsecret"), false);
  assert.equal(dumped.includes("vercel_blob_rw"), false);
});

test("GET handleProbeHttp returns readiness without invoking runProbe", async () => {
  let called = 0;
  const { status, body } = await handleProbeHttp(req("GET"), BASE_ENV, {
    runProbe: async () => {
      called += 1;
      return { stopped: true, stop_reason: "should_not_run", results: {} };
    },
  });
  assert.equal(called, 0);
  assert.equal(status, 200);
  assert.equal(body.mode, "readiness");
  assert.equal(body.ok, true);
});

test("POST without confirm does not run the probe", async () => {
  let called = 0;
  const { status, body } = await handleProbeHttp(req("POST", { body: {} }), BASE_ENV, {
    runProbe: async () => {
      called += 1;
      return { stopped: false, stop_reason: "completed", run_id: "x", pathname_prefix: "p", results: {} };
    },
  });
  assert.equal(called, 0);
  assert.equal(status, 400);
  assert.equal(body.reason, "confirm_required");
});

test("POST with confirm runs probe once and returns safe summary", async () => {
  let called = 0;
  const { status, body } = await handleProbeHttp(
    req("POST", { body: { confirm: PROBE_CONFIRM } }),
    BASE_ENV,
    {
      runProbe: async ({ env }) => {
        called += 1;
        assert.equal(env.PROBE_PRIVATE_CAS, "1");
        assert.equal(env.VERCEL_ENV, "preview");
        // Critical results shape from the real probe's allCriticalPassed list.
        const results = {
          env_ok: true,
          stores_isolated: true,
          public_store_id_ok: true,
          private_store_id_ok: true,
          preview_allowlist_present: true,
          preview_store_allowlist_matched: true,
          pathname_safe: true,
          create_a_ok: true,
          fresh_after_a: true,
          write_b_ok: true,
          write_a2_ok: true,
          etag_a_ne_b: true,
          etag_b_ne_a2: true,
          etag_a_ne_a2: true,
          fresh_after_a2: true,
          stale_ifmatch_rejected: true,
          stale_write_did_not_mutate: true,
          stale_etag_unchanged: true,
          conditional_put_ok: true,
          fresh_after_c: true,
          etag_changed_after_c: true,
          same_pathname: true,
          private_token_only: true,
          probe_completed: true,
        };
        return {
          stopped: false,
          stop_reason: "completed",
          run_id: "20261014T000000Z-abc123",
          pathname_prefix: "probe/cas-verify/20261014T000000Z-abc123/",
          results,
        };
      },
    }
  );
  assert.equal(called, 1);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, "run");
  assert.equal(body.pathname_prefix.startsWith("probe/cas-verify/"), true);
  const dumped = JSON.stringify(body);
  assert.equal(dumped.includes(SECRET), false);
  assert.equal(dumped.includes("privsecret"), false);
  assert.equal(dumped.includes("vercel_blob_rw"), false);
  // Boolean result keys may mention etag_*; raw ETag values must never appear.
  assert.equal(dumped.includes('"\\"'), false);
  assert.equal(/"[a-f0-9]{16,}"/i.test(dumped), false);
});

test("unauthorized POST never reaches runProbe", async () => {
  let called = 0;
  const { status } = await handleProbeHttp(
    req("POST", { auth: "Bearer totally-wrong-secret!!", body: { confirm: PROBE_CONFIRM } }),
    BASE_ENV,
    {
      runProbe: async () => {
        called += 1;
        return { stopped: false, results: {} };
      },
    }
  );
  assert.equal(called, 0);
  assert.equal(status, 401);
});

test("api handler module has no vercel cron registration", () => {
  const vercel = JSON.parse(readFileSync(path.resolve("vercel.json"), "utf8"));
  const paths = (vercel.crons || []).map((c) => c.path);
  assert.equal(paths.includes("/api/probe-private-cas"), false);
  assert.equal(paths.includes("/api/reminders"), true);
});

test("api/probe-private-cas.js source stays a thin authorized wrapper", () => {
  const src = readFileSync(path.resolve("api/probe-private-cas.js"), "utf8");
  assert.match(src, /handleProbeHttp/);
  assert.match(src, /no-store/);
  assert.equal(src.includes("lessons.json"), false);
  assert.equal(src.includes("holds.json"), false);
  assert.equal(/console\.(log|info|debug)\(/.test(src), false);
});

test("http gate responses never echo the bearer secret", () => {
  const g = evaluateHttpGates(req("GET", { auth: `Bearer ${SECRET}` }), BASE_ENV);
  const dumped = JSON.stringify(g);
  assert.equal(dumped.includes(SECRET), false);
  assert.equal(dumped.includes("Bearer"), false);
});
