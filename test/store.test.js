// Blob reads must only mark an ETag as safe for ifMatch when it came from the
// SDK. A public CDN ETag used to make every save fail with "check Blob".
import { test } from "node:test";
import assert from "node:assert/strict";
import { blobReadVersioned } from "../lib/store.js";

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
    const result = await blobReadVersioned("lessons.json");
    assert.equal(result.conditional, false);
    assert.equal(result.etag, "");
    assert.match(result.text, /lessons/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevToken;
    if (prevUrl === undefined) delete process.env.AVAILABILITY_URL;
    else process.env.AVAILABILITY_URL = prevUrl;
  }
});
