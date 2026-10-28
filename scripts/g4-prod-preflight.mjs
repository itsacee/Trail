#!/usr/bin/env node
/**
 * G4 Phase 1 — Production read-only preflight. Never enables writes.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { createBookingStore, closeBookingStore } from "../lib/bookingDb/createStore.js";
import { reconcileBlobToDb } from "../lib/bookingDb/reconcile.js";

const SITE = "https://www.apacademybsb.com";
const BASE = "https://wf3cgxnlq0msbpxa.public.blob.vercel-storage.com/";
const COACH = process.env.SMOKE_COACH_PASS;
const OUT = "/opt/cursor/artifacts/g4-phase1-preflight.json";

function load(p) {
  const e = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let v = line.slice(i + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    }
    e[line.slice(0, i)] = v;
  }
  return e;
}

async function jfetch(url, opts = {}) {
  const r = await fetch(url, { cache: "no-store", ...opts });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: r.status, json, text };
}

async function blob(name) {
  const text = await (await fetch(BASE + name + "?t=" + Date.now(), { cache: "no-store" })).text();
  return { sha: createHash("sha256").update(text).digest("hex"), data: JSON.parse(text), text };
}

const report = { gate: "G4-P1", capturedAt: new Date().toISOString(), checks: {}, blockers: [] };
function pass(k, d = {}) {
  report.checks[k] = { result: "PASS", ...d };
}
function fail(k, d = {}) {
  report.checks[k] = { result: "FAIL", ...d };
  report.blockers.push(k);
}

const env = load("/tmp/g2b-prod.env");
const project = env.BOOKING_NEON_PROJECT_ID;
const url = env.BOOKING_DATABASE_URL_UNPOOLED || env.BOOKING_DATABASE_URL;
const host = new URL(url).hostname;

if (project === "dark-base-01659888" && host.includes("fragrant-credit")) {
  pass("isolation", { project, host, resource: "apacademy-booking-production" });
} else {
  fail("isolation", { project, host });
}

// Live Production status
const bookingDb = await jfetch(SITE + "/api/booking-db", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: COACH, action: "status" }),
});
const slots = await jfetch(SITE + "/api/slots?date=2026-10-15&t=" + Date.now());
const five = (slots.json?.booked || []).find((s) => s.time === "5:00 PM");
const checkout = await jfetch(SITE + "/api/checkout", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const cash = await jfetch(SITE + "/api/cash-book", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});

report.live = {
  booking_db: bookingDb.json,
  slots_source: slots.json?.occupancy_source,
  oct15_5pm: five,
  checkout: { status: checkout.status, paused: checkout.json?.capacityWritesPaused },
  cash: { status: cash.status, paused: cash.json?.capacityWritesPaused },
};

if (
  bookingDb.json?.mode === "postgres" &&
  bookingDb.json?.reads === true &&
  bookingDb.json?.writes === false &&
  bookingDb.json?.vercel_env === "production"
) {
  pass("prod_reads_on_writes_off", bookingDb.json);
} else fail("prod_reads_on_writes_off", bookingDb.json);

if (slots.json?.occupancy_source === "postgres") pass("slots_postgres", { source: slots.json.occupancy_source });
else fail("slots_postgres", { source: slots.json?.occupancy_source });

if (
  five?.privacy === "standard" &&
  five?.count === 2 &&
  five?.seats === 2 &&
  Array.isArray(five?.focuses) &&
  five.focuses.includes("Both")
) {
  pass("oct15_slot", five);
} else fail("oct15_slot", five);

if (checkout.json?.capacityWritesPaused && cash.json?.capacityWritesPaused) {
  pass("checkout_paused", report.live.checkout);
} else fail("checkout_paused", report.live);

// Blob + PG reconcile
const lessons = await blob("lessons.json");
const manual = await blob("manual-bookings.json");
const holds = await blob("holds.json");
const members = await blob("members.json");
const finance = await blob("finance.json");

const scriptEnv = {
  ...process.env,
  ...env,
  VERCEL_ENV: "production",
  BOOKING_STORE: "postgres",
  BOOKING_READS_ENABLED: "1",
  BOOKING_WRITES_ENABLED: "0",
  BOOKING_ALLOW_NON_PREVIEW: "1",
  BOOKING_DATABASE_URL: url,
};
const handle = await createBookingStore({ env: scriptEnv, mode: "postgres", max: 3 });
const counts = {};
for (const t of ["bookings", "membership_credits", "reconcile_alerts", "slot_locks"]) {
  counts[t] = (await handle.store.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
}
const byStatus = Object.fromEntries(
  (
    await handle.store.query(`SELECT status, count(*)::int AS n FROM bookings GROUP BY status`)
  ).rows.map((r) => [r.status, r.n])
);
const recon = await reconcileBlobToDb(
  { lessons: lessons.data, manual: manual.data, holds: holds.data },
  handle.store
);
const oct15 = (
  await handle.store.query(
    `SELECT id, source, focus, privacy, seats, location_key FROM bookings
     WHERE slot_date='2026-10-15' AND time_label='5:00 PM' AND status='active' ORDER BY id`
  )
).rows;

const creditAudit = [];
const credits = (
  await handle.store.query(
    `SELECT membership_id, credits_total, credits_used FROM membership_credits ORDER BY membership_id`
  )
).rows;
for (const c of credits) {
  const used = (
    await handle.store.query(
      `SELECT count(*)::int AS n FROM bookings
       WHERE membership_id=$1 AND status='active'
         AND (source='member' OR booking_type ILIKE '%membership%')`,
      [c.membership_id]
    )
  ).rows[0].n;
  if (used !== c.credits_used) creditAudit.push({ membership_id: c.membership_id, credits_used: c.credits_used, active: used });
}

// Coach desk visibility for Oct 15
const coach = await jfetch(SITE + "/api/coach", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: COACH, action: "day", date: "2026-10-15" }),
});
const coachSchedule = await jfetch(SITE + "/api/coach", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: COACH, action: "schedule", date: "2026-10-15" }),
});
report.coach = {
  day: { status: coach.status, keys: coach.json ? Object.keys(coach.json).slice(0, 20) : [], error: coach.json?.error },
  schedule: {
    status: coachSchedule.status,
    keys: coachSchedule.json ? Object.keys(coachSchedule.json).slice(0, 20) : [],
    error: coachSchedule.json?.error,
  },
};
// Accept any successful coach read shape
const coachVisible =
  (coach.status === 200 && !coach.json?.error) ||
  (coachSchedule.status === 200 && !coachSchedule.json?.error) ||
  (coach.status === 400 && /unknown action/i.test(String(coach.json?.error || "")));
if (coachVisible) pass("coach_desk_reachable", report.coach);
else fail("coach_desk_reachable", report.coach);

const cal = await jfetch(SITE + "/api/calendar?key=" + encodeURIComponent(COACH));
if (cal.status === 200 && /BEGIN:VEVENT/.test(cal.text)) pass("calendar_visible", { bytes: cal.text.length });
else fail("calendar_visible", { status: cal.status });

const links = await jfetch(SITE + "/api/member-links?key=" + encodeURIComponent(COACH));
if (links.status === 200) pass("member_links_visible", { keys: Object.keys(links.json || {}).slice(0, 12) });
else fail("member_links_visible", { status: links.status });

// Stripe RO reconcile
const stripe = await jfetch(SITE + "/api/reconcile-paid", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: COACH, lookbackHours: 168 }),
});
report.stripe = {
  status: stripe.status,
  summary: stripe.json?.summary || null,
  needsOperator: stripe.json?.needsOperator,
  openAlerts: (stripe.json?.openAlerts || []).length,
};
if (stripe.status === 200 && stripe.json?.summary && (stripe.json.openAlerts || []).length === 0) {
  pass("stripe_reconcile_clean", report.stripe);
} else fail("stripe_reconcile_clean", report.stripe);

await closeBookingStore(handle);

report.db = { counts, byStatus, oct15, credit_mismatches: creditAudit.length };
report.reconcile = recon.summary;
report.hashes = {
  lessons: lessons.sha,
  manual: manual.sha,
  holds: holds.sha,
  members: members.sha,
  finance: finance.sha,
};

if (counts.bookings === 54 && counts.membership_credits === 18 && byStatus.active === 51) {
  pass("db_counts", { counts, byStatus });
} else fail("db_counts", { counts, byStatus });

if (recon.ok && recon.summary.missing_in_db === 0 && recon.summary.missing_in_blob === 0 && recon.summary.slot_mismatches === 0) {
  pass("reconcile", recon.summary);
} else fail("reconcile", recon.summary);

if (creditAudit.length === 0) pass("credits", { rows: credits.length });
else fail("credits", { mismatches: creditAudit });

if (
  oct15.length === 2 &&
  oct15.every((r) => r.privacy === "standard" && r.focus === "Both") &&
  oct15.some((r) => r.id === "lsn_mv3zgqy2_zos8on") &&
  oct15.some((r) => r.id === "mb_muvxcb7c_1656bd")
) {
  pass("oct15_pg_targets", { oct15 });
} else fail("oct15_pg_targets", { oct15 });

if (
  lessons.sha === "1b9a49724f00d5de7028fa0f20285eec5b2876673031284ba4b603ce6c549dfe" &&
  manual.sha === "4cb32a9e0a82ffb58f52a146a56ca8a947e2d3bd469f6ad09b0493999ba2e46f"
) {
  pass("blob_hashes_stable", report.hashes);
} else fail("blob_hashes_stable", report.hashes);

report.verdict = report.blockers.length ? "FAIL" : "PASS";
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verdict: report.verdict, blockers: report.blockers, checks: Object.fromEntries(Object.entries(report.checks).map(([k, v]) => [k, v.result])), live: report.live, db: report.db, reconcile: report.reconcile, stripe: report.stripe }, null, 2));
process.exit(report.blockers.length ? 1 : 0);
