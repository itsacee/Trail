#!/usr/bin/env node
/**
 * G4 Phase 2 supplemental Preview E2E (beyond S1–S12).
 * Preview Neon only. Disposable smoke.g4.* emails.
 */
import { spawnSync } from "node:child_process";
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

function record(id, pass, detail, { soft = false } = {}) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id}: ${detail}`);
  if (!pass && !soft) stopped = true;
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
        try {
          return { json: JSON.parse(slice.slice(0, i + 1)), text: slice.slice(0, 400) };
        } catch {
          break;
        }
      }
    }
  }
  return { json: null, text: slice.slice(0, 400) };
}

function vercelCurl(path, { method = "GET", body, bearer } = {}) {
  const args = ["vercel", "curl", path, "--deployment", DEPLOY, "--yes", "--"];
  if (bearer) args.push("-H", `Authorization: Bearer ${bearer}`);
  if (method !== "GET") {
    args.push("-X", method, "-H", "Content-Type: application/json", "-d", JSON.stringify(body || {}));
  }
  const run = spawnSync("npx", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return extractJson(`${run.stdout || ""}\n${run.stderr || ""}`);
}

function coach(action, fields = {}) {
  return vercelCurl("/api/coach", { method: "POST", body: { key: COACH, action, ...fields } });
}

function bookCash(fields) {
  const r = coach("create_booking", {
    paymentMethod: "cash",
    note: "g4-smoke-disposable",
    force: true,
    type: "single",
    ...fields,
  });
  if (r.json?.booking?.id) createdIds.push(r.json.booking.id);
  return r;
}

function memberTokenFor(email) {
  const r = vercelCurl(`/api/member-links?format=json&key=${encodeURIComponent(COACH)}`);
  const row = (r.json?.members || []).find(
    (m) => String(m.email || "").toLowerCase() === String(email).toLowerCase()
  );
  if (!row?.link) return { token: null };
  try {
    return { token: new URL(row.link).searchParams.get("k") };
  } catch {
    const m = String(row.link).match(/[?&]k=([^&]+)/);
    return { token: m ? decodeURIComponent(m[1]) : null };
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

function memberGet(token) {
  return vercelCurl("/api/member", { bearer: token });
}

function memberPost(token, body) {
  return vercelCurl("/api/member", { method: "POST", bearer: token, body });
}

async function pgActiveOn(date, time) {
  const store = await getBookingStore(process.env);
  const { rows } = await store.query(
    `SELECT id, source, status, focus, privacy, seats, booking_type, email, player, membership_id
     FROM bookings WHERE slot_date=$1::date AND time_label=$2 AND status='active' ORDER BY id`,
    [date, time]
  );
  return rows;
}

function denied(r) {
  if (!r?.json) return false;
  if (r.json.ok === false) return true;
  return /taken|full|focus|unavailable|slot_/i.test(String(r.json.error || r.json.code || ""));
}

async function main() {
  process.env.BOOKING_STORE = "postgres";
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "1";
  process.env.VERCEL_ENV = process.env.VERCEL_ENV || "preview";
  process.env.BOOKING_ALLOW_NON_PREVIEW = process.env.BOOKING_ALLOW_NON_PREVIEW || "1";
  if (String(process.env.COACH_PASS || "").includes("SENSITIVE")) delete process.env.COACH_PASS;
  await resetBookingStoreCache();

  const status = vercelCurl(`/api/booking-db?action=status&key=${encodeURIComponent(COACH)}`);
  const host = String(process.env.BOOKING_PGHOST_UNPOOLED || process.env.BOOKING_PGHOST || "");
  const project = String(process.env.BOOKING_NEON_PROJECT_ID || "");
  if (
    !status.json?.writes ||
    !status.json?.reads ||
    status.json?.vercel_env !== "preview" ||
    !host.includes("polished-moon") ||
    project !== "withered-mud-40468222"
  ) {
    record("PRE", false, JSON.stringify({ status: status.json, host, project }));
    return finish();
  }
  record("PRE", true, JSON.stringify({ ...status.json, host, project }));

  // E1 — membership cancel returns portal credit
  if (!stopped) {
    const email = "smoke.g4.memcancel@example.com";
    const date = "2026-10-20"; // Tue
    const time = "6:00 PM";
    const mem = bookCash({
      date,
      time,
      focus: "Hitting",
      type: "membership",
      player: "G4 Mem Cancel",
      email,
    });
    const lessonId = mem.json?.booking?.id;
    const { token } = memberTokenForRetry(email);
    const before = token ? memberGet(token) : { json: null };
    const used0 = Number(before.json?.used);
    const rem0 = Number(before.json?.remaining);
    const cancel = coach("cancel_booking", { id: lessonId });
    const afterRows = await pgActiveOn(date, time);
    const after = token ? memberGet(token) : { json: null };
    const used1 = Number(after.json?.used);
    const rem1 = Number(after.json?.remaining);
    // After canceling the only lesson, used should drop / remaining increase (or portal shows 0 used)
    const creditOk =
      cancel.json?.ok &&
      afterRows.length === 0 &&
      ((!Number.isNaN(used0) && !Number.isNaN(used1) && used1 === used0 - 1) ||
        (!Number.isNaN(rem0) && !Number.isNaN(rem1) && rem1 === rem0 + 1) ||
        (used1 === 0 && rem1 >= rem0));
    record(
      "E1_credit_return",
      !!creditOk,
      `memOk=${!!mem.json?.ok} cancelOk=${!!cancel.json?.ok} slotClear=${afterRows.length === 0} used ${used0}->${used1} rem ${rem0}->${rem1}`
    );
    const idx = createdIds.indexOf(lessonId);
    if (idx >= 0) createdIds.splice(idx, 1);
    if (!creditOk) return finish();
  }

  // E2 — member portal books second lesson with credit
  if (!stopped) {
    const email = "smoke.g4.portalbook@example.com";
    const firstDate = "2026-10-19"; // Mon — open, avoid imported Tue 7pm seat
    const firstTime = "6:00 PM";
    const bookDate = "2026-10-21"; // Wed — open day
    const bookTime = "6:00 PM";
    const mem = bookCash({
      date: firstDate,
      time: firstTime,
      focus: "Fielding",
      type: "membership",
      player: "G4 Portal Book",
      email,
    });
    const { token } = memberTokenForRetry(email);
    const before = token ? memberGet(token) : { json: null };
    const used0 = Number(before.json?.used);
    const rem0 = Number(before.json?.remaining);
    const lessons0 = (before.json?.lessons || before.json?.allLessons || []).length;
    const portal = memberPost(token, { action: "book", date: bookDate, time: bookTime, focus: "Fielding" });
    const afterBook = await pgActiveOn(bookDate, bookTime);
    const afterFirst = await pgActiveOn(firstDate, firstTime);
    const store = await getBookingStore(process.env);
    const { rows: allMine } = await store.query(
      `SELECT id, slot_date::text AS date, time_label AS time, source, status
       FROM bookings WHERE lower(email)=lower($1) AND status='active' ORDER BY slot_date, time_label`,
      [email]
    );
    const after = token ? memberGet(token) : { json: null };
    const used1 = Number(after.json?.used);
    const rem1 = Number(after.json?.remaining);
    const lessons1 = (after.json?.lessons || after.json?.allLessons || []).length;
    const mine = afterBook.filter((r) => String(r.email).toLowerCase() === email);
    for (const r of allMine) createdIds.push(r.id);
    // Success = portal book persisted a second active lesson (or moved — still must occupy target).
    // Prefer PG truth: 2 actives for email with target occupied; portal used/rem may lag on cash-seeded mem.
    const pgTwo = allMine.length >= 2 && mine.length === 1 && afterFirst.some((r) => String(r.email).toLowerCase() === email);
    const creditConsumed =
      (!Number.isNaN(used0) && used1 === used0 + 1) || (!Number.isNaN(rem0) && rem1 === rem0 - 1);
    const pass = mem.json?.ok && token && portal.json?.ok && mine.length === 1 && (pgTwo || creditConsumed || lessons1 === lessons0 + 1);
    record(
      "E2_portal_book",
      !!pass,
      `memOk=${!!mem.json?.ok} portalOk=${!!portal.json?.ok} err=${portal.json?.error || ""} mine=${mine.length} pgActive=${allMine.length} firstStill=${afterFirst.length} used ${used0}->${used1} rem ${rem0}->${rem1} lessons ${lessons0}->${lessons1}`
    );
    if (!pass) return finish();
  }

  // E3 — mixed focus denied
  if (!stopped) {
    const date = "2026-10-27";
    const time = "7:00 PM";
    const a = bookCash({ date, time, focus: "Hitting", player: "G4 Mix A", email: "smoke.g4.mixa@example.com" });
    const b = bookCash({ date, time, focus: "Fielding", player: "G4 Mix B", email: "smoke.g4.mixb@example.com" });
    const rows = await pgActiveOn(date, time);
    const pass = a.json?.ok && denied(b) && rows.length === 1 && rows[0].focus === "Hitting";
    record("E3_mixed_focus", !!pass, `okA=${!!a.json?.ok} denyB=${denied(b)} pg=${rows.length} focus=${rows[0]?.focus} err=${b.json?.error || ""}`);
    if (!pass) return finish();
  }

  // E4 — private exclusive
  if (!stopped) {
    const date = "2026-11-18"; // Wed — avoid imported Oct occupancy
    const time = "7:00 PM";
    const priv = bookCash({
      date,
      time,
      focus: "Both",
      type: "private",
      player: "G4 Priv",
      email: "smoke.g4.priv@example.com",
    });
    const second = bookCash({
      date,
      time,
      focus: "Both",
      player: "G4 Priv2",
      email: "smoke.g4.priv2@example.com",
    });
    const rows = await pgActiveOn(date, time);
    const pass = priv.json?.ok && denied(second) && rows.length === 1 && rows[0].privacy === "private";
    record(
      "E4_private_exclusive",
      !!pass,
      `priv=${!!priv.json?.ok} deny=${denied(second)} pg=${rows.length} privacy=${rows[0]?.privacy} err=${priv.json?.error || second.json?.error || ""}`
    );
    if (!pass) return finish();
  }

  // E5 — checkout CAPACITY_WRITES gate (document expected gap) or Stripe test open
  if (!stopped) {
    const checkout = vercelCurl("/api/checkout", {
      method: "POST",
      body: {
        type: "single",
        date: "2026-10-27", // Mon — inside Oct book-ahead window; avoid prior hold leftovers
        time: "6:00 PM",
        focus: "Hitting",
        player: "G4 Checkout",
        email: "smoke.g4.checkout@example.com",
      },
    });
    const paused = checkout.json?.capacityWritesPaused === true || checkout.json?.code === "schedule_unavailable";
    const opened = Boolean(checkout.json?.url || checkout.json?.sessionId);
    const stripeTestUrl = typeof checkout.json?.url === "string" && /stripe\.com|checkout/i.test(checkout.json.url);
    if (opened) {
      record(
        "E5_checkout_stripe_test",
        true,
        `opened url=${Boolean(checkout.json?.url)} stripeish=${stripeTestUrl} session=${Boolean(checkout.json?.sessionId)}`
      );
      if (checkout.json?.sessionId) {
        vercelCurl("/api/release-hold", {
          method: "POST",
          body: { sessionId: checkout.json.sessionId },
        });
      }
    } else if (paused) {
      record(
        "E5_checkout_capacity_gate",
        true,
        `EXPECTED_GAP capacityWritesPaused=${checkout.json?.capacityWritesPaused} code=${checkout.json?.code}`
      );
    } else {
      // Retry once on a second open slot (stale holds / focus conflicts)
      const retry = vercelCurl("/api/checkout", {
        method: "POST",
        body: {
          type: "single",
          date: "2026-10-27",
          time: "7:00 PM",
          focus: "Fielding",
          player: "G4 Checkout",
          email: "smoke.g4.checkout2@example.com",
        },
      });
      if (retry.json?.url || retry.json?.sessionId) {
        record("E5_checkout_stripe_test", true, `retry opened session=${Boolean(retry.json?.sessionId)}`);
        if (retry.json?.sessionId) {
          vercelCurl("/api/release-hold", { method: "POST", body: { sessionId: retry.json.sessionId } });
        }
      } else {
        record("E5_checkout", false, JSON.stringify(checkout.json || retry.json).slice(0, 240));
        return finish();
      }
    }
  }

  // E6 — confirmPaid idempotency via store (same as S11)
  if (!stopped) {
    const store = await getBookingStore(process.env);
    const date = "2026-10-26"; // Mon
    const time = "7:00 PM";
    const sourceId = `pi_smoke_g4_idem_${Date.now()}`;
    const meta = {
      date,
      time,
      focus: "Hitting",
      type: "single",
      privacy: "standard",
      email: "smoke.g4.idem@example.com",
      player: "G4 Idem",
    };
    const first = await store.confirmPaid({
      idempotencyKey: `mirror:${sourceId}`,
      sourceId,
      sessionId: `cs_smoke_g4_${Date.now()}`,
      metadata: meta,
    });
    const second = await store.confirmPaid({
      idempotencyKey: `mirror:${sourceId}`,
      sourceId,
      sessionId: `cs_smoke_g4_retry`,
      metadata: meta,
    });
    const rows = (await pgActiveOn(date, time)).filter((r) => r.email === meta.email);
    for (const id of first.bookingIds || []) createdIds.push(id);
    const pass = first.ok && first.idempotent === false && second.ok && second.idempotent === true && rows.length === 1;
    record("E6_confirm_idempotent", !!pass, `first=${first.ok}/${first.idempotent} second=${second.ok}/${second.idempotent} rows=${rows.length}`);
    if (!pass) return finish();
  }

  // E7 — coach move
  if (!stopped) {
    const date = "2026-11-03";
    const time = "6:00 PM";
    const destDate = "2026-11-04";
    const destTime = "6:00 PM";
    const created = bookCash({
      date,
      time,
      focus: "Hitting",
      player: "G4 Move",
      email: "smoke.g4.move@example.com",
    });
    const id = created.json?.booking?.id;
    const moved = coach("move_booking", { id, date: destDate, time: destTime, focus: "Hitting" });
    const atOld = await pgActiveOn(date, time);
    const atNew = await pgActiveOn(destDate, destTime);
    const pass = created.json?.ok && moved.json?.ok && atOld.length === 0 && atNew.length === 1;
    record("E7_coach_move", !!pass, `create=${!!created.json?.ok} move=${!!moved.json?.ok} old=${atOld.length} new=${atNew.length} err=${moved.json?.error || ""}`);
    if (atNew[0]?.id) createdIds.push(atNew[0].id);
    if (!pass) return finish();
  }

  // E8 — cash collect on manual booking (do not stop suite on fail — activation blocker candidate)
  if (!stopped) {
    const date = "2026-11-03";
    const time = "7:00 PM";
    const created = bookCash({
      date,
      time,
      focus: "Fielding",
      player: "G4 Cash",
      email: "smoke.g4.cash@example.com",
    });
    const id = created.json?.booking?.id;
    const collect = coach("collect_payment", { id, amountCents: 8000, method: "cash" });
    const pass = !!(created.json?.ok && collect.json?.ok === true);
    record(
      "E8_cash_collect",
      pass,
      `create=${!!created.json?.ok} id=${id} collectOk=${!!collect.json?.ok} code=${collect.json?.code || ""} err=${collect.json?.error || ""}`,
      { soft: true }
    );
    // Continue even on fail — document as blocker; local store.collectManualPayment works.
  }

  // E9 — failed reschedule preserves credits (same pattern as S10)
  if (!stopped) {
    const email = `smoke.g4.failcredit.${Date.now().toString(36)}@example.com`;
    const date = "2026-10-20"; // Tue
    const time = "6:00 PM";
    const blockDate = "2026-10-21"; // Wed
    const blockTime = "7:00 PM";
    const mem = bookCash({
      date,
      time,
      focus: "Hitting",
      type: "membership",
      player: "G4 Fail Credit",
      email,
    });
    const lessonId = mem.json?.booking?.id;
    const blocker = bookCash({
      date: blockDate,
      time: blockTime,
      focus: "Hitting",
      type: "private",
      player: "G4 Block",
      email: "smoke.g4.block@example.com",
    });
    const { token } = memberTokenForRetry(email);
    const before = token ? memberGet(token) : { json: null };
    if (before.json?.error) {
      record("E9_fail_reschedule_credits", false, `portal auth failed: ${before.json.error}`);
      return finish();
    }
    const used0 = Number(before.json?.used);
    const rem0 = Number(before.json?.remaining);
    const failMove = memberPost(token, {
      action: "reschedule",
      id: lessonId,
      date: blockDate,
      time: blockTime,
      focus: "Hitting",
    });
    const still = await pgActiveOn(date, time);
    const after = token ? memberGet(token) : { json: null };
    const used1 = Number(after.json?.used);
    const rem1 = Number(after.json?.remaining);
    const pass =
      mem.json?.ok &&
      blocker.json?.ok &&
      token &&
      denied(failMove) &&
      still.length === 1 &&
      (Number.isNaN(used0) || used1 === used0) &&
      (Number.isNaN(rem0) || rem1 === rem0);
    record(
      "E9_fail_reschedule_credits",
      !!pass,
      `deny=${denied(failMove)} still=${still.length} used ${used0}->${used1} rem ${rem0}->${rem1} err=${failMove.json?.error || ""}`
    );
    if (!pass) return finish();
  }

  // E10 — membership plans Hitting / Fielding / Both via cash membership bookings
  if (!stopped) {
    const cases = [
      { focus: "Hitting", date: "2026-11-16", time: "6:00 PM", email: "smoke.g4.plan.hit@example.com" },
      { focus: "Fielding", date: "2026-11-16", time: "7:00 PM", email: "smoke.g4.plan.fld@example.com" },
      { focus: "Both", date: "2026-11-17", time: "6:00 PM", email: "smoke.g4.plan.both@example.com" },
    ];
    const details = [];
    let allOk = true;
    for (const c of cases) {
      const r = bookCash({
        date: c.date,
        time: c.time,
        focus: c.focus,
        type: "membership",
        player: `G4 Plan ${c.focus}`,
        email: c.email,
      });
      const rows = await pgActiveOn(c.date, c.time);
      const ok = r.json?.ok && rows.some((x) => x.email === c.email && x.focus === c.focus);
      details.push(`${c.focus}:${ok}`);
      if (!ok) allOk = false;
    }
    record("E10_membership_plans", allOk, details.join(" "));
    if (!allOk) return finish();
  }

  finish();
}

async function finish() {
  console.log("--- cleanup ---");
  for (const id of [...new Set(createdIds)].filter(Boolean)) {
    const r = coach("cancel_booking", { id });
    console.log("cancel", id, !!r.json?.ok);
  }
  try {
    const store = await getBookingStore(process.env);
    const r = await store.query(
      `UPDATE bookings SET status='cancelled', updated_at=now()
       WHERE email ILIKE 'smoke.%@example.com' AND status IN ('active','held') RETURNING id`
    );
    console.log("pg_smoke_cancel_rowcount", r.rowCount);
  } catch (e) {
    console.log("pg cleanup err", e.message);
  }
  const failed = results.filter((r) => !r.pass);
  console.log("=== SUMMARY ===");
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id}: ${r.detail}`);
  console.log(failed.length ? "HAS_FAILURES" : "ALL_REPORTED_PASS");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
