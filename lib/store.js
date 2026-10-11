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

import { BlobPreconditionFailedError, get, head, put } from "@vercel/blob";

const BLOB_API = "https://blob.vercel-storage.com";

// Capacity-critical JSON files use private blobs so get({ useCache: false })
// can read origin storage. Public get() ignores useCache (CDN may serve a
// stale body + ETag for up to cacheControlMaxAge), which makes ifMatch CAS
// return HTTP 412 forever and fail-closed checkout holds.
const ORIGIN_CONSISTENT_FILES = new Set(["holds.json", "lessons.json", "manual-bookings.json"]);

/** @param {string} filename */
export function blobAccessFor(filename) {
  return ORIGIN_CONSISTENT_FILES.has(filename) ? "private" : "public";
}

function accessFor(filename) {
  return blobAccessFor(filename);
}

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

async function streamToText(stream) {
  return new Response(stream).text();
}

async function readSdkBlob(filename, access, { useCache = true } = {}) {
  const result = await get(filename, { access, useCache });
  if (!(result && result.statusCode === 200 && result.stream)) {
    return null;
  }
  const etag = result.blob.etag || "";
  return {
    text: await streamToText(result.stream),
    etag,
    url: result.blob.url || "",
  };
}

// Legacy public objects for CAS files: only trust the body when the CDN ETag
// still matches origin (via head). Then rewrite as private so future reads
// can use useCache:false.
async function migratePublicOriginBlob(filename, publicRead) {
  if (!publicRead?.text || !publicRead.etag) return null;
  let originEtag = publicRead.etag;
  try {
    const meta = await head(publicRead.url || filename);
    if (meta?.etag) originEtag = meta.etag;
  } catch {
    // head unavailable — refuse conditional use of a possibly stale CDN read.
    return { text: null, etag: "", conditional: false, unreachable: true };
  }
  if (originEtag !== publicRead.etag) {
    // CDN still serving a prior version; caller must retry rather than CAS
    // with a mismatched body/etag pair.
    return { text: null, etag: "", conditional: false, unreachable: true };
  }
  try {
    const written = await put(filename, publicRead.text, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      ifMatch: originEtag,
      cacheControlMaxAge: 15,
      contentType: "application/json",
    });
    return {
      text: publicRead.text,
      etag: written?.etag || originEtag,
      conditional: true,
      unreachable: false,
    };
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) {
      return { text: null, etag: "", conditional: false, unreachable: true };
    }
    // Migration put failed; body still matches origin so CAS may proceed once.
    return {
      text: publicRead.text,
      etag: originEtag,
      conditional: true,
      unreachable: false,
    };
  }
}

// Reads from origin for capacity-critical files (private + useCache:false)
// so the ETag is safe for ifMatch. Returns:
//   text / etag / conditional / unreachable
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
  const consistent = ORIGIN_CONSISTENT_FILES.has(filename);

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    if (consistent) {
      try {
        const priv = await readSdkBlob(filename, "private", { useCache: false });
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
        // Fall through to legacy public object / URL read.
      }
      try {
        const pub = await readSdkBlob(filename, "public", { useCache: true });
        contacted = true;
        if (pub) {
          const migrated = await migratePublicOriginBlob(filename, pub);
          if (migrated) return migrated;
        }
      } catch {
        // Fall through to the public URL read.
      }
    } else {
      try {
        // useCache is a no-op for public access; kept for SDK compatibility.
        const result = await readSdkBlob(filename, "public", { useCache: false });
        contacted = true;
        if (result) {
          return {
            text: result.text,
            etag: result.etag,
            conditional: Boolean(result.etag),
            unreachable: false,
          };
        }
        // null / non-200 (including 404) — try the public URL next.
      } catch {
        // Fall through to the public read.
      }
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
    // Public URL bodies never carry an ifMatch-safe ETag.
    return { text: await r.text(), etag: "", conditional: false, unreachable: false };
  } catch {
    return { text: null, etag: "", conditional: false, unreachable: !contacted };
  }
}

async function putViaSdk(filename, body, extra = {}) {
  const access = extra.access || accessFor(filename);
  const { access: _ignore, ...rest } = extra;
  await put(filename, body, {
    access,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 15,
    contentType: "application/json",
    ...rest,
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
      "x-vercel-blob-access": accessFor(filename),
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

  const access = accessFor(filename);

  if (ifMatch) {
    try {
      await putViaSdk(filename, body, { ifMatch, access });
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
    for (const probeAccess of access === "private" ? ["private", "public"] : ["public"]) {
      try {
        const existing = await get(filename, {
          access: probeAccess,
          useCache: probeAccess === "private" ? false : true,
        });
        if (existing && existing.statusCode === 200) {
          // Caller should reload and retry with the real ETag.
          return { ok: false, conflict: true };
        }
      } catch {
        /* try next probe / treat as missing */
      }
    }
  }

  try {
    const ok = await putViaSdk(filename, body, { access });
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
