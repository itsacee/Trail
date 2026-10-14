// Persistence backed by Vercel Blob (dual-store successor to PR #63).
//
// Built on production main 26a6dab — preserves:
//   PR #64 — public capacity reads + withSafeConditional until verified cutover
//   PR #65 — confirm/webhook fail-closed (unchanged outside this module)
//   CAPACITY_WRITES_ENABLED — default OFF in deployed envs
//
// Public store (existing):
//   BLOB_READ_WRITE_TOKEN  — read/write token
//   AVAILABILITY_URL       — public URL of availability.json
//   AVAILABILITY_BLOB_PATH  — pathname to write (default "availability.json")
//
// Private capacity store (new — holds / lessons / manual-bookings after cutover):
//   PRIVATE_BLOB_READ_WRITE_TOKEN — read/write token for a PRIVATE Blob store
//   CAPACITY_BLOB_CUTOVER=1       — hard switch after verified migration
//   CAPACITY_MIGRATION_PAUSE=1    — pause capacity WRITES during cutover
//   CAPACITY_ALLOW_SHARED_STORE=1 — allow preview to share private store id
//                                   with public store id (discouraged; off)
//   CAPACITY_WRITES_ENABLED=1     — allow holds/lessons/manual CAS writes
//
// Pre-cutover: capacity READS stay on the public store (calendar recovery).
// Post-cutover: capacity READS/WRITES use the private store (origin, no CDN).
// Capacity files never auto-migrate on booking reads.

import { BlobPreconditionFailedError, get, head, put } from "@vercel/blob";

const BLOB_API = "https://blob.vercel-storage.com";

export const CAPACITY_FILES = new Set(["holds.json", "lessons.json", "manual-bookings.json"]);
export const CUTOVER_MARKER = "capacity-cutover.json";

export class StorageUnavailableError extends Error {
  constructor(message = "Booking storage is temporarily unavailable.") {
    super(message);
    this.name = "StorageUnavailableError";
    this.code = "schedule_unavailable";
  }
}

// In-process Blob stand-in for concurrency tests (BLOB_MEMORY_STORE=1).
const memoryBlobs = new Map();
let memoryEtagSeq = 0;

function memoryEnabled() {
  return process.env.BLOB_MEMORY_STORE === "1";
}

function nextMemoryEtag() {
  memoryEtagSeq += 1;
  return `W/"mem-${memoryEtagSeq}-${Date.now().toString(36)}"`;
}

export function clearMemoryBlobStore() {
  memoryBlobs.clear();
  memoryEtagSeq = 0;
}

export function useMemoryBlobStore(enabled = true) {
  if (enabled) {
    process.env.BLOB_MEMORY_STORE = "1";
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_mempublic_test";
    }
    if (!process.env.PRIVATE_BLOB_READ_WRITE_TOKEN) {
      process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_memprivate_test";
    }
    if (!process.env.AVAILABILITY_URL) {
      process.env.AVAILABILITY_URL = "https://public.example/availability.json";
    }
    // Memory booking tests operate post-cutover against the private map unless
    // a test explicitly clears CAPACITY_BLOB_CUTOVER.
    process.env.CAPACITY_BLOB_CUTOVER = process.env.CAPACITY_BLOB_CUTOVER || "1";
    // Tests exercise CAS writes; production keeps mutations paused by default.
    process.env.CAPACITY_WRITES_ENABLED = process.env.CAPACITY_WRITES_ENABLED || "1";
    clearMemoryBlobStore();
  } else {
    delete process.env.BLOB_MEMORY_STORE;
    clearMemoryBlobStore();
  }
}

/** Public store configured (availability / settings / members / finance). */
export function storeConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.AVAILABILITY_URL) || memoryEnabled();
}

/** Private capacity store configured (holds / lessons / manual-bookings). */
export function capacityStoreConfigured() {
  return Boolean(process.env.PRIVATE_BLOB_READ_WRITE_TOKEN) || memoryEnabled();
}

/** Capacity CAS writes (holds / lessons / manual). Off unless explicitly enabled. */
export function capacityWritesEnabled() {
  if (memoryEnabled()) return process.env.CAPACITY_WRITES_ENABLED !== "0";
  return process.env.CAPACITY_WRITES_ENABLED === "1";
}

export function capacityMigrationPaused() {
  return process.env.CAPACITY_MIGRATION_PAUSE === "1";
}

export function capacityCutoverForced() {
  return process.env.CAPACITY_BLOB_CUTOVER === "1";
}

/** @param {string} filename */
export function isCapacityFile(filename) {
  return CAPACITY_FILES.has(filename);
}

/**
 * Access mode for SDK calls.
 * Pre-cutover capacity stays public (PR #64 recovery). Post-cutover → private.
 */
export function blobAccessFor(filename) {
  if (!isCapacityFile(filename)) return "public";
  if (capacityCutoverForced()) return "private";
  return "public";
}

/** Extract store id from a vercel_blob_rw_* token (no secrets logged). */
export function storeIdFromToken(token) {
  if (!token || typeof token !== "string") return "";
  const parts = token.split("_");
  // vercel_blob_rw_<storeId>_<secret…>
  return parts.length >= 4 ? parts[3] : "";
}

export function publicStoreId() {
  return storeIdFromToken(process.env.BLOB_READ_WRITE_TOKEN || "");
}

export function privateStoreId() {
  return storeIdFromToken(process.env.PRIVATE_BLOB_READ_WRITE_TOKEN || "");
}

/**
 * Preview must not silently share the production private store.
 * Returns { ok, reason } — never includes token values.
 */
export function previewCapacityIsolationOk() {
  if (process.env.CAPACITY_ALLOW_SHARED_STORE === "1") {
    return { ok: true, reason: "shared_store_explicitly_allowed" };
  }
  const env = String(process.env.VERCEL_ENV || "");
  if (env !== "preview") return { ok: true, reason: "not_preview" };
  if (!capacityStoreConfigured()) {
    return { ok: false, reason: "missing_private_token" };
  }
  const pub = publicStoreId();
  const priv = privateStoreId();
  if (pub && priv && pub === priv) {
    return { ok: false, reason: "private_token_matches_public_store" };
  }
  return { ok: true, reason: "isolated_or_unparsed" };
}

function publicToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}

function privateToken() {
  return process.env.PRIVATE_BLOB_READ_WRITE_TOKEN || "";
}

function publicUrlFor(filename) {
  const base = process.env.AVAILABILITY_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/[^/]+$/, filename);
    return url.toString();
  } catch {
    return null;
  }
}

async function streamToText(stream) {
  return new Response(stream).text();
}

/** ETag from a single get() result only — never pair across requests. */
export function etagFromGetResult(result) {
  if (!result || result.statusCode !== 200) return "";
  const fromBlob = String(result.blob?.etag || "");
  if (fromBlob) return fromBlob;
  try {
    return String(result.headers?.get?.("etag") || "");
  } catch {
    return "";
  }
}

async function readSdkBlob(filename, { access, token, useCache = true } = {}) {
  const result = await get(filename, { access, token, useCache });
  if (!(result && result.statusCode === 200 && result.stream)) {
    return null;
  }
  return {
    text: await streamToText(result.stream),
    etag: etagFromGetResult(result),
    url: result.blob.url || "",
  };
}

/** Safe ops log for capacity CAS — filename + reason codes only; never tokens, ETags, or bodies. */
function capacityDiag(kind, detail = {}) {
  const file = typeof detail.file === "string" ? detail.file : "";
  const reason = typeof detail.reason === "string" ? detail.reason : "";
  const bits = [`capacity_cas:${kind}`];
  if (file) bits.push(`file=${file}`);
  if (reason) bits.push(`reason=${reason}`);
  console.error(bits.join(" "));
}

/** Blob API / test-hook head ETag only — never logged; never paired without get agreement. */
async function privateHeadEtag(filename, token) {
  if (privateHeadForTests) {
    const meta = await privateHeadForTests(filename, { token });
    return typeof meta === "string" ? String(meta || "") : String(meta?.etag || "");
  }
  if (memoryEnabled()) {
    // Memory store is a single version map: head agrees with get by construction.
    const entry = memoryBlobs.get(filename);
    return String(entry?.etag || "");
  }
  const meta = await head(filename, { token });
  return String(meta?.etag || "");
}

/** Bounded head→get→head attempts when the object changes during the read window. */
export const PRIVATE_CAPACITY_BOOKEND_ATTEMPTS = 3;

/**
 * Version-consistent private capacity read for CAS (head-bookended).
 *
 * Live private Blob exposes two ETag channels:
 *   - get() download ETag (HTTP ETag on the blob URL) — NOT accepted by put(ifMatch)
 *   - head()/put() Blob-API object ETag — the token put(ifMatch) / x-if-match uses
 *
 * Requiring get.etag === head.etag therefore fail-closes every paid mirror on
 * Preview (get_head_etag_mismatch) even when the object is stable. Vercel's own
 * CAS examples use head().etag for ifMatch.
 *
 * Safe pairing without trusting the download ETag:
 *   1. H1 = head() API ETag
 *   2. body = get(useCache:false)  (download ETag ignored for CAS)
 *   3. H2 = head() API ETag
 *   4. Conditional writes only when H1 and H2 are non-empty and equal
 *
 * H1 !== H2 means a concurrent writer raced the read window — retry, then fail
 * closed (readable, not CAS-safe). Never pair a body with a single unpaired
 * head() ETag. Never unconditionally overwrite existing capacity JSON.
 */
async function readPrivateCapacityConsistent(filename, token, getter) {
  let lastText = null;

  for (let attempt = 0; attempt < PRIVATE_CAPACITY_BOOKEND_ATTEMPTS; attempt++) {
    let headBefore = "";
    let headBeforeFailed = false;
    try {
      headBefore = await privateHeadEtag(filename, token);
    } catch {
      headBeforeFailed = true;
    }

    let got;
    try {
      got = await getter();
    } catch {
      capacityDiag("blob_read_failed", { file: filename, reason: "get_failed" });
      return { text: lastText, etag: "", conditional: false, unreachable: true };
    }

    if (!got) {
      // Missing object: allow first create only when head also sees absence.
      if (headBeforeFailed || !headBefore) {
        return { text: null, etag: "", conditional: false, unreachable: false };
      }
      // head saw a version but get missed — race; retry bookend.
      capacityDiag("head_bookend_mismatch", {
        file: filename,
        reason: "head_present_get_missing",
      });
      continue;
    }

    lastText = got.text;

    if (headBeforeFailed) {
      // Body exists but head is unreachable — readable, not CAS-safe.
      capacityDiag("blob_read_failed", { file: filename, reason: "head_failed" });
      return { text: got.text, etag: "", conditional: false, unreachable: false };
    }

    if (!headBefore) {
      capacityDiag("missing_etag", { file: filename, reason: "head_without_etag" });
      return { text: got.text, etag: "", conditional: false, unreachable: false };
    }

    let headAfter = "";
    try {
      headAfter = await privateHeadEtag(filename, token);
    } catch {
      capacityDiag("blob_read_failed", { file: filename, reason: "head_failed" });
      return { text: got.text, etag: "", conditional: false, unreachable: false };
    }

    if (!headAfter) {
      capacityDiag("missing_etag", { file: filename, reason: "head_without_etag" });
      return { text: got.text, etag: "", conditional: false, unreachable: false };
    }

    if (headBefore !== headAfter) {
      capacityDiag("head_bookend_mismatch", {
        file: filename,
        reason: "head_changed_during_read",
      });
      continue;
    }

    // Stable API version token from head(); body from the bookended get().
    // Download ETag on get() is intentionally ignored for ifMatch.
    return {
      text: got.text,
      etag: headBefore,
      conditional: true,
      unreachable: false,
    };
  }

  capacityDiag("head_bookend_mismatch", {
    file: filename,
    reason: "bookend_attempts_exhausted",
  });
  return { text: lastText, etag: "", conditional: false, unreachable: false };
}

/**
 * Public CDN etags are not always safe for ifMatch. Prefer head() origin etag
 * and only mark conditional when it matches the body we read.
 * Always return the body when present so calendars recover even if CDN is stale.
 */
async function withSafeConditional(pub) {
  if (pub?.text == null) {
    return { text: null, etag: "", conditional: false, unreachable: false };
  }
  if (!pub.etag) {
    return { text: pub.text, etag: "", conditional: false, unreachable: false };
  }
  try {
    const meta = await head(pub.url || undefined);
    const origin = meta?.etag || "";
    if (origin && origin === pub.etag) {
      return { text: pub.text, etag: origin, conditional: true, unreachable: false };
    }
  } catch {
    /* head unavailable — readable but not CAS-safe */
  }
  return { text: pub.text, etag: "", conditional: false, unreachable: false };
}

/** Read a public-store capacity file for migration tooling (and pre-cutover reads). */
export async function readPublicCapacitySnapshot(filename) {
  if (!isCapacityFile(filename)) {
    throw new Error(`${filename} is not a capacity file`);
  }
  if (memoryEnabled()) {
    const entry = memoryBlobs.get(`public:${filename}`);
    if (!entry) return { text: null, etag: "", found: false };
    return { text: entry.body, etag: entry.etag, found: true };
  }
  const token = publicToken();
  if (!token) return { text: null, etag: "", found: false, error: "missing_public_token" };
  try {
    const got = await readSdkBlob(filename, { access: "public", token, useCache: true });
    if (got) return { text: got.text, etag: got.etag, found: true, url: got.url };
  } catch (error) {
    return { text: null, etag: "", found: false, error: error?.message || "public_read_failed" };
  }
  const url = publicUrlFor(filename);
  if (!url) return { text: null, etag: "", found: false };
  try {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return { text: null, etag: "", found: false };
    return { text: await r.text(), etag: "", found: true, url };
  } catch (error) {
    return { text: null, etag: "", found: false, error: error?.message || "public_url_failed" };
  }
}

/** Seed a public-store capacity snapshot in memory tests (migration / pre-cutover). */
export function seedMemoryPublicCapacity(filename, value) {
  if (!memoryEnabled()) throw new Error("memory store disabled");
  const body = typeof value === "string" ? value : JSON.stringify(value);
  memoryBlobs.set(`public:${filename}`, { body, etag: nextMemoryEtag() });
}

/** Seed a private capacity file in memory tests (optional empty etag for fail-closed paths). */
export function seedMemoryPrivateCapacity(filename, value, { etag } = {}) {
  if (!memoryEnabled()) throw new Error("memory store disabled");
  if (!isCapacityFile(filename)) throw new Error(`${filename} is not a capacity file`);
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const tag = etag === undefined ? nextMemoryEtag() : String(etag || "");
  memoryBlobs.set(filename, { body, etag: tag });
}

/** Test-only private head() stand-in for head-bookend CAS tests. */
let privateHeadForTests = null;
export function setPrivateHeadForTests(fn) {
  privateHeadForTests = typeof fn === "function" ? fn : null;
}

/**
 * Test-only private get() sequence. Each call should return { text, etag } or null.
 * Production uses the real SDK get() and never installs this hook.
 */
let privateGetForTests = null;
export function setPrivateGetForTests(fn) {
  privateGetForTests = typeof fn === "function" ? fn : null;
}

/**
 * Test-only put stand-in. When set, runs after memory CAS prechecks (or instead of
 * SDK put) so tests can simulate BlobPreconditionFailedError without live Blob.
 */
let privatePutForTests = null;
export function setPrivatePutForTests(fn) {
  privatePutForTests = typeof fn === "function" ? fn : null;
}

let cutoverCache = { at: 0, value: null };

export function clearCutoverCache() {
  cutoverCache = { at: 0, value: null };
}

export async function readCutoverMarker() {
  if (capacityCutoverForced()) {
    return { active: true, source: "env" };
  }
  if (memoryEnabled()) {
    const entry = memoryBlobs.get(CUTOVER_MARKER);
    if (!entry) return { active: false, source: "missing" };
    try {
      const parsed = JSON.parse(entry.body) || {};
      return { active: parsed.active !== false, source: "marker", ...parsed };
    } catch {
      return { active: true, source: "marker" };
    }
  }
  const now = Date.now();
  if (cutoverCache.value && now - cutoverCache.at < 5000) return cutoverCache.value;
  const token = privateToken();
  if (!token) {
    const miss = { active: false, source: "missing_private_token" };
    cutoverCache = { at: now, value: miss };
    return miss;
  }
  try {
    const got = await readSdkBlob(CUTOVER_MARKER, {
      access: "private",
      token,
      useCache: false,
    });
    if (!got) {
      const miss = { active: false, source: "missing" };
      cutoverCache = { at: now, value: miss };
      return miss;
    }
    let parsed = {};
    try {
      parsed = JSON.parse(got.text) || {};
    } catch {
      parsed = {};
    }
    const active = parsed.active !== false;
    const hit = { active, source: "marker", etag: got.etag, ...parsed };
    cutoverCache = { at: now, value: hit };
    return hit;
  } catch {
    const miss = { active: false, source: "error" };
    cutoverCache = { at: now, value: miss };
    return miss;
  }
}

export async function writeCutoverMarker(payload) {
  const body = JSON.stringify({
    cutoverAt: new Date().toISOString(),
    ...payload,
  });
  if (memoryEnabled()) {
    memoryBlobs.set(CUTOVER_MARKER, { body, etag: nextMemoryEtag() });
    clearCutoverCache();
    return { ok: true };
  }
  const token = privateToken();
  if (!token) return { ok: false, error: "missing_private_token" };
  try {
    await put(CUTOVER_MARKER, body, {
      access: "private",
      token,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
    });
    clearCutoverCache();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || "cutover_write_failed" };
  }
}

export async function clearCutoverMarker() {
  if (memoryEnabled()) {
    memoryBlobs.delete(CUTOVER_MARKER);
    clearCutoverCache();
    return { ok: true };
  }
  return writeCutoverMarker({ active: false, rolledBackAt: new Date().toISOString() });
}

export async function blobRead(filename) {
  return (await blobReadVersioned(filename)).text;
}

export async function blobReadVersioned(filename) {
  if (!isCapacityFile(filename)) {
    return readPublicVersioned(filename);
  }
  return readCapacityVersioned(filename);
}

/** Pre-cutover: public + safe conditional. Post-cutover: private origin. */
async function readCapacityVersioned(filename) {
  const cutover = await readCutoverMarker();

  if (!cutover.active) {
    // PR #64 path — keep calendars readable from the public store.
    return readPublicCapacityVersioned(filename);
  }

  // Post-cutover private path.
  const isolation = previewCapacityIsolationOk();
  if (!isolation.ok) {
    capacityDiag("isolation_failed", { file: filename, reason: isolation.reason || "unknown" });
    return { text: null, etag: "", conditional: false, unreachable: true };
  }

  if (memoryEnabled()) {
    const token = privateToken() || "memory";
    return readPrivateCapacityConsistent(filename, token, async () => {
      if (privateGetForTests) {
        return privateGetForTests(filename, memoryBlobs.get(filename) || null);
      }
      const entry = memoryBlobs.get(filename);
      if (!entry) return null;
      return { text: entry.body, etag: entry.etag || "" };
    });
  }

  const token = privateToken();
  if (!token) {
    capacityDiag("isolation_failed", { file: filename, reason: "missing_private_token" });
    return { text: null, etag: "", conditional: false, unreachable: true };
  }

  try {
    return await readPrivateCapacityConsistent(filename, token, async () => {
      if (privateGetForTests) {
        return privateGetForTests(filename, null);
      }
      return readSdkBlob(filename, {
        access: "private",
        token,
        useCache: false,
      });
    });
  } catch {
    capacityDiag("blob_read_failed", { file: filename });
    return { text: null, etag: "", conditional: false, unreachable: true };
  }
}

async function readPublicCapacityVersioned(filename) {
  if (memoryEnabled()) {
    // Prefer private map only when cutover env forced in same process — handled
    // upstream. Pre-cutover memory uses public: prefix.
    const pub = memoryBlobs.get(`public:${filename}`);
    if (pub) {
      return {
        text: pub.body,
        etag: pub.etag,
        conditional: Boolean(pub.etag),
        unreachable: false,
      };
    }
    // Also accept unprefixed keys for older tests that seed capacity directly
    // before cutover is cleared.
    const entry = memoryBlobs.get(filename);
    if (!entry) {
      return { text: null, etag: "", conditional: false, unreachable: false };
    }
    return {
      text: entry.body,
      etag: entry.etag,
      conditional: Boolean(entry.etag),
      unreachable: false,
    };
  }

  let contacted = false;
  const token = publicToken();
  if (token) {
    try {
      const pub = await readSdkBlob(filename, { access: "public", token, useCache: true });
      contacted = true;
      if (pub) return withSafeConditional(pub);
    } catch {
      /* fall through */
    }
  }

  const url = publicUrlFor(filename);
  if (!url) {
    return {
      text: null,
      etag: "",
      conditional: false,
      unreachable: Boolean(token) && !contacted,
    };
  }
  try {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    contacted = true;
    if (!r.ok) {
      return { text: null, etag: "", conditional: false, unreachable: false };
    }
    return { text: await r.text(), etag: "", conditional: false, unreachable: false };
  } catch {
    return { text: null, etag: "", conditional: false, unreachable: !contacted };
  }
}

async function readPublicVersioned(filename) {
  if (memoryEnabled()) {
    const entry = memoryBlobs.get(filename);
    if (!entry) return { text: null, etag: "", conditional: false, unreachable: false };
    return {
      text: entry.body,
      etag: entry.etag,
      conditional: Boolean(entry.etag),
      unreachable: false,
    };
  }

  let contacted = false;
  const token = publicToken();
  if (token) {
    try {
      const result = await readSdkBlob(filename, {
        access: "public",
        token,
        useCache: true,
      });
      contacted = true;
      if (result) {
        return {
          text: result.text,
          etag: result.etag,
          conditional: Boolean(result.etag),
          unreachable: false,
        };
      }
    } catch {
      /* fall through */
    }
  }

  const url = publicUrlFor(filename);
  if (!url) {
    return { text: null, etag: "", conditional: false, unreachable: Boolean(token) && !contacted };
  }
  try {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    contacted = true;
    if (!r.ok) return { text: null, etag: "", conditional: false, unreachable: false };
    return { text: await r.text(), etag: "", conditional: false, unreachable: false };
  } catch {
    return { text: null, etag: "", conditional: false, unreachable: !contacted };
  }
}

async function putViaSdk(filename, body, { token, access, ifMatch = "" } = {}) {
  const opts = {
    access,
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: "application/json",
  };
  if (ifMatch) opts.ifMatch = ifMatch;
  await put(filename, body, opts);
  return true;
}

async function putViaRest(filename, body, token, access) {
  const r = await fetch(`${BLOB_API}/${filename}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-content-type": "application/json",
      "x-add-random-suffix": "0",
      "x-allow-overwrite": "1",
      "x-cache-control-max-age": "60",
      "x-vercel-blob-access": access,
    },
    body,
  });
  return r.ok;
}

// Public / non-capacity writes. Optional ifMatch is best-effort with overwrite
// fallthrough (settings / members / finance — not capacity-critical).
export async function blobWrite(filename, value, { ifMatch = "", conditional = false } = {}) {
  if (isCapacityFile(filename)) {
    return false;
  }
  const body = typeof value === "string" ? value : JSON.stringify(value);

  if (memoryEnabled()) {
    if (conditional && ifMatch) {
      const cas = await blobCompareAndSet(filename, body, ifMatch);
      if (cas.ok) return true;
      if (cas.conflict) return false;
    }
    memoryBlobs.set(filename, { body, etag: nextMemoryEtag() });
    return true;
  }

  const token = publicToken();
  if (!token) return false;

  if (conditional && ifMatch) {
    try {
      return await putViaSdk(filename, body, { token, access: "public", ifMatch });
    } catch {
      /* fall through */
    }
  }

  try {
    return await putViaSdk(filename, body, { token, access: "public" });
  } catch {
    /* REST */
  }
  try {
    return await putViaRest(filename, body, token, "public");
  } catch {
    return false;
  }
}

/**
 * Strict conditional write for capacity-critical files.
 * - Requires CAPACITY_WRITES_ENABLED=1 (production default: paused)
 * - Blocked while CAPACITY_MIGRATION_PAUSE=1
 * - Post-cutover → private store; pre-cutover → public store (CDN risk; paused in prod)
 * - No unconditional overwrite after failed ifMatch
 */
export async function blobCompareAndSet(filename, value, ifMatch = "") {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const capacity = isCapacityFile(filename);

  if (capacity && !capacityWritesEnabled()) {
    return { ok: false, conflict: false, paused: true };
  }
  if (capacity && capacityMigrationPaused()) {
    return { ok: false, conflict: false, paused: true };
  }

  const cutover = capacity ? await readCutoverMarker() : { active: false };
  const access = capacity && cutover.active ? "private" : "public";
  const token = capacity && cutover.active ? privateToken() : publicToken();

  if (capacity && cutover.active) {
    const isolation = previewCapacityIsolationOk();
    if (!isolation.ok) {
      capacityDiag("isolation_failed", { file: filename, reason: isolation.reason || "unknown" });
      return { ok: false, conflict: false };
    }
    if (!token) {
      capacityDiag("isolation_failed", { file: filename, reason: "missing_private_token" });
      return { ok: false, conflict: false };
    }
  }

  if (memoryEnabled()) {
    const key =
      capacity && !cutover.active && memoryBlobs.has(`public:${filename}`)
        ? `public:${filename}`
        : filename;
    // Post-cutover memory writes always use unprefixed private key.
    const writeKey = capacity && cutover.active ? filename : key === `public:${filename}` ? key : filename;

    const entry = memoryBlobs.get(writeKey) || (capacity && !cutover.active ? memoryBlobs.get(filename) : null);
    const effectiveKey = entry
      ? memoryBlobs.has(writeKey)
        ? writeKey
        : filename
      : cutover.active
        ? filename
        : writeKey;

    const current = memoryBlobs.get(effectiveKey);
    if (!current) {
      if (ifMatch) {
        capacityDiag("cas_conflict", { file: filename, reason: "missing_for_ifmatch" });
        return { ok: false, conflict: true };
      }
      await Promise.resolve();
      if (memoryBlobs.get(effectiveKey)) {
        capacityDiag("cas_conflict", { file: filename, reason: "create_race" });
        return { ok: false, conflict: true };
      }
      memoryBlobs.set(effectiveKey, { body, etag: nextMemoryEtag() });
      return { ok: true, conflict: false };
    }
    if (!ifMatch) {
      capacityDiag("cas_conflict", { file: filename, reason: "existing_without_ifmatch" });
      return { ok: false, conflict: true };
    }
    if (current.etag !== ifMatch) {
      capacityDiag("cas_conflict", { file: filename, reason: "etag_mismatch" });
      return { ok: false, conflict: true };
    }
    await Promise.resolve();
    const again = memoryBlobs.get(effectiveKey);
    if (!again || again.etag !== ifMatch) {
      capacityDiag("cas_conflict", { file: filename, reason: "etag_changed" });
      return { ok: false, conflict: true };
    }
    if (privatePutForTests) {
      try {
        await privatePutForTests(filename, body, { token, access: "private", ifMatch });
      } catch (error) {
        if (
          error instanceof BlobPreconditionFailedError ||
          error?.name === "BlobPreconditionFailedError"
        ) {
          capacityDiag("cas_precondition_failed", { file: filename });
          return { ok: false, conflict: true };
        }
        capacityDiag("blob_write_failed", { file: filename, reason: "put_ifmatch_error" });
        return { ok: false, conflict: false };
      }
    }
    memoryBlobs.set(effectiveKey, { body, etag: nextMemoryEtag() });
    return { ok: true, conflict: false };
  }

  if (!token) {
    capacityDiag("blob_write_failed", { file: filename, reason: "missing_token" });
    return { ok: false, conflict: false };
  }

  if (ifMatch) {
    try {
      if (privatePutForTests) {
        await privatePutForTests(filename, body, { token, access, ifMatch });
      } else {
        await putViaSdk(filename, body, { token, access, ifMatch });
      }
      return { ok: true, conflict: false };
    } catch (error) {
      if (
        error instanceof BlobPreconditionFailedError ||
        error?.name === "BlobPreconditionFailedError"
      ) {
        capacityDiag("cas_precondition_failed", { file: filename });
        return { ok: false, conflict: true };
      }
      capacityDiag("blob_write_failed", { file: filename, reason: "put_ifmatch_error" });
      return { ok: false, conflict: false };
    }
  }

  // First create only — probe so we never clobber an existing object.
  try {
    const existing = await get(filename, {
      access,
      token,
      useCache: access === "private" ? false : true,
    });
    if (existing && existing.statusCode === 200) {
      capacityDiag("cas_conflict", { file: filename, reason: "create_but_exists" });
      return { ok: false, conflict: true };
    }
  } catch {
    /* treat as missing */
  }

  if (capacity && access === "public") {
    const url = publicUrlFor(filename);
    if (url) {
      try {
        const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
        if (r.ok) {
          capacityDiag("cas_conflict", { file: filename, reason: "public_url_exists" });
          return { ok: false, conflict: true };
        }
      } catch {
        /* ignore */
      }
    }
  }

  try {
    await putViaSdk(filename, body, { token, access });
    return { ok: true, conflict: false };
  } catch {
    /* REST */
  }
  try {
    const ok = await putViaRest(filename, body, token, access);
    if (!ok) capacityDiag("blob_write_failed", { file: filename, reason: "rest_put_failed" });
    return { ok: Boolean(ok), conflict: false };
  } catch {
    capacityDiag("blob_write_failed", { file: filename, reason: "rest_put_error" });
    return { ok: false, conflict: false };
  }
}

/** Migration helper: write a capacity file into the private store (create/overwrite). */
export async function writePrivateCapacityFile(filename, value, { ifMatch = "" } = {}) {
  if (!isCapacityFile(filename) && filename !== CUTOVER_MARKER && !filename.startsWith("backup/")) {
    throw new Error("not a private capacity path");
  }
  const body = typeof value === "string" ? value : JSON.stringify(value);
  if (memoryEnabled()) {
    if (ifMatch) {
      const entry = memoryBlobs.get(filename);
      if (!entry || entry.etag !== ifMatch) return { ok: false, conflict: true };
    }
    memoryBlobs.set(filename, { body, etag: nextMemoryEtag() });
    return { ok: true, conflict: false };
  }
  const token = privateToken();
  if (!token) return { ok: false, conflict: false, error: "missing_private_token" };
  try {
    await putViaSdk(filename, body, {
      token,
      access: "private",
      ifMatch: ifMatch || undefined,
    });
    return { ok: true, conflict: false };
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) {
      return { ok: false, conflict: true };
    }
    return { ok: false, conflict: false, error: error?.message || "write_failed" };
  }
}

export async function readPrivateCapacityFile(filename) {
  if (memoryEnabled()) {
    const entry = memoryBlobs.get(filename);
    if (!entry) return { text: null, etag: "", found: false };
    return { text: entry.body, etag: entry.etag, found: true };
  }
  const token = privateToken();
  if (!token) return { text: null, etag: "", found: false, error: "missing_private_token" };
  try {
    const got = await readSdkBlob(filename, { access: "private", token, useCache: false });
    if (!got) return { text: null, etag: "", found: false };
    return { text: got.text, etag: got.etag, found: true };
  } catch (error) {
    return { text: null, etag: "", found: false, error: error?.message || "read_failed" };
  }
}

export async function kvGet(_key) {
  return blobRead("availability.json");
}

export async function kvSet(_key, value) {
  const path = process.env.AVAILABILITY_BLOB_PATH || "availability.json";
  return blobWrite(path, value);
}
