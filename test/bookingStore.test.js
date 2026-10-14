// Authoritative BookingStore tests (pg-mem SQL transactions).
// No cloud database, no Blob mutations, no Stripe network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createBookingStore, closeBookingStore } from "../lib/bookingDb/createStore.js";
import { importBlobSnapshots } from "../lib/bookingDb/importFromBlob.js";
import { reconcileBlobToDb } from "../lib/bookingDb/reconcile.js";
import { evaluateAdmission } from "../lib/bookingDb/capacity.js";
import {
  bookingReadsEnabled,
  bookingWritesEnabled,
  bookingStoreMode,
  assertPreviewDbAllowed,
} from "../lib/bookingDb/flags.js";
import { slotBlocked } from "../lib/schedule.js";

let handle;
let store;

before(async () => {
  handle = await createBookingStore({
    mode: "memory",
    useMem: true,
    env: { BOOKING_ALLOW_NON_PREVIEW: "1", VERCEL_ENV: "preview" },
  });
  store = handle.store;
});

after(async () => {
  await closeBookingStore(handle);
});

async function clearBookings() {
  await store.query("DELETE FROM idempotency_keys");
  await store.query("DELETE FROM bookings");
  await store.query("DELETE FROM membership_credits");
  await store.query("DELETE FROM slot_locks");
}

test("flags keep writes disabled by default", () => {
  assert.equal(bookingStoreMode({}), "blob");
  assert.equal(bookingReadsEnabled({ BOOKING_STORE: "postgres" }), false);
  assert.equal(bookingWritesEnabled({ BOOKING_STORE: "postgres" }), false);
  assert.equal(
    bookingWritesEnabled({ BOOKING_STORE: "postgres", BOOKING_WRITES_ENABLED: "1" }),
    true
  );
  assert.equal(
    bookingWritesEnabled({
      BOOKING_STORE: "postgres",
      BOOKING_WRITES_ENABLED: "1",
      BOOKING_DUAL_WRITE_BLOB: "1",
    }),
    false
  );
  assert.equal(assertPreviewDbAllowed({ VERCEL_ENV: "production" }).ok, false);
  assert.equal(assertPreviewDbAllowed({ VERCEL_ENV: "preview" }).ok, true);
});

test("capacity helper matches schedule rules for private and focus conflicts", () => {
  const existing = [
    {
      id: "a",
      status: "active",
      time_label: "6:00 PM",
      mins: 60,
      focus: "Hitting",
      privacy: "standard",
      seats: 1,
    },
  ];
  assert.equal(evaluateAdmission(existing, { focus: "Fielding", time: "6:00 PM", privacy: "standard" }).ok, false);
  assert.equal(evaluateAdmission(existing, { focus: "Hitting", time: "6:00 PM", privacy: "standard" }).ok, true);
  assert.equal(evaluateAdmission(existing, { focus: "Hitting", time: "6:00 PM", privacy: "private" }).ok, false);

  const privateHour = [
    {
      id: "p",
      status: "active",
      time_label: "7:00 PM",
      mins: 60,
      focus: "Hitting",
      privacy: "private",
      seats: 2,
    },
  ];
  assert.equal(
    evaluateAdmission(privateHour, { focus: "Hitting", time: "7:00 PM", privacy: "standard" }).ok,
    false
  );
});

test("simultaneous standard bookings: two seats then reject third", async () => {
  await clearBookings();
  const date = "2026-11-02";
  const time = "6:00 PM";

  const a = await store.reserveHold({
    sessionId: "cs_a",
    slots: [{ date, time }],
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    seats: 1,
  });
  const b = await store.reserveHold({
    sessionId: "cs_b",
    slots: [{ date, time }],
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    seats: 1,
  });
  const c = await store.reserveHold({
    sessionId: "cs_c",
    slots: [{ date, time }],
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    seats: 1,
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(c.ok, false);
  assert.equal(c.code, "slot_unavailable");
});

test("different focuses cannot share an hour", async () => {
  await clearBookings();
  const date = "2026-11-02";
  const time = "7:00 PM";
  const a = await store.confirmPaid({
    idempotencyKey: "mirror:pi_hit",
    sourceId: "pi_hit",
    metadata: {
      date,
      time,
      focus: "Hitting",
      type: "single",
      privacy: "standard",
      email: "a@example.com",
      player: "A",
    },
  });
  const b = await store.confirmPaid({
    idempotencyKey: "mirror:pi_field",
    sourceId: "pi_field",
    metadata: {
      date,
      time,
      focus: "Fielding",
      type: "single",
      privacy: "standard",
      email: "b@example.com",
      player: "B",
    },
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
});

test("private lesson reserves entire hour", async () => {
  await clearBookings();
  const date = "2026-11-03";
  const time = "6:00 PM";
  const priv = await store.confirmPaid({
    idempotencyKey: "mirror:pi_priv",
    sourceId: "pi_priv",
    metadata: {
      date,
      time,
      focus: "Both",
      type: "private",
      privacy: "private",
      email: "p@example.com",
      player: "P",
    },
  });
  const other = await store.reserveHold({
    sessionId: "cs_other",
    slots: [{ date, time }],
    focus: "Both",
    type: "single",
    privacy: "standard",
    seats: 1,
  });
  assert.equal(priv.ok, true);
  assert.equal(other.ok, false);
});

test("payment retries are idempotent", async () => {
  await clearBookings();
  const meta = {
    date: "2026-11-04",
    time: "6:00 PM",
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    email: "pay@example.com",
    player: "Pay",
  };
  const first = await store.confirmPaid({
    idempotencyKey: "mirror:pi_retry",
    sourceId: "pi_retry",
    sessionId: "cs_retry",
    metadata: meta,
  });
  const second = await store.confirmPaid({
    idempotencyKey: "mirror:pi_retry",
    sourceId: "pi_retry",
    sessionId: "cs_retry",
    metadata: meta,
  });
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  const { rows } = await store.query(
    `SELECT count(*)::int AS n FROM bookings WHERE source_ref = 'pi_retry' AND status = 'active'`
  );
  assert.equal(rows[0].n, 1);
});

test("membership credit accounting and reschedule preserve credit on failure", async () => {
  await clearBookings();
  const membershipId = "sub_test_1";
  const email = "member@example.com";

  const book1 = await store.memberBook({
    membershipId,
    email,
    date: "2026-11-05",
    time: "6:00 PM",
    focus: "Hitting",
    type: "membership",
    privacy: "standard",
    player: "Kid",
    creditsTotal: 4,
  });
  assert.equal(book1.ok, true);
  assert.equal(book1.creditsUsed, 1);

  // Fill the target hour with a private lesson so move must fail.
  await store.confirmPaid({
    idempotencyKey: "mirror:pi_block",
    sourceId: "pi_block",
    metadata: {
      date: "2026-11-06",
      time: "6:00 PM",
      focus: "Hitting",
      type: "private",
      privacy: "private",
      email: "x@example.com",
      player: "X",
    },
  });

  const moveFail = await store.reschedule({
    bookingId: book1.bookingId,
    newDate: "2026-11-06",
    newTime: "6:00 PM",
    newFocus: "Hitting",
  });
  assert.equal(moveFail.ok, false);

  const original = await store.getBooking(book1.bookingId);
  assert.equal(original.status, "active");
  assert.equal(String(original.slot_date).slice(0, 10), "2026-11-05");
  assert.equal(original.time_label, "6:00 PM");

  const credits = await store.getMembershipCredits(membershipId);
  assert.equal(credits.credits_used, 1);

  const moveOk = await store.reschedule({
    bookingId: book1.bookingId,
    newDate: "2026-11-07",
    newTime: "6:00 PM",
    newFocus: "Hitting",
  });
  assert.equal(moveOk.ok, true);
  const moved = await store.getBooking(book1.bookingId);
  assert.equal(String(moved.slot_date).slice(0, 10), "2026-11-07");
  const creditsAfter = await store.getMembershipCredits(membershipId);
  assert.equal(creditsAfter.credits_used, 1);
});

test("cancel restores membership credit", async () => {
  await clearBookings();
  const membershipId = "sub_test_2";
  const book = await store.memberBook({
    membershipId,
    email: "c@example.com",
    date: "2026-11-08",
    time: "6:00 PM",
    focus: "Fielding",
    type: "membership",
    privacy: "standard",
    creditsTotal: 4,
  });
  assert.equal(book.ok, true);
  const cancelled = await store.cancelBooking(book.bookingId, { restoreCredit: true });
  assert.equal(cancelled.ok, true);
  const credits = await store.getMembershipCredits(membershipId);
  assert.equal(credits.credits_used, 0);
});

test("import from Blob snapshots is read-only on Blob and reconciles", async () => {
  await clearBookings();
  const snapshots = {
    lessons: {
      lessons: [
        {
          id: "pi_imp-1",
          source: "stripe",
          sourceId: "pi_imp",
          date: "2026-11-09",
          time: "6:00 PM",
          focus: "Hitting",
          type: "single",
          privacy: "standard",
          email: "imp@example.com",
          player: "Imp",
          seats: 1,
        },
      ],
      voids: [],
    },
    holds: {
      holds: [
        {
          sessionId: "cs_imp",
          date: "2026-11-09",
          time: "7:00 PM",
          mins: 60,
          focus: "Fielding",
          seats: 1,
          type: "single",
          privacy: "standard",
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * 60 * 1000,
        },
      ],
    },
    manual: {
      bookings: [
        {
          id: "mb_imp",
          date: "2026-11-10",
          time: "6:00 PM",
          focus: "Both",
          type: "single",
          privacy: "standard",
          email: "cash@example.com",
          player: "Cash",
          seats: 1,
          status: "active",
        },
      ],
    },
  };

  const imported = await importBlobSnapshots(snapshots, store);
  assert.equal(imported.lessons_imported, 1);
  assert.equal(imported.holds_imported, 1);
  assert.equal(imported.manual_imported, 1);
  assert.equal(imported.errors.length, 0);

  const reconciliation = await reconcileBlobToDb(snapshots, store);
  assert.equal(reconciliation.ok, true, JSON.stringify(reconciliation.summary));
});

test("concurrent reserveHold against same hour: at most two standard seats", async () => {
  await clearBookings();
  const date = "2026-11-11";
  const time = "6:00 PM";
  const attempts = Array.from({ length: 8 }, (_, i) =>
    store.reserveHold({
      sessionId: `cs_race_${i}`,
      slots: [{ date, time }],
      focus: "Hitting",
      type: "single",
      privacy: "standard",
      seats: 1,
    })
  );
  const results = await Promise.all(attempts);
  const wins = results.filter((r) => r.ok);
  const losses = results.filter((r) => !r.ok);
  assert.equal(wins.length, 2);
  assert.equal(losses.length, 6);
  const occ = await store.listOccupancy(date);
  const held = occ.filter((r) => r.time_label === time || r.time === time);
  // listOccupancy returns raw rows
  const atTime = occ.filter((r) => r.time_label === time);
  assert.equal(atTime.length, 2);
  // schedule view still blocks a third
  assert.equal(
    slotBlocked(
      atTime.map((r) => ({
        time: r.time_label,
        mins: 60,
        focuses: [r.focus],
        privacy: r.privacy,
        seats: r.seats,
      })),
      time,
      60,
      "Hitting",
      { seats: 1, privacy: "standard" }
    ),
    true
  );
});

test("standard Hitting+Fielding shares of 2 with matching focus only", async () => {
  await clearBookings();
  const date = "2026-11-12";
  const time = "6:00 PM";
  const a = await store.confirmPaid({
    idempotencyKey: "mirror:pi_both1",
    sourceId: "pi_both1",
    metadata: {
      date,
      time,
      focus: "Both",
      type: "single",
      privacy: "standard",
      email: "1@example.com",
      player: "1",
    },
  });
  const b = await store.confirmPaid({
    idempotencyKey: "mirror:pi_both2",
    sourceId: "pi_both2",
    metadata: {
      date,
      time,
      focus: "Both",
      type: "membership",
      privacy: "standard",
      email: "2@example.com",
      player: "2",
    },
  });
  const c = await store.confirmPaid({
    idempotencyKey: "mirror:pi_both3",
    sourceId: "pi_both3",
    metadata: {
      date,
      time,
      focus: "Both",
      type: "single",
      privacy: "standard",
      email: "3@example.com",
      player: "3",
    },
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(c.ok, false);
});

test("manualBook enforces capacity and is idempotent on retry", async () => {
  await clearBookings();
  const date = "2026-11-13";
  const time = "6:00 PM";
  const first = await store.manualBook({
    id: "cash_m1",
    date,
    time,
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    seats: 1,
    email: "m1@example.com",
    player: "M1",
    payload: { amountDueCents: 4000, paymentMethod: "cash" },
  });
  const again = await store.manualBook({
    id: "cash_m1",
    date,
    time,
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    seats: 1,
    email: "m1@example.com",
    player: "M1",
  });
  const second = await store.manualBook({
    id: "cash_m2",
    date,
    time,
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    seats: 1,
    email: "m2@example.com",
    player: "M2",
  });
  const third = await store.manualBook({
    id: "cash_m3",
    date,
    time,
    focus: "Hitting",
    type: "single",
    privacy: "standard",
    seats: 1,
    email: "m3@example.com",
    player: "M3",
  });
  assert.equal(first.ok, true);
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  assert.equal(third.code, "slot_unavailable");
});

test("simultaneous standard bookings admit exactly two matching-focus seats", async () => {
  await clearBookings();
  const date = "2026-11-14";
  const time = "6:00 PM";
  const attempts = await Promise.all(
    [1, 2, 3, 4].map((n) =>
      store.confirmPaid({
        idempotencyKey: `mirror:pi_race_${n}`,
        sourceId: `pi_race_${n}`,
        metadata: {
          date,
          time,
          focus: "Hitting",
          type: "single",
          privacy: "standard",
          email: `r${n}@example.com`,
          player: `R${n}`,
        },
      })
    )
  );
  const ok = attempts.filter((r) => r.ok);
  const denied = attempts.filter((r) => !r.ok);
  assert.equal(ok.length, 2);
  assert.equal(denied.length, 2);
  const { rows } = await store.query(
    `SELECT count(*)::int AS n FROM bookings
     WHERE slot_date = $1::date AND time_label = $2 AND status = 'active'`,
    [date, time]
  );
  assert.equal(rows[0].n, 2);
});

test("simultaneous reschedules into one hour keep original appointments on failure", async () => {
  await clearBookings();
  const a = await store.memberBook({
    membershipId: "sub_race_a",
    email: "ra@example.com",
    date: "2026-11-15",
    time: "5:00 PM",
    focus: "Hitting",
    type: "membership",
    privacy: "standard",
    creditsTotal: 4,
  });
  const b = await store.memberBook({
    membershipId: "sub_race_b",
    email: "rb@example.com",
    date: "2026-11-15",
    time: "7:00 PM",
    focus: "Hitting",
    type: "membership",
    privacy: "standard",
    creditsTotal: 4,
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  // Private blocker leaves only one standard seat free at 6:00 — actually private
  // fills the hour, so both moves must fail and originals stay put.
  await store.confirmPaid({
    idempotencyKey: "mirror:pi_race_block",
    sourceId: "pi_race_block",
    metadata: {
      date: "2026-11-16",
      time: "6:00 PM",
      focus: "Hitting",
      type: "private",
      privacy: "private",
      email: "block@example.com",
      player: "Block",
    },
  });

  const [moveA, moveB] = await Promise.all([
    store.reschedule({
      bookingId: a.bookingId,
      newDate: "2026-11-16",
      newTime: "6:00 PM",
      newFocus: "Hitting",
    }),
    store.reschedule({
      bookingId: b.bookingId,
      newDate: "2026-11-16",
      newTime: "6:00 PM",
      newFocus: "Hitting",
    }),
  ]);
  assert.equal(moveA.ok, false);
  assert.equal(moveB.ok, false);

  const origA = await store.getBooking(a.bookingId);
  const origB = await store.getBooking(b.bookingId);
  assert.equal(origA.status, "active");
  assert.equal(origB.status, "active");
  assert.equal(String(origA.slot_date).slice(0, 10), "2026-11-15");
  assert.equal(String(origB.slot_date).slice(0, 10), "2026-11-15");
  assert.equal(origA.time_label, "5:00 PM");
  assert.equal(origB.time_label, "7:00 PM");

  const creditsA = await store.getMembershipCredits("sub_race_a");
  const creditsB = await store.getMembershipCredits("sub_race_b");
  assert.equal(creditsA.credits_used, 1);
  assert.equal(creditsB.credits_used, 1);
});
