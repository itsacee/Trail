// Public-store reads must not enable ifMatch from CDN URL bodies.
// Capacity files (lessons/holds/manual) use the private store — see dualStore.test.js.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

test("public CDN reads never enable conditional ifMatch writes", async () => {
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevPrivate = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  const prevUrl = process.env.AVAILABILITY_URL;
  const prevMem = process.env.BLOB_MEMORY_STORE;
  const prevFetch = globalThis.fetch;

  delete process.env.BLOB_MEMORY_STORE;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";

  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => '"cdn-etag"' },
    text: async () => JSON.stringify({ days: {} }),
  });

  try {
    const { blobReadVersioned } = await import(`../lib/store.js?cdn=${Date.now()}`);
    const result = await blobReadVersioned("settings.json");
    assert.equal(result.conditional, false);
    assert.equal(result.etag, "");
    assert.equal(result.unreachable, false);
    assert.match(result.text, /days/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevToken;
    if (prevPrivate === undefined) delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
    else process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = prevPrivate;
    if (prevUrl === undefined) delete process.env.AVAILABILITY_URL;
    else process.env.AVAILABILITY_URL = prevUrl;
    if (prevMem === undefined) delete process.env.BLOB_MEMORY_STORE;
    else process.env.BLOB_MEMORY_STORE = prevMem;
  }
});

test("a missing public blob is empty, not unreachable", async () => {
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevPrivate = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  const prevUrl = process.env.AVAILABILITY_URL;
  const prevMem = process.env.BLOB_MEMORY_STORE;
  const prevFetch = globalThis.fetch;

  delete process.env.BLOB_MEMORY_STORE;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "" });

  try {
    const { blobReadVersioned } = await import(`../lib/store.js?miss=${Date.now()}`);
    const result = await blobReadVersioned("settings.json");
    assert.equal(result.text, null);
    assert.equal(result.unreachable, false);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevToken;
    if (prevPrivate === undefined) delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
    else process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = prevPrivate;
    if (prevUrl === undefined) delete process.env.AVAILABILITY_URL;
    else process.env.AVAILABILITY_URL = prevUrl;
    if (prevMem === undefined) delete process.env.BLOB_MEMORY_STORE;
    else process.env.BLOB_MEMORY_STORE = prevMem;
  }
});

test("capacity file without private token is unreachable (fail closed)", async () => {
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevPrivate = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  const prevUrl = process.env.AVAILABILITY_URL;
  const prevMem = process.env.BLOB_MEMORY_STORE;
  const prevCutover = process.env.CAPACITY_BLOB_CUTOVER;

  delete process.env.BLOB_MEMORY_STORE;
  delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  delete process.env.CAPACITY_BLOB_CUTOVER;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_public_test";
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";

  try {
    const { blobReadVersioned } = await import(`../lib/store.js?cap=${Date.now()}`);
    const result = await blobReadVersioned("lessons.json");
    assert.equal(result.unreachable, true);
    assert.equal(result.text, null);
  } finally {
    if (prevToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevToken;
    if (prevPrivate === undefined) delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
    else process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = prevPrivate;
    if (prevUrl === undefined) delete process.env.AVAILABILITY_URL;
    else process.env.AVAILABILITY_URL = prevUrl;
    if (prevMem === undefined) delete process.env.BLOB_MEMORY_STORE;
    else process.env.BLOB_MEMORY_STORE = prevMem;
    if (prevCutover === undefined) delete process.env.CAPACITY_BLOB_CUTOVER;
    else process.env.CAPACITY_BLOB_CUTOVER = prevCutover;
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
      head: async () => ({ etag: '"x"' }),
      put: async (filename, body, opts) => {
        puts.push({ filename, opts: { ...opts } });
        if (opts.ifMatch) throw new BlobPreconditionFailedError();
        return { url: `https://example.com/${filename}`, pathname: filename };
      },
    },
  });

  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  delete process.env.BLOB_MEMORY_STORE;
  try {
    const { blobWrite } = await import(`../lib/store.js?conflict=${Date.now()}`);
    // Non-capacity public files may fall through to overwrite.
    assert.equal(
      await blobWrite("settings.json", { prices: {} }, { ifMatch: "stale", conditional: true }),
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
