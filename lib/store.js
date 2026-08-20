// Persistence for the coach's editable availability, backed by Vercel Blob.
// Talks to the Blob REST API directly with fetch — no npm dependency.
//
// Env (auto-provisioned on the Vercel project):
//   BLOB_READ_WRITE_TOKEN  — scoped read/write token for the blob store
//   AVAILABILITY_URL       — the public URL of availability.json (for reads)
//   AVAILABILITY_BLOB_PATH — the pathname to write to (default "availability.json")
//
// If those aren't set, every call returns null/false and the site falls back
// to the built-in default hours.

const BLOB_API = "https://blob.vercel-storage.com";

export function storeConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.AVAILABILITY_URL);
}

// key is accepted for API symmetry; this store only holds "availability".
export async function kvGet(_key) {
  const url = process.env.AVAILABILITY_URL;
  if (!url) return null;
  try {
    // cache-bust so the booking form picks up edits quickly
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

export async function kvSet(_key, value) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return false;
  const path = process.env.AVAILABILITY_BLOB_PATH || "availability.json";
  const body = typeof value === "string" ? value : JSON.stringify(value);
  try {
    const r = await fetch(`${BLOB_API}/${path}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "x-content-type": "application/json",
        "x-add-random-suffix": "0", // keep the URL stable so reads always find it
        "x-cache-control-max-age": "30", // short cache so edits show up fast
      },
      body,
    });
    return r.ok;
  } catch {
    return false;
  }
}
