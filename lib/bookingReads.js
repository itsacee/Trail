// Authoritative booking reads for Preview Postgres cutover.
// When BOOKING_READS_ENABLED=1: Postgres is required (fail closed).
// While BOOKING_WRITES_ENABLED=0: Blob-only rows are bridged in so dual-period
// Blob writes remain visible — never as a substitute when Postgres is down.

import { loadLessons } from "./lessons.js";
import { loadHolds } from "./holds.js";
import { loadManualBookings } from "./manualBookings.js";
import {
  bookingReadsActive,
  bookingWritesActive,
  loadPostgresBookingSnapshots,
  mergeBlobBridge,
} from "./bookingDb/readSnapshots.js";

export { bookingReadsActive, bookingWritesActive };

export async function loadAuthoritativeLessons(env = process.env) {
  if (!bookingReadsActive(env)) return loadLessons();
  const snaps = await loadPostgresBookingSnapshots(env);
  if (bookingWritesActive(env)) return snaps.lessons;
  const blob = await loadLessons();
  return mergeBlobBridge(snaps.lessons, blob, { key: "lessons" });
}

export async function loadAuthoritativeManual(env = process.env) {
  if (!bookingReadsActive(env)) return loadManualBookings();
  const snaps = await loadPostgresBookingSnapshots(env);
  if (bookingWritesActive(env)) return snaps.manual;
  const blob = await loadManualBookings();
  return mergeBlobBridge(snaps.manual, blob, { key: "manual" });
}

export async function loadAuthoritativeHolds(env = process.env) {
  if (!bookingReadsActive(env)) return loadHolds();
  const snaps = await loadPostgresBookingSnapshots(env);
  if (bookingWritesActive(env)) return snaps.holds;
  const blob = await loadHolds();
  return mergeBlobBridge(snaps.holds, blob, { key: "holds" });
}

/** Load lessons + manual (+ holds) together with one Postgres round-trip when reads on. */
export async function loadAuthoritativeBookingState(env = process.env) {
  if (!bookingReadsActive(env)) {
    const [lessons, manual, holds] = await Promise.all([
      loadLessons(),
      loadManualBookings(),
      loadHolds(),
    ]);
    return { lessons, manual, holds, origin: "blob" };
  }
  const snaps = await loadPostgresBookingSnapshots(env);
  if (bookingWritesActive(env)) {
    return {
      lessons: snaps.lessons,
      manual: snaps.manual,
      holds: snaps.holds,
      origin: "postgres",
    };
  }
  const [blobLessons, blobManual, blobHolds] = await Promise.all([
    loadLessons(),
    loadManualBookings(),
    loadHolds(),
  ]);
  return {
    lessons: mergeBlobBridge(snaps.lessons, blobLessons, { key: "lessons" }),
    manual: mergeBlobBridge(snaps.manual, blobManual, { key: "manual" }),
    holds: mergeBlobBridge(snaps.holds, blobHolds, { key: "holds" }),
    origin: "postgres+blob_bridge",
  };
}
