// Membership balance collect must ledger each partial payment; retries of a
// settled balance must not write finance.
import { test } from "node:test";
import assert from "node:assert/strict";

import { addFinanceEntry } from "../lib/finance.js";

function emptyFinance() {
  return { entries: [] };
}

test("membership balance finance keys allow progressive partials", () => {
  const fin = emptyFinance();
  const email = "partial.mem@example.com";
  const first = addFinanceEntry(fin, {
    amountCents: 10000,
    method: "cash",
    type: "membership",
    email,
    bookingId: `membal_${email}_10000`,
    note: "Membership balance collected",
  });
  const second = addFinanceEntry(fin, {
    amountCents: 18000,
    method: "cash",
    type: "membership",
    email,
    bookingId: `membal_${email}_28000`,
    note: "Membership balance collected",
  });
  assert.notEqual(first.id, second.id);
  assert.equal(fin.entries.length, 2);
  assert.equal(
    fin.entries.reduce((n, e) => n + e.amountCents, 0),
    28000
  );
});

test("same progressive paid-total key is idempotent", () => {
  const fin = emptyFinance();
  const email = "retry.mem@example.com";
  const a = addFinanceEntry(fin, {
    amountCents: 28000,
    method: "cash",
    type: "membership",
    email,
    bookingId: `membal_${email}_28000`,
    note: "Membership balance collected",
  });
  const b = addFinanceEntry(fin, {
    amountCents: 28000,
    method: "cash",
    type: "membership",
    email,
    bookingId: `membal_${email}_28000`,
    note: "Membership balance collected",
  });
  assert.equal(a.id, b.id);
  assert.equal(fin.entries.length, 1);
});
