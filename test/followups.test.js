// Follow-up pickers and email copy. Frozen clock:
// Thursday 2026-08-27 10:00 America/Chicago (the morning after a Wed lesson).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  KIND_PITCH,
  KIND_BOOK_AGAIN,
  alreadySent,
  bookAgainMail,
  isRecentlyComplete,
  markSent,
  membershipPitchMail,
  pickBookAgainNudges,
  pickMembershipPitches,
  recentlyPitched,
  sessionFromMeta,
} from "../lib/followups.js";

const TODAY = "2026-08-27";
const NOW = Date.parse("2026-08-27T10:00:00-05:00");

function atTime(iso, fn) {
  mock.timers.enable({ apis: ["Date"], now: new Date(iso) });
  try {
    return fn();
  } finally {
    mock.timers.reset();
  }
}

function singlePayment(id, extra = {}) {
  return {
    id,
    status: "succeeded",
    metadata: {
      type: "single",
      email: "parent@example.com",
      player: "Sam",
      parent: "Maria",
      phone: "(405) 555-0199",
      date1: "2026-08-26",
      time1: "5:00 PM",
      ...extra,
    },
  };
}

test("sessionFromMeta reads date1/time1 and falls back to date/time", () => {
  assert.deepEqual(sessionFromMeta({ date1: "2026-08-26", time1: "5:00 PM" }), {
    date: "2026-08-26",
    time: "5:00 PM",
  });
  assert.deepEqual(sessionFromMeta({ date: "2026-08-26", time: "6:00 PM" }), {
    date: "2026-08-26",
    time: "6:00 PM",
  });
  assert.equal(sessionFromMeta({}), null);
});

test("isRecentlyComplete is the morning after, not the same day", () => {
  assert.equal(
    isRecentlyComplete("2026-08-26", "5:00 PM", { today: TODAY, now: NOW }),
    true
  );
  assert.equal(
    isRecentlyComplete("2026-08-27", "5:00 PM", { today: TODAY, now: NOW }),
    false
  );
  assert.equal(
    isRecentlyComplete("2026-08-22", "5:00 PM", { today: TODAY, now: NOW }),
    false
  );
});

test("pickMembershipPitches sends after a completed single", () => {
  const picks = pickMembershipPitches({
    payments: [singlePayment("pi_1")],
    memberEmails: new Set(),
    followups: { sent: [] },
    today: TODAY,
    now: NOW,
  });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].kind, KIND_PITCH);
  assert.equal(picks[0].email, "parent@example.com");
  assert.equal(picks[0].id, "pi_1");
  assert.equal(picks[0].phone, "(405) 555-0199");
});

test("pickMembershipPitches skips 30-min drop-ins and memberships", () => {
  const thirty = singlePayment("pi_30", { type: "thirty" });
  const member = singlePayment("pi_m", { type: "membership" });
  const picks = pickMembershipPitches({
    payments: [thirty, member],
    memberEmails: new Set(),
    followups: { sent: [] },
    today: TODAY,
    now: NOW,
  });
  assert.equal(picks.length, 0);
});

test("pickMembershipPitches skips parents who already have a membership", () => {
  const picks = pickMembershipPitches({
    payments: [singlePayment("pi_1")],
    memberEmails: new Set(["parent@example.com"]),
    followups: { sent: [] },
    today: TODAY,
    now: NOW,
  });
  assert.equal(picks.length, 0);
});

test("pickMembershipPitches does not send twice for the same payment or inbox", () => {
  const followups = { sent: [] };
  markSent(followups, { kind: KIND_PITCH, id: "pi_1", email: "parent@example.com", at: NOW });
  assert.equal(alreadySent(followups, KIND_PITCH, "pi_1"), true);
  assert.equal(recentlyPitched(followups, "parent@example.com", NOW), true);

  const again = pickMembershipPitches({
    payments: [singlePayment("pi_1"), singlePayment("pi_2")],
    memberEmails: new Set(),
    followups,
    today: TODAY,
    now: NOW,
  });
  assert.equal(again.length, 0);
});

test("pickBookAgainNudges writes after a done lesson with credits left and nothing upcoming", () => {
  const picks = pickBookAgainNudges({
    members: [
      {
        email: "parent@example.com",
        player: "Sam",
        parent: "Maria",
        phone: "(405) 555-0199",
        remaining: 3,
        lastDayPretty: "Wednesday, September 16",
        expired: false,
        scheduled: [
          { id: "lsn_1", date: "2026-08-26", time: "5:00 PM" },
        ],
      },
    ],
    followups: { sent: [] },
    today: TODAY,
    now: NOW,
  });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].kind, KIND_BOOK_AGAIN);
  assert.equal(picks[0].remaining, 3);
  assert.equal(picks[0].phone, "(405) 555-0199");
  assert.deepEqual(picks[0].alsoMark, ["lsn_1"]);
});

test("pickBookAgainNudges stays quiet if the next lesson is already booked", () => {
  const picks = pickBookAgainNudges({
    members: [
      {
        email: "parent@example.com",
        remaining: 2,
        expired: false,
        scheduled: [
          { id: "lsn_1", date: "2026-08-26", time: "5:00 PM" },
          { id: "lsn_2", date: "2026-09-02", time: "5:00 PM" },
        ],
      },
    ],
    followups: { sent: [] },
    today: TODAY,
    now: NOW,
  });
  assert.equal(picks.length, 0);
});

test("pickBookAgainNudges skips used-up or expired memberships", () => {
  const used = pickBookAgainNudges({
    members: [
      {
        email: "a@example.com",
        remaining: 0,
        expired: false,
        scheduled: [{ id: "lsn_1", date: "2026-08-26", time: "5:00 PM" }],
      },
    ],
    followups: { sent: [] },
    today: TODAY,
    now: NOW,
  });
  const expired = pickBookAgainNudges({
    members: [
      {
        email: "b@example.com",
        remaining: 2,
        expired: true,
        scheduled: [{ id: "lsn_2", date: "2026-08-26", time: "5:00 PM" }],
      },
    ],
    followups: { sent: [] },
    today: TODAY,
    now: NOW,
  });
  assert.equal(used.length, 0);
  assert.equal(expired.length, 0);
});

test("membershipPitchMail sells the month without the field address", () => {
  const mail = membershipPitchMail(
    {
      player: "Sam",
      parent: "Maria",
      date: "2026-08-26",
      email: "parent@example.com",
    },
    "https://www.apacademybsb.com"
  );
  assert.match(mail.subject, /\$240/);
  assert.match(mail.text, /Four singles are \$280/);
  assert.match(mail.text, /nothing auto-renews/i);
  assert.match(mail.text, /book\.html\?type=membership/);
  assert.doesNotMatch(mail.text, /Juniper|73064|231 W/i);
  assert.doesNotMatch(mail.html, /Juniper|73064|231 W/i);
  assert.match(mail.html, /Maria/);
});

test("bookAgainMail points at the member portal and names remaining lessons", () => {
  const mail = atTime("2026-08-27T10:00:00-05:00", () =>
    bookAgainMail(
      {
        player: "Sam",
        parent: "Maria",
        email: "parent@example.com",
        remaining: 3,
        lastDayPretty: "Wednesday, September 16",
      },
      "https://www.apacademybsb.com"
    )
  );
  assert.match(mail.subject, /3 lessons left/);
  assert.match(mail.text, /account\.html\?k=/);
  assert.match(mail.text, /Wednesday, September 16/);
  assert.doesNotMatch(mail.text, /Juniper|73064|231 W/i);
  assert.match(mail.html, /Book my next lesson/);
});
