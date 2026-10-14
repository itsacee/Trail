// Paid Stripe → Postgres reconciliation, occupancy safety net, conflicts.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";

import { createBookingStore, closeBookingStore } from "../lib/bookingDb/createStore.js";
import {
  getBookingStore,
  resetBookingStoreCache,
} from "../lib/bookingStore.js";
import {
  reconcilePaidCheckoutSession,
  reconcileRecentPaidSessions,
  occupancyHasStripeSource,
  listRecentPaidCheckoutSessions,
} from "../lib/bookingDb/stripePaidReconcile.js";
import { bookedTimes } from "../api/slots.js";
import { authorityMatrix } from "../lib/bookingDb/authority.js";

let handle;
let store;

before(async () => {
  process.env.BOOKING_STORE = "memory";
  process.env.BOOKING_ALLOW_NON_PREVIEW = "1";
  process.env.VERCEL_ENV = "preview";
  process.env.BOOKING_READS_ENABLED = "0";
  process.env.BOOKING_WRITES_ENABLED = "0";
  await resetBookingStoreCache();
  // Use the same singleton bookedTimes/loadDbOccupancy will see.
  store = await getBookingStore(process.env);
  handle = { store, pool: null };
});

after(async () => {
  await resetBookingStoreCache();
  if (handle?.pool) await closeBookingStore(handle);
  delete process.env.BOOKING_STORE;
  delete process.env.BOOKING_READS_ENABLED;
  delete process.env.BOOKING_WRITES_ENABLED;
  delete process.env.BOOKING_ALLOW_NON_PREVIEW;
  delete process.env.VERCEL_ENV;
  mock.restoreAll();
});

async function clear() {
  await store.query("DELETE FROM reconcile_alerts");
  await store.query("DELETE FROM idempotency_keys");
  await store.query("DELETE FROM bookings");
  await store.query("DELETE FROM membership_credits");
  await store.query("DELETE FROM slot_locks");
}

test("occupancyHasStripeSource matches pi and pi-N lesson ids", () => {
  assert.equal(occupancyHasStripeSource([{ id: "pi_abc-1", kind: "paid" }], "pi_abc"), true);
  assert.equal(occupancyHasStripeSource([{ id: "pi_abc", sourceRef: "pi_abc" }], "pi_abc"), true);
  assert.equal(occupancyHasStripeSource([{ id: "pi_other-1" }], "pi_abc"), false);
  assert.equal(occupancyHasStripeSource([], "pi_abc"), false);
});

test("authority matrix documents Blob vs Postgres ownership", () => {
  const m = authorityMatrix();
  assert.ok(m.postgresAuthoritative.some((s) => /booking/i.test(s)));
  assert.ok(m.stripeAuthoritative.some((s) => /payment/i.test(s)));
  assert.ok(m.blobAuthoritative.some((s) => /finance/i.test(s)));
  assert.ok(m.neverDo.some((s) => /Auto-evict/i.test(s)));
});

test("reconcile mirrors a paid session idempotently without duplicates", async () => {
  await clear();
  process.env.BOOKING_WRITES_ENABLED = "1";
  const session = {
    id: "cs_recon_1",
    payment_status: "paid",
    payment_intent: "pi_recon_1",
    metadata: {
      date: "2026-12-01",
      time: "6:00 PM",
      focus: "Hitting",
      type: "single",
      privacy: "standard",
      email: "recon@example.com",
      player: "Recon Kid",
    },
  };
  const first = await reconcilePaidCheckoutSession(store, session, { env: process.env });
  assert.equal(first.ok, true);
  assert.equal(first.action, "mirrored");
  const second = await reconcilePaidCheckoutSession(store, session, { env: process.env });
  assert.equal(second.ok, true);
  assert.equal(second.action, "already_mirrored");
  const { rows } = await store.query(
    `SELECT count(*)::int AS n FROM bookings WHERE source_ref = 'pi_recon_1' AND status = 'active'`
  );
  assert.equal(rows[0].n, 1);
  process.env.BOOKING_WRITES_ENABLED = "0";
});

test("reconcile conflict alerts operator and never deletes the seated customer", async () => {
  await clear();
  process.env.BOOKING_WRITES_ENABLED = "1";
  // Fill the hour with two standard seats.
  await store.confirmPaid({
    idempotencyKey: "mirror:pi_seat_a",
    sourceId: "pi_seat_a",
    metadata: {
      date: "2026-12-02",
      time: "6:00 PM",
      focus: "Hitting",
      type: "single",
      email: "a@example.com",
      player: "A",
    },
  });
  await store.confirmPaid({
    idempotencyKey: "mirror:pi_seat_b",
    sourceId: "pi_seat_b",
    metadata: {
      date: "2026-12-02",
      time: "6:00 PM",
      focus: "Hitting",
      type: "single",
      email: "b@example.com",
      player: "B",
    },
  });

  const conflictSession = {
    id: "cs_conflict",
    payment_status: "paid",
    payment_intent: "pi_conflict",
    metadata: {
      date: "2026-12-02",
      time: "6:00 PM",
      focus: "Hitting",
      type: "single",
      email: "paid@example.com",
      player: "Paid Late",
    },
  };
  const outcome = await reconcilePaidCheckoutSession(store, conflictSession, { env: process.env });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.action, "alert_operator");
  assert.equal(outcome.alertId, "paid_conflict:pi_conflict");

  const seated = await store.query(
    `SELECT source_ref FROM bookings
     WHERE slot_date = '2026-12-02'::date AND time_label = '6:00 PM' AND status = 'active'
     ORDER BY source_ref`
  );
  assert.equal(seated.rows.length, 2);
  assert.deepEqual(
    seated.rows.map((r) => r.source_ref),
    ["pi_seat_a", "pi_seat_b"]
  );
  // Conflict payment must not appear as an active booking.
  const late = await store.listActiveBySourceRef("pi_conflict");
  assert.equal(late.length, 0);

  const alerts = await store.listOpenReconcileAlerts();
  assert.ok(alerts.some((a) => a.id === "paid_conflict:pi_conflict"));
  process.env.BOOKING_WRITES_ENABLED = "0";
});

test("confirmPaid rolls back partial multi-slot writes on capacity failure", async () => {
  await clear();
  // Block second hour with a private lesson.
  await store.confirmPaid({
    idempotencyKey: "mirror:pi_block_h2",
    sourceId: "pi_block_h2",
    metadata: {
      date: "2026-12-03",
      time: "7:00 PM",
      focus: "Hitting",
      type: "private",
      privacy: "private",
      email: "block@example.com",
      player: "Block",
    },
  });
  const multi = await store.confirmPaid({
    idempotencyKey: "mirror:pi_multi_partial",
    sourceId: "pi_multi_partial",
    metadata: {
      date1: "2026-12-03",
      time1: "6:00 PM",
      date2: "2026-12-03",
      time2: "7:00 PM",
      focus: "Hitting",
      type: "single",
      email: "multi@example.com",
      player: "Multi",
    },
  });
  assert.equal(multi.ok, false);
  assert.equal(multi.code, "slot_unavailable");
  const { rows } = await store.query(
    `SELECT id, status FROM bookings WHERE source_ref = 'pi_multi_partial'`
  );
  assert.equal(rows.length, 0, "partial mirror must roll back");
  const keys = await store.query(`SELECT key FROM idempotency_keys WHERE key = 'mirror:pi_multi_partial'`);
  assert.equal(keys.rows.length, 0, "failed mirror must not stamp idempotency");
});

test("webhook-style retries stay idempotent after successful mirror", async () => {
  await clear();
  process.env.BOOKING_WRITES_ENABLED = "1";
  const meta = {
    date: "2026-12-04",
    time: "6:00 PM",
    focus: "Fielding",
    type: "single",
    email: "retry@example.com",
    player: "Retry",
  };
  const session = {
    id: "cs_retry",
    payment_status: "paid",
    payment_intent: "pi_retry",
    metadata: meta,
  };
  const a = await reconcilePaidCheckoutSession(store, session, { env: process.env });
  const b = await reconcilePaidCheckoutSession(store, session, { env: process.env });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.idempotent || b.action === "already_mirrored", true);
  const { rows } = await store.query(
    `SELECT count(*)::int AS n FROM bookings WHERE source_ref = 'pi_retry' AND status = 'active'`
  );
  assert.equal(rows[0].n, 1);
  process.env.BOOKING_WRITES_ENABLED = "0";
});

test("membership credit audit detects ledger lag and sync repairs without double-spend", async () => {
  await clear();
  const membershipId = "cash_audit@example.com";
  await store.manualBook({
    id: "cash_audit_1",
    date: "2026-12-05",
    time: "6:00 PM",
    focus: "Hitting",
    type: "membership",
    membershipId,
    email: "audit@example.com",
    player: "Audit",
    seats: 1,
  });
  await store.query(
    `INSERT INTO membership_credits (membership_id, email, tier, credits_total, credits_used, status)
     VALUES ($1, 'audit@example.com', 'standard', 4, 0, 'active')`,
    [membershipId]
  );
  const audit = await store.auditMembershipCredits({ membershipId });
  assert.equal(audit[0].mismatch, true);
  assert.equal(audit[0].lessonCount, 1);
  assert.equal(audit[0].creditsUsed, 0);
  const synced = await store.syncMembershipCreditsFromLessons({ membershipId });
  assert.equal(synced.ok, true);
  assert.equal(synced.creditsUsed, 1);
  process.env.BOOKING_WRITES_ENABLED = "1";
  const next = await store.memberBook({
    membershipId,
    email: "audit@example.com",
    date: "2026-12-08",
    time: "6:00 PM",
    focus: "Hitting",
    type: "membership",
    creditsTotal: 4,
  });
  assert.equal(next.ok, true);
  const after = await store.getMembershipCredits(membershipId);
  assert.equal(after.credits_used, 2);
  process.env.BOOKING_WRITES_ENABLED = "0";
});

test("reconcile defers when writes are disabled (reads safety net still applies)", async () => {
  await clear();
  process.env.BOOKING_WRITES_ENABLED = "0";
  const outcome = await reconcilePaidCheckoutSession(
    store,
    {
      id: "cs_defer",
      payment_status: "paid",
      payment_intent: "pi_defer",
      metadata: {
        date: "2026-12-06",
        time: "6:00 PM",
        focus: "Hitting",
        type: "single",
        email: "defer@example.com",
        player: "Defer",
      },
    },
    { env: process.env }
  );
  assert.equal(outcome.action, "deferred");
  assert.equal(outcome.code, "writes_disabled");
});

test("bookedTimes with Postgres reads keeps paid-unmirrored seats after hold would expire", async () => {
  await clear();
  process.env.BOOKING_READS_ENABLED = "1";
  process.env.BOOKING_WRITES_ENABLED = "0";
  process.env.BOOKING_STORE = "memory";
  // Seed one PG booking so reads path is active; Stripe mock returns a second paid PI.
  await store.importBookingRow({
    id: "pi_seed-1",
    source: "stripe",
    source_ref: "pi_seed",
    status: "active",
    slot_date: "2026-12-07",
    time_label: "6:00 PM",
    focus: "Hitting",
    privacy: "standard",
    seats: 1,
    booking_type: "single",
    email: "seed@example.com",
    player: "Seed",
  });

  mock.method(globalThis, "fetch", async (url) => {
    const path = String(url);
    if (path.includes("/search?")) {
      // Unmirrored paid PI for the same hour — must still occupy a seat.
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "pi_unmirrored",
              status: "succeeded",
              created: Math.floor(Date.now() / 1000),
              metadata: {
                date: "2026-12-07",
                time: "6:00 PM",
                focus: "Hitting",
                type: "single",
                player: "Unmirrored",
                seats: "1",
              },
            },
          ],
        }),
      };
    }
    if (path.includes("/checkout/sessions?")) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  });

  try {
    const taken = await bookedTimes("sk_test", "2026-12-07");
    const hour = taken.find((t) => t.time === "6:00 PM");
    assert.ok(hour, "6:00 PM should be present");
    const seats = hour.sources.reduce((n, s) => n + (Number(s.seats) || 1), 0);
    assert.equal(seats, 2, "seed + unmirrored paid must both occupy");
    assert.ok(hour.sources.some((s) => s.id === "pi_unmirrored" || s.sourceRef === "pi_unmirrored"));
    assert.ok(hour.sources.some((s) => s.id === "pi_seed-1" || s.sourceRef === "pi_seed"));
  } finally {
    mock.restoreAll();
    process.env.BOOKING_READS_ENABLED = "0";
  }
});

test("batch reconcile surfaces open alerts for operator recovery", async () => {
  await clear();
  process.env.BOOKING_WRITES_ENABLED = "1";
  await store.confirmPaid({
    idempotencyKey: "mirror:pi_full_1",
    sourceId: "pi_full_1",
    metadata: {
      date: "2026-12-09",
      time: "6:00 PM",
      focus: "Hitting",
      type: "single",
      email: "f1@example.com",
      player: "F1",
    },
  });
  await store.confirmPaid({
    idempotencyKey: "mirror:pi_full_2",
    sourceId: "pi_full_2",
    metadata: {
      date: "2026-12-09",
      time: "6:00 PM",
      focus: "Hitting",
      type: "single",
      email: "f2@example.com",
      player: "F2",
    },
  });

  mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("checkout/sessions?")) {
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "cs_batch_conflict",
              payment_status: "paid",
              payment_intent: "pi_batch_conflict",
              created: Math.floor(Date.now() / 1000),
              metadata: {
                date: "2026-12-09",
                time: "6:00 PM",
                focus: "Hitting",
                type: "single",
                email: "late@example.com",
                player: "Late",
              },
            },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  });

  try {
    const report = await reconcileRecentPaidSessions(store, "sk_test", { env: process.env });
    assert.equal(report.summary.alerts, 1);
    assert.ok(report.openAlerts.some((a) => a.id === "paid_conflict:pi_batch_conflict"));
  } finally {
    mock.restoreAll();
    process.env.BOOKING_WRITES_ENABLED = "0";
  }
});

test("listRecentPaidCheckoutSessions filters to paid only", async () => {
  mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: "cs_paid", payment_status: "paid", metadata: { date: "2026-12-10" } },
        { id: "cs_unpaid", payment_status: "unpaid", metadata: { date: "2026-12-10" } },
      ],
    }),
  }));
  try {
    const listed = await listRecentPaidCheckoutSessions("sk_test", { lookbackHours: 2 });
    assert.equal(listed.ok, true);
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].id, "cs_paid");
  } finally {
    mock.restoreAll();
  }
});
