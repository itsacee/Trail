// Public CDN reads must not enable conditional ifMatch.
// Capacity CAS must not fall through to unconditional overwrite.
// CAPACITY_WRITES_ENABLED default-off preserved (PR #64).
// Post-cutover private capacity covered in dualStore.test.js.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

test("public CDN reads never enable conditional ifMatch writes", async () => {
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevPrivate = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  const prevUrl = process.env.AVAILABILITY_URL;
  const prevMem = process.env.BLOB_MEMORY_STORE;
  const prevCutover = process.env.CAPACITY_BLOB_CUTOVER;
  const prevFetch = globalThis.fetch;

  delete process.env.BLOB_MEMORY_STORE;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  delete process.env.CAPACITY_BLOB_CUTOVER;
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";

  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => '"cdn-etag"' },
    text: async () => JSON.stringify({ lessons: [{ id: "keep-me" }] }),
  });

  try {
    const { blobReadVersioned } = await import(`../lib/store.js?cdn=${Date.now()}`);
    // Pre-cutover capacity reads stay on the public CDN path (PR #64).
    const result = await blobReadVersioned("lessons.json");
    assert.equal(result.conditional, false);
    assert.equal(result.etag, "");
    assert.equal(result.unreachable, false);
    assert.match(result.text, /keep-me/);
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
    if (prevCutover === undefined) delete process.env.CAPACITY_BLOB_CUTOVER;
    else process.env.CAPACITY_BLOB_CUTOVER = prevCutover;
  }
});

test("a missing public blob is empty, not unreachable", async () => {
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevPrivate = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  const prevUrl = process.env.AVAILABILITY_URL;
  const prevMem = process.env.BLOB_MEMORY_STORE;
  const prevCutover = process.env.CAPACITY_BLOB_CUTOVER;
  const prevFetch = globalThis.fetch;

  delete process.env.BLOB_MEMORY_STORE;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  delete process.env.CAPACITY_BLOB_CUTOVER;
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "" });

  try {
    const { blobReadVersioned } = await import(`../lib/store.js?miss=${Date.now()}`);
    const result = await blobReadVersioned("lessons.json");
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
    if (prevCutover === undefined) delete process.env.CAPACITY_BLOB_CUTOVER;
    else process.env.CAPACITY_BLOB_CUTOVER = prevCutover;
  }
});

test("post-cutover capacity without private token is unreachable", async () => {
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevPrivate = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  const prevUrl = process.env.AVAILABILITY_URL;
  const prevMem = process.env.BLOB_MEMORY_STORE;
  const prevCutover = process.env.CAPACITY_BLOB_CUTOVER;

  delete process.env.BLOB_MEMORY_STORE;
  delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  process.env.CAPACITY_BLOB_CUTOVER = "1";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_publicOnly_x";
  process.env.AVAILABILITY_URL = "https://public.example/availability.json";

  try {
    const { blobReadVersioned } = await import(`../lib/store.js?nopriv=${Date.now()}`);
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

test("blobWrite refuses capacity files (must use CAS)", async (t) => {
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
      head: async () => null,
      put: async (filename, body, opts) => {
        puts.push({ filename, opts: { ...opts } });
        return { url: `https://example.com/${filename}`, pathname: filename };
      },
    },
  });

  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  process.env.CAPACITY_WRITES_ENABLED = "1";
  try {
    const { blobWrite } = await import(`../lib/store.js?capacity-write=${Date.now()}`);
    assert.equal(await blobWrite("lessons.json", { lessons: [1] }, { ifMatch: "stale", conditional: true }), false);
    assert.equal(puts.length, 0);
  } finally {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.CAPACITY_WRITES_ENABLED;
    mock.restoreAll();
  }
});

test("capacity CAS does not fall through to unconditional overwrite on 412", async (t) => {
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
      head: async () => null,
      put: async (filename, body, opts) => {
        puts.push({ filename, opts: { ...opts } });
        if (opts.ifMatch) throw new BlobPreconditionFailedError();
        return { url: `https://example.com/${filename}`, pathname: filename };
      },
    },
  });

  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  process.env.PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_priv_test";
  process.env.CAPACITY_WRITES_ENABLED = "1";
  process.env.CAPACITY_BLOB_CUTOVER = "1";
  try {
    const { blobCompareAndSet } = await import(`../lib/store.js?cas412=${Date.now()}`);
    const result = await blobCompareAndSet("holds.json", { holds: [] }, "stale-etag");
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].opts.ifMatch, "stale-etag");
    assert.equal(puts[0].opts.access, "private");
  } finally {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
    delete process.env.CAPACITY_WRITES_ENABLED;
    delete process.env.CAPACITY_BLOB_CUTOVER;
    mock.restoreAll();
  }
});

test("capacity CAS is paused unless CAPACITY_WRITES_ENABLED=1", async () => {
  const prev = process.env.CAPACITY_WRITES_ENABLED;
  const prevMem = process.env.BLOB_MEMORY_STORE;
  delete process.env.BLOB_MEMORY_STORE;
  delete process.env.CAPACITY_WRITES_ENABLED;
  process.env.BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || "test-token";
  try {
    const { blobCompareAndSet, capacityWritesEnabled } = await import(`../lib/store.js?pause=${Date.now()}`);
    assert.equal(capacityWritesEnabled(), false);
    const result = await blobCompareAndSet("lessons.json", { lessons: [] }, "etag");
    assert.equal(result.ok, false);
    assert.equal(result.paused, true);
  } finally {
    if (prev === undefined) delete process.env.CAPACITY_WRITES_ENABLED;
    else process.env.CAPACITY_WRITES_ENABLED = prev;
    if (prevMem === undefined) delete process.env.BLOB_MEMORY_STORE;
    else process.env.BLOB_MEMORY_STORE = prevMem;
  }
});
