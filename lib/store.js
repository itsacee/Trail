// Persistence backed by Vercel Blob (public store).
//
// EMERGENCY HOTFIX (post ff3dff2): capacity files stay on the EXISTING public
// store. There is no private-store migration and no public→private rewrite.
//
// Env:
//   BLOB_READ_WRITE_TOKEN  — public store read/write token (unchanged)
//   AVAILABILITY_URL       — public URL of availability.json (unchanged)
//   AVAILABILITY_BLOB_PATH — pathname to write (default "availability.json")
//   CAPACITY_WRITES_ENABLED=1 — allow holds/lessons/manual CAS writes after
//     backup verification. Default OFF in deployed envs so calendar recovery
//     is read-first and mutations stay paused.

import { BlobPreconditionFailedError, get, head, put } from "@vercel/blob";

const BLOB_API = "https://blob.vercel-storage.com";

export const CAPACITY_FILES = new Set(["holds.json", "lessons.json", "manual-bookings.json"]);

export class StorageUnavailableError extends Error {
  constructor(message = "Booking storage is temporarily unavailable.") {
    super(message);
    this.name = "StorageUnavailableError";
    this.code = "schedule_unavailable";
  }
}

/** Always public in this hotfix — restores compatibility with the live store. */
export function blobAccessFor(_filename) {
  return "public";
}

export function isCapacityFile(filename) {
  return CAPACITY_FILES.has(filename);
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
      process.env.BLOB_READ_WRITE_TOKEN = "memory_test_token";
    }
    // Tests exercise CAS writes; production keeps mutations paused by default.
    process.env.CAPACITY_WRITES_ENABLED = process.env.CAPACITY_WRITES_ENABLED || "1";
    clearMemoryBlobStore();
  } else {
    delete process.env.BLOB_MEMORY_STORE;
    clearMemoryBlobStore();
  }
}

export function storeConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.AVAILABILITY_URL) || memoryEnabled();
}

/** Capacity CAS writes (holds / lessons / manual). Off unless explicitly enabled. */
export function capacityWritesEnabled() {
  if (memoryEnabled()) return process.env.CAPACITY_WRITES_ENABLED !== "0";
  return process.env.CAPACITY_WRITES_ENABLED === "1";
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

export async function blobRead(filename) {
  return (await blobReadVersioned(filename)).text;
}

async function streamToText(stream) {
  return new Response(stream).text();
}

async function readSdkPublic(filename) {
  const result = await get(filename, { access: "public", useCache: true });
  if (!(result && result.statusCode === 200 && result.stream)) return null;
  return {
    text: await streamToText(result.stream),
    etag: result.blob.etag || "",
    url: result.blob.url || "",
  };
}

/**
 * Public CDN etags are not always safe for ifMatch. Prefer head() origin etag
 * and only mark conditional when it matches the body we read.
 * Always return the body when present so calendars recover even if CDN is stale
 * (writes stay fail-closed via conditional:false / CAPACITY_WRITES_ENABLED).
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
  // Readable for display; not safe for conditional overwrite.
  return { text: pub.text, etag: "", conditional: false, unreachable: false };
}

export async function blobReadVersioned(filename) {
  if (memoryEnabled()) {
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
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (token) {
    try {
      const pub = await readSdkPublic(filename);
      contacted = true;
      if (pub) {
        if (isCapacityFile(filename)) return withSafeConditional(pub);
        return {
          text: pub.text,
          etag: pub.etag,
          conditional: Boolean(pub.etag),
          unreachable: false,
        };
      }
    } catch {
      // Fall through to public URL.
    }
  }

  const url = publicUrlFor(filename);
  if (!url) {
    // No read path configured. Unreachable only when a token suggested the
    // store should exist but every contact failed.
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
      // 404 = missing file (empty store). Reachable store.
      return { text: null, etag: "", conditional: false, unreachable: false };
    }
    // URL bodies never carry an ifMatch-safe ETag.
    return { text: await r.text(), etag: "", conditional: false, unreachable: false };
  } catch {
    return { text: null, etag: "", conditional: false, unreachable: !contacted };
  }
}

async function putViaSdk(filename, body, extra = {}) {
  await put(filename, body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: "application/json",
    ...extra,
  });
  return true;
}

async function putViaRest(filename, body, token) {
  const r = await fetch(`${BLOB_API}/${filename}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-content-type": "application/json",
      "x-add-random-suffix": "0",
      "x-allow-overwrite": "1",
      "x-cache-control-max-age": "60",
      "x-vercel-blob-access": "public",
    },
    body,
  });
  return r.ok;
}

// Non-capacity writes (settings/members/finance). Optional ifMatch may fall
// through to overwrite — these are not schedule capacity files.
export async function blobWrite(filename, value, { ifMatch = "", conditional = false } = {}) {
  if (isCapacityFile(filename)) {
    // Capacity files must use blobCompareAndSet only.
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

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return false;

  if (conditional && ifMatch) {
    try {
      return await putViaSdk(filename, body, { ifMatch });
    } catch {
      // Fall through to overwrite for non-capacity files only.
    }
  }

  try {
    return await putViaSdk(filename, body);
  } catch {
    /* REST */
  }
  try {
    return await putViaRest(filename, body, token);
  } catch {
    return false;
  }
}

// Strict conditional write for capacity-critical files.
// - No unconditional overwrite after failed ifMatch
// - No private access
// - Paused unless CAPACITY_WRITES_ENABLED=1 (production default: paused)
export async function blobCompareAndSet(filename, value, ifMatch = "") {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const capacity = isCapacityFile(filename);

  if (capacity && !capacityWritesEnabled()) {
    return { ok: false, conflict: false, paused: true };
  }

  if (memoryEnabled()) {
    const entry = memoryBlobs.get(filename);
    if (!entry) {
      if (ifMatch) return { ok: false, conflict: true };
      await Promise.resolve();
      if (memoryBlobs.get(filename)) return { ok: false, conflict: true };
      memoryBlobs.set(filename, { body, etag: nextMemoryEtag() });
      return { ok: true, conflict: false };
    }
    if (!ifMatch) return { ok: false, conflict: true };
    if (entry.etag !== ifMatch) return { ok: false, conflict: true };
    await Promise.resolve();
    const again = memoryBlobs.get(filename);
    if (!again || again.etag !== ifMatch) return { ok: false, conflict: true };
    memoryBlobs.set(filename, { body, etag: nextMemoryEtag() });
    return { ok: true, conflict: false };
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { ok: false, conflict: false };

  if (ifMatch) {
    try {
      await putViaSdk(filename, body, { ifMatch });
      return { ok: true, conflict: false };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) {
        return { ok: false, conflict: true };
      }
      // No unconditional fallthrough — fail closed.
      return { ok: false, conflict: false };
    }
  }

  // First create only. Probe so we never clobber an existing object.
  try {
    const existing = await get(filename, { access: "public", useCache: true });
    if (existing && existing.statusCode === 200) {
      return { ok: false, conflict: true };
    }
  } catch {
    /* treat as missing */
  }

  // Also probe the public URL so a CDN/SDK miss cannot recreate over live data.
  const url = publicUrlFor(filename);
  if (url) {
    try {
      const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) return { ok: false, conflict: true };
    } catch {
      /* ignore */
    }
  }

  try {
    await putViaSdk(filename, body);
    return { ok: true, conflict: false };
  } catch {
    /* REST */
  }
  try {
    const ok = await putViaRest(filename, body, token);
    return { ok: Boolean(ok), conflict: false };
  } catch {
    return { ok: false, conflict: false };
  }
}

export async function kvGet(_key) {
  return blobRead("availability.json");
}

export async function kvSet(_key, value) {
  const path = process.env.AVAILABILITY_BLOB_PATH || "availability.json";
  return blobWrite(path, value);
}
