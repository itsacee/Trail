// Persistence backed by Vercel Blob (dual-store).
//
// Public store (existing):
//   BLOB_READ_WRITE_TOKEN  — read/write token
//   AVAILABILITY_URL       — public URL of availability.json
//   AVAILABILITY_BLOB_PATH  — pathname to write (default "availability.json")
//
// Private capacity store (new — required for holds / lessons / manual-bookings):
//   PRIVATE_BLOB_READ_WRITE_TOKEN — read/write token for a PRIVATE Blob store
//   CAPACITY_BLOB_CUTOVER=1       — optional hard switch after verified migration
//   CAPACITY_MIGRATION_PAUSE=1    — pause booking writes during cutover
//   CAPACITY_ALLOW_SHARED_STORE=1 — allow preview to share private store id
//                                   with production (discouraged; off by default)
//
// Capacity files never use in-place public→private conversion. They read/write
// only the private store after cutover. Before cutover, missing private files
// that still exist on the public store are treated as unreachable (fail closed).

import { BlobPreconditionFailedError, get, head, put } from "@vercel/blob";

const BLOB_API = "https://blob.vercel-storage.com";

export const CAPACITY_FILES = new Set(["holds.json", "lessons.json", "manual-bookings.json"]);
export const CUTOVER_MARKER = "capacity-cutover.json";

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
    // Memory tests operate post-cutover against the in-process private map.
    process.env.CAPACITY_BLOB_CUTOVER = process.env.CAPACITY_BLOB_CUTOVER || "1";
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

/** @param {string} filename */
export function blobAccessFor(filename) {
  return isCapacityFile(filename) ? "private" : "public";
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

function tokenFor(filename) {
  return isCapacityFile(filename) ? privateToken() : publicToken();
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

async function readSdkBlob(filename, { access, token, useCache = true } = {}) {
  const result = await get(filename, { access, token, useCache });
  if (!(result && result.statusCode === 200 && result.stream)) {
    return null;
  }
  return {
    text: await streamToText(result.stream),
    etag: result.blob.etag || "",
    url: result.blob.url || "",
  };
}

/** Read a public-store capacity file for migration tooling only (not booking paths). */
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
  // CDN URL fallback (no conditional ETag).
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

/** Seed a public-store capacity snapshot in memory tests (migration only). */
export function seedMemoryPublicCapacity(filename, value) {
  if (!memoryEnabled()) throw new Error("memory store disabled");
  const body = typeof value === "string" ? value : JSON.stringify(value);
  memoryBlobs.set(`public:${filename}`, { body, etag: nextMemoryEtag() });
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
  // Rollback clears the env flag externally; marker overwrite with inactive.
  return writeCutoverMarker({ active: false, rolledBackAt: new Date().toISOString() });
}

export async function blobRead(filename) {
  return (await blobReadVersioned(filename)).text;
}

export async function blobReadVersioned(filename) {
  if (memoryEnabled()) {
    if (isCapacityFile(filename)) {
      if (capacityMigrationPaused()) {
        return { text: null, etag: "", conditional: false, unreachable: true };
      }
      const isolation = previewCapacityIsolationOk();
      if (!isolation.ok) {
        return { text: null, etag: "", conditional: false, unreachable: true };
      }
      const cutover = await readCutoverMarker();
      const entry = memoryBlobs.get(filename);
      if (entry) {
        return {
          text: entry.body,
          etag: entry.etag,
          conditional: Boolean(entry.etag),
          unreachable: false,
        };
      }
      if (!cutover.active) {
        const pub = memoryBlobs.get(`public:${filename}`);
        if (pub) {
          // Public still has data and cutover not done — refuse empty invent.
          return { text: null, etag: "", conditional: false, unreachable: true };
        }
      }
      return { text: null, etag: "", conditional: false, unreachable: false };
    }
    const entry = memoryBlobs.get(filename);
    if (!entry) return { text: null, etag: "", conditional: false, unreachable: false };
    return {
      text: entry.body,
      etag: entry.etag,
      conditional: Boolean(entry.etag),
      unreachable: false,
    };
  }

  if (isCapacityFile(filename)) {
    return readCapacityVersioned(filename);
  }
  return readPublicVersioned(filename);
}

async function readCapacityVersioned(filename) {
  const isolation = previewCapacityIsolationOk();
  if (!isolation.ok) {
    return { text: null, etag: "", conditional: false, unreachable: true };
  }
  if (capacityMigrationPaused()) {
    return { text: null, etag: "", conditional: false, unreachable: true };
  }
  const token = privateToken();
  if (!token) {
    return { text: null, etag: "", conditional: false, unreachable: true };
  }

  let contacted = false;
  try {
    const priv = await readSdkBlob(filename, {
      access: "private",
      token,
      useCache: false,
    });
    contacted = true;
    if (priv) {
      return {
        text: priv.text,
        etag: priv.etag,
        conditional: Boolean(priv.etag),
        unreachable: false,
      };
    }
  } catch {
    // Fall through to cutover / public-existence check.
  }

  const cutover = await readCutoverMarker();
  if (cutover.active) {
    // Post-cutover: missing private file is a true empty schedule.
    return { text: null, etag: "", conditional: false, unreachable: false };
  }

  // Pre-cutover: if public still holds reservations, do NOT invent empty.
  const pub = await readPublicCapacitySnapshot(filename);
  if (pub.found && pub.text && pub.text.trim() && pub.text.trim() !== "{}" ) {
    let hasRows = true;
    try {
      const parsed = JSON.parse(pub.text);
      if (filename === "holds.json") hasRows = Array.isArray(parsed?.holds) && parsed.holds.length > 0;
      if (filename === "lessons.json") {
        hasRows =
          (Array.isArray(parsed?.lessons) && parsed.lessons.length > 0) ||
          (Array.isArray(parsed?.voids) && parsed.voids.length > 0);
      }
      if (filename === "manual-bookings.json") {
        hasRows = Array.isArray(parsed?.bookings) && parsed.bookings.length > 0;
      }
    } catch {
      hasRows = true;
    }
    if (hasRows) {
      return { text: null, etag: "", conditional: false, unreachable: true };
    }
  }

  return { text: null, etag: "", conditional: false, unreachable: !contacted && !pub.found };
}

async function readPublicVersioned(filename) {
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
      // Fall through to public URL.
    }
  }

  const url = publicUrlFor(filename);
  if (!url) {
    return { text: null, etag: "", conditional: false, unreachable: !contacted };
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
    // Capacity files must use blobCompareAndSet — never this path.
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
      // Fall through to overwrite for non-capacity files only.
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

// Strict conditional write for capacity-critical files. No overwrite fallthrough
// on 412 or unexpected errors. Returns { ok, conflict }.
export async function blobCompareAndSet(filename, value, ifMatch = "") {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const capacity = isCapacityFile(filename);
  const access = capacity ? "private" : "public";

  if (memoryEnabled()) {
    const key = filename;
    const entry = memoryBlobs.get(key);
    if (!entry) {
      if (ifMatch) return { ok: false, conflict: true };
      if (capacity) {
        if (capacityMigrationPaused()) return { ok: false, conflict: false };
        const isolation = previewCapacityIsolationOk();
        if (!isolation.ok) return { ok: false, conflict: false };
        const cutover = await readCutoverMarker();
        if (!cutover.active && memoryBlobs.get(`public:${filename}`)) {
          return { ok: false, conflict: false };
        }
      }
      await Promise.resolve();
      if (memoryBlobs.get(key)) return { ok: false, conflict: true };
      memoryBlobs.set(key, { body, etag: nextMemoryEtag() });
      return { ok: true, conflict: false };
    }
    if (!ifMatch) return { ok: false, conflict: true };
    if (entry.etag !== ifMatch) return { ok: false, conflict: true };
    await Promise.resolve();
    const again = memoryBlobs.get(key);
    if (!again || again.etag !== ifMatch) return { ok: false, conflict: true };
    memoryBlobs.set(key, { body, etag: nextMemoryEtag() });
    return { ok: true, conflict: false };
  }

  if (capacity) {
    if (capacityMigrationPaused()) return { ok: false, conflict: false };
    const isolation = previewCapacityIsolationOk();
    if (!isolation.ok) return { ok: false, conflict: false };
  }

  const token = tokenFor(filename);
  if (!token) return { ok: false, conflict: false };

  if (ifMatch) {
    try {
      await putViaSdk(filename, body, { token, access, ifMatch });
      return { ok: true, conflict: false };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) {
        return { ok: false, conflict: true };
      }
      // No unconditional fallthrough for capacity (or public CAS) writes.
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
      return { ok: false, conflict: true };
    }
  } catch {
    /* treat as missing */
  }

  if (capacity) {
    const cutover = await readCutoverMarker();
    if (!cutover.active) {
      const pub = await readPublicCapacitySnapshot(filename);
      if (pub.found && pub.text && pub.text.trim()) {
        // Refuse create-over-legacy-public without explicit migration.
        return { ok: false, conflict: false };
      }
    }
  }

  try {
    await putViaSdk(filename, body, { token, access });
    return { ok: true, conflict: false };
  } catch {
    /* REST only for create; still no ifMatch bypass */
  }
  try {
    const ok = await putViaRest(filename, body, token, access);
    return { ok: Boolean(ok), conflict: false };
  } catch {
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
