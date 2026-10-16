import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLessonTime, labelToMin } from "../lib/schedule.js";

test("normalizeLessonTime accepts common coach desk entries", () => {
  assert.equal(normalizeLessonTime("5:00 PM").label, "5:00 PM");
  assert.equal(normalizeLessonTime("5pm").label, "5:00 PM");
  assert.equal(normalizeLessonTime("5:00pm").label, "5:00 PM");
  assert.equal(normalizeLessonTime("5 PM").label, "5:00 PM");
  assert.equal(normalizeLessonTime("17:00").label, "5:00 PM");
  assert.equal(normalizeLessonTime("17:00:00").label, "5:00 PM");
  assert.equal(normalizeLessonTime("6:30 AM").label, "6:30 AM");
  assert.equal(normalizeLessonTime("12:00 PM").label, "12:00 PM");
  assert.equal(normalizeLessonTime("12:00 AM").label, "12:00 AM");
});

test("bare hour 5 is ambiguous without meridiem and never becomes 5:00 AM silently", () => {
  const bare = normalizeLessonTime("5");
  assert.equal(bare.ok, false);
  assert.equal(bare.error, "ambiguous");
  assert.equal(bare.hour, 5);

  const asPm = normalizeLessonTime("5", { meridiem: "PM" });
  assert.equal(asPm.ok, true);
  assert.equal(asPm.label, "5:00 PM");
  assert.equal(asPm.minutes, 17 * 60);

  const asAm = normalizeLessonTime("5", { meridiem: "AM" });
  assert.equal(asAm.label, "5:00 AM");
  assert.equal(asAm.minutes, 5 * 60);
});

test("bare 5:00 with PM meridiem normalizes", () => {
  const r = normalizeLessonTime("5:00", { meridiem: "PM" });
  assert.equal(r.ok, true);
  assert.equal(r.label, "5:00 PM");
});

test("24h bare hours 13–23 are unambiguous", () => {
  assert.equal(normalizeLessonTime("17").label, "5:00 PM");
  assert.equal(normalizeLessonTime("13").label, "1:00 PM");
});

test("invalid and missing times fail clearly", () => {
  assert.equal(normalizeLessonTime("").error, "missing");
  assert.equal(normalizeLessonTime("nonsense").error, "invalid");
  assert.equal(normalizeLessonTime("25:00").error, "invalid");
});

test("normalized labels remain TIME_RE compatible for booking storage", () => {
  const TIME_RE = /^\d{1,2}:\d{2} (AM|PM)$/;
  for (const raw of ["5", "5pm", "5:00", "17:00", "5:00 PM"]) {
    const r = normalizeLessonTime(raw, { meridiem: "PM" });
    assert.equal(r.ok, true, raw);
    assert.match(r.label, TIME_RE);
    assert.equal(typeof labelToMin(r.label), "number");
  }
});
