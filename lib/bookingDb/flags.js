// Feature flags for the Postgres booking store.
// Defaults keep Blob paths authoritative and all DB writes disabled until
// Preview tests + reconciliation + explicit operator approval.

export function bookingStoreMode(env = process.env) {
  const mode = String(env.BOOKING_STORE || "blob").trim().toLowerCase();
  if (mode === "postgres" || mode === "pg" || mode === "memory") return mode === "pg" ? "postgres" : mode;
  return "blob";
}

/** DB reads for occupancy / coach / member calendars. */
export function bookingReadsEnabled(env = process.env) {
  if (bookingStoreMode(env) === "blob") return false;
  return env.BOOKING_READS_ENABLED === "1";
}

/**
 * DB writes for holds / confirm / member / coach.
 * Requires an explicit second flag so importing Preview data cannot
 * accidentally open customer-facing writes.
 */
export function bookingWritesEnabled(env = process.env) {
  if (bookingStoreMode(env) === "blob") return false;
  if (env.BOOKING_WRITES_ENABLED !== "1") return false;
  // Never dual-write Production Blob from this path.
  if (env.BOOKING_DUAL_WRITE_BLOB === "1") return false;
  return true;
}

/**
 * True when Postgres owns booking capacity rows (reads and/or writes).
 * Collect/outstanding must not fall back to Blob while this is true —
 * manuals created under BOOKING_WRITES live only in Postgres.
 */
export function bookingPostgresAuthoritative(env = process.env) {
  return bookingReadsEnabled(env) || bookingWritesEnabled(env);
}

export function bookingDatabaseUrl(env = process.env) {
  return String(env.BOOKING_DATABASE_URL || env.DATABASE_URL || "").trim();
}

/** Preview guard: refuse Production Vercel env unless explicitly overridden (tests). */
export function assertPreviewDbAllowed(env = process.env) {
  if (env.BOOKING_ALLOW_NON_PREVIEW === "1") return { ok: true };
  const vercelEnv = String(env.VERCEL_ENV || "");
  if (vercelEnv === "production") {
    return { ok: false, reason: "production_db_blocked" };
  }
  return { ok: true };
}
