import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import coachHandler from "../api/coach.js";
import { DEFAULT_COACH_PASS } from "../lib/coachAuth.js";

// One in-memory stand-in for the Blob store: reads serve whatever the test put
// there, writes land back in the same place so the next read sees them.
let blob = {};

function fakeBlob() {
  mock.method(globalThis, "fetch", async (url, options = {}) => {
    const value = String(url);
    const name = value.replace(/\?.*$/, "").split("/").pop();
    if ((options.method || "GET").toUpperCase() === "PUT") {
      blob[name] = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      return { ok: true, json: async () => ({}) };
    }
    if (blob[name] === undefined) return { ok: false, text: async () => "" };
    return { ok: true, text: async () => blob[name] };
  });
}

function responseRecorder() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function post(body) {
  const res = responseRecorder();
  await coachHandler({ method: "POST", query: { key: DEFAULT_COACH_PASS }, body }, res);
  return res;
}

function members() {
  return JSON.parse(blob["members.json"]);
}

const saved = {};

beforeEach(() => {
  blob = {
    "members.json": JSON.stringify({
      freezeAll: false,
      freezeAllAt: null,
      freezeAllReason: "",
      byEmail: {
        "first@example.com": { email: "first@example.com", player: "Jo Smith", phone: "4055550000" },
        "second@example.com": {
          email: "second@example.com",
          player: "Jo Smith",
          amountDueCents: 20000,
          cashMembership: true,
        },
      },
    }),
  };
  saved.blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  saved.availability = process.env.AVAILABILITY_URL;
  saved.stripe = process.env.STRIPE_SECRET_KEY;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_test";
  process.env.AVAILABILITY_URL = "https://blob.example/availability.json";
  delete process.env.STRIPE_SECRET_KEY;
  fakeBlob();
});

afterEach(() => {
  saved.blobToken === undefined
    ? delete process.env.BLOB_READ_WRITE_TOKEN
    : (process.env.BLOB_READ_WRITE_TOKEN = saved.blobToken);
  saved.availability === undefined
    ? delete process.env.AVAILABILITY_URL
    : (process.env.AVAILABILITY_URL = saved.availability);
  saved.stripe === undefined
    ? delete process.env.STRIPE_SECRET_KEY
    : (process.env.STRIPE_SECRET_KEY = saved.stripe);
  mock.restoreAll();
});

test("removing a card drops it from the members list and files it under removed", async () => {
  const res = await post({ action: "remove_member", email: "first@example.com" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.members.map((m) => m.email),
    ["second@example.com"]
  );
  assert.deepEqual(
    res.body.removedMembers.map((m) => m.email),
    ["first@example.com"]
  );
  assert.equal(members().byEmail["first@example.com"].player, "Jo Smith");
});

test("a card with money owed needs a second look before it goes", async () => {
  const blocked = await post({ action: "remove_member", email: "second@example.com" });

  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.code, "owes_money");
  assert.equal(blocked.body.amountDueCents, 20000);
  assert.match(blocked.body.error, /\$200\.00/);
  assert.equal(members().byEmail["second@example.com"].removed, undefined);

  const forced = await post({ action: "remove_member", email: "second@example.com", force: true });
  assert.equal(forced.statusCode, 200);
  assert.equal(members().byEmail["second@example.com"].removed, true);
  // The card is off the list, so its balance is off the Money tab too.
  assert.deepEqual(forced.body.finance.outstanding, []);
});

test("putting a card back restores the member and the balance", async () => {
  await post({ action: "remove_member", email: "second@example.com", force: true });
  const res = await post({ action: "restore_member", email: "second@example.com" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.removedMembers, []);
  const row = res.body.members.find((m) => m.email === "second@example.com");
  assert.equal(row.amountDueCents, 20000);
  assert.deepEqual(
    res.body.finance.outstanding.map((o) => o.amountDueCents),
    [20000]
  );
});

test("removing a card needs an email", async () => {
  const res = await post({ action: "remove_member", email: "  " });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /email/i);
});

test("the passcode still guards removing a card", async () => {
  const res = responseRecorder();
  await coachHandler(
    { method: "POST", query: { key: "nope" }, body: { action: "remove_member", email: "first@example.com" } },
    res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(members().byEmail["first@example.com"].removed, undefined);
});
