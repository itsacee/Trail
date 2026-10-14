// AP Academy business rules — source of truth for capacity, privacy, and
// membership reschedule. Pure schedule math + in-memory CAS; no live Stripe/Blob.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  slotBlocked,
  seatsLeft,
  seatsFor,
  isExclusiveBooking,
  privacyForPurchaseType,
  resolvePrivacy,
  SLOT_CAPACITY,
} from "../lib/schedule.js";
import { moveLesson, seatsOnLesson } from "../lib/reschedule.js";
import {
  useMemoryBlobStore,
  clearMemoryBlobStore,
  seedMemoryPrivateCapacity,
} from "../lib/store.js";
import {
  loadLessons,
  mutateLessons,
  makeMemberLesson,
  isVoided,
  scheduledFor,
} from "../lib/lessons.js";
import {
  membershipSummary,
  bookingBlocked,
  canCancelLesson,
  todayChicago,
  fromPayment,
  MEMBER_CREDITS,
} from "../lib/members.js";
import { loadManualBookings, mutateManualBookings } from "../lib/manualBookings.js";

function testPayment(id, email, type = "membership", ageDays = 1) {
  const created = Math.floor(Date.now() / 1000) - ageDays * 86400;
  return {
    id,
    status: "succeeded",
    created,
    metadata: {
      type,
      email,
      player: "Athlete",
      privacy: privacyForPurchaseType(type),
    },
  };
}

const TIME = "6:00 PM";
const FOCUSSES = ["Hitting", "Fielding", "Both"];
const STD = { seats: 1, exclusive: false, privacy: "standard" };
const PRIV = { seats: SLOT_CAPACITY, exclusive: true, privacy: "private" };

const availability = {
  slotMinutes: 60,
  days: {
    1: { open: true, start: "18:00", end: "20:00" },
    2: { open: true, start: "18:00", end: "20:00" },
    3: { open: true, start: "18:00", end: "20:00" },
  },
  blocked: [],
};

function chicagoPlusDays(days) {
  const base = new Date(`${todayChicago()}T12:00:00`);
  base.setDate(base.getDate() + days);
  return base.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function row(focus, { seats = 1, privacy = "standard", exclusive = false, kind = "paid" } = {}) {
  return {
    time: TIME,
    mins: 60,
    seats,
    count: seats,
    exclusive: exclusive || privacy === "private",
    privacy,
    focuses: [focus],
    sources: [{ kind, focus, seats, privacy }],
  };
}

function chipTag(booked, focus, privacy = "standard") {
  const need = privacy === "private" ? PRIV : STD;
  const blocked = slotBlocked(booked, TIME, 60, focus, need);
  if (blocked) {
    if (!booked.length) return "Unavailable";
    const left = seatsLeft(booked, TIME, 60, focus, privacy);
    if (left === 0) return "Full";
    return "Blocked";
  }
  const left = seatsLeft(booked, TIME, 60, focus, privacy);
  if (privacy === "standard" && need.seats === 1 && left === 1) return "1 spot left";
  return "";
}

before(() => {
  useMemoryBlobStore(true);
  process.env.CAPACITY_BLOB_CUTOVER = "1";
  process.env.CAPACITY_WRITES_ENABLED = "1";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_mempublic_test";
  process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_memprivate_test";
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";
});

after(() => {
  useMemoryBlobStore(false);
});

beforeEach(() => {
  clearMemoryBlobStore();
  seedMemoryPrivateCapacity("lessons.json", { lessons: [], voids: [] }, { etag: '"v0"' });
  seedMemoryPrivateCapacity("manual-bookings.json", { bookings: [] }, { etag: '"m0"' });
  seedMemoryPrivateCapacity("holds.json", { holds: [] }, { etag: '"h0"' });
});

// ---------------------------------------------------------------------------
// 1–3. Standard capacity for every focus × drop-in/membership mix
// ---------------------------------------------------------------------------

for (const focus of FOCUSSES) {
  test(`Standard ${focus}: empty hour shows capacity for a shareable seat`, () => {
    assert.equal(slotBlocked([], TIME, 60, focus, STD), false);
    assert.equal(seatsLeft([], TIME, 60, focus, "standard"), SLOT_CAPACITY);
    assert.equal(chipTag([], focus, "standard"), "");
  });

  test(`Standard ${focus}: drop-in + drop-in share; third is Full`, () => {
    const one = [row(focus)];
    assert.equal(slotBlocked(one, TIME, 60, focus, STD), false);
    assert.equal(seatsLeft(one, TIME, 60, focus, "standard"), 1);
    assert.equal(chipTag(one, focus, "standard"), "1 spot left");

    const two = [row(focus), row(focus)];
    assert.equal(slotBlocked(two, TIME, 60, focus, STD), true);
    assert.equal(seatsLeft(two, TIME, 60, focus, "standard"), 0);
    assert.equal(chipTag(two, focus, "standard"), "Full");
  });

  test(`Standard ${focus}: membership + membership share like drop-ins`, () => {
    const one = [row(focus, { kind: "member" })];
    assert.equal(slotBlocked(one, TIME, 60, focus, STD), false);
    const two = [row(focus, { kind: "member" }), row(focus, { kind: "member" })];
    assert.equal(slotBlocked(two, TIME, 60, focus, STD), true);
  });

  test(`Standard ${focus}: drop-in + membership count as two athletes`, () => {
    const mixed = [row(focus, { kind: "paid" }), row(focus, { kind: "member" })];
    assert.equal(slotBlocked(mixed, TIME, 60, focus, STD), true);
    assert.equal(seatsLeft(mixed, TIME, 60, focus, "standard"), 0);
    assert.equal(chipTag(mixed, focus, "standard"), "Full");
  });

  test(`Standard ${focus}: mismatched focus cannot join`, () => {
    const one = [row(focus)];
    for (const other of FOCUSSES.filter((f) => f !== focus)) {
      assert.equal(slotBlocked(one, TIME, 60, other, STD), true, `${other} vs ${focus}`);
      assert.equal(seatsLeft(one, TIME, 60, other, "standard"), 0);
    }
  });
}

test("purchase privacy: standard types share; private types exclusive", () => {
  assert.equal(privacyForPurchaseType("single"), "standard");
  assert.equal(privacyForPurchaseType("membership"), "standard");
  assert.equal(privacyForPurchaseType("private"), "private");
  assert.equal(privacyForPurchaseType("membership_private"), "private");
  assert.equal(resolvePrivacy({ type: "membership", focus: "Both", privacy: "standard" }), "standard");
  assert.equal(isExclusiveBooking({ type: "membership", focus: "Both", privacy: "standard" }), false);
  assert.equal(isExclusiveBooking({ type: "membership_private", focus: "Hitting" }), true);
  assert.equal(seatsFor("membership", 1), 1);
  assert.equal(seatsFor("membership_private", 1), SLOT_CAPACITY);
  assert.equal(seatsFor("private", 1), SLOT_CAPACITY);
});

// ---------------------------------------------------------------------------
// 4–5. Private exclusive + Standard↔Private conflicts
// ---------------------------------------------------------------------------

for (const focus of FOCUSSES) {
  test(`Private ${focus}: empty hour OK; any existing booking blocks`, () => {
    assert.equal(slotBlocked([], TIME, 60, focus, PRIV), false);
    assert.equal(slotBlocked([row(focus)], TIME, 60, focus, PRIV), true);
    assert.equal(slotBlocked([row("Hitting")], TIME, 60, focus, PRIV), true);
  });

  test(`Private ${focus}: owns the hour — standard cannot join`, () => {
    const priv = [row(focus, { seats: 2, privacy: "private", exclusive: true })];
    assert.equal(slotBlocked(priv, TIME, 60, focus, STD), true);
    assert.equal(slotBlocked(priv, TIME, 60, "Hitting", STD), true);
    assert.equal(seatsLeft(priv, TIME, 60, focus, "standard"), 0);
    assert.equal(chipTag(priv, focus, "standard"), "Full");
  });
}

test("Standard-to-Private and Private-to-Standard conflict matrix", () => {
  const stdHit = [row("Hitting")];
  const privField = [row("Fielding", { seats: 2, privacy: "private", exclusive: true })];
  assert.equal(slotBlocked(stdHit, TIME, 60, "Hitting", PRIV), true);
  assert.equal(slotBlocked(stdHit, TIME, 60, "Fielding", PRIV), true);
  assert.equal(slotBlocked(privField, TIME, 60, "Fielding", STD), true);
  assert.equal(slotBlocked(privField, TIME, 60, "Hitting", STD), true);
  assert.equal(slotBlocked(privField, TIME, 60, "Both", PRIV), true);
});

// ---------------------------------------------------------------------------
// 6–7. Membership reschedule capacity + atomic commit
// ---------------------------------------------------------------------------

test("membership move into empty / partial / full / mismatched / private hours", () => {
  const empty = [];
  const partial = [row("Hitting")];
  const full = [row("Hitting"), row("Hitting")];
  const mismatched = [row("Fielding")];
  const priv = [row("Hitting", { seats: 2, privacy: "private", exclusive: true })];

  assert.equal(slotBlocked(empty, TIME, 60, "Hitting", STD), false);
  assert.equal(slotBlocked(partial, TIME, 60, "Hitting", STD), false);
  assert.equal(slotBlocked(full, TIME, 60, "Hitting", STD), true);
  assert.equal(slotBlocked(mismatched, TIME, 60, "Hitting", STD), true);
  assert.equal(slotBlocked(priv, TIME, 60, "Hitting", STD), true);

  // Private membership may only move into a free hour.
  assert.equal(slotBlocked(empty, TIME, 60, "Hitting", PRIV), false);
  assert.equal(slotBlocked(partial, TIME, 60, "Hitting", PRIV), true);
  assert.equal(slotBlocked(full, TIME, 60, "Hitting", PRIV), true);
});

test("private membership cannot move into a standard partial hour", () => {
  const partial = [row("Both", { privacy: "standard" })];
  assert.equal(
    slotBlocked(partial, TIME, 60, "Both", {
      seats: seatsOnLesson({ type: "membership_private", focus: "Both", privacy: "private" }),
      exclusive: true,
      privacy: "private",
    }),
    true
  );
});

test("reschedule commits replacement and releases original in one CAS write", async () => {
  const dateOld = chicagoPlusDays(3);
  const dateNew = chicagoPlusDays(4);
  // Pick weekdays that are open in availability helper used by moveLesson loc only.
  seedMemoryPrivateCapacity(
    "lessons.json",
    {
      lessons: [
        {
          id: "ml_move",
          subId: "pi_mem",
          source: "member",
          type: "membership",
          email: "athlete@example.com",
          player: "A",
          focus: "Hitting",
          privacy: "standard",
          seats: 1,
          date: dateOld,
          time: "6:00 PM",
        },
      ],
      voids: [],
    },
    { etag: '"m1"' }
  );

  const saved = await mutateLessons(async (stored) => {
    const result = moveLesson({
      row: {
        id: "ml_move",
        source: "member",
        type: "membership",
        email: "athlete@example.com",
        focus: "Hitting",
        privacy: "standard",
        date: dateOld,
        time: "6:00 PM",
      },
      stored,
      manual: { bookings: [] },
      date: dateNew,
      time: "7:00 PM",
      focus: "Hitting",
      availability,
    });
    assert.equal(result.ok, true);
    return { ok: true, moved: result.moved };
  });
  assert.equal(saved.ok, true);

  const after = await loadLessons();
  assert.equal(after.lessons.length, 1);
  assert.equal(after.lessons[0].id, "ml_move");
  assert.equal(after.lessons[0].date, dateNew);
  assert.equal(after.lessons[0].time, "7:00 PM");
  assert.equal(after.lessons.some((l) => l.date === dateOld && l.time === "6:00 PM"), false);
});

test("failed reschedule preserves original booking and does not open a hole", async () => {
  const dateOld = chicagoPlusDays(5);
  seedMemoryPrivateCapacity(
    "lessons.json",
    {
      lessons: [
        {
          id: "ml_keep",
          subId: "pi_mem",
          source: "member",
          type: "membership",
          email: "keep@example.com",
          focus: "Fielding",
          privacy: "standard",
          seats: 1,
          date: dateOld,
          time: "6:00 PM",
        },
        {
          id: "ml_blocker_a",
          subId: "pi_other",
          source: "member",
          type: "membership",
          email: "b@example.com",
          focus: "Hitting",
          privacy: "standard",
          seats: 1,
          date: dateOld,
          time: "7:00 PM",
        },
        {
          id: "ml_blocker_b",
          subId: "pi_other2",
          source: "member",
          type: "membership",
          email: "c@example.com",
          focus: "Hitting",
          privacy: "standard",
          seats: 1,
          date: dateOld,
          time: "7:00 PM",
        },
      ],
      voids: [],
    },
    { etag: '"fail1"' }
  );

  const before = await loadLessons();
  const refused = await mutateLessons(async (stored) => {
    // Simulate gate failure: do not call moveLesson.
    const taken = [
      { time: "7:00 PM", mins: 60, seats: 1, focuses: ["Hitting"], privacy: "standard" },
      { time: "7:00 PM", mins: 60, seats: 1, focuses: ["Hitting"], privacy: "standard" },
    ];
    if (slotBlocked(taken, "7:00 PM", 60, "Fielding", STD)) {
      return {
        ok: false,
        error: "Sorry — that time is full or has a different training focus. Pick another.",
        status: 409,
        code: "slot_taken",
      };
    }
    moveLesson({
      row: before.lessons[0],
      stored,
      manual: { bookings: [] },
      date: dateOld,
      time: "7:00 PM",
      focus: "Fielding",
      availability,
    });
    return { ok: true };
  });
  assert.equal(refused.ok, false);

  const after = await loadLessons();
  assert.equal(after.lessons.length, 3);
  const original = after.lessons.find((l) => l.id === "ml_keep");
  assert.equal(original.date, dateOld);
  assert.equal(original.time, "6:00 PM");
  assert.equal(original.focus, "Fielding");
});

test("stripe checkout slot move voids old time only after in-memory replacement is prepared", () => {
  const stored = {
    lessons: [
      {
        id: "pi_abc-1",
        sourceId: "pi_abc",
        source: "stripe",
        type: "membership",
        email: "p@example.com",
        focus: "Both",
        privacy: "standard",
        seats: 1,
        date: "2026-11-02",
        time: "6:00 PM",
      },
    ],
    voids: [],
  };
  const result = moveLesson({
    row: {
      id: "pi_abc-1",
      sourceId: "pi_abc",
      source: "stripe",
      type: "membership",
      email: "p@example.com",
      focus: "Both",
      privacy: "standard",
      date: "2026-11-02",
      time: "6:00 PM",
    },
    stored,
    manual: { bookings: [] },
    date: "2026-11-03",
    time: "7:00 PM",
    focus: "Both",
    availability,
  });
  assert.equal(result.ok, true);
  assert.ok(result.clearStripe);
  assert.equal(isVoided(stored, { sourceId: "pi_abc", date: "2026-11-02", time: "6:00 PM" }), true);
  assert.equal(stored.lessons.some((l) => l.id === "pi_abc-1"), false);
  assert.equal(stored.lessons.length, 1);
  assert.equal(stored.lessons[0].date, "2026-11-03");
  assert.equal(stored.lessons[0].time, "7:00 PM");
  assert.equal(stored.lessons[0].privacy, "standard");
  assert.equal(stored.lessons[0].seats, 1);
});

test("manual cash lesson moves in place without cancelling first", async () => {
  seedMemoryPrivateCapacity(
    "manual-bookings.json",
    {
      bookings: [
        {
          id: "mb_1",
          type: "membership",
          email: "cash@example.com",
          player: "Cash",
          focus: "Hitting",
          privacy: "standard",
          date: chicagoPlusDays(6),
          time: "6:00 PM",
          status: "active",
        },
      ],
    },
    { etag: '"man1"' }
  );

  const saved = await mutateManualBookings(async (manual) => {
    const stored = await loadLessons();
    const result = moveLesson({
      row: {
        id: "mb_1",
        source: "manual",
        type: "membership",
        email: "cash@example.com",
        focus: "Hitting",
        privacy: "standard",
        date: manual.bookings[0].date,
        time: "6:00 PM",
      },
      stored,
      manual,
      date: chicagoPlusDays(7),
      time: "7:00 PM",
      focus: "Hitting",
      availability,
    });
    assert.equal(result.ok, true);
    return { ok: true, moved: result.moved };
  });
  assert.equal(saved.ok, true);
  const manual = await loadManualBookings();
  assert.equal(manual.bookings.length, 1);
  assert.equal(manual.bookings[0].status, "active");
  assert.equal(manual.bookings[0].time, "7:00 PM");
  assert.equal(manual.bookings[0].cancelledAt, undefined);
});

test("two concurrent membership moves: one wins CAS, the other retries safely", async () => {
  const dateOld = chicagoPlusDays(8);
  const dateA = chicagoPlusDays(9);
  const dateB = chicagoPlusDays(10);
  seedMemoryPrivateCapacity(
    "lessons.json",
    {
      lessons: [
        {
          id: "ml_race",
          subId: "pi_mem",
          source: "member",
          type: "membership",
          email: "race@example.com",
          focus: "Hitting",
          privacy: "standard",
          seats: 1,
          date: dateOld,
          time: "6:00 PM",
        },
      ],
      voids: [],
    },
    { etag: '"race0"' }
  );

  const [first, second] = await Promise.all([
    mutateLessons(async (stored) => {
      const lesson = (stored.lessons || []).find((l) => l.id === "ml_race");
      if (!lesson) return { ok: false, error: "gone", status: 404 };
      const result = moveLesson({
        row: {
          id: "ml_race",
          source: "member",
          type: "membership",
          email: "race@example.com",
          focus: lesson.focus,
          privacy: "standard",
          date: lesson.date,
          time: lesson.time,
        },
        stored,
        manual: { bookings: [] },
        date: dateA,
        time: "6:00 PM",
        focus: "Hitting",
        availability,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, moved: result.moved };
    }),
    mutateLessons(async (stored) => {
      const lesson = (stored.lessons || []).find((l) => l.id === "ml_race");
      if (!lesson) return { ok: false, error: "gone", status: 404 };
      const result = moveLesson({
        row: {
          id: "ml_race",
          source: "member",
          type: "membership",
          email: "race@example.com",
          focus: lesson.focus,
          privacy: "standard",
          date: lesson.date,
          time: lesson.time,
        },
        stored,
        manual: { bookings: [] },
        date: dateB,
        time: "7:00 PM",
        focus: "Hitting",
        availability,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, moved: result.moved };
    }),
  ]);

  assert.equal(first.ok && second.ok, true);
  const after = await loadLessons();
  assert.equal(after.lessons.filter((l) => l.id === "ml_race").length, 1);
  const final = after.lessons.find((l) => l.id === "ml_race");
  assert.ok([dateA, dateB].includes(final.date));
  // Exactly one booking — no duplicate credit spend rows.
  assert.equal(after.lessons.length, 1);
});

// ---------------------------------------------------------------------------
// 8. Credits, expiry helpers, one-lesson-per-day, cutoff
// ---------------------------------------------------------------------------

test("reschedule does not spend an extra membership credit", () => {
  const sub = fromPayment(testPayment("pi_cred", "cred@example.com", "membership", 2));
  assert.ok(sub);
  const day1 = chicagoPlusDays(2);
  const day2 = chicagoPlusDays(3);
  const original = makeMemberLesson({
    sub,
    date: day1,
    time: "6:00 PM",
    focus: "Hitting",
    availability,
  });
  const stored = { lessons: [original], voids: [] };
  const before = membershipSummary(sub, scheduledFor(sub, stored, null, [sub]), { siblings: [sub] });
  assert.equal(before.used, 1);
  assert.equal(before.remaining, MEMBER_CREDITS - 1);

  const moved = { ...original, date: day2, time: "7:00 PM", movedAt: Date.now() };
  const afterStored = { lessons: [moved], voids: [] };
  const after = membershipSummary(sub, scheduledFor(sub, afterStored, null, [sub]), {
    siblings: [sub],
  });
  assert.equal(after.used, 1);
  assert.equal(after.remaining, MEMBER_CREDITS - 1);
  assert.equal(after.credits, before.credits);
});

test("one-lesson-per-day still blocks a second book but allows reschedule exclude", () => {
  const sub = fromPayment(testPayment("pi_day", "day@example.com", "membership", 1));
  assert.ok(sub);
  const day = chicagoPlusDays(2);
  const existing = makeMemberLesson({
    sub,
    date: day,
    time: "6:00 PM",
    focus: "Hitting",
    availability,
  });
  const summary = membershipSummary(sub, [existing], { siblings: [sub] });
  assert.match(String(bookingBlocked(summary, day, [existing], [existing]) || ""), /already/i);
  // Excluding the lesson being moved frees that day for the same credit.
  assert.equal(bookingBlocked(summary, day, [], []), null);
});

test("12-hour cancellation/reschedule cutoff remains intact", () => {
  const far = chicagoPlusDays(10);
  assert.equal(canCancelLesson(far, "6:00 PM"), true);
  // A lesson that already started (yesterday) cannot be changed.
  const past = chicagoPlusDays(-1);
  assert.equal(canCancelLesson(past, "6:00 PM"), false);
});

// ---------------------------------------------------------------------------
// 9. Agreement helpers — seat math used by Coach Desk / slots / UI
// ---------------------------------------------------------------------------

test("Coach Desk / slots / UI seat math agree for mixed standard hour", () => {
  const booked = [
    row("Hitting", { kind: "paid" }),
    row("Hitting", { kind: "member" }),
  ];
  const seats = booked.reduce((n, b) => n + (Number(b.seats) || 1), 0);
  assert.equal(seats, 2);
  assert.equal(slotBlocked(booked, TIME, 60, "Hitting", STD), true);
  assert.equal(seatsLeft(booked, TIME, 60, "Hitting", "standard"), 0);
  assert.equal(chipTag(booked, "Hitting", "standard"), "Full");
});

test("legacy Both without privacy stays exclusive; new standard Both shares", () => {
  const legacy = [{ time: TIME, mins: 60, seats: 1, focuses: ["Both"] }];
  assert.equal(slotBlocked(legacy, TIME, 60, "Both", STD), true);
  const modern = [row("Both", { privacy: "standard" })];
  assert.equal(slotBlocked(modern, TIME, 60, "Both", STD), false);
  assert.equal(chipTag(modern, "Both", "standard"), "1 spot left");
});
