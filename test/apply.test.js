import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApply, coachMail, parentMail } from "../lib/apply.js";
import handler from "../api/apply.js";

const good = {
  player: "Sam Rivera",
  age: "14 / freshman",
  parent: "Maria Rivera",
  phone: "(405) 555-0199",
  email: "maria@example.com",
  team: "Mustang 14U",
  focus: "Hitting",
  why: "Getting ready for high school tryouts.",
  days: ["Monday", "Wednesday", "Friday"],
  time: "5:30 PM",
  notes: "Can start the first week of September.",
};

test("parseApply accepts a complete application", () => {
  const r = parseApply(good);
  assert.equal(r.ok, true);
  assert.equal(r.spam, false);
  assert.equal(r.data.email, "maria@example.com");
  assert.deepEqual(r.data.days, ["Monday", "Wednesday", "Friday"]);
});

test("parseApply lowercases email and trims fields", () => {
  const r = parseApply({ ...good, email: "  Maria@Example.COM  ", player: "  Sam  " });
  assert.equal(r.ok, true);
  assert.equal(r.data.email, "maria@example.com");
  assert.equal(r.data.player, "Sam");
});

test("parseApply requires exactly 3 valid days", () => {
  assert.equal(parseApply({ ...good, days: ["Monday"] }).ok, false);
  assert.equal(parseApply({ ...good, days: ["Monday", "Tuesday", "Wednesday", "Friday"] }).ok, false);
  assert.equal(parseApply({ ...good, days: ["Monday", "Funday", "Wednesday"] }).ok, false);
  const fromString = parseApply({ ...good, days: "Monday, Wednesday, Friday" });
  assert.equal(fromString.ok, true);
  assert.deepEqual(fromString.data.days, ["Monday", "Wednesday", "Friday"]);
});

test("parseApply requires player, age, phone, email, time, and why", () => {
  for (const key of ["player", "age", "phone", "email", "time", "why"]) {
    const r = parseApply({ ...good, [key]: "" });
    assert.equal(r.ok, false, `expected ${key} to be required`);
  }
  assert.equal(parseApply({ ...good, email: "not-an-email" }).ok, false);
});

test("parseApply drops unknown focus values", () => {
  const r = parseApply({ ...good, focus: "Pitching" });
  assert.equal(r.ok, true);
  assert.equal(r.data.focus, "");
});

test("honeypot is accepted as spam and never looks like a validation error", () => {
  const r = parseApply({ ...good, company: "Buy now" });
  assert.equal(r.ok, true);
  assert.equal(r.spam, true);
  assert.equal(r.data, undefined);
});

test("coachMail names the player and says it is not paid", () => {
  const mail = coachMail(parseApply(good).data);
  assert.match(mail.subject, /Sam Rivera/);
  assert.match(mail.text, /Not paid yet/i);
  assert.match(mail.text, /14U–college/);
  assert.match(mail.text, /Monday, Wednesday, Friday/);
  assert.match(mail.html, /tel:\+14055550199/);
});

test("parentMail tells them nothing is charged", () => {
  const mail = parentMail(parseApply(good).data);
  assert.match(mail.text, /Nothing is charged/);
  assert.match(mail.html, /Nothing is charged today/);
});

function resSpy() {
  const out = { statusCode: 200, body: null };
  return {
    out,
    status(code) {
      out.statusCode = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    },
  };
}

test("apply API rejects incomplete payloads", async () => {
  const res = resSpy();
  await handler({ method: "POST", body: { player: "Sam" } }, res);
  assert.equal(res.out.statusCode, 400);
});

test("apply API swallows honeypot without sending mail", async () => {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return { ok: true, json: async () => ({}) };
  };
  try {
    const res = resSpy();
    await handler({ method: "POST", body: { ...good, company: "bot" } }, res);
    assert.equal(res.out.statusCode, 200);
    assert.equal(res.out.body.sent, true);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = prev;
  }
});

test("apply API emails the coach, then the parent, and never charges", async () => {
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, "RESEND_API_KEY");
  const prevKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test";
  const payloads = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    payloads.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({}) };
  };
  try {
    const res = resSpy();
    await handler({ method: "POST", body: good }, res);
    assert.equal(res.out.statusCode, 200);
    assert.equal(res.out.body.sent, true);
    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads[0].to, ["Apacademybsb@gmail.com"]);
    assert.equal(payloads[0].reply_to, "maria@example.com");
    assert.match(payloads[0].text, /Not paid yet/i);
    assert.deepEqual(payloads[1].to, ["maria@example.com"]);
    assert.match(payloads[1].text, /Nothing is charged/);
  } finally {
    globalThis.fetch = prev;
    if (hadKey) process.env.RESEND_API_KEY = prevKey;
    else delete process.env.RESEND_API_KEY;
  }
});

