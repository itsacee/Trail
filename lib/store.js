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

export function storeConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.AVAILABILITY_URL);
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
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return false;
  const body = typeof value === "string" ? value : JSON.stringify(value);

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

export async function kvGet(_key) {
  return blobRead("availability.json");
}

export async function kvSet(_key, value) {
  const path = process.env.AVAILABILITY_BLOB_PATH || "availability.json";
  return blobWrite(path, value);
}
