// Safety tests for the Preview-runtime CAS probe HTTP gate.
// No live Blob / network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  PROBE_CONFIRM,
  MIN_PROBE_SECRET_LEN,
  GIT_SHA_RE,
  evaluateHttpGates,
  readinessReport,
  handleProbeHttp,
  claimHttpExecutionOnce,
  buildOnceLockPathname,
  sanitizePublicBody,
  isFullGitSha,
} from "../lib/probePrivateCasHttp.js";
import { assertPathnameSafe, PATHNAME_RE } from "../scripts/probe-private-cas.mjs";

const SECRET = "preview-probe-secret-32chars!!";
assert.ok(SECRET.length >= MIN_PROBE_SECRET_LEN);

const COMMIT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const BASE_ENV = {
  PROBE_PRIVATE_CAS: "1",
  VERCEL_ENV: "preview",
  PROBE_RUN_SECRET: SECRET,
  PROBE_PREVIEW_GIT_BRANCH: "cursor/preview-cas-probe-api-f621",
  VERCEL_GIT_COMMIT_REF: "cursor/preview-cas-probe-api-f621",
  PROBE_PREVIEW_GIT_SHA: COMMIT_SHA,
  VERCEL_GIT_COMMIT_SHA: COMMIT_SHA,
  PRIVATE_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_privStore_privsecret",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_pubStorexx_pubsecret",
  PROBE_PREVIEW_PRIVATE_STORE_ID: "privStore",
};

const CRITICAL_TRUE = {
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

function req(method = "GET", { auth = `Bearer ${SECRET}`, body = null, query = {} } = {}) {
  return {
    method,
    headers: auth ? { authorization: auth } : {},
    body,
    query,
  };
}

function assertNoSensitiveLeak(payload, extra = []) {
  const dumped = JSON.stringify(payload);
  assert.equal(dumped.includes(SECRET), false);
  assert.equal(dumped.includes("Bearer"), false);
  assert.equal(dumped.includes("privsecret"), false);
  assert.equal(dumped.includes("pubsecret"), false);
  assert.equal(dumped.includes("vercel_blob_rw"), false);
  assert.equal(dumped.includes("privStore"), false);
  assert.equal(dumped.includes("Authorization"), false);
  // Raw ETag values (quoted) must never appear; boolean keys like etag_a_ne_b are OK.
  assert.equal(/"[a-f0-9]{16,}"/i.test(dumped), false);
  assert.equal(dumped.includes('"\\"'), false);
  for (const s of extra) {
    assert.equal(dumped.includes(s), false, `leak: ${s}`);
  }
}

test("PROBE_CONFIRM and secret length constants are strict", () => {
  assert.equal(PROBE_CONFIRM, "RUN-PREVIEW-CAS-PROBE");
  assert.equal(MIN_PROBE_SECRET_LEN, 16);
  assert.equal(GIT_SHA_RE.test(COMMIT_SHA), true);
  assert.equal(isFullGitSha("abc"), false);
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

test("missing any required security variable keeps endpoint non-runnable", () => {
  const cases = [
    { PROBE_RUN_SECRET: "" },
    { PROBE_RUN_SECRET: "too-short" },
    { PROBE_PREVIEW_GIT_BRANCH: "" },
    { PROBE_PREVIEW_GIT_SHA: "" },
    { PROBE_PREVIEW_GIT_SHA: "notasha" },
    { PROBE_PREVIEW_PRIVATE_STORE_ID: "" },
  ];
  for (const patch of cases) {
    const g = evaluateHttpGates(req("GET"), { ...BASE_ENV, ...patch });
    assert.equal(g.ok, false, JSON.stringify(patch));
    assert.equal(g.status, 503, JSON.stringify(patch));
    assert.equal(g.reason, "security_config_required", JSON.stringify(patch));
  }
});

test("wrong or missing bearer is unauthorized", () => {
  const wrong = evaluateHttpGates(req("GET", { auth: "Bearer wrong-secret-value!!!!" }), BASE_ENV);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.reason, "unauthorized");
  const none = evaluateHttpGates(req("GET", { auth: "" }), BASE_ENV);
  assert.equal(none.status, 401);
});

test("incorrect git branch is rejected", () => {
  const mismatch = evaluateHttpGates(req("GET"), {
    ...BASE_ENV,
    VERCEL_GIT_COMMIT_REF: "main",
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.reason, "git_branch_mismatch");
});

test("incorrect git commit SHA is rejected", () => {
  const mismatch = evaluateHttpGates(req("GET"), {
    ...BASE_ENV,
    VERCEL_GIT_COMMIT_SHA: OTHER_SHA,
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.reason, "git_sha_mismatch");
});

test("HTTP gates pass for authorized Preview GET/POST when fully configured", () => {
  for (const method of ["GET", "POST"]) {
    const g = evaluateHttpGates(req(method), BASE_ENV);
    assert.equal(g.ok, true, method);
    assert.equal(g.reason, "http_gates_ok", method);
    assert.equal(g.results.git_sha_matched, true, method);
  }
});

test("once-lock pathname is disposable probe path bound to commit SHA", () => {
  const pathname = buildOnceLockPathname(COMMIT_SHA);
  assert.equal(PATHNAME_RE.test(pathname), true);
  assert.equal(assertPathnameSafe(pathname).ok, true);
  assert.equal(pathname.includes(COMMIT_SHA), true);
  assert.equal(pathname.startsWith("probe/cas-verify/"), true);
  assert.equal(pathname.includes("lessons.json"), false);
});

test("claimHttpExecutionOnce is create-only and fails closed on conflict", async () => {
  let puts = 0;
  const blobPutFn = async (pathname, body, opts) => {
    puts += 1;
    assert.equal(opts.allowOverwrite, false);
    assert.equal(opts.access, "private");
    assert.equal(opts.token, BASE_ENV.PRIVATE_BLOB_READ_WRITE_TOKEN);
    assert.equal(assertPathnameSafe(pathname).ok, true);
    assert.equal(JSON.parse(body).v, "http-once-claimed");
    if (puts === 1) return { pathname };
    const err = new Error("already exists");
    err.name = "BlobError";
    throw err;
  };

  const first = await claimHttpExecutionOnce({
    env: BASE_ENV,
    commitSha: COMMIT_SHA,
    blobPutFn,
  });
  assert.equal(first.ok, true);
  assert.equal(first.reason, "claimed");

  const second = await claimHttpExecutionOnce({
    env: BASE_ENV,
    commitSha: COMMIT_SHA,
    blobPutFn,
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_executed");
  assertNoSensitiveLeak(first);
  assertNoSensitiveLeak(second);
});

test("readiness never includes secrets, store ids, or ETags", () => {
  const ready = readinessReport(BASE_ENV);
  assert.equal(ready.ready, true);
  assertNoSensitiveLeak(ready, [COMMIT_SHA]);
});

test("GET handleProbeHttp returns readiness without claiming or running", async () => {
  let claimed = 0;
  let called = 0;
  const { status, body } = await handleProbeHttp(req("GET"), BASE_ENV, {
    claimHttpExecutionOnce: async () => {
      claimed += 1;
      return { ok: true, reason: "claimed" };
    },
    runProbe: async () => {
      called += 1;
      return { stopped: true, stop_reason: "should_not_run", results: {} };
    },
  });
  assert.equal(claimed, 0);
  assert.equal(called, 0);
  assert.equal(status, 200);
  assert.equal(body.mode, "readiness");
  assert.equal(body.ok, true);
});

test("POST without confirm does not claim or run the probe", async () => {
  let claimed = 0;
  let called = 0;
  const { status, body } = await handleProbeHttp(req("POST", { body: {} }), BASE_ENV, {
    claimHttpExecutionOnce: async () => {
      claimed += 1;
      return { ok: true, reason: "claimed" };
    },
    runProbe: async () => {
      called += 1;
      return { stopped: false, stop_reason: "completed", run_id: "x", pathname_prefix: "p", results: {} };
    },
  });
  assert.equal(claimed, 0);
  assert.equal(called, 0);
  assert.equal(status, 400);
  assert.equal(body.reason, "confirm_required");
});

test("POST with confirm claims once then runs probe and returns safe summary", async () => {
  let claimed = 0;
  let called = 0;
  const { status, body } = await handleProbeHttp(
    req("POST", { body: { confirm: PROBE_CONFIRM } }),
    BASE_ENV,
    {
      claimHttpExecutionOnce: async ({ commitSha }) => {
        claimed += 1;
        assert.equal(commitSha, COMMIT_SHA);
        return { ok: true, reason: "claimed" };
      },
      runProbe: async ({ env }) => {
        called += 1;
        assert.equal(env.PROBE_PRIVATE_CAS, "1");
        assert.equal(env.VERCEL_ENV, "preview");
        return {
          stopped: false,
          stop_reason: "completed",
          run_id: "20261014T000000Z-abc123",
          pathname_prefix: "probe/cas-verify/20261014T000000Z-abc123/",
          results: CRITICAL_TRUE,
        };
      },
    }
  );
  assert.equal(claimed, 1);
  assert.equal(called, 1);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, "run");
  assert.equal(body.pathname_prefix.startsWith("probe/cas-verify/"), true);
  assertNoSensitiveLeak(body, ['"etag":', "W/"]);
});

test("second POST after successful claim is rejected without running again", async () => {
  let claimed = 0;
  let runs = 0;
  const deps = {
    claimHttpExecutionOnce: async () => {
      claimed += 1;
      if (claimed === 1) return { ok: true, reason: "claimed" };
      return { ok: false, reason: "already_executed" };
    },
    runProbe: async () => {
      runs += 1;
      return {
        stopped: false,
        stop_reason: "completed",
        run_id: "20261014T000000Z-abc123",
        pathname_prefix: "probe/cas-verify/20261014T000000Z-abc123/",
        results: CRITICAL_TRUE,
      };
    },
  };

  const first = await handleProbeHttp(
    req("POST", { body: { confirm: PROBE_CONFIRM } }),
    BASE_ENV,
    deps
  );
  const second = await handleProbeHttp(
    req("POST", { body: { confirm: PROBE_CONFIRM } }),
    BASE_ENV,
    deps
  );
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(second.body.reason, "already_executed");
  assert.equal(runs, 1);
});

test("concurrent POST attempts: only one runProbe executes", async () => {
  let puts = 0;
  const blobPutFn = async () => {
    puts += 1;
    // Simulate atomic create-only: first writer wins.
    if (puts === 1) return { pathname: buildOnceLockPathname(COMMIT_SHA) };
    const err = new Error("already exists");
    err.name = "BlobError";
    throw err;
  };

  let runs = 0;
  const deps = {
    claimHttpExecutionOnce: (args) => claimHttpExecutionOnce({ ...args, blobPutFn }),
    runProbe: async () => {
      runs += 1;
      // Small delay so the loser can contend during the winner's run window.
      await new Promise((r) => setTimeout(r, 20));
      return {
        stopped: false,
        stop_reason: "completed",
        run_id: "20261014T000000Z-abc123",
        pathname_prefix: "probe/cas-verify/20261014T000000Z-abc123/",
        results: CRITICAL_TRUE,
      };
    },
  };

  const settled = await Promise.all([
    handleProbeHttp(req("POST", { body: { confirm: PROBE_CONFIRM } }), BASE_ENV, deps),
    handleProbeHttp(req("POST", { body: { confirm: PROBE_CONFIRM } }), BASE_ENV, deps),
    handleProbeHttp(req("POST", { body: { confirm: PROBE_CONFIRM } }), BASE_ENV, deps),
  ]);

  const statuses = settled.map((s) => s.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409, 409]);
  assert.equal(runs, 1);
  assert.equal(puts, 3);
  for (const s of settled) assertNoSensitiveLeak(s.body);
});

test("unauthorized POST never reaches claim or runProbe", async () => {
  let claimed = 0;
  let called = 0;
  const { status } = await handleProbeHttp(
    req("POST", { auth: "Bearer totally-wrong-secret!!", body: { confirm: PROBE_CONFIRM } }),
    BASE_ENV,
    {
      claimHttpExecutionOnce: async () => {
        claimed += 1;
        return { ok: true, reason: "claimed" };
      },
      runProbe: async () => {
        called += 1;
        return { stopped: false, results: {} };
      },
    }
  );
  assert.equal(claimed, 0);
  assert.equal(called, 0);
  assert.equal(status, 401);
});

test("failed authorization / wrong branch / wrong commit never claim", async () => {
  let claimed = 0;
  const deps = {
    claimHttpExecutionOnce: async () => {
      claimed += 1;
      return { ok: true, reason: "claimed" };
    },
    runProbe: async () => ({ stopped: false, results: CRITICAL_TRUE }),
  };

  const unauthorized = await handleProbeHttp(
    req("POST", { auth: "Bearer xxxxxxxxxxxxxxxx", body: { confirm: PROBE_CONFIRM } }),
    BASE_ENV,
    deps
  );
  const wrongBranch = await handleProbeHttp(
    req("POST", { body: { confirm: PROBE_CONFIRM } }),
    { ...BASE_ENV, VERCEL_GIT_COMMIT_REF: "main" },
    deps
  );
  const wrongSha = await handleProbeHttp(
    req("POST", { body: { confirm: PROBE_CONFIRM } }),
    { ...BASE_ENV, VERCEL_GIT_COMMIT_SHA: OTHER_SHA },
    deps
  );
  const disabled = await handleProbeHttp(
    req("POST", { body: { confirm: PROBE_CONFIRM } }),
    { ...BASE_ENV, PROBE_PRIVATE_CAS: "0" },
    deps
  );
  const production = await handleProbeHttp(
    req("POST", { body: { confirm: PROBE_CONFIRM } }),
    { ...BASE_ENV, VERCEL_ENV: "production" },
    deps
  );

  assert.equal(unauthorized.status, 401);
  assert.equal(wrongBranch.status, 409);
  assert.equal(wrongSha.status, 409);
  assert.equal(disabled.status, 404);
  assert.equal(production.status, 404);
  assert.equal(claimed, 0);
});

test("sanitizePublicBody strips tokens, ETags, auth headers, and private bodies", () => {
  const cleaned = sanitizePublicBody({
    ok: true,
    mode: "run",
    reason: "completed",
    stop_reason: "completed",
    run_id: "20261014T000000Z-abc123",
    pathname_prefix: "probe/cas-verify/20261014T000000Z-abc123/",
    authorization: `Bearer ${SECRET}`,
    etag: '"deadbeefdeadbeefdeadbeef"',
    body: { lessons: [1, 2, 3] },
    token: "vercel_blob_rw_privStore_privsecret",
    results: {
      probe_completed: true,
      etag_a_ne_a2: true,
      leaked_etag: '"deadbeefdeadbeef"',
      leaked_token: "vercel_blob_rw_x",
      exception_name: "BlobPreconditionFailedError",
    },
  });
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.results.probe_completed, true);
  assert.equal(cleaned.results.etag_a_ne_a2, true);
  assert.equal(cleaned.results.exception_name, "BlobPreconditionFailedError");
  assert.equal("authorization" in cleaned, false);
  assert.equal("etag" in cleaned, false);
  assert.equal("body" in cleaned, false);
  assert.equal("token" in cleaned, false);
  assert.equal("leaked_etag" in cleaned.results, false);
  assert.equal("leaked_token" in cleaned.results, false);
  assertNoSensitiveLeak(cleaned, ["deadbeef", "lessons"]);
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
  assert.match(src, /PROBE_PREVIEW_GIT_SHA/);
  assert.equal(src.includes("lessons.json"), false);
  assert.equal(src.includes("holds.json"), false);
  assert.equal(/console\.(log|info|debug)\(/.test(src), false);
});

test("http gate responses never echo the bearer secret", () => {
  const g = evaluateHttpGates(req("GET", { auth: `Bearer ${SECRET}` }), BASE_ENV);
  assertNoSensitiveLeak(g);
});

test("repo has no GitHub workflow that auto-merges or deploys Production", () => {
  const dir = path.resolve(".github/workflows");
  if (!existsSync(dir)) {
    assert.equal(existsSync(dir), false);
    return;
  }
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f));
  for (const file of files) {
    const src = readFileSync(path.join(dir, file), "utf8").toLowerCase();
    assert.equal(src.includes("auto-merge"), false, file);
    assert.equal(src.includes("gh pr merge"), false, file);
    assert.equal(/vercel\s+deploy\s+--prod/.test(src), false, file);
  }
});
