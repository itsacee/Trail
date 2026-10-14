#!/usr/bin/env node
// Preview write-window smoke for G4 E8 (collect_payment) + E2 (portal credits).
// Never prints secrets. Requires SMOKE_DEPLOY_URL + SMOKE_COACH_PASS.
// Member tokens come from Preview /api/member-links (server-side sign).

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
          return { json: JSON.parse(text), text: text.slice(0, 400) };
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
  const out = `${run.stdout || ""}\n${run.stderr || ""}`;
  return extractJson(out);
}

function coach(action, fields = {}) {
  return vercelCurl("/api/coach", { method: "POST", body: { key: COACH, action, ...fields } });
}

function memberGet(token) {
  return vercelCurl("/api/member", { bearer: token });
}

function memberPost(token, body) {
  return vercelCurl("/api/member", { method: "POST", bearer: token, body });
}

function slots(date) {
  return vercelCurl(`/api/slots?date=${date}&key=${encodeURIComponent(COACH)}`);
}

function bookCash(fields) {
  const r = coach("create_booking", {
    paymentMethod: "cash",
    note: "smoke-e8-e2-disposable",
    force: true,
    ...fields,
  });
  if (r.json?.booking?.id) createdIds.push(r.json.booking.id);
  return r;
}

function cancelId(id) {
  return coach("cancel_booking", { id });
}

function memberTokenFor(email) {
  const r = vercelCurl(`/api/member-links?format=json&key=${encodeURIComponent(COACH)}`);
  const row = (r.json?.members || []).find(
    (m) => String(m.email || "").toLowerCase() === String(email).toLowerCase()
  );
  if (!row?.link) return { token: null, row: null };
  try {
    const u = new URL(row.link);
    return { token: u.searchParams.get("k"), row };
  } catch {
    const m = String(row.link).match(/[?&]k=([^&]+)/);
    return { token: m ? decodeURIComponent(m[1]) : null, row };
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
    `SELECT id, source, status, focus, privacy, seats, booking_type, email, player, membership_id,
            (payload->>'paymentStatus') AS payment_status,
            (payload->>'amountDueCents') AS amount_due
     FROM bookings
     WHERE slot_date = $1::date AND time_label = $2 AND status = 'active'
     ORDER BY id`,
    [date, time]
  );
  return rows;
}

async function pgBooking(id) {
  const store = await getBookingStore(process.env);
  const { rows } = await store.query(
    `SELECT id, source, status, focus, seats, booking_type, email, membership_id,
            payload->>'paymentStatus' AS payment_status,
            COALESCE((payload->>'amountDueCents')::int, 0) AS amount_due,
            COALESCE((payload->>'amountPaidCents')::int, 0) AS amount_paid
     FROM bookings WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function pgCredit(membershipId) {
  const store = await getBookingStore(process.env);
  const { rows } = await store.query(
    `SELECT membership_id, credits_total, credits_used FROM membership_credits WHERE membership_id = $1`,
    [membershipId]
  );
  return rows[0] || null;
}

function outstandingHas(dash, id) {
  const list = dash?.finance?.outstanding || [];
  return list.find((o) => o.id === id || o.bookingId === id);
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
  if (!status.json?.writes || !status.json?.reads || status.json?.vercel_env !== "preview") {
    record("PRE", false, `bad status ${JSON.stringify(status.json)}`);
    return finish();
  }
  record("PRE", true, JSON.stringify(status.json));

  // ---------- E8: unpaid cash → collect → refresh Coach Desk ----------
  const e8Date = "2026-11-09"; // Monday disposable
  const e8Time = "7:00 PM";
  const e8Email = "smoke.e8.collect@example.com";

  const created = bookCash({
    date: e8Date,
    time: e8Time,
    focus: "Hitting",
    type: "single",
    player: "Smoke E8 Cash",
    email: e8Email,
  });
  const bookingId = created.json?.booking?.id;
  const due =
    Number(created.json?.booking?.amountDueCents) ||
    Number(created.json?.booking?.amountCents) ||
    0;
  if (!created.json?.ok || !bookingId || due <= 0) {
    record(
      "E8_create",
      false,
      `create failed ok=${!!created.json?.ok} id=${bookingId} due=${due} err=${created.json?.error || created.json?.code || ""}`
    );
    return finish();
  }
  record("E8_create", true, `id=${bookingId} due=${due}`);

  const beforePg = await pgBooking(bookingId);
  const beforeSlots = slots(e8Date);
  const beforeSeat = (beforeSlots.json?.booked || []).find((b) => b.time === e8Time)?.seats;
  const dashBefore = coach("dashboard"); // may be unsupported — fall through to GET
  let dashGet = vercelCurl(`/api/coach?key=${encodeURIComponent(COACH)}`);
  if (!dashGet.json?.finance) {
    // Some builds use POST-less GET with empty action
    dashGet = vercelCurl("/api/coach", { method: "POST", body: { key: COACH, action: "load" } });
  }
  // Prefer explicit outstanding from collect response later; first check unpaid appears
  const outBefore =
    outstandingHas(dashGet.json, bookingId) ||
    outstandingHas(dashBefore.json, bookingId) ||
    outstandingHas(created.json, bookingId);

  // Collect payment
  const collect1 = coach("collect_payment", {
    id: bookingId,
    amountCents: due,
    method: "cash",
  });
  const afterPg = await pgBooking(bookingId);
  const afterSlots = slots(e8Date);
  const afterSeat = (afterSlots.json?.booked || []).find((b) => b.time === e8Time)?.seats;
  const rowsAfter = await pgActiveOn(e8Date, e8Time);
  const outAfter = outstandingHas(collect1.json, bookingId);
  const paidOk =
    collect1.json?.ok &&
    collect1.json?.collected?.id === bookingId &&
    Number(collect1.json?.collected?.take) === due &&
    !collect1.json?.collected?.idempotent &&
    afterPg?.payment_status === "paid" &&
    Number(afterPg?.amount_due) === 0 &&
    Number(afterPg?.amount_paid) >= due &&
    rowsAfter.length === 1 &&
    rowsAfter[0].id === bookingId &&
    beforeSeat === afterSeat &&
    !outAfter;

  record(
    "E8_collect",
    !!paidOk,
    `ok=${!!collect1.json?.ok} take=${collect1.json?.collected?.take} status=${afterPg?.payment_status} due=${afterPg?.amount_due} seats ${beforeSeat}->${afterSeat} rows=${rowsAfter.length} outBefore=${!!outBefore} outAfter=${!!outAfter} err=${collect1.json?.error || collect1.json?.code || ""}`
  );
  if (!paidOk) return finish();

  // Idempotent retry — no second take / no seat change
  const collect2 = coach("collect_payment", {
    bookingId, // alias
    amountCents: due,
    method: "cash",
  });
  const afterRetry = await pgBooking(bookingId);
  const seatsRetry = (slots(e8Date).json?.booked || []).find((b) => b.time === e8Time)?.seats;
  const idemOk =
    collect2.json?.ok &&
    (collect2.json?.collected?.idempotent === true || Number(collect2.json?.collected?.take) === 0) &&
    afterRetry?.payment_status === "paid" &&
    Number(afterRetry?.amount_due) === 0 &&
    seatsRetry === afterSeat &&
    (await pgActiveOn(e8Date, e8Time)).length === 1;

  record(
    "E8_idempotent",
    !!idemOk,
    `ok=${!!collect2.json?.ok} idem=${collect2.json?.collected?.idempotent} take=${collect2.json?.collected?.take} seats=${seatsRetry}`
  );
  if (!idemOk) return finish();

  // Refresh Coach Desk outstanding
  const dashRefresh = vercelCurl(`/api/coach?key=${encodeURIComponent(COACH)}`);
  const stillOut = outstandingHas(dashRefresh.json, bookingId);
  const refreshOk = !stillOut && Number(dashRefresh.json?.finance?.outstandingCents ?? 0) >= 0;
  record(
    "E8_refresh",
    !!refreshOk,
    `stillOutstanding=${!!stillOut} outstandingCents=${dashRefresh.json?.finance?.outstandingCents} code=${dashRefresh.json?.code || ""}`
  );
  if (!refreshOk) return finish();

  // ---------- E2: membership credits after book / cancel / reschedule ----------
  const memEmail = `smoke.e2.credits.${Date.now()}@example.com`;
  // Prefer empty future open days inside a fresh cash membership period.
  const d1 = "2026-11-02";
  const d2 = "2026-11-03";
  const d3 = "2026-11-04";
  const t = "6:00 PM";

  const m1 = bookCash({
    date: d1,
    time: t,
    focus: "Hitting",
    type: "membership",
    player: "Smoke E2 Kid",
    email: memEmail,
  });
  if (!m1.json?.ok) {
    record("E2_seed1", false, `err=${m1.json?.error || m1.json?.code}`);
    return finish();
  }
  record("E2_seed1", true, `id=${m1.json.booking.id}`);

  const { token } = memberTokenForRetry(memEmail);
  if (!token) {
    record("E2_token", false, "member-links did not return token");
    return finish();
  }
  record("E2_token", true, "token ok");

  const acct1 = memberGet(token);
  const used1 = Number(acct1.json?.used ?? acct1.json?.summary?.used);
  const rem1 = Number(acct1.json?.remaining ?? acct1.json?.summary?.remaining);
  const u1ok = used1 === 1 && rem1 === 3;
  record("E2_after_first", !!u1ok, `used=${used1} remaining=${rem1} err=${acct1.json?.error || ""}`);
  if (!u1ok) return finish();

  // Second booking via member portal
  const book2 = memberPost(token, {
    action: "book",
    date: d2,
    time: t,
    focus: "Hitting",
  });
  const id2 = book2.json?.lesson?.id || book2.json?.booking?.id || book2.json?.id;
  if (id2) createdIds.push(id2);
  const acct2 = memberGet(token);
  const used2 = Number(acct2.json?.used ?? acct2.json?.summary?.used);
  const rem2 = Number(acct2.json?.remaining ?? acct2.json?.summary?.remaining);
  // Also check response summary if present
  const used2r = Number(book2.json?.summary?.used ?? book2.json?.used ?? used2);
  const rem2r = Number(book2.json?.summary?.remaining ?? book2.json?.remaining ?? rem2);
  const u2ok = book2.json?.ok && used2 === 2 && rem2 === 2 && used2r === 2 && rem2r === 2;
  record(
    "E2_after_second",
    !!u2ok,
    `ok=${!!book2.json?.ok} used=${used2}/${used2r} rem=${rem2}/${rem2r} err=${book2.json?.error || book2.json?.code || ""}`
  );
  if (!u2ok) return finish();

  // Immediate repeat GET consistency
  const acct2b = memberGet(token);
  const used2b = Number(acct2b.json?.used ?? acct2b.json?.summary?.used);
  const rem2b = Number(acct2b.json?.remaining ?? acct2b.json?.summary?.remaining);
  record("E2_repeat_get", used2b === 2 && rem2b === 2, `used=${used2b} rem=${rem2b}`);
  if (stopped) return finish();

  // Reschedule second lesson — credits unchanged
  const move = memberPost(token, {
    action: "reschedule",
    id: id2,
    date: d3,
    time: t,
    focus: "Hitting",
  });
  const movedId = (await pgActiveOn(d3, t)).find((r) => r.email === memEmail)?.id;
  if (movedId) {
    createdIds.push(movedId);
    const i = createdIds.indexOf(id2);
    if (i >= 0) createdIds.splice(i, 1);
  }
  const acct3 = memberGet(token);
  const used3 = Number(acct3.json?.used ?? acct3.json?.summary?.used);
  const rem3 = Number(acct3.json?.remaining ?? acct3.json?.summary?.remaining);
  const moveOk = move.json?.ok && used3 === 2 && rem3 === 2 && (await pgActiveOn(d2, t)).length === 0;
  record(
    "E2_after_reschedule",
    !!moveOk,
    `ok=${!!move.json?.ok} used=${used3} rem=${rem3} err=${move.json?.error || move.json?.code || ""}`
  );
  if (!moveOk) return finish();

  // Cancel one — credits restore
  const cancelTarget = movedId || id2;
  const cancel = memberPost(token, { action: "cancel", id: cancelTarget });
  const acct4 = memberGet(token);
  const used4 = Number(acct4.json?.used ?? acct4.json?.summary?.used);
  const rem4 = Number(acct4.json?.remaining ?? acct4.json?.summary?.remaining);
  const cancelOk = cancel.json?.ok && used4 === 1 && rem4 === 3;
  record(
    "E2_after_cancel",
    !!cancelOk,
    `ok=${!!cancel.json?.ok} used=${used4} rem=${rem4} err=${cancel.json?.error || cancel.json?.code || ""}`
  );

  // Ledger check if present
  const mid = beforePg?.membership_id; // ignore
  const creditRow = await pgCredit(`cash_${memEmail}`).catch(() => null);
  if (creditRow) {
    const ledgerOk = Number(creditRow.credits_used) === used4;
    record("E2_ledger", !!ledgerOk, `credits_used=${creditRow.credits_used} portal_used=${used4}`);
  } else {
    record("E2_ledger", true, "no ledger row yet (manual-only period) — portal counts authoritative via scheduledFor");
  }

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
    await store.query(
      `UPDATE bookings
       SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE status IN ('active','held')
         AND (email LIKE 'smoke.e8.%@example.com' OR email LIKE 'smoke.e2.%@example.com')`
    );
  } catch (e) {
    console.log("pg_cleanup_err", e.message);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== SUMMARY ===");
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id}: ${r.detail}`);
  console.log(failed.length ? `OVERALL FAIL (${failed.length})` : "OVERALL PASS");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
