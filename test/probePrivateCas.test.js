// Local mock tests for scripts/probe-private-cas.mjs safety gates.
// Does NOT call live Vercel Blob.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  FORBIDDEN_PATHNAMES,
  PATHNAME_RE,
  storeIdFromToken,
  isWellFormedStoreId,
  buildRunId,
  buildPathname,
  assertPathnameSafe,
  preflight,
  runProbe,
  allCriticalPassed,
} from "../scripts/probe-private-cas.mjs";

const PREV = { ...process.env };

const VALID_ENV = {
  PROBE_PRIVATE_CAS: "1",
  VERCEL_ENV: "preview",
  PRIVATE_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_privStore_privsecret",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_pubStorexx_pubsecret",
  PROBE_PREVIEW_PRIVATE_STORE_ID: "privStore",
};

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (
      k.startsWith("PROBE_") ||
      k === "VERCEL_ENV" ||
      k === "PRIVATE_BLOB_READ_WRITE_TOKEN" ||
      k === "BLOB_READ_WRITE_TOKEN"
    ) {
      delete process.env[k];
    }
  }
});

afterEach(() => {
  for (const k of [
    "PROBE_PRIVATE_CAS",
    "PROBE_ALLOW_LOCAL",
    "PROBE_PREVIEW_PRIVATE_STORE_ID",
    "VERCEL_ENV",
    "PRIVATE_BLOB_READ_WRITE_TOKEN",
    "BLOB_READ_WRITE_TOKEN",
  ]) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
});

function mockBlob({
  etags = ['"e1"', '"e2"', '"e3"', '"e4"'],
  bodies = {},
  staleShouldReject = true,
} = {}) {
  let etagSeq = 0;
  let currentEtag = "";
  let currentBody = null;
  const pathnames = new Set();
  const accesses = new Set();
  const tokens = new Set();

  class BlobPreconditionFailedError extends Error {
    constructor() {
      super("Precondition failed: ETag mismatch.");
      this.name = "BlobPreconditionFailedError";
    }
  }

  return {
    BlobPreconditionFailedError,
    pathnames,
    accesses,
    tokens,
    async put(pathname, body, opts) {
      pathnames.add(pathname);
      accesses.add(opts.access);
      tokens.add(opts.token);
      assert.equal(opts.access, "private");
      assert.equal(opts.addRandomSuffix, false);
      if (opts.ifMatch) {
        if (opts.ifMatch !== currentEtag) {
          if (staleShouldReject) throw new BlobPreconditionFailedError();
          currentBody = body;
          return { pathname };
        }
      }
      currentBody = body;
      currentEtag = etags[Math.min(etagSeq, etags.length - 1)];
      etagSeq += 1;
      return { pathname, etag: currentEtag };
    },
    async get(pathname, opts) {
      pathnames.add(pathname);
      accesses.add(opts.access);
      tokens.add(opts.token);
      assert.equal(opts.access, "private");
      assert.equal(opts.useCache, false);
      if (bodies[pathname] !== undefined) {
        return {
          statusCode: 200,
          stream: new Response(bodies[pathname]).body,
        };
      }
      return {
        statusCode: 200,
        stream: new Response(currentBody ?? JSON.stringify({ v: "?" })).body,
      };
    },
    async head(pathname, opts) {
      pathnames.add(pathname);
      tokens.add(opts.token);
      return { etag: currentEtag, pathname };
    },
  };
}

test("pathname pattern accepts only disposable probe paths", () => {
  assert.equal(PATHNAME_RE.test("probe/cas-verify/run1/object.json"), true);
  assert.equal(PATHNAME_RE.test("lessons.json"), false);
  assert.equal(assertPathnameSafe("lessons.json").ok, false);
  assert.equal(assertPathnameSafe("probe/cas-verify/../lessons.json/object.json").ok, false);
  for (const name of FORBIDDEN_PATHNAMES) {
    assert.equal(assertPathnameSafe(name).ok, false);
  }
  const ok = assertPathnameSafe(buildPathname(buildRunId(new Date("2026-10-14T01:00:00.000Z"), "abc123")));
  assert.equal(ok.ok, true);
});

test("storeIdFromToken and isWellFormedStoreId validate without exposing secrets", () => {
  assert.equal(storeIdFromToken("vercel_blob_rw_storeABC_secretVALUE"), "storeABC");
  assert.equal(storeIdFromToken(""), "");
  assert.equal(storeIdFromToken("not-a-token"), "");
  assert.equal(isWellFormedStoreId("storeABC"), true);
  assert.equal(isWellFormedStoreId("ab"), false);
  assert.equal(isWellFormedStoreId("bad id"), false);
  assert.equal(isWellFormedStoreId(""), false);
});

test("preflight requires PROBE_PRIVATE_CAS=1", () => {
  const r = preflight({
    ...VALID_ENV,
    PROBE_PRIVATE_CAS: undefined,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "probe_flag_required");
});

test("preflight hard-stops in production", () => {
  const r = preflight({
    ...VALID_ENV,
    VERCEL_ENV: "production",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "production_blocked");
  assert.equal(r.results.production_blocked, true);
});

test("preflight rejects non-preview environments including empty and development", () => {
  for (const envName of ["", "development", "test", "staging"]) {
    const r = preflight({
      ...VALID_ENV,
      VERCEL_ENV: envName,
    });
    assert.equal(r.ok, false, `expected block for VERCEL_ENV=${JSON.stringify(envName)}`);
    assert.equal(r.reason, envName === "production" ? "production_blocked" : "env_blocked");
  }
});

test("PROBE_ALLOW_LOCAL no longer bypasses Preview requirement", () => {
  const r = preflight({
    ...VALID_ENV,
    VERCEL_ENV: "development",
    PROBE_ALLOW_LOCAL: "1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "env_blocked");
});

test("preflight requires both tokens", () => {
  const missingPriv = preflight({
    ...VALID_ENV,
    PRIVATE_BLOB_READ_WRITE_TOKEN: "",
  });
  assert.equal(missingPriv.ok, false);
  assert.equal(missingPriv.reason, "missing_private_token");

  const missingPub = preflight({
    ...VALID_ENV,
    BLOB_READ_WRITE_TOKEN: "",
  });
  assert.equal(missingPub.ok, false);
  assert.equal(missingPub.reason, "missing_public_token");
});

test("preflight rejects malformed store IDs", () => {
  const badPriv = preflight({
    ...VALID_ENV,
    PRIVATE_BLOB_READ_WRITE_TOKEN: "not-a-valid-token",
    PROBE_PREVIEW_PRIVATE_STORE_ID: "privStore",
  });
  assert.equal(badPriv.ok, false);
  assert.equal(badPriv.reason, "private_store_id_malformed");

  const badPub = preflight({
    ...VALID_ENV,
    BLOB_READ_WRITE_TOKEN: "also-bad",
  });
  assert.equal(badPub.ok, false);
  assert.equal(badPub.reason, "public_store_id_malformed");
});

test("preflight blocks identical public and private store ids", () => {
  const r = preflight({
    ...VALID_ENV,
    PRIVATE_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_sameStore_privsecret",
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_sameStore_pubsecret",
    PROBE_PREVIEW_PRIVATE_STORE_ID: "sameStore",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "shared_store_blocked");
  assert.equal(r.results.stores_isolated, false);
});

test("preflight requires Preview private store allowlist", () => {
  const missing = preflight({
    ...VALID_ENV,
    PROBE_PREVIEW_PRIVATE_STORE_ID: "",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing_preview_store_allowlist");
  assert.equal(missing.results.preview_allowlist_present, false);

  const malformed = preflight({
    ...VALID_ENV,
    PROBE_PREVIEW_PRIVATE_STORE_ID: "x",
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "preview_store_allowlist_malformed");
});

test("preflight rejects mismatched Preview private store allowlist", () => {
  const r = preflight({
    ...VALID_ENV,
    PROBE_PREVIEW_PRIVATE_STORE_ID: "otherStore",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "preview_store_allowlist_mismatch");
  assert.equal(r.results.preview_store_allowlist_matched, false);
  // Never leak store ids in the report object.
  const dumped = JSON.stringify(r);
  assert.equal(dumped.includes("privStore"), false);
  assert.equal(dumped.includes("otherStore"), false);
  assert.equal(dumped.includes("privsecret"), false);
});

test("preflight accepts isolated preview tokens with matching allowlist", () => {
  const r = preflight(VALID_ENV);
  assert.equal(r.ok, true);
  assert.equal(r.results.env_ok, true);
  assert.equal(r.results.stores_isolated, true);
  assert.equal(r.results.preview_store_allowlist_matched, true);
  const dumped = JSON.stringify(r);
  assert.equal(dumped.includes("privStore"), false);
  assert.equal(dumped.includes("pubStorexx"), false);
});

test("runProbe happy path with mocked private Blob", async () => {
  const blob = mockBlob({ etags: ['"a"', '"b"', '"a2"', '"c"'] });
  const report = await runProbe({
    env: VALID_ENV,
    blobApi: blob,
    runId: "20261014T010000Z-test01",
  });

  assert.equal(report.stopped, false);
  assert.equal(report.results.probe_completed, true);
  assert.equal(allCriticalPassed(report.results), true);
  assert.equal(report.pathname_prefix, "probe/cas-verify/20261014T010000Z-test01/");
  assert.ok([...blob.pathnames].every((p) => p === "probe/cas-verify/20261014T010000Z-test01/object.json"));
  assert.deepEqual([...blob.accesses], ["private"]);
  assert.ok([...blob.tokens].every((t) => t === VALID_ENV.PRIVATE_BLOB_READ_WRITE_TOKEN));
  const dumped = JSON.stringify(report);
  assert.equal(dumped.includes('"a"'), false);
  assert.equal(dumped.includes("STALE"), false);
  assert.equal(dumped.includes("privStore"), false);
});

test("runProbe stops immediately if stale ifMatch unexpectedly succeeds", async () => {
  const blob = mockBlob({ etags: ['"a"', '"b"', '"a2"'], staleShouldReject: false });
  const report = await runProbe({
    env: VALID_ENV,
    blobApi: blob,
    runId: "20261014T010000Z-stale",
  });
  assert.equal(report.stopped, true);
  assert.equal(report.stop_reason, "stale_ifmatch_unexpected_success");
  assert.equal(report.results.cas_integrity_failure, true);
  assert.equal(report.results.probe_completed, false);
});

test("runProbe does not call Blob when preflight fails", async () => {
  let putCalls = 0;
  const blob = {
    BlobPreconditionFailedError: class extends Error {},
    put: async () => {
      putCalls += 1;
    },
    get: async () => null,
    head: async () => ({}),
  };
  const report = await runProbe({
    env: { VERCEL_ENV: "preview" },
    blobApi: blob,
    runId: "nope",
  });
  assert.equal(report.stopped, true);
  assert.equal(report.stop_reason, "probe_flag_required");
  assert.equal(putCalls, 0);
});

test("CLI without PROBE_PRIVATE_CAS=1 exits without running probe body", () => {
  const script = path.resolve("scripts/probe-private-cas.mjs");
  const result = spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      PROBE_PRIVATE_CAS: "",
      VERCEL_ENV: "preview",
      PRIVATE_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_privStore_x",
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_pubStorexx_y",
      PROBE_PREVIEW_PRIVATE_STORE_ID: "privStore",
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  const err = JSON.parse(result.stderr.trim().split("\n").pop());
  assert.equal(err.reason, "probe_flag_required");
});

test("importing the module does not execute the live probe", async () => {
  assert.equal(process.env.PROBE_PRIVATE_CAS, undefined);
  const mod = await import(`../scripts/probe-private-cas.mjs?cacheBust=${Date.now()}`);
  assert.equal(typeof mod.runProbe, "function");
  assert.equal(typeof mod.preflight, "function");
});
