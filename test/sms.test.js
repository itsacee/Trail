import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  bookAgainSms,
  membershipPitchSms,
  sendSms,
  smsConfigured,
  toE164,
} from "../lib/sms.js";

test("toE164 accepts US numbers in common shapes", () => {
  assert.equal(toE164("(405) 555-0199"), "+14055550199");
  assert.equal(toE164("405-555-0199"), "+14055550199");
  assert.equal(toE164("14055550199"), "+14055550199");
  assert.equal(toE164("+1 405 555 0199"), "+14055550199");
});

test("toE164 rejects junk and short numbers", () => {
  assert.equal(toE164(""), null);
  assert.equal(toE164("555-0199"), null);
  assert.equal(toE164("call me"), null);
});

test("smsConfigured needs all three Twilio settings", () => {
  assert.equal(smsConfigured({}), false);
  assert.equal(smsConfigured({ TWILIO_ACCOUNT_SID: "ACxxx" }), false);
  assert.equal(
    smsConfigured({
      TWILIO_ACCOUNT_SID: "ACxxx",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_FROM: "+14055550100",
    }),
    true
  );
});

test("membershipPitchSms sells the month without the field address", () => {
  const body = membershipPitchSms(
    { player: "Sam", parent: "Maria", date: "2026-08-26" },
    "https://www.apacademybsb.com"
  );
  assert.match(body, /\$280/);
  assert.match(body, /\$240/);
  assert.match(body, /nothing auto-renews/i);
  assert.match(body, /book\.html\?type=membership/);
  assert.doesNotMatch(body, /Juniper|73064|231 W/i);
});

test("bookAgainSms names remaining lessons and links the member page", () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-27T10:00:00-05:00") });
  try {
    const body = bookAgainSms(
      {
        player: "Sam",
        parent: "Maria",
        email: "parent@example.com",
        remaining: 3,
        lastDayPretty: "Wednesday, September 16",
      },
      "https://www.apacademybsb.com"
    );
    assert.match(body, /3 lessons left/);
    assert.match(body, /account\.html\?k=/);
    assert.match(body, /September 16/);
    assert.doesNotMatch(body, /Juniper|73064|231 W/i);
  } finally {
    mock.timers.reset();
  }
});

test("sendSms posts to Twilio and skips a bad destination", async () => {
  const calls = [];
  mock.method(globalThis, "fetch", async (url, opts) => {
    calls.push({ url: String(url), body: String(opts.body) });
    return { ok: true, json: async () => ({ sid: "SM1" }) };
  });
  try {
    const bad = await sendSms({
      sid: "ACxxx",
      token: "tok",
      from: "+14055550100",
      to: "nope",
      body: "hi",
    });
    assert.equal(bad.ok, false);
    assert.equal(calls.length, 0);

    const ok = await sendSms({
      sid: "ACxxx",
      token: "tok",
      from: "+14055550100",
      to: "(405) 555-0199",
      body: "hi",
    });
    assert.equal(ok.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /Accounts\/ACxxx\/Messages\.json/);
    assert.match(calls[0].body, /To=%2B14055550199/);
  } finally {
    mock.restoreAll();
  }
});
