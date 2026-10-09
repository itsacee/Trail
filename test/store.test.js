// Blob reads must only mark an ETag as safe for ifMatch when it came from the
// SDK. Writes must always allow overwrite so existing lessons.json saves work.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

test("public CDN reads never enable conditional ifMatch writes", async () => {
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevUrl = process.env.AVAILABILITY_URL;
  const prevFetch = globalThis.fetch;

  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";

  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => '"cdn-etag"' },
    text: async () => JSON.stringify({ lessons: [] }),
  });

  try {
    const { blobReadVersioned } = await import("../lib/store.js");
    const result = await blobReadVersioned("lessons.json");
    assert.equal(result.conditional, false);
    assert.equal(result.etag, "");
    assert.equal(result.unreachable, false);
    assert.match(result.text, /lessons/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevToken;
    if (prevUrl === undefined) delete process.env.AVAILABILITY_URL;
    else process.env.AVAILABILITY_URL = prevUrl;
  }
});

test("a missing blob is empty, not unreachable", async () => {
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevUrl = process.env.AVAILABILITY_URL;
  const prevFetch = globalThis.fetch;

  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "" });

  try {
    const { blobReadVersioned } = await import("../lib/store.js");
    const result = await blobReadVersioned("lessons.json");
    assert.equal(result.text, null);
    assert.equal(result.unreachable, false);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevToken;
    if (prevUrl === undefined) delete process.env.AVAILABILITY_URL;
    else process.env.AVAILABILITY_URL = prevUrl;
  }
});

test("blobWrite falls through to overwrite when ifMatch is rejected", async (t) => {
  // Node's module mock is still experimental; skip if unavailable.
  if (typeof mock.module !== "function") {
    t.skip("mock.module is not available in this Node build");
    return;
  }

  class BlobPreconditionFailedError extends Error {
    constructor() {
      super("precondition failed");
      this.name = "BlobPreconditionFailedError";
    }
  }

  const puts = [];
  mock.module("@vercel/blob", {
    namedExports: {
      BlobPreconditionFailedError,
      get: async () => null,
      put: async (filename, body, opts) => {
        puts.push({ filename, opts: { ...opts } });
        if (opts.ifMatch) throw new BlobPreconditionFailedError();
        return { url: `https://example.com/${filename}`, pathname: filename };
      },
    },
  });

  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  try {
    const { blobWrite } = await import(`../lib/store.js?conflict=${Date.now()}`);
    // Members were stuck on "Couldn't safely reserve" when ifMatch 412'd.
    // Fall through to an unconditional overwrite so Lock in succeeds.
    assert.equal(
      await blobWrite("lessons.json", { lessons: [1] }, { ifMatch: "stale", conditional: true }),
      true
    );
    assert.equal(puts.length, 2);
    assert.equal(puts[0].opts.ifMatch, "stale");
    assert.equal(puts[1].opts.ifMatch, undefined);
    assert.equal(puts[1].opts.allowOverwrite, true);
  } finally {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    mock.restoreAll();
  }
});
