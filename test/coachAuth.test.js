// Every coach-only endpoint checks the passcode through here, so this is the one
// place that decides who gets in.
import { test } from "node:test";
import assert from "node:assert/strict";

import { coachPass, isCoachPass, requireCoach, DEFAULT_COACH_PASS } from "../lib/coachAuth.js";

function fakeRes() {
  return {
    code: 0,
    body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test("the passcode falls back to the built-in one when COACH_PASS isn't set", () => {
  const before = process.env.COACH_PASS;
  delete process.env.COACH_PASS;
  try {
    assert.equal(coachPass(), DEFAULT_COACH_PASS);
    assert.equal(isCoachPass(DEFAULT_COACH_PASS), true);
    assert.equal(isCoachPass("nope"), false);
    assert.equal(isCoachPass(""), false);
    assert.equal(isCoachPass(undefined), false);
  } finally {
    if (before === undefined) delete process.env.COACH_PASS;
    else process.env.COACH_PASS = before;
  }
});

test("COACH_PASS overrides the built-in passcode", () => {
  const before = process.env.COACH_PASS;
  process.env.COACH_PASS = "  somethingelse  ";
  try {
    assert.equal(coachPass(), "somethingelse");
    assert.equal(isCoachPass("somethingelse"), true);
    assert.equal(isCoachPass(DEFAULT_COACH_PASS), false);
  } finally {
    if (before === undefined) delete process.env.COACH_PASS;
    else process.env.COACH_PASS = before;
  }
});

test("requireCoach accepts the passcode from the query or the body, and 401s otherwise", () => {
  const before = process.env.COACH_PASS;
  process.env.COACH_PASS = "letmein";
  try {
    assert.equal(requireCoach({ query: { key: "letmein" } }, fakeRes()), "letmein");
    assert.equal(requireCoach({ body: { key: "letmein" } }, fakeRes()), "letmein");

    const res = fakeRes();
    assert.equal(requireCoach({ query: { key: "wrong" } }, res), null);
    assert.equal(res.code, 401);
    assert.match(res.body.error, /passcode/i);

    const bare = fakeRes();
    assert.equal(requireCoach({}, bare), null);
    assert.equal(bare.code, 401);
  } finally {
    if (before === undefined) delete process.env.COACH_PASS;
    else process.env.COACH_PASS = before;
  }
});
