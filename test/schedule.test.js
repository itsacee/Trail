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

test("slotBlocked lets a second player join the same start time", () => {
  assert.equal(SLOT_CAPACITY, 2);
  const one = [{ time: "5:00 PM", mins: 60, count: 1 }];
  assert.equal(slotBlocked(one, "5:00 PM", 60), false);
  assert.equal(slotBlocked(one, "5:30 PM", 60), true);
  assert.equal(slotBlocked([{ time: "5:00 PM", mins: 60, count: 2 }], "5:00 PM", 60), true);
  assert.equal(slotBlocked(one, "5:00 PM", 30), true);
  assert.equal(slotBlocked([{ time: "5:00 PM", mins: 30, count: 1 }], "5:30 PM", 30), false);
  assert.equal(slotBlocked([], "5:00 PM", 60), false);
});
