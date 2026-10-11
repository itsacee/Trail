# STAGE 2B REPORT — Booking Concurrency and Data Safety

**Branch:** `cursor/stage2-booking-rules-f621`  
**Base Stage 2 implementation:** `93d32c8`  
**Prior tip:** `e214c2d`  
**Stage 2B implementation commit:** `5a979d4`  
**Scope:** Targeted CAS protection for `lessons.json` / `manual-bookings.json`. No Stage 3. No deploy.

---

## A. Files modified

| File | Change |
|------|--------|
| `lib/store.js` | Memory Blob test backend; `blobCompareAndSet` no longer creates-over-existing without ETag; first-create race yields + conflict |
| `lib/blobTxn.js` | **New** — bounded load → mutator → CAS → reload/retry helper |
| `lib/lessons.js` | `commitLessons` + `mutateLessons`; fail-closed without safe ETag |
| `lib/manualBookings.js` | `commitManualBookings` + `mutateManualBookings` |
| `api/member.js` | Book / cancel / reschedule use mutators + revalidate on retry |
| `api/cash-book.js` | Cash reserve uses `mutateManualBookings` |
| `api/coach.js` | Collect / move / cancel / create use mutators |
| `api/confirm.js` | Stripe lesson mirror via `mutateLessons` (idempotent upsert) |
| `api/checkout.js` | Failed hold (when Blob configured) expires Checkout + 503 |
| `lib/recordAttendance.js` | Attendance writes via `mutateLessons` |
| `test/concurrency.test.js` | **New** — parallel CAS / capacity / credit / mirror tests |
| `test/lessons.test.js` | First-create save test uses memory store |
| `STAGE-2B-CONCURRENCY-REPORT.md` | This report |

---

## B. Root cause of the concurrency issue

Vercel Blob stores one JSON document per schedule file. Writers used **read → mutate → unconditional overwrite**. Two concurrent requests could each load the same snapshot; the later `put` replaced the earlier writer’s append, dropping reservations and making membership credit counts wrong.

Lock-in **#58** / **#54** history: conditional `ifMatch` without reload/reapply caused endless 412s or was “fixed” by silent overwrite. The bug was not “CAS cannot work” — it was **CAS without a proper conflict transaction**.

---

## C. Exact fix implemented

1. **`mutateLessons` / `mutateManualBookings`** — bounded (5) transactions:
   - load versioned snapshot (SDK ETag when available)
   - run mutator (revalidate capacity / privacy / credits)
   - `blobCompareAndSet` — **no** overwrite on 412
   - on conflict: reload and re-run mutator on latest data
   - on exhausted retries / unsafe: return `schedule_unavailable` (not success)

2. **Fail closed** when content exists but no conditional ETag (`unsafe`) — never silent clobber.

3. **First create** of a missing file allowed once; if another writer created it, return **conflict** and retry with ETag.

4. Booking APIs updated to use mutators (not stale array rewrites).

---

## D. How simultaneous requests are handled

| Race | Behavior **[tested]** |
|------|------------------------|
| Two final standard seats | One CAS wins; loser reloads, `slotBlocked` → `slot_taken` |
| Two privates | One wins; other rejected |
| Standard vs private | One wins; other rejected |
| Two members last seat | One wins; seat rule rejects other |
| Book + cancel different rows | Both can succeed; neither wipes the other after retry |
| Two reschedules / two edits | Both persist after CAS retry |
| Manual cash two writers | Both bookings retained |

---

## E. How membership credits are protected

Credits remain **derived** from active membership lessons in the period (`membershipSummary` / `bookingBlocked`). Because lesson appends/cancels/moves go through CAS mutators that **recompute** scheduled lessons + `bookingBlocked` on every attempt, a lost overwrite can no longer silently resurrect a credit or double-spend under contended Blob writes.

**[tested]** parallel member last-seat race.  
**[assumption]** live Stripe membership lookup still serializes outside Blob (unchanged).

---

## F. How successful Stripe payments are preserved

| Case | Behavior |
|------|----------|
| Mirror fails after pay | Confirm/webhook still complete; Stripe metadata remains source of truth; error logged **[code]** |
| Hold cannot be written | If Blob configured: expire Checkout, 503, no payment **[code]** |
| Two confirmations / webhook + browser | `upsertStripeLessons` by stable id; second save may `skipSave` **[tested]** |
| Duplicate webhook | Existing `confirmation_sent` flag unchanged |
| Customer retries checkout | Prior session release + new hold path unchanged |

Live Stripe products/prices/subscriptions were **not** modified.

---

## G. Automated test results

| Command | Result |
|---------|--------|
| `npm test` | **175 passed**, **1 skipped** (`blobWrite` ifMatch `mock.module` unavailable), **0 failed** |
| `node --check` on modified JS | Passed |

Parallel coverage lives in `test/concurrency.test.js` using an in-process memory Blob with real ETag CAS (`BLOB_MEMORY_STORE=1`), not sequential seat math alone.

**Still skipped / unverified against real Vercel Blob API:** end-to-end CAS against production Blob from this environment (no production credentials used). Memory backend proves the transaction logic; production relies on `@vercel/blob` `ifMatch` (same primitive holds already use).

---

## H. Remaining limitations

1. **Not a database** — two files are still separate; cross-file atomicity (manual cancel + lessons insert in one member reschedule) is sequential, not a distributed transaction.
2. **CDN-only reads** (no SDK ETag) refuse writes rather than overwrite — safer, but booking fails closed until origin read works.
3. **Members / finance / settings** blobs still use unconditional `blobWrite` (out of Stage 2B scope).
4. **`mock.module` skip** remains for the old `blobWrite` fallthrough unit test (Node build limitation).
5. **Production dual-request load** against live Blob/Stripe not executed here.

---

## I. Whether Stage 2 is ready for Stage 3

**Yes — Stage 3 feature work may begin after external review of this Stage 2B change**, with Stage 2 privacy rules + CAS schedule writes in place.

Do not treat Stage 3 as a substitute for this concurrency fix. Prefer merging/reviewing Stage 2B before or with production deploy of Stage 2 rules.

---

## J. Git branch, commit, and working-tree status

See git output after commit in the agent summary. Working tree should be clean aside from any intentional untracked Stage 1 report.

---

STAGE 2B COMPLETE — AWAITING EXTERNAL REVIEW BEFORE STAGE 3.
