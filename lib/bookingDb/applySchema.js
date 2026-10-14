import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(HERE, "../../db/schema.sql");

export function loadSchemaSql() {
  return readFileSync(SCHEMA_PATH, "utf8");
}

/** Apply schema.sql to a pg Client / Pool client. */
export async function applyBookingSchema(client) {
  const sql = loadSchemaSql();
  await client.query(sql);
  return { ok: true };
}
