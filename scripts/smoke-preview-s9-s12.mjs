#!/usr/bin/env node
// Resume Preview write smoke S9–S12 only.
// Member tokens come from Preview /api/member-links (server-side signMemberToken).
// Never prints secrets. Requires SMOKE_DEPLOY_URL + SMOKE_COACH_PASS (coach key only).

import { spawn, spawnSync } from "node:child_process";
import { getBookingStore, resetBookingStoreCache } from "../lib/bookingStore.js";

const DEPLOY = process.env.SMOKE_DEPLOY_URL;
const COACH = process.env.SMOKE_COACH_PASS;
if (!DEPLOY || !COACH) {
  console.error("SMOKE_DEPLOY_URL and SMOKE_COACH_PASS required");
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

function extractJson(out) {
  const start = (() => {
    const a = out.indexOf("{");
    const b = out.indexOf("[");
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  })();
  if (start < 0) return { json: null, text: "" };
  const slice = out.slice(start);
  // Prefer balanced JSON — vercel curl often appends CLI noise after the body.
  const open = slice[0];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const text = slice.slice(0, i + 1);
        try {
          return { json: JSON.parse(text), text: text.slice(0, 300) };
        } catch {
          break;
        }
      }
    }
  }
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) continue;
    try {
      return { json: JSON.parse(t), text: t.slice(0, 300) };
    } catch {
      /* keep looking */
    }
  }
  return { json: null, text: slice.slice(0, 300) };
}

function vercelCurl(path, { method = "GET", body, bearer } = {}) {
  const args = ["vercel", "curl", path, "--deployment", DEPLOY, "--yes", "--"];
  if (bearer) args.push("-H", `Authorization: Bearer ${bearer}`);
  if (method !== "GET") {
    args.push("-X", method, "-H", "Content-Type: application/json", "-d", JSON.stringify(body || {}));
  }
  const run = spawnSync("npx", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const out = `${run.stdout || ""}\n${run.stderr || ""}`;
  return extractJson(out);
}

/** Member portal calls use Authorization Bearer (same as js/account.js). */
function memberGet(token) {
  return vercelCurl("/api/member", { bearer: token });
}

function memberPost(token, body) {
  return vercelCurl("/api/member", { method: "POST", bearer: token, body });
}

function coach(action, fields = {}) {
  return vercelCurl("/api/coach", { method: "POST", body: { key: COACH, action, ...fields } });
}

function slots(date) {
  return vercelCurl(`/api/slots?date=${date}&key=${encodeURIComponent(COACH)}`);
}

function bookCash(fields) {
  const r = coach("create_booking", {
    paymentMethod: "cash",
    note: "smoke-test-disposable-s9s12",
    force: true,
    ...fields,
  });
  if (r.json?.booking?.id) createdIds.push(r.json.booking.id);
  return r;
}

function cancelId(id) {
  return coach("cancel_booking", { id });
}

function denied(r) {
  if (!r?.json) return false;
  if (r.json.ok === false) return true;
  const err = String(r.json.error || r.json.code || "");
  return /taken|full|focus|unavailable|slot_|sign in/i.test(err) === false
    ? /taken|full|focus|unavailable|slot_/i.test(err)
    : /taken|full|focus|unavailable|slot_/i.test(err);
}

function isDeniedMove(r) {
  if (!r?.json) return false;
  if (r.json.ok === false) return true;
  const err = String(r.json.error || r.json.code || "");
  return /taken|full|focus|unavailable|slot_|Something else|already/i.test(err) || r.json.code === "slot_unavailable";
}

/** Obtain Preview-signed member token via coach member-links (runtime secret stays on server). */
function memberTokenFor(email) {
  const r = vercelCurl(`/api/member-links?format=json&key=${encodeURIComponent(COACH)}`);
  const row = (r.json?.members || []).find(
    (m) => String(m.email || "").toLowerCase() === String(email).toLowerCase()
  );
  if (!row?.link) return { token: null, row: null, raw: r };
  try {
    const u = new URL(row.link);
    return { token: u.searchParams.get("k"), row, raw: r };
  } catch {
    const m = String(row.link).match(/[?&]k=([^&]+)/);
    return { token: m ? decodeURIComponent(m[1]) : null, row, raw: r };
  }
}

function memberTokenForRetry(email, { attempts = 8, delayMs = 750 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const got = memberTokenFor(email);
    if (got.token) return got;
    spawnSync("node", ["-e", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${delayMs})`]);
  }
  return memberTokenFor(email);
}

async function pgActiveOn(date, time) {
  const store = await getBookingStore(process.env);
  const { rows } = await store.query(
    `SELECT id, source, status, focus, privacy, seats, booking_type, email, player, membership_id
     FROM bookings
     WHERE slot_date = $1::date AND time_label = $2 AND status = 'active'
     ORDER BY id`,
    [date, time]
  );
  return rows;
}

async function main() {
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "1";
  process.env.VERCEL_ENV = process.env.VERCEL_ENV || "preview";
  process.env.BOOKING_ALLOW_NON_PREVIEW = process.env.BOOKING_ALLOW_NON_PREVIEW || "1";
  // Avoid signing with placeholder secrets if present in env run output
  if (String(process.env.COACH_PASS || "").includes("SENSITIVE")) delete process.env.COACH_PASS;
  if (String(process.env.MEMBER_SECRET || "").includes("SENSITIVE")) delete process.env.MEMBER_SECRET;
  await resetBookingStoreCache();

  const status = vercelCurl(`/api/booking-db?action=status&key=${encodeURIComponent(COACH)}`);
  if (!status.json?.writes || !status.json?.reads || status.json?.vercel_env !== "preview") {
    record("PRE", false, `bad status ${JSON.stringify(status.json)}`);
    return finish();
  }
  record("PRE", true, JSON.stringify(status.json));

  // Fresh email; lesson dates must fall inside the ~30-day cash membership period
  // (bookingBlocked rejects out-of-period reschedule targets).
  const memEmail = "smoke.s9c.member@example.com";
  const date = "2026-10-19"; // Monday — within period, open day
  const time = "6:00 PM";
  const openDate = "2026-10-21"; // Wednesday — open day, free slot
  const openTime = "6:00 PM";
  const blockDate = "2026-10-26"; // Monday — private blocker for failed move
  const blockTime = "6:00 PM";

  // Availability: Mon/Tue/Wed open 18:00-20:00. force:true on bookCash.

  // --- S9 ---
  const memBook = bookCash({
    date,
    time,
    focus: "Hitting",
    type: "membership",
    player: "Smoke S9 Kid",
    email: memEmail,
  });
  let lessonId = memBook.json?.booking?.id;
  if (!memBook.json?.ok || !lessonId) {
    record("S9", false, `membership create failed ${JSON.stringify(memBook.json)?.slice(0, 200)}`);
    return finish();
  }

  const { token } = memberTokenForRetry(memEmail);
  if (!token) {
    record("S9", false, `member-links did not return Preview-signed token for ${memEmail} after retries`);
    return finish();
  }

  const acct0 = vercelCurl(`/api/member?k=${encodeURIComponent(token)}`);
  if (acct0.json?.error) {
    record("S9", false, `portal auth failed: ${acct0.json.error}`);
    return finish();
  }
  const lessons0 = acct0.json?.lessons || acct0.json?.allLessons || [];
  if (lessons0[0]?.id) lessonId = lessons0[0].id;
  const used0 = Number(acct0.json?.used);
  const rem0 = Number(acct0.json?.remaining);
  console.log(`credit_before used=${used0} remaining=${rem0} lessons=${lessons0.length}`);

  const moveOk = vercelCurl("/api/member", {
    method: "POST",
    body: { k: token, action: "reschedule", id: lessonId, date: openDate, time: openTime, focus: "Hitting" },
  });
  const atOpen = await pgActiveOn(openDate, openTime);
  const atOld = await pgActiveOn(date, time);
  const acct1 = vercelCurl(`/api/member?k=${encodeURIComponent(token)}`);
  const used1 = Number(acct1.json?.used);
  const rem1 = Number(acct1.json?.remaining);
  const slOpen = slots(openDate);
  const slOld = slots(date);

  const s9 =
    moveOk.json?.ok &&
    atOpen.length === 1 &&
    atOld.length === 0 &&
    slOpen.json?.occupancy_source === "postgres" &&
    !(slOld.json?.booked || []).some((b) => b.time === time) &&
    (Number.isNaN(used0) || used1 === used0) &&
    (Number.isNaN(rem0) || rem1 === rem0);
  record(
    "S9",
    !!s9,
    `moveOk=${!!moveOk.json?.ok} err=${moveOk.json?.error || moveOk.json?.code || ""} atOpen=${atOpen.length} atOld=${atOld.length} used ${used0}->${used1} rem ${rem0}->${rem1} slotsSrc=${slOpen.json?.occupancy_source}`
  );
  if (!s9) return finish();

  const currentId = atOpen[0].id;
  createdIds.push(currentId);
  const iOld = createdIds.indexOf(lessonId);
  if (iOld >= 0) createdIds.splice(iOld, 1);

  // --- S10 ---
  const blocker = bookCash({
    date: blockDate,
    time: blockTime,
    focus: "Hitting",
    type: "private",
    player: "Smoke S10 Blocker",
    email: "smoke.s10.blocker@example.com",
  });
  if (!blocker.json?.ok) {
    record("S10", false, `blocker create failed ${blocker.json?.error || ""}`);
    return finish();
  }

  const moveFail = vercelCurl("/api/member", {
    method: "POST",
    body: {
      k: token,
      action: "reschedule",
      id: currentId,
      date: blockDate,
      time: blockTime,
      focus: "Hitting",
    },
  });
  const stillOpen = await pgActiveOn(openDate, openTime);
  const blockRows = await pgActiveOn(blockDate, blockTime);
  const acct2 = vercelCurl(`/api/member?k=${encodeURIComponent(token)}`);
  const used2 = Number(acct2.json?.used);
  const rem2 = Number(acct2.json?.remaining);

  const s10 =
    isDeniedMove(moveFail) &&
    stillOpen.length === 1 &&
    stillOpen[0].id === currentId &&
    blockRows.length === 1 &&
    (Number.isNaN(used1) || used2 === used1) &&
    (Number.isNaN(rem1) || rem2 === rem1);
  record(
    "S10",
    !!s10,
    `denied=${isDeniedMove(moveFail)} err=${moveFail.json?.error || moveFail.json?.code || ""} stillOpen=${stillOpen.length} block=${blockRows.length} used ${used1}->${used2} rem ${rem1}->${rem2}`
  );
  if (!s10) return finish();

  // --- S11 confirmPaid idempotency on Preview Postgres (confirm/webhook store path) ---
  const store = await getBookingStore(process.env);
  const idemDate = "2026-10-27"; // Tuesday — free slot inside Preview window
  const idemTime = "6:00 PM";
  const sourceId = `pi_smoke_idem_${Date.now()}`;
  const meta = {
    date: idemDate,
    time: idemTime,
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    email: "smoke.s11.idem@example.com",
    player: "Smoke S11 Idem",
  };
  const first = await store.confirmPaid({
    idempotencyKey: `mirror:${sourceId}`,
    sourceId,
    sessionId: `cs_smoke_s11_${Date.now()}`,
    metadata: meta,
  });
  const second = await store.confirmPaid({
    idempotencyKey: `mirror:${sourceId}`,
    sourceId,
    sessionId: `cs_smoke_s11_retry`,
    metadata: meta,
  });
  const idemRows = (await pgActiveOn(idemDate, idemTime)).filter((r) => r.email === meta.email);
  for (const id of first.bookingIds || []) createdIds.push(id);
  const slIdem = slots(idemDate);
  const s11 =
    first.ok &&
    first.idempotent === false &&
    second.ok &&
    second.idempotent === true &&
    idemRows.length === 1 &&
    slIdem.json?.occupancy_source === "postgres";
  record(
    "S11",
    !!s11,
    `first=${first.ok}/${first.idempotent} second=${second.ok}/${second.idempotent} rows=${idemRows.length} slotsSrc=${slIdem.json?.occupancy_source}`
  );
  if (!s11) return finish();

  // --- S12 concurrent final seat ---
  const raceDate = "2026-11-02"; // Monday — final-seat race
  const raceTime = "6:00 PM";
  bookCash({
    date: raceDate,
    time: raceTime,
    focus: "Hitting",
    player: "Smoke S12 Seed",
    email: "smoke.s12.seed@example.com",
  });
  const seedRows = await pgActiveOn(raceDate, raceTime);
  const launch = (n) =>
    new Promise((resolve) => {
      const body = JSON.stringify({
        key: COACH,
        action: "create_booking",
        date: raceDate,
        time: raceTime,
        focus: "Hitting",
        type: "single",
        player: `Smoke S12 Race ${n}`,
        email: `smoke.s12.race${n}@example.com`,
        paymentMethod: "cash",
        note: "smoke-test-disposable-s9s12",
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
        resolve({ ok: !!json?.ok, json });
      });
    });
  const [r1, r2] = await Promise.all([launch(1), launch(2)]);
  const raceRows = await pgActiveOn(raceDate, raceTime);
  const wins = [r1, r2].filter((r) => r.ok).length;
  const s12 = seedRows.length === 1 && wins === 1 && raceRows.length === 2;
  record("S12", !!s12, `seed=${seedRows.length} wins=${wins} r1=${r1.ok} r2=${r2.ok} pg=${raceRows.length}`);

  return finish();
}

async function finish() {
  console.log("\n--- cleanup ---");
  for (const id of [...new Set(createdIds)]) {
    try {
      const r = cancelId(id);
      console.log("cancel", id, !!r.json?.ok);
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
         AND email LIKE 'smoke.%@example.com'`
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
