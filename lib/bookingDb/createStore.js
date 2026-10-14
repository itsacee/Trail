import pg from "pg";
import { newDb } from "pg-mem";
import { applyBookingSchema } from "./applySchema.js";
import { PostgresBookingStore } from "./postgresStore.js";
import { assertPreviewDbAllowed, bookingDatabaseUrl, bookingStoreMode } from "./flags.js";

/**
 * Create a BookingStore.
 * - mode memory / unset DATABASE_URL in tests → pg-mem (in-process SQL)
 * - mode postgres + BOOKING_DATABASE_URL → real pg Pool
 */
export async function createBookingStore(options = {}) {
  const env = options.env || process.env;
  const mode = options.mode || bookingStoreMode(env);

  if (mode === "blob") {
    return { store: null, mode: "blob", pool: null };
  }

  const preview = assertPreviewDbAllowed(env);
  if (!preview.ok && mode === "postgres") {
    const err = new Error(preview.reason);
    err.code = preview.reason;
    throw err;
  }

  if (mode === "memory" || options.useMem) {
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    const { Pool } = mem.adapters.createPg();
    const pool = new Pool();
    const client = await pool.connect();
    try {
      await applyBookingSchema(client);
    } finally {
      client.release();
    }
    const store = new PostgresBookingStore(pool, { now: options.now });
    return { store, mode: "memory", pool, mem };
  }

  // mode === "postgres"
  const url = bookingDatabaseUrl(env);
  if (!url) {
    const err = new Error("missing_booking_database_url");
    err.code = "missing_booking_database_url";
    throw err;
  }

  const pool = new pg.Pool({ connectionString: url, max: options.max || 5 });
  const client = await pool.connect();
  try {
    await applyBookingSchema(client);
  } finally {
    client.release();
  }
  const store = new PostgresBookingStore(pool, { now: options.now });
  return { store, mode: "postgres", pool };
}

export async function closeBookingStore(handle) {
  if (handle?.pool?.end) await handle.pool.end();
}
