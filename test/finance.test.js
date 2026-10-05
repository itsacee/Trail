import { test } from "node:test";
import assert from "node:assert/strict";

import { addFinanceEntry } from "../lib/finance.js";

test("card confirmation retries do not duplicate a finance entry", () => {
  const finance = { entries: [] };
  const payment = {
    amountCents: 28000,
    method: "card",
    type: "membership",
    player: "Sam",
    email: "parent@example.com",
    bookingId: "pi_paid_once",
    note: "Stripe checkout",
    date: "2026-10-05",
  };

  const first = addFinanceEntry(finance, payment);
  const retry = addFinanceEntry(finance, payment);

  assert.equal(finance.entries.length, 1);
  assert.equal(retry.id, first.id);
  assert.equal(finance.entries[0].bookingId, "pi_paid_once");
});

test("separate payments still create separate finance entries", () => {
  const finance = { entries: [] };
  addFinanceEntry(finance, { amountCents: 8000, bookingId: "pi_one" });
  addFinanceEntry(finance, { amountCents: 8000, bookingId: "pi_two" });
  assert.equal(finance.entries.length, 2);
});
