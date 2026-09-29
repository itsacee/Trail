// Coach-togglable overrides for facility-wide pause flags.
// Hardcoded defaults live in siteStatus.js; this Blob lets the coach flip
// them from the Coach Desk without a redeploy.

import { blobRead, blobWrite } from "./store.js";

const FILE = "coach-status.json";

let cache = null;
let cacheAt = 0;

export async function loadCoachStatus() {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  const raw = await blobRead(FILE);
  if (!raw) {
    cache = {};
    cacheAt = Date.now();
    return cache;
  }
  try {
    cache = JSON.parse(raw) || {};
  } catch {
    cache = {};
  }
  cacheAt = Date.now();
  return cache;
}

export async function saveCoachStatus(status) {
  const next = { ...(status || {}), updatedAt: Date.now() };
  const ok = await blobWrite(FILE, next);
  if (ok) {
    cache = next;
    cacheAt = Date.now();
  }
  return ok ? next : null;
}

export function coachStatusCached() {
  return cache || {};
}
