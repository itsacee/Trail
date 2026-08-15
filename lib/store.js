// Tiny key/value store backed by Upstash Redis (a.k.a. Vercel KV), used to
// persist the coach's editable availability. Talks to the REST API directly
// with fetch, so there's no npm dependency to install.
//
// It reads whichever env vars the Vercel/Upstash integration added — the
// newer "Vercel KV" names (KV_REST_API_URL / KV_REST_API_TOKEN) or the raw
// Upstash names (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
//
// If no store is configured, every call quietly returns null so the site
// keeps working on its built-in defaults.

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

export function storeConfigured() {
  return Boolean(creds());
}

export async function kvGet(key) {
  const c = creds();
  if (!c) return null;
  try {
    const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${c.token}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d && typeof d.result === "string" ? d.result : null;
  } catch {
    return null;
  }
}

export async function kvSet(key, value) {
  const c = creds();
  if (!c) return false;
  try {
    const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}` },
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
    return r.ok;
  } catch {
    return false;
  }
}
