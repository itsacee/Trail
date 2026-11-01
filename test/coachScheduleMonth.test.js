// Coach Desk schedule month calendar — structural + date math checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const coachHtml = readFileSync(join(root, "coach.html"), "utf8");

/** Shift a month anchor by delta months (year-safe). */
function shiftMonth(anchor, delta) {
  return new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1);
}

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("coach schedule panel uses a full-month calendar, not a week strip", () => {
  assert.match(coachHtml, /id="scheduleCal"/);
  assert.match(coachHtml, /id="schedDays"/);
  assert.match(coachHtml, /id="schedPrev"/);
  assert.match(coachHtml, /id="schedNext"/);
  assert.match(coachHtml, /id="schedLabel"/);
  assert.doesNotMatch(coachHtml, /id="weekStrip"/);
  assert.match(coachHtml, /function renderScheduleMonth/);
  assert.match(coachHtml, /scheduleSelectedDay \|\| todayISO\(\)/);
  assert.match(coachHtml, /has-lessons/);
});

test("month navigation crosses year boundaries", () => {
  const dec = new Date(2026, 11, 1); // Dec 2026
  const jan = shiftMonth(dec, 1);
  assert.equal(jan.getFullYear(), 2027);
  assert.equal(jan.getMonth(), 0);
  assert.equal(isoOf(jan), "2027-01-01");

  const back = shiftMonth(jan, -1);
  assert.equal(back.getFullYear(), 2026);
  assert.equal(back.getMonth(), 11);
  assert.equal(isoOf(back), "2026-12-01");
});

test("cancel confirmation mentions membership credit return", () => {
  assert.match(coachHtml, /that credit is returned once to the member/i);
  assert.match(coachHtml, /async function cancelLesson/);
});
