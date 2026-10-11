// Stage 2B: parallel booking writers against a memory Blob with real ETag CAS.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { useMemoryBlobStore, clearMemoryBlobStore, blobCompareAndSet } from "../lib/store.js";
import { mutateVersioned } from "../lib/blobTxn.js";
import {
  loadLessons,
  mutateLessons,
  commitLessons,
  upsertStripeLessons,
} from "../lib/lessons.js";
import { mutateManualBookings, loadManualBookings } from "../lib/manualBookings.js";
import {
  slotBlocked,
  isExclusiveBooking,
  SLOT_CAPACITY,
  resolvePrivacy,
} from "../lib/schedule.js";

const DATE = "2026-11-10";
const TIME = "5:00 PM";

function bookedFromLessons(lessons, date = DATE) {
  return (lessons || [])
    .filter((l) => l.date === date && !l.cancelledAt && String(l.status || "").toLowerCase() !== "cancelled")
    .map((l) => ({
      time: l.time,
      mins: 60,
      seats: Number(l.seats) || (resolvePrivacy(l) === "private" ? SLOT_CAPACITY : 1),
      focuses: [l.focus].filter(Boolean),
      privacy: l.privacy || "",
      exclusive: isExclusiveBooking(l),
    }));
}

function stdLesson(id, focus = "Hitting") {
  return {
    id,
    date: DATE,
    time: TIME,
    focus,
    privacy: "standard",
    seats: 1,
    type: "single",
    email: `${id}@example.com`,
  };
}

function privateLesson(id, focus = "Hitting") {
  return {
    id,
    date: DATE,
    time: TIME,
    focus,
    privacy: "private",
    seats: SLOT_CAPACITY,
    type: "private",
    email: `${id}@example.com`,
  };
}

async function seedLessons(rows) {
  const first = await mutateLessons((data) => {
    data.lessons = rows.map((r) => ({ ...r }));
    data.voids = [];
    return { ok: true };
  });
  assert.equal(first.ok, true);
}

/** Hold both parallel mutators until each has loaded the same snapshot. */
function makeBarrier(n = 2) {
  let arrived = 0;
  return async () => {
    arrived += 1;
    while (arrived < n) {
      await new Promise((r) => setImmediate(r));
    }
  };
}

before(() => {
  useMemoryBlobStore(true);
});

after(() => {
  useMemoryBlobStore(false);
});

beforeEach(() => {
  clearMemoryBlobStore();
});

test("compare-and-set rejects a stale etag without overwriting", async () => {
  assert.equal((await blobCompareAndSet("lessons.json", { lessons: [{ id: "a" }], voids: [] }, "")).ok, true);
  const loaded = await loadLessons();
  const stale = loaded._etag;
  assert.equal((await blobCompareAndSet("lessons.json", { lessons: [{ id: "b" }], voids: [] }, stale)).ok, true);
  const conflict = await blobCompareAndSet("lessons.json", { lessons: [{ id: "stale" }], voids: [] }, stale);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  const final = await loadLessons();
  assert.deepEqual(
    final.lessons.map((l) => l.id),
    ["b"]
  );
});

test("exhausted CAS retries return a safe error", async () => {
  const result = await mutateVersioned({
    load: async () => ({ lessons: [], voids: [] }),
    commit: async () => ({ ok: false, conflict: true }),
    mutator: async () => ({ ok: true }),
    attempts: 3,
  });
  assert.equal(result.ok, false);
  assert.equal(result.exhausted, true);
  assert.equal(result.code, "schedule_unavailable");
});

test("two simultaneous requests for the final standard seat — only one wins", async () => {
  await seedLessons([stdLesson("seed", "Hitting")]);
  const want = { seats: 1, privacy: "standard" };
  const barrier = makeBarrier(2);

  const race = async (id) =>
    mutateLessons(async (data) => {
      await barrier();
      if (slotBlocked(bookedFromLessons(data.lessons), TIME, 60, "Hitting", want)) {
        return { ok: false, code: "slot_taken", error: "full" };
      }
      data.lessons.push(stdLesson(id, "Hitting"));
      return { ok: true };
    });

  const [a, b] = await Promise.all([race("a"), race("b")]);
  const winners = [a, b].filter((r) => r.ok);
  const losers = [a, b].filter((r) => !r.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, "slot_taken");
  const final = await loadLessons();
  assert.equal(final.lessons.filter((l) => l.time === TIME).length, 2);
});

test("two simultaneous private bookings — only one wins", async () => {
  const want = { seats: SLOT_CAPACITY, exclusive: true, privacy: "private" };
  const barrier = makeBarrier(2);
  const race = async (id) =>
    mutateLessons(async (data) => {
      await barrier();
      if (slotBlocked(bookedFromLessons(data.lessons), TIME, 60, "Fielding", want)) {
        return { ok: false, code: "slot_taken", error: "private taken" };
      }
      data.lessons.push(privateLesson(id, "Fielding"));
      return { ok: true };
    });

  const [a, b] = await Promise.all([race("priv-a"), race("priv-b")]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal([a, b].filter((r) => !r.ok).length, 1);
  const final = await loadLessons();
  assert.equal(final.lessons.length, 1);
});

test("standard booking racing a private booking — only one wins", async () => {
  const barrier = makeBarrier(2);
  const [std, priv] = await Promise.all([
    mutateLessons(async (data) => {
      await barrier();
      const want = { seats: 1, privacy: "standard" };
      if (slotBlocked(bookedFromLessons(data.lessons), TIME, 60, "Hitting", want)) {
        return { ok: false, code: "slot_taken" };
      }
      data.lessons.push(stdLesson("std-race", "Hitting"));
      return { ok: true };
    }),
    mutateLessons(async (data) => {
      await barrier();
      const want = { seats: SLOT_CAPACITY, exclusive: true, privacy: "private" };
      if (slotBlocked(bookedFromLessons(data.lessons), TIME, 60, "Hitting", want)) {
        return { ok: false, code: "slot_taken" };
      }
      data.lessons.push(privateLesson("priv-race", "Hitting"));
      return { ok: true };
    }),
  ]);
  assert.equal([std, priv].filter((r) => r.ok).length, 1);
  assert.equal([std, priv].filter((r) => !r.ok).length, 1);
});

test("two members booking simultaneously — credits and seats both enforced", async () => {
  await seedLessons([stdLesson("other-kid", "Hitting")]);
  const barrier = makeBarrier(2);

  const bookMember = (id) =>
    mutateLessons(async (data) => {
      await barrier();
      const mine = data.lessons.filter((l) => l.email === `${id}@example.com` && l.type === "membership");
      if (mine.length >= 4) return { ok: false, code: "no_credits", error: "no credits" };
      const want = { seats: 1, privacy: "standard" };
      if (slotBlocked(bookedFromLessons(data.lessons), TIME, 60, "Hitting", want)) {
        return { ok: false, code: "slot_taken" };
      }
      data.lessons.push({
        ...stdLesson(id, "Hitting"),
        type: "membership",
        email: `${id}@example.com`,
      });
      return { ok: true };
    });

  const [a, b] = await Promise.all([bookMember("mem-a"), bookMember("mem-b")]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal([a, b].filter((r) => r.code === "slot_taken").length, 1);
  const final = await loadLessons();
  assert.equal(final.lessons.length, 2);
});

test("concurrent booking and cancellation preserve other rows", async () => {
  // cancel-me is on a different hour so focus rules don't block the new seat.
  await seedLessons([
    stdLesson("keep-me", "Hitting"),
    { ...stdLesson("cancel-me", "Fielding"), time: "6:00 PM" },
  ]);
  const barrier = makeBarrier(2);
  const [booked, cancelled] = await Promise.all([
    mutateLessons(async (data) => {
      await barrier();
      const want = { seats: 1, privacy: "standard" };
      if (slotBlocked(bookedFromLessons(data.lessons), TIME, 60, "Hitting", want)) {
        return { ok: false, code: "slot_taken" };
      }
      data.lessons.push(stdLesson("new-book", "Hitting"));
      return { ok: true };
    }),
    mutateLessons(async (data) => {
      await barrier();
      const before = data.lessons.length;
      data.lessons = data.lessons.filter((l) => l.id !== "cancel-me");
      if (data.lessons.length === before) return { ok: true, skipSave: true };
      return { ok: true };
    }),
  ]);
  assert.equal(booked.ok, true);
  assert.equal(cancelled.ok, true);
  const final = await loadLessons();
  const ids = final.lessons.map((l) => l.id).sort();
  assert.deepEqual(ids, ["keep-me", "new-book"]);
});

test("concurrent rescheduling of two different lessons both persist", async () => {
  await seedLessons([
    { ...stdLesson("move-a", "Hitting"), time: "4:00 PM" },
    { ...stdLesson("move-b", "Fielding"), time: "4:00 PM" },
  ]);
  const barrier = makeBarrier(2);

  const [a, b] = await Promise.all([
    mutateLessons(async (data) => {
      await barrier();
      const row = data.lessons.find((l) => l.id === "move-a");
      if (!row) return { ok: false, error: "missing" };
      row.time = "6:00 PM";
      row.movedAt = Date.now();
      return { ok: true };
    }),
    mutateLessons(async (data) => {
      await barrier();
      const row = data.lessons.find((l) => l.id === "move-b");
      if (!row) return { ok: false, error: "missing" };
      row.time = "7:00 PM";
      row.movedAt = Date.now();
      return { ok: true };
    }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  // At least one writer must have retried after a CAS conflict.
  assert.ok(a.attempts + b.attempts >= 3);
  const final = await loadLessons();
  assert.equal(final.lessons.find((l) => l.id === "move-a").time, "6:00 PM");
  assert.equal(final.lessons.find((l) => l.id === "move-b").time, "7:00 PM");
});

test("two writers updating different lessons both keep their changes", async () => {
  await seedLessons([stdLesson("alpha", "Hitting"), stdLesson("beta", "Fielding")]);
  const barrier = makeBarrier(2);
  const [a, b] = await Promise.all([
    mutateLessons(async (data) => {
      await barrier();
      data.lessons.find((l) => l.id === "alpha").note = "alpha-ok";
      return { ok: true };
    }),
    mutateLessons(async (data) => {
      await barrier();
      data.lessons.find((l) => l.id === "beta").note = "beta-ok";
      return { ok: true };
    }),
  ]);
  assert.equal(a.ok && b.ok, true);
  const final = await loadLessons();
  assert.equal(final.lessons.find((l) => l.id === "alpha").note, "alpha-ok");
  assert.equal(final.lessons.find((l) => l.id === "beta").note, "beta-ok");
});

test("Stripe confirmation running twice is idempotent", async () => {
  const meta = {
    player: "Sam",
    email: "sam@example.com",
    type: "single",
    focus: "Hitting",
    privacy: "standard",
    seats: "1",
    date1: DATE,
    time1: TIME,
    loc1: "mustang",
  };
  const mirror = () =>
    mutateLessons((stored) => {
      const changed = upsertStripeLessons(stored, "pi_once", meta);
      if (!changed) return { ok: true, skipSave: true };
      return { ok: true };
    });
  const first = await mirror();
  const second = await mirror();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const final = await loadLessons();
  assert.equal(final.lessons.filter((l) => l.id === "pi_once-1").length, 1);
});

test("payment success with failed Blob mirroring leaves Stripe as source of truth", async () => {
  // Simulate confirm's behavior: mirror failure must not invent success on Blob,
  // but the caller still treats Stripe payment as authoritative.
  const mirrored = await mutateVersioned({
    load: loadLessons,
    commit: async () => ({ ok: false, conflict: false }),
    mutator: async (stored) => {
      upsertStripeLessons(stored, "pi_paid", {
        player: "Paid",
        email: "paid@example.com",
        type: "single",
        focus: "Hitting",
        privacy: "standard",
        date1: DATE,
        time1: TIME,
      });
      return { ok: true };
    },
    attempts: 2,
  });
  assert.equal(mirrored.ok, false);
  const final = await loadLessons();
  assert.equal(final.lessons.length, 0);
  // Stripe metadata (not in Blob) remains the reservation — asserted by absence of wipe
  // and by confirm.js continuing email/flag flow after mirror failure.
});

test("existing historical exclusive Both booking remains protected", async () => {
  await seedLessons([
    {
      id: "legacy-both",
      date: DATE,
      time: TIME,
      focus: "Both",
      // no privacy — legacy exclusive Both from #60 era
      seats: 1,
      type: "single",
      email: "legacy@example.com",
    },
  ]);
  const barrier = makeBarrier(2);

  const [intruder, otherHour] = await Promise.all([
    mutateLessons(async (data) => {
      await barrier();
      const want = { seats: 1, privacy: "standard" };
      if (slotBlocked(bookedFromLessons(data.lessons), TIME, 60, "Hitting", want)) {
        return { ok: false, code: "slot_taken" };
      }
      data.lessons.push(stdLesson("intruder", "Hitting"));
      return { ok: true };
    }),
    mutateLessons(async (data) => {
      await barrier();
      data.lessons.push({ ...stdLesson("other-hour", "Hitting"), time: "7:00 PM" });
      return { ok: true };
    }),
  ]);

  assert.equal(intruder.ok, false);
  assert.equal(intruder.code, "slot_taken");
  assert.equal(otherHour.ok, true);
  const final = await loadLessons();
  const legacy = final.lessons.find((l) => l.id === "legacy-both");
  assert.ok(legacy);
  assert.equal(legacy.focus, "Both");
  assert.equal(legacy.privacy || "", "");
  assert.equal(resolvePrivacy(legacy), "private");
});

test("manual-bookings CAS keeps concurrent cash reservations", async () => {
  const barrier = makeBarrier(2);
  const [a, b] = await Promise.all([
    mutateManualBookings(async (store) => {
      await barrier();
      store.bookings.push({
        id: "mb_a",
        date: DATE,
        time: TIME,
        focus: "Hitting",
        privacy: "standard",
        seats: 1,
        status: "scheduled",
      });
      return { ok: true };
    }),
    mutateManualBookings(async (store) => {
      await barrier();
      store.bookings.push({
        id: "mb_b",
        date: DATE,
        time: "6:00 PM",
        focus: "Fielding",
        privacy: "standard",
        seats: 1,
        status: "scheduled",
      });
      return { ok: true };
    }),
  ]);
  assert.equal(a.ok && b.ok, true);
  const final = await loadManualBookings();
  assert.deepEqual(final.bookings.map((b) => b.id).sort(), ["mb_a", "mb_b"]);
});

test("commitLessons refuses unsafe overwrite without an ETag", async () => {
  const data = {
    lessons: [{ id: "x", date: DATE, time: TIME }],
    voids: [],
  };
  Object.defineProperty(data, "_readFailed", { value: false, enumerable: false });
  Object.defineProperty(data, "_conditional", { value: false, enumerable: false });
  Object.defineProperty(data, "_etag", { value: "", enumerable: false });
  Object.defineProperty(data, "_allowUnconditionalCreate", { value: false, enumerable: false });
  const result = await commitLessons(data);
  assert.equal(result.ok, false);
  assert.equal(result.unsafe, true);
});
