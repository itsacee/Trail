# AP Academy — Checkout Hold Failure Investigation

**Branch:** `cursor/stage2-booking-rules-f621` (PR #62)  
**Preview:** https://apacademywebsite-git-cursor-st-707e4b-nubulahfr4-4891s-projects.vercel.app  
**Status:** Application fix committed; preview re-test requires SSO + post-deploy smoke

---

## A. Confirmed root cause

`placeHold` was failing closed because `blobReadVersioned` used:

```js
get(filename, { access: "public", useCache: false })
```

In `@vercel/blob`, `useCache: false` **only** appends `?cache=0` when `access === "private"`. For public blobs it is a no-op. CDN-cached public reads can return a **stale ETag** (up to `cacheControlMaxAge`, here 15s; Vercel docs also note overwrite propagation delay).

CAS then called `put(..., { ifMatch: staleEtag })` → **HTTP 412** `BlobPreconditionFailedError` → `blobCompareAndSet` `{ ok:false, conflict:true }` → `placeHold` retried 3× against the same stale read → `false` → `api/checkout.js` expired the Stripe session and returned:

> “I couldn’t safely hold that time. No payment was taken — please try again.”

This is **not** “slot unavailable” and **not** missing `BLOB_READ_WRITE_TOKEN` (that path would skip the fail-closed hold check because `storeConfigured()` would be false).

---

## B. Evidence

| Evidence | Source |
|----------|--------|
| Fail-closed hold path | `api/checkout.js` ~481–494: `if (!held && storeConfigured())` → 503 + exact user message |
| Same message also on post-Stripe `bookedTimes` throw | `api/checkout.js` ~464–472 (less likely for both $280 and $100) |
| Public `useCache:false` no-op | `node_modules/@vercel/blob/dist/index.js`: `if (options.useCache === false && access === "private")` |
| Upstream note | Vercel storage commit: backend rejects `cache=0` on public stores |
| Preview SSO | `curl -sI` preview → 302 to `vercel.com/sso-api` (function logs not readable from this agent) |
| Env inference | Error only when `storeConfigured()` is true → preview **has** Blob token + `AVAILABILITY_URL` |

---

## C. Files modified

- `lib/store.js` — private origin reads/writes for `holds.json`, `lessons.json`, `manual-bookings.json`; legacy public→private migration when CDN ETag matches `head()`
- `lib/holds.js` — always CAS (no unconditional overwrite); honor unreachable reads; 5 retries
- `test/holdsOriginRead.test.js` — new coverage
- `CHECKOUT-FAILURE-INVESTIGATION.md` — this report

---

## D. Exact correction

1. Capacity-critical blobs: **write `access: "private"`**, **read `get(..., { access: "private", useCache: false })`** so ETags are origin-fresh for `ifMatch`.
2. Leave `availability.json` / settings / members / finance on **public** (public URL reads still required).
3. On legacy public capacity files: verify CDN body ETag against `head()` origin ETag; migrate to private under CAS; if mismatch, mark unreachable and retry (no empty-file invent / no unsafe overwrite).
4. `saveHolds` always uses `blobCompareAndSet` (create-only when no ETag).

CAS, holds, and availability checks are preserved — not disabled.

---

## E. Test results

**Command:** `npm test`  
**Result:** **224 passed**, **1 skipped** (`blobWrite` ifMatch `mock.module` unavailable), **0 failed**

Covered (mocked / memory Blob — not live Vercel preview):

- Hold create / release
- Standard + private membership-shaped holds
- CAS create-only conflict
- Hold conflict retry
- Simultaneous `placeHold`
- Missing Blob credentials fail closed
- SDK source asserts private-only cache bypass
- Existing checkout pricing, concurrency, privacy, Stage 4 suite

**Not executed here (SSO / no Stripe test keys / no staging Blob token in this VM):**

- Live preview `$80 / $100 / $280 / $360` / deposit checkout
- Live Stripe Checkout redirect
- Live dual last-seat against preview Blob

---

## F. Preview environment configuration

No env var change required for this root cause.

Confirm in Vercel project (Preview + Production):

- `BLOB_READ_WRITE_TOKEN` present
- `AVAILABILITY_URL` present
- Preview may share the production Blob store (same token) — capacity files will rewrite as **private** on first successful CAS after deploy; public `availability.json` unchanged

Optional hardening (not required for the fix): dedicated staging Blob store + Stripe test mode for previews so preview holds never touch production `holds.json`.

---

## G. Whether checkout now works in the preview

**Not verified live.** Preview is SSO-protected; this agent could not open Checkout or read Vercel function logs.

After this commit deploys to the PR preview, manual smoke should show Stripe Checkout URL returned (no 503 hold message) for the four purchase types.

---

## H. Remaining production risks

1. First post-deploy writes migrate public `holds.json` / `lessons.json` / `manual-bookings.json` to private — brief window if CDN still stale during migration (retries + fail-closed).
2. Preview and production may share one Blob store — preview checkouts can write real holds (expire in ~31 minutes).
3. Members/finance/settings still use unconditional `blobWrite` (out of scope).
4. Live dual-request load against production Blob not re-run in this investigation.

---

## I. Git / PR

- Branch: `cursor/stage2-booking-rules-f621`
- PR: #62 (updated with this fix)
- Do **not** merge / deploy production without approval
