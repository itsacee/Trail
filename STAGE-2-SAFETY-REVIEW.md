# STAGE 2 SAFETY REVIEW

**Reviewed:** `cursor/stage2-booking-rules-f621`  
**Implementation commit:** `93d32c8`  
**Branch tip:** `e214c2d` (report note only)  
**Scope:** Code review + existing tests only. No code, Blob, Stripe, or production changes.

Legend: **[code]** confirmed in source · **[tested]** covered by automated tests · **[untested]** behavior inferred, not proven under real concurrency

---

## 1. Concurrency safety

### Write-path map

| Path | Capacity check | Hold / reservation | Durable schedule write | Atomicity |
|------|----------------|--------------------|------------------------|-----------|
| **Card** (`api/checkout.js` → Stripe → `api/confirm.js`) | `slotBlocked` before create; post-create recheck + expire | `placeHold` → `holds.json` via **CAS** | `saveLessons` mirror after pay (**unconditional**) | Stripe session is source of truth; Blob mirror is best-effort |
| **Cash** (`api/cash-book.js`) | `slotBlocked` (+ retry reload) | None | `saveManualBookings` (**unconditional**) | Read-modify-write overwrite |
| **Member book** (`api/member.js` book) | `slotBlocked` (+ 3-attempt reload) | None | `saveLessons` (**unconditional**) | Same |
| **Member cancel / reschedule** | Reschedule rechecks slot | None | `saveLessons` / `saveManualBookings` (**unconditional**) | Same |
| **Coach create / move** (`api/coach.js`) | `slotBlocked` | None | Both stores (**unconditional**) | Same |
| **Reschedule helper** (`lib/reschedule.js`) | Caller checks | None | Caller saves via above | Mutates in memory only |

**[code]** `blobCompareAndSet` is used only in `lib/holds.js` → `saveHolds` when an SDK ETag is present.  
**[code]** `saveLessons` / `saveManualBookings` always call `blobWrite(..., { conditional: false })`.

### Could simultaneous requests…

| Risk | Card | Cash / coach / member / reschedule |
|------|------|-------------------------------------|
| Overwrite each other’s appends | Hold races mitigated by CAS; **lesson mirror** still last-writer-wins **[code]** | **Yes** — concurrent load → push → overwrite can drop the other append **[code, untested under real parallel load]** |
| Lose an existing booking | Mirror overwrite can drop a concurrent mirror/member write **[code]**; Stripe metadata for that payment remains | **Yes** if two writers race on the same JSON blob **[code]** |
| Standard slot > 2 athletes | Mitigated by open Checkout + expire-on-conflict + holds CAS **[code, partially tested]** | **Possible** if two last-seat writers both pass `slotBlocked` then both overwrite **[code, untested]** |
| Enter a private session | Same mitigations for card | Same last-seat race **[code, untested]** |
| Wrong credit deduct/restore | N/A for drop-in | Credits = count of lessons in period in `lessons.json` **[code]**. Lost write → credit appears unused; race can admit an extra book before overwrite loses a row |
| Pay without preserving reservation | Payment can succeed if hold place fails (non-throwing) or mirror fails after pay **[code]**; Stripe metadata still carries the slot; Blob lag until confirm/search catches up | Cash “reservation” is only the manual blob row — if save loses the race, booking can vanish after a 200 |

### Does CAS protect all booking paths?

**No. [code]** It protects **checkout holds** (`holds.json`) only, and only when `blobReadVersioned` returns a usable conditional ETag. It does **not** protect `lessons.json`, `manual-bookings.json`, finance, or members stores.

### Smallest reliable improvement (do not implement yet)

Reuse the holds pattern on the two capacity-critical blobs:

1. `saveLessons` / `saveManualBookings`: strict CAS (`blobCompareAndSet`) when ETag is safe; **no** silent overwrite on 412.
2. On conflict: reload → re-run `slotBlocked` / credit rules → re-apply mutation → retry (bounded).
3. Leave `blobWrite` fallthrough for non-capacity files so Lock-in #58 does not regress.

That is the smallest change compatible with the existing Vercel Blob architecture.

---

## 2. Booking privacy — code verification

| Requirement | Status |
|-------------|--------|
| New standard Hitting & Fielding can share an hour | **[code][tested]** `privacy:"standard"` + `slotBlocked` admits second same-focus seat |
| New private Hitting & Fielding cannot share | **[code][tested]** `type:"private"` → privacy private, seats = 2, blocks overlap |
| Standard bookings cannot mix training activities | **[code][tested]** different `focuses` → blocked |
| Private drop-ins cannot contain two siblings | **[code][tested]** UI `pair=false`; checkout/cash/coach 400; `canPair("private")===false` |
| Historical explicitly exclusive bookings remain protected | **[code][tested]** legacy Both with no privacy → private; explicit `privacy:"private"` honored |
| Private pricing exactly $100 for new purchases | **[code][tested]** `amount: 10000` in checkout; browser `prices.private: 10000` |
| Browser and server calculations agree | **[code]** mirrored helpers in `js/booking-core.js` / `lib/schedule.js` / `lib/settings.js` |

**Discrepancies / notes (not Stage 2 bugs):**

- **[code]** Membership always stamps `privacy:"standard"` — private membership ($360) is Stage 3; comment in `privacyForPurchaseType` acknowledges this.
- **[code]** `unitPriceFor("private", athletes>1)` still returns the standard rate for **legacy** price checks only; new private pairs are rejected before charge.
- **[assumption]** Production inventory of legacy Both rows was not audited (no production access).

---

## 3. Test coverage

**Current run:** 161 passed, 1 skipped, 0 failed.

| Question | Answer |
|----------|--------|
| Why was `blobWrite` skipped? | **[code]** `test/store.test.js` requires `mock.module`; this Node build does not provide it → `t.skip(...)`. |
| Is compare-and-set verified elsewhere? | **No.** No test imports or asserts `blobCompareAndSet` / hold 412 retry. CDN-read ETag safety is tested; CAS write path is **[untested]**. |
| Were actual simultaneous booking requests tested? | **No.** `simultaneous standard requests…` is sequential algorithm admission. `a later simultaneous checkout…` is a **mocked sequential** Stripe expire path — not two parallel HTTP handlers. |
| Scenarios only covered by unit / mocked API tests | Privacy/capacity math; private sibling rejection; pricing; slots aggregation; checkout expire-on-conflict with fake `fetch`; member/cash retry loops without contested Blob ETags |
| Additional tests needed before production | (1) Unit test `blobCompareAndSet` 412 → `{conflict:true}` with no overwrite; (2) `placeHold` reload/retry on conflict; (3) contested `lessons.json` / `manual-bookings.json` dual-writer after CAS lands; (4) true parallel integration (two concurrent book handlers) for last seat, private vs standard, member credit; (5) card path: payment success + failed mirror still visible via Stripe in `bookedTimes` |

Do **not** treat sequential unit tests as concurrency proof.

---

## 4. Production compatibility

| Topic | Finding |
|-------|---------|
| Deploy Stage 2 without Stage 3? | **Yes, from a product-rules perspective** — Stage 2 does not depend on private memberships. Concurrency gap is independent of Stage 3. |
| New env vars? | **None required [code].** Existing `BLOB_READ_WRITE_TOKEN`, `STRIPE_SECRET_KEY` (and related Stripe/site vars already in use). CAS uses the same Blob token. |
| Blob permission changes? | **None new [assumption]** beyond current read/write token; `ifMatch` is already used by the SDK path for holds. |
| Stripe config changes? | **None for Stage 2** — still `price_data` Checkout; no new Products/Prices required. |
| Backward compatible with existing records? | **[code]** Yes for schedule semantics: legacy Both without privacy stays exclusive; historical private sibling rows still occupy seats; new rows get explicit `privacy`. No migration rewrite required. |

Stage 2 is **feature-compatible** with today’s data model. It is **not** a concurrency hardening release for lessons/manual blobs.

---

## 5. Recommendation

### A. Confirmed working functionality **[code][tested]**

- Privacy derived from purchase type for new bookings  
- Standard (including Both) shareable up to 2 same focus  
- Private one athlete, $100, exclusive hour  
- Private siblings rejected on checkout / cash / coach  
- Legacy Both-without-privacy remains exclusive  
- Seat summing across overlapping rows  
- Checkout hold CAS + expire-on-conflict for card last-seat races (partial)  
- 161 tests passing on this branch  

### B. Remaining concurrency risks **[code; parallel behavior untested]**

- Unconditional overwrite of `lessons.json` and `manual-bookings.json`  
- Lost appends under concurrent cash / member / coach / reschedule / confirm-mirror  
- Possible last-seat oversell or private-hour intrusion on non-card paths  
- Membership credit count races tied to lesson-blob RMW  
- Card: hold failure or mirror failure after successful Stripe payment  

### C. Exact files/functions needing more protection

- `lib/lessons.js` — `saveLessons`  
- `lib/manualBookings.js` — `saveManualBookings`  
- Callers that RMW then save: `api/member.js` (book/cancel/reschedule), `api/cash-book.js`, `api/coach.js`, `api/confirm.js` (mirror), `lib/recordAttendance.js`  
- Already protected (holds only): `lib/holds.js` — `placeHold` / `releaseHold` / `saveHolds`  

### D. Recommended minimal fix

Strict CAS + reload + re-validate + retry for `lessons.json` and `manual-bookings.json`, matching holds; no 412 fallthrough on those two files.

### E. Additional tests required

CAS unit tests; hold conflict retry; dual-writer blob tests; true parallel last-seat / private / member-credit integration tests. Sequential tests alone are insufficient.

### F. Can Stage 3 safely begin on the current branch?

**Yes for Stage 3 feature work** (private membership product), **with the concurrency gap still open**. Stage 3 should not be treated as fixing Blob races unless it explicitly includes the CAS work above. Prefer landing (or scheduling) the minimal CAS fix before or with production deploy of Stage 2 rules under load.

### G. Is Stage 2 safe for eventual production deployment?

**Privacy / pricing / legacy compatibility: yes for eventual deploy** after normal review.  
**Concurrency under simultaneous bookings: not fully safe** — card path is stronger; cash/member/coach/reschedule still share unconditional Blob overwrites. Treat production deploy as acceptable only if concurrent last-seat traffic is rare **or** the minimal CAS fix lands first.

---

**Assumptions (not proven here):** production Blob/Stripe credentials and live dual-request behavior; production count of legacy Both rows; that Vercel Blob `ifMatch` remains reliable when re-enabled on lessons/manual (historically caused Lock-in 412 failures when paired with fallthrough-disabled writes without retry).

STAGE 2 SAFETY REVIEW COMPLETE — AWAITING APPROVAL.
