// Returns the times already booked (paid) for a given date, so the
// booking widget can gray them out.
//
// Occupancy sources depend on Preview BookingStore flags:
// - Default (Blob): Stripe paid search + Blob lessons/holds/manual
// - BOOKING_READS_ENABLED=1: Postgres owns lesson/manual/hold rows from the
//   store (fail closed). Blob lessons/manual and Stripe paid search are not
//   merged — those would hide missing Postgres rows.
// - While BOOKING_WRITES_ENABLED=0, checkout still writes holds to Blob, so
//   Blob holds + Stripe open Checkout sessions remain visible.

import {
  durationFor,
  seatsFor,
  resolvePrivacy,
  normalizePrivacy,
  SLOT_CAPACITY,
} from "../lib/schedule.js";
import { loadLessons, lessonsOnDate, isVoided } from "../lib/lessons.js";
import { HOLD_MINUTES, loadHolds, holdsOnDate } from "../lib/holds.js";
import { loadManualBookings, bookingsOnDate } from "../lib/manualBookings.js";
import { isCoachPass } from "../lib/coachAuth.js";
import { storeConfigured, StorageUnavailableError } from "../lib/store.js";
import { bookingReadsEnabled, bookingWritesEnabled } from "../lib/bookingDb/flags.js";
import { occupancyHasStripeSource } from "../lib/bookingDb/stripePaidReconcile.js";
import { loadDbOccupancy } from "../lib/bookingStore.js";

function assertCapacityReadable(data, label) {
  if (!storeConfigured()) return;
  if (data?._readFailed || data?._unreachable) {
    throw new StorageUnavailableError(
      `Couldn't read ${label} from booking storage. Open times were not replaced with an empty schedule.`
    );
  }
}

const ACTIVE_SUBSCRIPTION = ["active", "trialing", "past_due"];

// How many of the hour's two athlete seats a booking occupies.
// Private (type or privacy) takes both. Legacy Both-without-privacy is treated
// as private. Standard Both with privacy:"standard" takes its seat count only.
function seatsOn(row) {
  const type = String(row?.type || "");
  const privacy = resolvePrivacy({ type, focus: row?.focus, privacy: row?.privacy });
  if (privacy === "private") return SLOT_CAPACITY;
  const explicit = Number(row?.seats);
  if (explicit > 0) return Math.min(SLOT_CAPACITY, explicit);
  return seatsFor(type, row?.athletes);
}

// Returns [{ time: "5:00 PM", mins: 60, sources: [...] }] — each taken slot with
// how long it runs, so callers can block overlapping start times (a 1-hour
// lesson blocks both the hour and the half-hour that follow it).
// `ignoreHold` is the caller's own checkout session. Without it a parent who
// backs out of payment and tries again is blocked by the hold they just
// created — the slot they were about to buy reads as taken, to them, for the
// full hold window.
export async function bookedTimes(
  key,
  date,
  { ignoreHold = "", ignoreSourceId = "", holdBefore = null } = {}
) {
  const byTime = new Map(); // time label -> { mins, sources }
  const readsDb = bookingReadsEnabled();
  const writesDb = bookingWritesEnabled();
  // Reads-on: Postgres owns lesson/manual occupancy. Do not merge Blob lessons
  // (those would hide missing Postgres rows). Stripe *paid* search stays on as
  // a safety net so paid-but-unmirrored seats cannot disappear after hold TTL;
  // duplicates against Postgres source_ref / `${pi}-N` ids are skipped.
  // Writes-off: checkout still writes holds to Blob + Stripe open sessions, so
  // keep those hold sources until BOOKING_WRITES_ENABLED=1.
  const skipBlobCapacity = readsDb || writesDb;
  const skipStripePaidSearch = false;
  const keepBlobHolds = !writesDb;
  const dbFailClosed = readsDb || writesDb;

  const stored = skipBlobCapacity ? { lessons: [], voids: [] } : await loadLessons();
  if (!skipBlobCapacity) assertCapacityReadable(stored, "lessons.json");

  const add = (time, mins, source) => {
    if (!time) return;
    const cur = byTime.get(time) || { mins: 0, sources: [] };
    cur.mins = Math.max(cur.mins, mins);
    if (
      source &&
      !cur.sources.some((existing) => existing.kind === source.kind && existing.id === source.id)
    ) {
      cur.sources.push(source);
    }
    byTime.set(time, cur);
  };

  const holdIsEarlier = (created, id) => {
    if (!holdBefore) return true;
    const boundary = Number(holdBefore.created) || 0;
    const at = Number(created) || 0;
    if (at !== boundary) return at < boundary;
    return String(id || "") < String(holdBefore.id || "");
  };

  const search = async (resource, query, pick) => {
    const url = `https://api.stripe.com/v1/${resource}/search?query=${encodeURIComponent(query)}&limit=100`;
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    } catch {
      // Network blip — keep blob/holds so the calendar still loads.
      return;
    }
    // Prefetching a full month used to fire dozens of searches at once and
    // Stripe rate-limited them (429/503). Soft-skip that query instead of
    // failing the whole day — parents were seeing errors on later weeks.
    if (!res.ok) return;
    ((await res.json()).data || []).forEach((item) => {
      if (resource === "subscriptions" && !ACTIVE_SUBSCRIPTION.includes(item.status)) return;
      const m = item.metadata || {};
      const { time, mins } = pick(m);
      if (ignoreSourceId && item.id === ignoreSourceId) return;
      // Member moved/cancelled this Stripe signup slot — don't keep it blocked.
      if (isVoided(stored, { sourceId: item.id, date, time })) return;
      const existing = (byTime.get(time) || { sources: [] }).sources;
      // Already mirrored into Postgres (or previously added) — do not double-seat.
      if (occupancyHasStripeSource(existing, item.id)) return;
      add(time, mins, {
        kind: "paid",
        id: item.id,
        sourceRef: item.id,
        player: m.player || "",
        player2: m.player2 || "",
        type: m.type || "",
        focus: m.focus || "",
        privacy: normalizePrivacy(m.privacy) || resolvePrivacy({ type: m.type, focus: m.focus, privacy: m.privacy }),
        seats: seatsOn({ type: m.type, seats: m.seats, athletes: m.athletes, focus: m.focus, privacy: m.privacy }),
        created: item.created || 0,
        unmirroredSafetyNet: readsDb || writesDb,
      });
    });
  };

  const dur = (m) => durationFor(m.type);
  // When Postgres owns occupancy, load PG first then apply Stripe paid search
  // so unmirrored payments can be deduped against `${pi}-N` / source_ref.
  const deferStripePaidForDb = readsDb || writesDb;
  const stripePaidQueries = () => {
    const out = [];
    for (let i = 1; i <= 4; i++) {
      out.push(
        search("payment_intents", `status:'succeeded' AND metadata['date${i}']:'${date}'`, (m) => ({ time: m[`time${i}`], mins: dur(m) })),
        search("subscriptions", `metadata['date${i}']:'${date}'`, (m) => ({ time: m[`time${i}`], mins: dur(m) }))
      );
    }
    out.push(
      search("payment_intents", `status:'succeeded' AND metadata['date']:'${date}'`, (m) => ({ time: m.time, mins: dur(m) })),
      search("subscriptions", `metadata['date']:'${date}'`, (m) => ({ time: m.time, mins: dur(m) }))
    );
    return out;
  };
  const queries = [];
  if (!skipStripePaidSearch && !deferStripePaidForDb) {
    queries.push(...stripePaidQueries());
  }

  // Open Stripe Checkout Sessions — keep while Blob/Stripe still own holds.
  if (keepBlobHolds) {
    queries.push(
      (async () => {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const since = nowSeconds - (HOLD_MINUTES + 1) * 60;
        const url =
          `https://api.stripe.com/v1/checkout/sessions?limit=100&status=open` +
          `&created[gte]=${since}`;
        let res;
        try {
          res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
        } catch {
          return;
        }
        if (!res.ok) return;
        ((await res.json()).data || [])
          .filter(
            (session) =>
              session.status === "open" &&
              Number(session.expires_at || 0) > nowSeconds &&
              (!ignoreHold || session.id !== ignoreHold) &&
              holdIsEarlier(Number(session.created || 0) * 1000, session.id)
          )
          .forEach((session) => {
            const m = session.metadata || {};
            const source = {
              kind: "hold",
              id: session.id,
              type: m.type || "",
              focus: m.focus || "",
              privacy: normalizePrivacy(m.privacy) || resolvePrivacy({ type: m.type, focus: m.focus, privacy: m.privacy }),
              seats: seatsOn({ type: m.type, seats: m.seats, athletes: m.athletes, focus: m.focus, privacy: m.privacy }),
              createdAt: Number(session.created || 0) * 1000,
              expiresAt: Number(session.expires_at || 0) * 1000,
            };
            let found = false;
            for (let i = 1; i <= 4; i++) {
              if (m[`date${i}`] !== date || !m[`time${i}`]) continue;
              found = true;
              add(m[`time${i}`], durationFor(m.type), source);
            }
            if (!found && m.date === date && m.time) {
              add(m.time, durationFor(m.type), source);
            }
          });
      })()
    );
  }

  await Promise.all(queries);

  if (!skipBlobCapacity) {
    lessonsOnDate(stored, date)
      .filter((l) => !isVoided(stored, l))
      .filter(
        (l) =>
          !ignoreSourceId ||
          (l.id !== ignoreSourceId && l.sourceId !== ignoreSourceId)
      )
      .forEach((l) =>
        add(l.time, durationFor(l.type || "membership"), {
          kind: l.source === "stripe" ? "paid" : "member",
          id: l.source === "stripe" ? l.sourceId || l.id : l.id,
          player: l.player || "",
          email: l.email || "",
          type: l.type || "membership",
          focus: l.focus || "",
          privacy:
            normalizePrivacy(l.privacy) ||
            resolvePrivacy({ type: l.type || "membership", focus: l.focus, privacy: l.privacy }),
          seats: seatsOn({
            type: l.type || "membership",
            seats: l.seats,
            athletes: l.athletes,
            focus: l.focus,
            privacy: l.privacy,
          }),
          createdAt: l.createdAt || 0,
        })
      );

    const manual = await loadManualBookings();
    assertCapacityReadable(manual, "manual-bookings.json");
    bookingsOnDate(manual, date)
      .filter((b) => !ignoreSourceId || b.id !== ignoreSourceId)
      .forEach((b) =>
        add(b.time, durationFor(b.type || "single"), {
          kind: "cash",
          id: b.id,
          player: b.player || "",
          player2: b.player2 || "",
          email: b.email || "",
          type: b.type || "single",
          focus: b.focus || "",
          privacy:
            normalizePrivacy(b.privacy) ||
            resolvePrivacy({ type: b.type || "single", focus: b.focus, privacy: b.privacy }),
          seats: seatsOn({
            type: b.type || "single",
            seats: b.seats,
            athletes: b.athletes,
            focus: b.focus,
            privacy: b.privacy,
          }),
          createdAt: b.createdAt || 0,
        })
      );
  }

  // Blob holds while checkout still writes holds to Blob (!writesDb).
  if (keepBlobHolds) {
    const holds = await loadHolds();
    assertCapacityReadable(holds, "holds.json");
    holdsOnDate(holds, date)
      .filter((h) => !ignoreHold || h.sessionId !== ignoreHold)
      .filter((h) => holdIsEarlier(h.createdAt || 0, h.sessionId))
      .forEach((h) =>
        add(h.time, h.mins || 60, {
          kind: "hold",
          id: h.sessionId,
          type: h.type || "",
          focus: h.focus || "",
          privacy:
            normalizePrivacy(h.privacy) ||
            resolvePrivacy({ type: h.type, focus: h.focus, privacy: h.privacy }),
          seats: seatsOn({ type: h.type, seats: h.seats, athletes: h.athletes, focus: h.focus, privacy: h.privacy }),
          expiresAt: h.expiresAt,
          expiresInMin: Math.max(0, Math.round((h.expiresAt - Date.now()) / 60000)),
        })
      );
  }

  // Postgres occupancy when reads (or writes) are enabled — fail closed.
  if (readsDb || writesDb) {
    try {
      const dbRows = await loadDbOccupancy(date, { ignoreHold });
      if (!Array.isArray(dbRows)) {
        throw new Error("db_occupancy_invalid");
      }
      for (const row of dbRows) {
        if (ignoreSourceId && row.id === ignoreSourceId) continue;
        const kind =
          row.source === "hold"
            ? "hold"
            : row.source === "manual"
              ? "cash"
              : row.source === "stripe"
                ? "paid"
                : "member";
        add(row.time, row.mins || 60, {
          kind,
          id: row.id,
          sourceRef: row.sourceRef || "",
          type: row.booking_type || "",
          focus: row.focus || (row.focuses && row.focuses[0]) || "",
          privacy: row.privacy || "",
          seats: Number(row.seats) || 1,
          exclusive: Boolean(row.exclusive),
          origin: "postgres",
        });
      }
    } catch {
      if (dbFailClosed) {
        throw new StorageUnavailableError(
          "Couldn't read bookings from the database. Open times were not replaced with an empty schedule."
        );
      }
    }
  }

  // Paid-but-unmirrored safety net (after Postgres rows are present for dedupe).
  if (!skipStripePaidSearch && deferStripePaidForDb) {
    await Promise.all(stripePaidQueries());
  }

  return [...byTime.entries()].map(([time, v]) => {
    const seats = v.sources.reduce((n, source) => n + (Number(source.seats) || 1), 0);
    const focuses = [...new Set(v.sources.map((source) => source.focus || "").filter(Boolean))];
    const privacies = [...new Set(v.sources.map((source) => normalizePrivacy(source.privacy)).filter(Boolean))];
    const privacy = privacies.length === 1 ? privacies[0] : privacies.includes("private") ? "private" : "";
    // Private privacy, private type seats, or a full standard hour.
    const exclusive =
      seats >= SLOT_CAPACITY ||
      privacy === "private" ||
      v.sources.some((source) => resolvePrivacy(source) === "private");
    return {
      time,
      mins: v.mins,
      count: v.sources.length,
      seats,
      exclusive,
      privacy: exclusive && privacy !== "standard" ? privacy || "private" : privacy || (exclusive ? "" : "standard"),
      focuses,
      sources: v.sources,
      occupancy_source: readsDb || writesDb ? "postgres" : "blob",
    };
  });
}

export default async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const date = String(req.query?.date || "").slice(0, 10);
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(200).json({ booked: [] });
    return;
  }
  const isCoach = isCoachPass(req.query?.key);
  // The browser passes back the checkout it last started, so someone who
  // abandoned payment doesn't see their own hold sitting on the slot.
  const mine = /^cs_[A-Za-z0-9_]+$/.test(String(req.query?.mine || "")) ? String(req.query.mine) : "";
  try {
    const booked = await bookedTimes(key, date, { ignoreHold: mine });
    const occupancySource = bookingReadsEnabled() || bookingWritesEnabled() ? "postgres" : "blob";
    res.status(200).json({
      date,
      occupancy_source: occupancySource,
      // Names and ids stay private unless the coach asked.
      booked: isCoach
        ? booked
        : booked.map(({ time, mins, count, seats, exclusive, privacy, focuses }) => ({
            time,
            mins,
            count,
            seats,
            exclusive,
            privacy,
            focuses,
          })),
    });
  } catch {
    res.status(503).json({
      error: "Couldn't confirm open times. Please try again shortly.",
      code: "schedule_unavailable",
    });
  }
}
