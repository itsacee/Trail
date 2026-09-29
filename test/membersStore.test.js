import { test } from "node:test";
import assert from "node:assert/strict";

import {
  upsertMember,
  removeMember,
  restoreMember,
  isMemberRemoved,
  removedMembers,
  memberRecord,
  isMemberFrozen,
} from "../lib/membersStore.js";

function state() {
  return { freezeAll: false, freezeAllAt: null, freezeAllReason: "", byEmail: {} };
}

test("removing a card hides it but keeps everything on file", () => {
  const s = state();
  upsertMember(s, "Parent@Example.com", {
    player: "Jo",
    phone: "4055550000",
    amountDueCents: 20000,
    note: "pays cash",
  });

  removeMember(s, "parent@example.com");

  assert.equal(isMemberRemoved(s, "parent@example.com"), true);
  const row = memberRecord(s, "parent@example.com");
  assert.equal(row.player, "Jo");
  assert.equal(row.amountDueCents, 20000);
  assert.equal(row.note, "pays cash");
  assert.ok(row.removedAt > 0);
});

test("a card can be put back", () => {
  const s = state();
  upsertMember(s, "parent@example.com", { player: "Jo", amountDueCents: 8000 });
  removeMember(s, "parent@example.com");
  restoreMember(s, "parent@example.com");

  assert.equal(isMemberRemoved(s, "parent@example.com"), false);
  assert.equal(memberRecord(s, "parent@example.com").amountDueCents, 8000);
  assert.deepEqual(removedMembers(s), []);
});

// The duplicate card is often one Stripe knows about and members.json doesn't.
// Removing it has to leave a marker, or the next dashboard load rebuilds it.
test("removing an email with no record on file still marks it removed", () => {
  const s = state();
  removeMember(s, "second-email@example.com");

  assert.equal(isMemberRemoved(s, "second-email@example.com"), true);
  assert.equal(removedMembers(s).length, 1);
});

test("new activity on a removed email brings the card back", () => {
  const s = state();
  removeMember(s, "parent@example.com");
  upsertMember(s, "parent@example.com", { player: "Jo", cashMembership: true });

  assert.equal(isMemberRemoved(s, "parent@example.com"), false);
  assert.equal(memberRecord(s, "parent@example.com").player, "Jo");
});

test("removing a card leaves the rest of the list alone", () => {
  const s = state();
  upsertMember(s, "one@example.com", { player: "One" });
  upsertMember(s, "two@example.com", { player: "Two", frozen: true, reason: "Paused" });
  removeMember(s, "one@example.com");

  assert.equal(isMemberRemoved(s, "two@example.com"), false);
  assert.equal(isMemberFrozen(s, "two@example.com").frozen, true);
  assert.deepEqual(
    removedMembers(s).map((m) => m.email),
    ["one@example.com"]
  );
});

test("removed cards list newest first", () => {
  const s = state();
  s.byEmail = {
    "old@example.com": { email: "old@example.com", removed: true, removedAt: 1000 },
    "new@example.com": { email: "new@example.com", removed: true, removedAt: 5000 },
    "here@example.com": { email: "here@example.com" },
  };

  assert.deepEqual(
    removedMembers(s).map((m) => m.email),
    ["new@example.com", "old@example.com"]
  );
});

test("blank emails are ignored", () => {
  const s = state();
  removeMember(s, "");
  restoreMember(s, "  ");
  assert.deepEqual(s.byEmail, {});
  assert.equal(isMemberRemoved(s, ""), false);
});
