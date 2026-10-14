#!/usr/bin/env node
// Controlled Preview write smoke S1–S12. Disposable future dates only.
// Usage:
//   SMOKE_DEPLOY_URL=https://… SMOKE_COACH_PASS=… \
//   npx vercel env run -e preview --git-branch cursor/booking-postgres-full-f621 -- \
//     node scripts/smoke-preview-writes.mjs

import { spawnSync } from "node:child_process";
import { getBookingStore, resetBookingStoreCache } from "../lib/bookingStore.js";
import { signMemberToken } from "../lib/memberAuth.js";

const DEPLOY = process.env.SMOKE_DEPLOY_URL;
const COACH = process.env.SMOKE_COACH_PASS || process.env.COACH_PASS;

if (!DEPLOY || !COACH) {
  console.error("SMOKE_DEPLOY_URL and coach pass required");
  process.exit(2);
}

const results = [];
const createdIds = [];
let stopped = false;

function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id}: ${detail}`);
  if (!pass) stopped = true;
}

function vercelCurl(path, { method = "GET", body } = {}) {
  const args = ["vercel", "curl", path, "--deployment", DEPLOY, "--yes", "--"];
  if (method !== "GET") {
    args.push("-X", method, "-H", "Content-Type: application/json", "-d", JSON.stringify(body || {}));
  }
  const run = spawnSync("npx", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const out = `${run.stdout || ""}\n${run.stderr || ""}`;
  const brace = out.indexOf("{");
  const bracket = out.indexOf("[");
  let start = -1;
  if (brace >= 0 && bracket >= 0) start = Math.min(brace, bracket);
  else start = Math.max(brace, bracket);
  const text = start >= 0 ? out.slice(start).trim() : out.trim();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // try last json-looking line
    const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
    if (lines.length) {
      try {
        json = JSON.parse(lines[lines.length - 1]);
      } catch {
        /* ignore */
      }
    }
  }
  // Infer status from body
  let status = json ? 200 : 500;
  if (json?.error && !json?.ok && !json?.sessions) {
    if (String(json.code || "").includes("slot") || /taken|full|focus/i.test(json.error || "")) status = 409;
    else if (/not found/i.test(json.error || "")) status = 404;
    else if (json.code === "schedule_unavailable") status = 503;
    else status = 400;
  }
  if (json?.ok === true) status = 200;
  if (json?.ok === false && status === 200) status = 400;
  return { status, json, text: text.slice(0, 400), rawTail: out.slice(-200) };
}

function coach(action, fields = {}) {
  return vercelCurl("/api/coach", {
    method: "POST",
    body: { key: COACH, action, ...fields },
  });
}

function slots(date) {
  return vercelCurl(`/api/slots?date=${date}&key=${encodeURIComponent(COACH)}`);
}

function cancelId(id) {
  return coach("cancel_booking", { id });
}

function bookCash({ date, time, focus, type = "single", player, email, note }) {
  const r = coach("create_booking", {
    date,
    time,
    focus,
    type,
    player,
    email,
    paymentMethod: "cash",
    note: note || "smoke-test-disposable",
    force: true,
  });
  const booking = r.json?.booking;
  if (booking?.id) createdIds.push(booking.id);
  return r;
}

async function pgActiveOn(date, time) {
  const store = await getBookingStore(process.env);
  const { rows } = await store.query(
    `SELECT id, source, status, focus, privacy, seats, booking_type, email, player
     FROM bookings
     WHERE slot_date = $1::date AND time_label = $2 AND status = 'active'
     ORDER BY id`,
    [date, time]
  );
  return rows;
}

function denied(r) {
  if (!r.json) return false;
  if (r.json.ok === false) return true;
  if (r.status === 409) return true;
  const err = String(r.json.error || r.json.code || "");
  return /taken|full|focus|unavailable|slot_/i.test(err);
}

async function main() {
  // Ensure store flags match Preview writes-on
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "1";
  process.env.VERCEL_ENV = process.env.VERCEL_ENV || "preview";
  process.env.BOOKING_ALLOW_NON_PREVIEW = process.env.BOOKING_ALLOW_NON_PREVIEW || "1";
  await resetBookingStoreCache();

  const status = vercelCurl(`/api/booking-db?action=status&key=${encodeURIComponent(COACH)}`);
  if (!status.json?.writes || !status.json?.reads || status.json?.vercel_env !== "preview") {
    record("PRE", false, `bad status ${JSON.stringify(status.json)} raw=${status.rawTail}`);
    return finish();
  }
  record("PRE", true, JSON.stringify(status.json));

  // S1
  if (!stopped) {
    const date = "2026-12-07";
    const time = "6:00 PM";
    const a = bookCash({ date, time, focus: "Hitting", player: "Smoke Hit A", email: "smoke.hit.a@example.com" });
    const b = bookCash({ date, time, focus: "Hitting", player: "Smoke Hit B", email: "smoke.hit.b@example.com" });
    const c = bookCash({ date, time, focus: "Hitting", player: "Smoke Hit C", email: "smoke.hit.c@example.com" });
    const rows = await pgActiveOn(date, time);
    const sl = slots(date);
    const booked = (sl.json?.booked || []).find((x) => x.time === time);
    const pass =
      a.json?.ok && b.json?.ok && denied(c) && rows.length === 2 && sl.json?.occupancy_source === "postgres" && booked?.seats === 2;
    record("S1", !!pass, `okAB=${!!a.json?.ok}/${!!b.json?.ok} denyC=${denied(c)} pg=${rows.length} seats=${booked?.seats} src=${sl.json?.occupancy_source} cErr=${c.json?.error || c.json?.code}`);
    if (!pass) return finish();
  }

  // S2
  if (!stopped) {
    const date = "2026-12-07";
    const time = "7:00 PM";
    const a = bookCash({ date, time, focus: "Fielding", player: "Smoke Fld A", email: "smoke.fld.a@example.com" });
    const b = bookCash({ date, time, focus: "Fielding", player: "Smoke Fld B", email: "smoke.fld.b@example.com" });
    const c = bookCash({ date, time, focus: "Fielding", player: "Smoke Fld C", email: "smoke.fld.c@example.com" });
    const rows = await pgActiveOn(date, time);
    const pass = a.json?.ok && b.json?.ok && denied(c) && rows.length === 2;
    record("S2", !!pass, `okAB=${!!a.json?.ok}/${!!b.json?.ok} denyC=${denied(c)} pg=${rows.length}`);
    if (!pass) return finish();
  }

  // S3
  if (!stopped) {
    const date = "2026-12-14";
    const time = "6:00 PM";
    const a = bookCash({ date, time, focus: "Both", player: "Smoke Both A", email: "smoke.both.a@example.com" });
    const b = bookCash({ date, time, focus: "Both", player: "Smoke Both B", email: "smoke.both.b@example.com" });
    const miss = bookCash({ date, time, focus: "Hitting", player: "Smoke Both Miss", email: "smoke.both.miss@example.com" });
    const rows = await pgActiveOn(date, time);
    const pass = a.json?.ok && b.json?.ok && denied(miss) && rows.length === 2;
    record("S3", !!pass, `okAB=${!!a.json?.ok}/${!!b.json?.ok} denyMiss=${denied(miss)} pg=${rows.length} focuses=${rows.map((r) => r.focus)}`);
    if (!pass) return finish();
  }

  // S4
  if (!stopped) {
    const date = "2026-12-14";
    const time = "7:00 PM";
    const a = bookCash({
      date,
      time,
      focus: "Hitting",
      type: "private",
      player: "Smoke Priv Hit",
      email: "smoke.priv.hit@example.com",
    });
    const b = bookCash({
      date,
      time,
      focus: "Hitting",
      type: "single",
      player: "Smoke Priv Hit2",
      email: "smoke.priv.hit2@example.com",
    });
    const rows = await pgActiveOn(date, time);
    const pass = a.json?.ok && denied(b) && rows.length === 1;
    record("S4", !!pass, `priv=${!!a.json?.ok} deny=${denied(b)} pg=${rows.length} privacy=${rows[0]?.privacy}`);
    if (!pass) return finish();
  }

  // S5
  if (!stopped) {
    const date = "2026-12-21";
    const time = "6:00 PM";
    const a = bookCash({
      date,
      time,
      focus: "Fielding",
      type: "private",
      player: "Smoke Priv Fld",
      email: "smoke.priv.fld@example.com",
    });
    const b = bookCash({ date, time, focus: "Fielding", player: "Smoke Priv Fld2", email: "smoke.priv.fld2@example.com" });
    const rows = await pgActiveOn(date, time);
    const pass = a.json?.ok && denied(b) && rows.length === 1;
    record("S5", !!pass, `priv=${!!a.json?.ok} deny=${denied(b)} pg=${rows.length}`);
    if (!pass) return finish();
  }

  // S6
  if (!stopped) {
    const date = "2026-12-21";
    const time = "7:00 PM";
    const a = bookCash({
      date,
      time,
      focus: "Both",
      type: "private",
      player: "Smoke Priv Both",
      email: "smoke.priv.both@example.com",
    });
    const b = bookCash({ date, time, focus: "Both", player: "Smoke Priv Both2", email: "smoke.priv.both2@example.com" });
    const rows = await pgActiveOn(date, time);
    const pass = a.json?.ok && denied(b) && rows.length === 1;
    record("S6", !!pass, `priv=${!!a.json?.ok} deny=${denied(b)} pg=${rows.length}`);
    if (!pass) return finish();
  }

  // S7
  if (!stopped) {
    const date = "2026-12-28";
    const time = "6:00 PM";
    const drop = bookCash({
      date,
      time,
      focus: "Hitting",
      type: "single",
      player: "Smoke Mix Drop",
      email: "smoke.mix.drop@example.com",
    });
    const mem = bookCash({
      date,
      time,
      focus: "Hitting",
      type: "membership",
      player: "Smoke Mix Mem",
      email: "smoke.mix.mem@example.com",
    });
    const third = bookCash({
      date,
      time,
      focus: "Hitting",
      player: "Smoke Mix Third",
      email: "smoke.mix.third@example.com",
    });
    const rows = await pgActiveOn(date, time);
    const types = rows.map((r) => r.booking_type).sort();
    const pass = drop.json?.ok && mem.json?.ok && denied(third) && rows.length === 2 && types.includes("membership");
    record("S7", !!pass, `drop=${!!drop.json?.ok} mem=${!!mem.json?.ok} deny3=${denied(third)} pg=${rows.length} types=${types}`);
    if (!pass) return finish();
  }

  // S8
  if (!stopped) {
    const date = "2026-12-28";
    const time = "7:00 PM";
    const created = bookCash({
      date,
      time,
      focus: "Fielding",
      player: "Smoke Cancel Me",
      email: "smoke.cancel.me@example.com",
    });
    const id = created.json?.booking?.id;
    const before = await pgActiveOn(date, time);
    const cancelled = cancelId(id);
    const after = await pgActiveOn(date, time);
    const sl = slots(date);
    const still = (sl.json?.booked || []).find((x) => x.time === time);
    const pass = created.json?.ok && id && before.length >= 1 && cancelled.json?.ok && after.length === before.length - 1 && !still;
    record("S8", !!pass, `id=${id} cancelOk=${!!cancelled.json?.ok} before=${before.length} after=${after.length} slotGone=${!still}`);
    const idx = createdIds.indexOf(id);
    if (idx >= 0) createdIds.splice(idx, 1);
    if (!pass) return finish();
  }

  // S9 / S10
  if (!stopped) {
    const memEmail = "smoke.resched.member@example.com";
    const date = "2027-01-04";
    const time = "6:00 PM";
    const memBook = bookCash({
      date,
      time,
      focus: "Hitting",
      type: "membership",
      player: "Smoke Resched Kid",
      email: memEmail,
    });
    let memLessonId = memBook.json?.booking?.id;
    const openDate = "2027-01-05";
    const openTime = "6:00 PM";
    const blockDate = "2027-01-11";
    const blockTime = "6:00 PM";
    const blocker = bookCash({
      date: blockDate,
      time: blockTime,
      focus: "Hitting",
      type: "private",
      player: "Smoke Blocker",
      email: "smoke.blocker@example.com",
    });

    const token = signMemberToken(memEmail);
    const acct = vercelCurl(`/api/member?k=${encodeURIComponent(token)}`);
    // Find lesson id from account if needed
    const lessons = acct.json?.allLessons || acct.json?.scheduled || [];
    if (!memLessonId && lessons[0]?.id) memLessonId = lessons[0].id;

    const moveOk = vercelCurl("/api/member", {
      method: "POST",
      body: { k: token, action: "reschedule", id: memLessonId, date: openDate, time: openTime, focus: "Hitting" },
    });
    const afterOk = await pgActiveOn(openDate, openTime);
    const oldGone = await pgActiveOn(date, time);
    const s9 = memBook.json?.ok && !acct.json?.error && moveOk.json?.ok && afterOk.length === 1 && oldGone.length === 0;
    record(
      "S9",
      !!s9,
      `memOk=${!!memBook.json?.ok} acctErr=${acct.json?.error || ""} moveOk=${!!moveOk.json?.ok} moveErr=${moveOk.json?.error || moveOk.json?.code || ""} atOpen=${afterOk.length} old=${oldGone.length}`
    );
    if (!s9) return finish();

    const currentId = afterOk[0].id;
    const moveFail = vercelCurl("/api/member", {
      method: "POST",
      body: { k: token, action: "reschedule", id: currentId, date: blockDate, time: blockTime, focus: "Hitting" },
    });
    const stillAtOpen = await pgActiveOn(openDate, openTime);
    const blockRows = await pgActiveOn(blockDate, blockTime);
    const s10 = denied(moveFail) && stillAtOpen.length === 1 && blockRows.length === 1;
    record("S10", !!s10, `failDenied=${denied(moveFail)} err=${moveFail.json?.error || moveFail.json?.code} stillOpen=${stillAtOpen.length} block=${blockRows.length}`);
    createdIds.push(currentId);
    if (blocker.json?.booking?.id) createdIds.push(blocker.json.booking.id);
    if (memLessonId && memLessonId !== currentId) {
      const i = createdIds.indexOf(memLessonId);
      if (i >= 0) createdIds.splice(i, 1);
    }
    if (!s10) return finish();
  }

  // S11 idempotent confirmPaid on Preview DB (same path confirm/webhook use)
  if (!stopped) {
    const store = await getBookingStore(process.env);
    const date = "2027-01-18";
    const time = "6:00 PM";
    const sourceId = `pi_smoke_idem_${Date.now()}`;
    const meta = {
      date,
      time,
      focus: "Hitting",
      type: "single",
      privacy: "standard",
      email: "smoke.idem@example.com",
      player: "Smoke Idem",
    };
    const first = await store.confirmPaid({
      idempotencyKey: `mirror:${sourceId}`,
      sourceId,
      sessionId: `cs_smoke_${Date.now()}`,
      metadata: meta,
    });
    const second = await store.confirmPaid({
      idempotencyKey: `mirror:${sourceId}`,
      sourceId,
      sessionId: `cs_smoke_retry`,
      metadata: meta,
    });
    const rows = await pgActiveOn(date, time);
    const mine = rows.filter((r) => r.email === "smoke.idem@example.com");
    for (const id of first.bookingIds || []) createdIds.push(id);
    const sl = slots(date);
    const pass =
      first.ok && first.idempotent === false && second.ok && second.idempotent === true && mine.length === 1 && sl.json?.occupancy_source === "postgres";
    record("S11", !!pass, `first=${first.ok}/${first.idempotent} second=${second.ok}/${second.idempotent} rows=${mine.length} slotsSrc=${sl.json?.occupancy_source}`);
    if (!pass) return finish();
  }

  // S12 concurrent final seat
  if (!stopped) {
    const date = "2027-01-19";
    const time = "6:00 PM";
    bookCash({ date, time, focus: "Hitting", player: "Smoke Race Seed", email: "smoke.race.seed@example.com" });
    let seedRows = await pgActiveOn(date, time);
    const { spawn } = await import("node:child_process");
    const launch = (n) =>
      new Promise((resolve) => {
        const body = JSON.stringify({
          key: COACH,
          action: "create_booking",
          date,
          time,
          focus: "Hitting",
          type: "single",
          player: `Smoke Race ${n}`,
          email: `smoke.race.${n}@example.com`,
          paymentMethod: "cash",
          note: "smoke-test-disposable",
          force: true,
        });
        const child = spawn(
          "npx",
          ["vercel", "curl", "/api/coach", "--deployment", DEPLOY, "--yes", "--", "-X", "POST", "-H", "Content-Type: application/json", "-d", body],
          { encoding: "utf8" }
        );
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", () => {
          const i = out.indexOf("{");
          let json = null;
          try {
            json = JSON.parse(out.slice(i));
          } catch {
            /* ignore */
          }
          if (json?.booking?.id) createdIds.push(json.booking.id);
          resolve({ ok: !!json?.ok, json, out: out.slice(-180) });
        });
      });
    const [r1, r2] = await Promise.all([launch(1), launch(2)]);
    const rows = await pgActiveOn(date, time);
    const wins = [r1, r2].filter((r) => r.ok).length;
    const pass = seedRows.length + wins === 2 && rows.length === 2 && wins === 1;
    record("S12", !!pass, `seed=${seedRows.length} wins=${wins} r1=${r1.ok} r2=${r2.ok} pg=${rows.length}`);
  }

  return finish();
}

async function finish() {
  console.log("\n--- cleanup ---");
  for (const id of [...new Set(createdIds)]) {
    try {
      const r = cancelId(id);
      console.log("cancel", id, !!r.json?.ok, r.json?.error || "");
    } catch (e) {
      console.log("cancel_err", id, e.message);
    }
  }
  try {
    const store = await getBookingStore(process.env);
    const cleaned = await store.query(
      `UPDATE bookings
       SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE status IN ('active','held')
         AND email LIKE 'smoke.%@example.com'
         AND COALESCE(source_ref,'') NOT LIKE 'pi_3UP%'`
    );
    console.log("pg_smoke_cancel_rowcount", cleaned.rowCount);
  } catch (e) {
    console.log("pg_cleanup_err", e.message);
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id}: ${r.detail}`);
  const failed = results.filter((r) => !r.pass);
  console.log(failed.length ? `FAILED=${failed.length}` : "ALL_REPORTED_PASS");
  await resetBookingStoreCache();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
