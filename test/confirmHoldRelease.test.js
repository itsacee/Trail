// Confirm/webhook must release the checkout hold only after the paid lesson
// mirror succeeds — otherwise holds.json + lessons.json double-count one seat.
import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { useMemoryBlobStore, clearMemoryBlobStore } from "../lib/store.js";
import { placeHold, releaseHold, loadHolds } from "../lib/holds.js";
import { loadLessons, mutateLessons } from "../lib/lessons.js";
import { bookedTimes } from "../api/slots.js";
import { deliverConfirmation } from "../api/confirm.js";
import { SLOT_CAPACITY } from "../lib/schedule.js";

const DATE = "2026-11-18";
const TIME = "5:00 PM";

before(() => {
  useMemoryBlobStore(true);
});

after(() => {
  useMemoryBlobStore(false);
});

beforeEach(() => {
  clearMemoryBlobStore();
  process.env.CAPACITY_BLOB_CUTOVER = "1";
  process.env.CAPACITY_WRITES_ENABLED = "1";
  delete process.env.CAPACITY_MIGRATION_PAUSE;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_mempublic_test";
  process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_memprivate_test";
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";
  mock.restoreAll();
});

function standardMeta(player, email) {
  return {
    player,
    email,
    type: "single",
    focus: "Hitting",
    privacy: "standard",
    seats: "1",
    date1: DATE,
    time1: TIME,
    loc1: "mustang",
  };
}

/** Stripe + empty calendar search stubs for deliverConfirmation / bookedTimes. */
function mockStripe({
  sessions = [],
  confirmationSent = {},
} = {}) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  mock.method(globalThis, "fetch", async (url, opts = {}) => {
    const path = String(url);
    const sessionMatch = path.match(/\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)/);
    if (sessionMatch) {
      const session = byId.get(sessionMatch[1]);
      if (!session) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => session };
    }
    const piMatch = path.match(/\/payment_intents\/(pi_[A-Za-z0-9_]+)/);
    if (piMatch) {
      const id = piMatch[1];
      if (opts.method === "POST") {
        confirmationSent[id] = true;
        return { ok: true, json: async () => ({ id }) };
      }
      return {
        ok: true,
        json: async () => ({
          id,
          created: Math.floor(Date.now() / 1000),
          metadata: confirmationSent[id] ? { confirmation_sent: "1" } : {},
        }),
      };
    }
    // bookedTimes open-session + search probes
    if (path.includes("/checkout/sessions?") || path.includes("/search?")) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    throw new Error(`Unexpected fetch: ${path}`);
  });
}

function paidSession(sessionId, paymentIntent, meta) {
  return {
    id: sessionId,
    object: "checkout.session",
    payment_status: "paid",
    payment_intent: paymentIntent,
    amount_total: 4500,
    created: Math.floor(Date.now() / 1000),
    customer_details: { email: meta.email },
    metadata: meta,
  };
}

async function seatSources() {
  const rows = await bookedTimes("sk_test", DATE);
  const row = rows.find((r) => r.time === TIME);
  return row || { seats: 0, sources: [], exclusive: false, count: 0 };
}

test("confirm.js releases the checkout hold only after a successful lesson mirror", async () => {
  const confirm = await readFile(new URL("../api/confirm.js", import.meta.url), "utf8");
  assert.match(confirm, /import\s*\{\s*releaseHold\s*\}\s*from\s*["']\.\.\/lib\/holds\.js["']/);
  assert.match(confirm, /bookingMirrorFailed:\s*true/);
  // Hold release must sit after the mirrored.ok gate, not on the failure return.
  const failIdx = confirm.indexOf("bookingMirrorFailed: true");
  const releaseIdx = confirm.indexOf("await releaseHold(session.id)");
  assert.ok(failIdx > 0 && releaseIdx > failIdx, "releaseHold must run after successful mirror handling");
});

test("successful payment mirrors the lesson and releases its checkout hold", async () => {
  const sessionId = "cs_paid_ok";
  const paymentIntent = "pi_paid_ok";
  const meta = standardMeta("Sam", "sam@example.com");
  assert.equal(
    await placeHold(sessionId, [{ date: DATE, time: TIME }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    true
  );
  assert.equal((await loadHolds()).holds.length, 1);

  mockStripe({ sessions: [paidSession(sessionId, paymentIntent, meta)] });
  const result = await deliverConfirmation({
    key: "sk_test",
    sessionId,
    origin: "https://www.apacademybsb.com",
  });
  assert.equal(result.status, 200);
  assert.notEqual(result.body.bookingMirrorFailed, true);

  const holds = await loadHolds();
  assert.equal(holds.holds.length, 0);

  const lessons = await loadLessons();
  assert.equal(lessons.lessons.filter((l) => l.sourceId === paymentIntent).length, 1);

  const slot = await seatSources();
  assert.equal(slot.seats, 1);
  assert.equal(slot.sources.length, 1);
  assert.equal(slot.sources[0].kind, "paid");
  assert.equal(slot.exclusive, false);
});

test("persistence failure preserves the checkout hold", async () => {
  const sessionId = "cs_mirror_fail";
  const paymentIntent = "pi_mirror_fail";
  const meta = standardMeta("Pat", "pat@example.com");
  assert.equal(
    await placeHold(sessionId, [{ date: DATE, time: TIME }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    true
  );

  process.env.CAPACITY_WRITES_ENABLED = "0";
  mockStripe({ sessions: [paidSession(sessionId, paymentIntent, meta)] });
  const result = await deliverConfirmation({
    key: "sk_test",
    sessionId,
    origin: "https://www.apacademybsb.com",
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.bookingMirrorFailed, true);
  assert.equal(result.body.recorded, false);

  process.env.CAPACITY_WRITES_ENABLED = "1";
  const holds = await loadHolds();
  assert.equal(holds.holds.length, 1);
  assert.equal(holds.holds[0].sessionId, sessionId);
  assert.equal((await loadLessons()).lessons.length, 0);

  const slot = await seatSources();
  assert.equal(slot.seats, 1);
  assert.equal(slot.sources[0].kind, "hold");
});

test("repeated confirmation is safe after the hold is already released", async () => {
  const sessionId = "cs_retry";
  const paymentIntent = "pi_retry";
  const meta = standardMeta("Riley", "riley@example.com");
  assert.equal(
    await placeHold(sessionId, [{ date: DATE, time: TIME }], 60, "Hitting", {
      seats: 1,
      type: "single",
      privacy: "standard",
    }),
    true
  );

  const confirmationSent = {};
  mockStripe({
    sessions: [paidSession(sessionId, paymentIntent, meta)],
    confirmationSent,
  });

  const first = await deliverConfirmation({
    key: "sk_test",
    sessionId,
    origin: "https://www.apacademybsb.com",
  });
  // Skip email (no Resend key) so the test isolates mirror + hold release.
  assert.equal(first.status, 200);
  assert.equal((await loadHolds()).holds.length, 0);
  assert.equal((await loadLessons()).lessons.filter((l) => l.sourceId === paymentIntent).length, 1);

  // Mark confirmation already sent, then retry (webhook/page refresh).
  confirmationSent[paymentIntent] = true;
  const second = await deliverConfirmation({
    key: "sk_test",
    sessionId,
    origin: "https://www.apacademybsb.com",
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadySent, true);
  assert.equal((await loadHolds()).holds.length, 0);
  assert.equal((await loadLessons()).lessons.filter((l) => l.sourceId === paymentIntent).length, 1);
  assert.equal(await releaseHold(sessionId), true);

  const slot = await seatSources();
  assert.equal(slot.seats, 1);
  assert.equal(slot.sources.length, 1);
});

test("two separate standard bookings in the same slot count two seats after holds release", async () => {
  const a = {
    sessionId: "cs_std_a",
    paymentIntent: "pi_std_a",
    meta: standardMeta("Alex", "alex@example.com"),
  };
  const b = {
    sessionId: "cs_std_b",
    paymentIntent: "pi_std_b",
    meta: standardMeta("Blake", "blake@example.com"),
  };

  for (const row of [a, b]) {
    assert.equal(
      await placeHold(row.sessionId, [{ date: DATE, time: TIME }], 60, "Hitting", {
        seats: 1,
        type: "single",
        privacy: "standard",
      }),
      true
    );
  }
  assert.equal((await loadHolds()).holds.length, 2);

  // Pre-fix double-count: two holds + (after mirror without release) would be 4.
  mockStripe({
    sessions: [
      paidSession(a.sessionId, a.paymentIntent, a.meta),
      paidSession(b.sessionId, b.paymentIntent, b.meta),
    ],
  });

  const first = await deliverConfirmation({
    key: "sk_test",
    sessionId: a.sessionId,
    origin: "https://www.apacademybsb.com",
  });
  const second = await deliverConfirmation({
    key: "sk_test",
    sessionId: b.sessionId,
    origin: "https://www.apacademybsb.com",
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await loadHolds()).holds.length, 0);

  const lessons = await loadLessons();
  assert.equal(lessons.lessons.length, 2);

  const slot = await seatSources();
  assert.equal(slot.seats, SLOT_CAPACITY);
  assert.equal(slot.sources.length, 2);
  assert.ok(slot.sources.every((s) => s.kind === "paid"));
  assert.equal(slot.exclusive, true);

  // A third standard athlete is blocked by the two paid seats alone.
  const blocked = await mutateLessons((data) => {
    const taken = data.lessons.filter((l) => l.date === DATE && l.time === TIME && !l.cancelledAt);
    if (taken.reduce((n, l) => n + (Number(l.seats) || 1), 0) >= SLOT_CAPACITY) {
      return { ok: false, code: "slot_taken" };
    }
    data.lessons.push({
      id: "intruder-1",
      date: DATE,
      time: TIME,
      focus: "Hitting",
      privacy: "standard",
      seats: 1,
      type: "single",
    });
    return { ok: true };
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "slot_taken");
});
