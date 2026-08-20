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
  const url = publicUrlFor(filename);
  if (!url) return null;
  try {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

export async function blobWrite(filename, value) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return false;
  const body = typeof value === "string" ? value : JSON.stringify(value);
  try {
    const r = await fetch(`${BLOB_API}/${filename}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "x-content-type": "application/json",
        "x-add-random-suffix": "0",
        "x-cache-control-max-age": "15",
      },
      body,
    });
    return r.ok;
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
