// Pure scheduling logic — no clock, no network. These functions decide which
// times a day offers and how session types map to durations.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  labelToMin,
  fmtTime,
  durationFor,
  normalizeAvailability,
  startTimesForDate,
  allowedTimes,
  isOpenOn,
  locationKeyFor,
  slotBlocked,
  seatsFor,
  seatsLeft,
  isExclusiveType,
  canPair,
  SLOT_CAPACITY,
  DEFAULT_AVAILABILITY,
  migrateSavedAvailability,
} from "../lib/schedule.js";

test("labelToMin parses 12-hour labels, including noon/midnight", () => {
  assert.equal(labelToMin("9:00 AM"), 9 * 60);
  assert.equal(labelToMin("5:30 PM"), 17 * 60 + 30);
  assert.equal(labelToMin("12:00 PM"), 12 * 60); // noon
  assert.equal(labelToMin("12:00 AM"), 0); // midnight
  assert.equal(labelToMin("nonsense"), null);
});

test("fmtTime round-trips with labelToMin", () => {
  for (const hhmm of ["09:00", "12:00", "17:30", "00:00"]) {
    assert.equal(labelToMin(fmtTime(hhmm)), labelToMin(fmtTime(hhmm)));
  }
  assert.equal(fmtTime("17:00"), "5:00 PM");
  assert.equal(fmtTime("12:00"), "12:00 PM");
});

test("durationFor knows each session type, defaults to 60", () => {
  assert.equal(durationFor("single"), 60);
  assert.equal(durationFor("thirty"), 30);
  assert.equal(durationFor("membership"), 60);
  assert.equal(durationFor("mystery"), 60);
});

test("Mon–Wed 6–8 PM offers two hour starts", () => {
  const av = normalizeAvailability(DEFAULT_AVAILABILITY);
  // Wednesday 2026-08-26, hours 18:00–20:00. Starts at 6:00 and 7:00.
  assert.deepEqual(startTimesForDate("2026-08-26", av, 60), ["18:00", "19:00"]);
  assert.deepEqual(allowedTimes("2026-08-26", av, 60), ["6:00 PM", "7:00 PM"]);
  assert.equal(isOpenOn("2026-08-27", av), false); // Thursday closed
});

test("a 30-minute lesson can use a later start when slots are 30 minutes", () => {
  const av = normalizeAvailability({
    slotMinutes: 30,
    days: { 3: { open: true, start: "17:00", end: "21:00" } },
  });
  const hour = startTimesForDate("2026-08-26", av, 60);
  const half = startTimesForDate("2026-08-26", av, 30);
  assert.equal(hour[hour.length - 1], "20:00");
  assert.equal(half[half.length - 1], "20:30");
});

test("migrateSavedAvailability swaps old 5–9 weeknights for Mon–Wed 6–8", () => {
  const old = normalizeAvailability({
    slotMinutes: 60,
    days: {
      0: { open: true, start: "09:00", end: "19:00" },
      1: { open: true, start: "17:00", end: "21:00" },
      2: { open: true, start: "17:00", end: "21:00" },
      3: { open: true, start: "17:00", end: "21:00" },
      4: { open: true, start: "17:00", end: "21:00" },
      5: { open: true, start: "17:00", end: "21:00" },
      6: { open: true, start: "09:00", end: "19:00" },
    },
    blocked: ["2026-09-07"],
  });
  const next = migrateSavedAvailability(old);
  assert.equal(next.days[1].start, "18:00");
  assert.equal(next.days[1].end, "20:00");
  assert.equal(next.days[1].open, true);
  assert.equal(next.days[4].open, false);
  assert.deepEqual(next.blocked, ["2026-09-07"]);
  const custom = migrateSavedAvailability(
    normalizeAvailability({ days: { 1: { open: true, start: "16:00", end: "20:00" } } })
  );
  assert.equal(custom.days[1].start, "16:00");
});

test("blocked dates and closed days offer nothing", () => {
  const closed = normalizeAvailability({
    ...DEFAULT_AVAILABILITY,
    days: { ...DEFAULT_AVAILABILITY.days, 3: { open: false, start: "17:00", end: "21:00" } },
  });
  assert.deepEqual(startTimesForDate("2026-08-26", closed, 60), []); // Wed closed
  assert.equal(isOpenOn("2026-08-26", closed), false);

  const blocked = normalizeAvailability({ ...DEFAULT_AVAILABILITY, blocked: ["2026-08-26"] });
  assert.deepEqual(allowedTimes("2026-08-26", blocked, 60), []);
});

test("locationKeyFor is set on open days and empty on closed ones", () => {
  const av = normalizeAvailability(DEFAULT_AVAILABILITY);
  assert.equal(locationKeyFor("2026-08-26", av), "mustang");
  const blocked = normalizeAvailability({ ...DEFAULT_AVAILABILITY, blocked: ["2026-08-26"] });
  assert.equal(locationKeyFor("2026-08-26", blocked), "");
});

test("normalizeAvailability fills gaps and drops malformed blocked dates", () => {
  const a = normalizeAvailability({ days: { 1: { open: true, start: "bad", end: "21:00" } }, blocked: ["nope", "2026-01-01"] });
  assert.equal(a.days[1].start, DEFAULT_AVAILABILITY.days[1].start); // bad start replaced
  assert.deepEqual(a.blocked, ["2026-01-01"]);
  assert.equal(a.slotMinutes, 60);
});

test("slotBlocked lets a second player join only with the same focus", () => {
  assert.equal(SLOT_CAPACITY, 2);
  const hitting = [{ time: "5:00 PM", mins: 60, count: 1, focuses: ["Hitting"] }];
  assert.equal(slotBlocked(hitting, "5:00 PM", 60, "Hitting"), false);
  assert.equal(slotBlocked(hitting, "5:00 PM", 60, "Fielding"), true);
  assert.equal(slotBlocked(hitting, "5:00 PM", 60, "Both"), true);
  assert.equal(slotBlocked(hitting, "5:30 PM", 60, "Hitting"), true);
  assert.equal(
    slotBlocked([{ time: "5:00 PM", mins: 60, count: 2, focuses: ["Hitting"] }], "5:00 PM", 60, "Hitting"),
    true
  );
  assert.equal(slotBlocked(hitting, "5:00 PM", 30, "Hitting"), true);
  assert.equal(
    slotBlocked([{ time: "5:00 PM", mins: 30, count: 1, focuses: ["Fielding"] }], "5:30 PM", 30, "Fielding"),
    false
  );
  assert.equal(slotBlocked([], "5:00 PM", 60, "Both"), false);
});

test("old bookings without a focus stay exclusive", () => {
  const legacy = [{ time: "5:00 PM", mins: 60, count: 1, focuses: [] }];
  assert.equal(slotBlocked(legacy, "5:00 PM", 60, "Hitting"), true);
});

test("seatsFor caps at the hour's capacity and a private lesson takes it all", () => {
  assert.equal(seatsFor("single", 1), 1);
  assert.equal(seatsFor("single", 2), 2);
  assert.equal(seatsFor("single", 9), SLOT_CAPACITY);
  assert.equal(seatsFor("single", 0), 1);
  assert.equal(seatsFor("thirty", 2), 2);
  // A private hour is exclusive by definition, whatever the athlete count says.
  assert.equal(seatsFor("private", 1), SLOT_CAPACITY);
  assert.equal(seatsFor("private", 2), SLOT_CAPACITY);
  assert.equal(isExclusiveType("private"), true);
  assert.equal(isExclusiveType("single"), false);
});

test("a private hour can carry a sibling, but a membership credit can't", () => {
  assert.equal(canPair("single"), true);
  assert.equal(canPair("thirty"), true);
  assert.equal(canPair("private"), true);
  assert.equal(canPair("membership"), false);
});

test("a second athlete fills the hour so nobody else can join", () => {
  const oneAthlete = [{ time: "6:00 PM", mins: 60, seats: 1, focuses: ["Fielding"] }];
  // One athlete leaves a seat open at the same focus...
  assert.equal(slotBlocked(oneAthlete, "6:00 PM", 60, "Fielding", 1), false);
  // ...but not room for a pair.
  assert.equal(slotBlocked(oneAthlete, "6:00 PM", 60, "Fielding", 2), true);

  const pair = [{ time: "6:00 PM", mins: 60, seats: 2, exclusive: true, focuses: ["Fielding"] }];
  assert.equal(slotBlocked(pair, "6:00 PM", 60, "Fielding", 1), true);
});

test("a private lesson refuses an hour that already has anyone in it", () => {
  const want = { seats: SLOT_CAPACITY, exclusive: true };
  const oneAthlete = [{ time: "6:00 PM", mins: 60, seats: 1, focuses: ["Fielding"] }];
  assert.equal(slotBlocked(oneAthlete, "6:00 PM", 60, "Fielding", want), true);
  assert.equal(slotBlocked([], "6:00 PM", 60, "Fielding", want), false);
});

test("nobody can book into an hour a private lesson owns", () => {
  const priv = [{ time: "6:00 PM", mins: 60, seats: 2, exclusive: true, focuses: ["Fielding"] }];
  assert.equal(slotBlocked(priv, "6:00 PM", 60, "Fielding", 1), true);
  assert.equal(slotBlocked(priv, "7:00 PM", 60, "Fielding", 1), false);
});

test("seatsLeft counts down from two and hits zero on an exclusive hour", () => {
  assert.equal(seatsLeft([], "6:00 PM", 60, "Fielding"), SLOT_CAPACITY);
  assert.equal(
    seatsLeft([{ time: "6:00 PM", mins: 60, seats: 1, focuses: ["Fielding"] }], "6:00 PM", 60, "Fielding"),
    1
  );
  assert.equal(
    seatsLeft([{ time: "6:00 PM", mins: 60, seats: 2, focuses: ["Fielding"] }], "6:00 PM", 60, "Fielding"),
    0
  );
  assert.equal(
    seatsLeft([{ time: "6:00 PM", mins: 60, seats: 2, exclusive: true, focuses: ["Fielding"] }], "6:00 PM", 60, "Fielding"),
    0
  );
  // A different focus can't share at all.
  assert.equal(
    seatsLeft([{ time: "6:00 PM", mins: 60, seats: 1, focuses: ["Hitting"] }], "6:00 PM", 60, "Fielding"),
    0
  );
});

test("slotBlocked still works for callers that don't pass a seat count", () => {
  const oneAthlete = [{ time: "6:00 PM", mins: 60, count: 1, focuses: ["Fielding"] }];
  assert.equal(slotBlocked(oneAthlete, "6:00 PM", 60, "Fielding"), false);
  assert.equal(slotBlocked(oneAthlete, "6:00 PM", 60, "Hitting"), true);
});
