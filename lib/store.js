// Persistence backed by Vercel Blob. Talks to the Blob REST API with fetch —
// no npm dependency.
//
// Env (auto-provisioned on the Vercel project):
//   BLOB_READ_WRITE_TOKEN  — scoped read/write token for the blob store
//   AVAILABILITY_URL       — public URL of availability.json (for reads)
//   AVAILABILITY_BLOB_PATH — pathname to write (default "availability.json")
//
// Other JSON files (lessons.json) live next to availability.json in the same
// store. Reads use the same public host as AVAILABILITY_URL.

import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

const BLOB_API = "https://blob.vercel-storage.com";

// In-process Blob stand-in for concurrency tests (BLOB_MEMORY_STORE=1).
// Supports real ETag compare-and-set so parallel writers can race safely.
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
    // Token must be present so production write guards treat the store as configured.
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      process.env.BLOB_READ_WRITE_TOKEN = "memory_test_token";
    }
    clearMemoryBlobStore();
  } else {
    delete process.env.BLOB_MEMORY_STORE;
    clearMemoryBlobStore();
  }
}

export function storeConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.AVAILABILITY_URL) || memoryEnabled();
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

// Reads directly from origin when the write token is available and carries the
// ETag needed for an atomic conditional update.
//
// Returns:
//   text         — file body, or null if missing/unreadable
//   etag         — SDK etag when available
//   conditional  — true only when etag is safe for ifMatch
//   unreachable  — true when every read path failed (not the same as 404)
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

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const result = await get(filename, { access: "public", useCache: false });
      contacted = true;
      if (result && result.statusCode === 200 && result.stream) {
        const etag = result.blob.etag || "";
        return {
          text: await new Response(result.stream).text(),
          etag,
          conditional: Boolean(etag),
          unreachable: false,
        };
      }
      // null / non-200 (including 404) — try the public URL next.
    } catch {
      // Fall through to the public read.
    }
  }

  const url = publicUrlFor(filename);
  if (!url) {
    return { text: null, etag: "", conditional: false, unreachable: !contacted };
  }
  try {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    contacted = true;
    if (!r.ok) {
      // 404 = missing file (empty store). Other errors after contact still
      // leave us without a body, but the store itself was reachable.
      return { text: null, etag: "", conditional: false, unreachable: false };
    }
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
    cacheControlMaxAge: 15,
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
      "x-cache-control-max-age": "15",
    },
    body,
  });
  return r.ok;
}

// Writes always allow overwrite. Optional ifMatch is best-effort; on 412 or any
// SDK error we fall through to an unconditional overwrite so member "Lock in"
// and coach moves keep working.
export async function blobWrite(filename, value, { ifMatch = "", conditional = false } = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);

  if (memoryEnabled()) {
    // Test helper only — production booking paths use blobCompareAndSet.
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
    } catch (error) {
      if (!(error instanceof BlobPreconditionFailedError)) {
        // Unexpected SDK error — still try a plain overwrite below.
      }
      // Stale ETag: fall through to overwrite rather than failing the booking.
    }
  }

  try {
    return await putViaSdk(filename, body);
  } catch {
    // SDK unavailable (tests mock fetch; rare runtime glitches) — REST path.
  }

  try {
    return await putViaRest(filename, body, token);
  } catch {
    return false;
  }
}

// Strict conditional write for capacity-critical files (holds, lessons,
// manual-bookings). Does NOT fall through to overwrite on 412 — caller must
// reload and retry. Returns { ok, conflict }.
//
// When ifMatch is empty this only creates a missing file. It will not silently
// replace an existing blob (that is how concurrent bookings used to vanish).
export async function blobCompareAndSet(filename, value, ifMatch = "") {
  const body = typeof value === "string" ? value : JSON.stringify(value);

  if (memoryEnabled()) {
    const entry = memoryBlobs.get(filename);
    if (!entry) {
      if (ifMatch) return { ok: false, conflict: true };
      // Yield so two first-creates cannot both observe a missing file.
      await Promise.resolve();
      if (memoryBlobs.get(filename)) return { ok: false, conflict: true };
      memoryBlobs.set(filename, { body, etag: nextMemoryEtag() });
      return { ok: true, conflict: false };
    }
    // Existing object requires an ETag — ask the caller to reload.
    if (!ifMatch) return { ok: false, conflict: true };
    if (entry.etag !== ifMatch) return { ok: false, conflict: true };
    // Yield so Promise.all racers can interleave between check and set.
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
      // Unexpected SDK error — try REST without claiming atomicity.
    }
  } else {
    // First create only. Probe so we never clobber an existing object without
    // an ETag (the Lock-in #58 / #54 failure mode was silent overwrite).
    try {
      const existing = await get(filename, { access: "public", useCache: false });
      if (existing && existing.statusCode === 200) {
        // Caller should reload and retry with the real ETag.
        return { ok: false, conflict: true };
      }
    } catch {
      /* treat as missing and attempt create below */
    }
  }

  try {
    const ok = await putViaSdk(filename, body);
    return { ok: Boolean(ok), conflict: false };
  } catch {
    /* REST fallback */
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
