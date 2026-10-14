# AP Academy PostgreSQL — Production release readiness audit

**Date:** 2026-10-14  
**Audit branch:** `cursor/booking-prod-readiness-f621` (stacked on `cursor/booking-postgres-full-f621` / PR #73)  
**Scope:** Code audit + local fixes + local regressions. **No Production DB, no merges, no Production deploy, Preview writes left OFF.**

---

## Executive verdict

| Area | Status |
| --- | --- |
| Preview smoke S1–S12 | **PASS** (prior authorized window) |
| Capacity rules (Standard 2 / Private / reschedule) | **PASS** |
| Capacity mutations transactional when writes on | **PASS** |
| Stripe confirm/webhook idempotency | **PASS** (with noted recovery GAPs) |
| Coach money/ops parity under PG writes | **FIXED in this branch** (was FAIL) |
| Cash-book email + Blob capacity gate under PG writes | **FIXED in this branch** (was FAIL) |
| Membership credit ledger lag | **FIXED in this branch** (was WARN) |
| Production DB / import / cutover | **PLAN READY — not executed** |
| Production writes enablement | **BLOCKED pending approvals below** |

**Do not enable Production `BOOKING_WRITES_ENABLED=1` until the approvals checklist at the end is completed.**

---

## 1. Completed (code + evidence)

### Preview proof (already done on #73)

- S1–S12 PASS on Preview Neon (`ep-polished-moon…`) with writes briefly on, then disabled.
- Post-test status: `reads=true`, `writes=false`, `dual_write_blob=false`.
- Imported Stripe actives intact; smoke leftovers cleaned.
- CAS probe remains disabled (no `PROBE_*` Preview secrets).

### Capacity / transactions (verified)

| Mutation | PG path when writes=1 | Transaction + slot lock |
| --- | --- | --- |
| Hold reserve/release | Yes | Reserve: `BEGIN` + `FOR UPDATE`; release: single UPDATE |
| `confirmPaid` | Yes | Yes + `idempotency_keys` |
| Member book / cancel / reschedule | Yes | Yes |
| Coach create / cancel / move | Yes | Yes |
| Cash-book | Yes | Yes |
| Attendance (`recordMemberLessons`) | Yes (`memberBook`) | Yes |
| **collect_payment (manual)** | **Yes (this branch)** | **Yes** |

Standard (2 matching-focus), Private exclusivity, and failed-reschedule preservation are covered by `test/bookingStore.test.js`, `test/bookingBusinessRules.test.js`, and Preview S1–S10/S12.

### Fixes landed on this readiness branch

1. **`collectManualPayment`** on `PostgresBookingStore` + Coach Desk PG branch — Money tab collect no longer 404s against PG cash rows.
2. **`mapDbBookingRow`** merges `payload` payment fields (`amountDueCents`, `paymentStatus`, etc.) so Coach schedule shows owed balances under reads=1.
3. **Cash-book PG path** sends confirmation email and returns the same client payload as Blob (`sessions`, `amountDue`, `places`, `sent`).
4. **Cash-book** no longer blocked by Blob `capacityWritesEnabled` pause when PG writes are on.
5. **Coach `create_booking`** PG path writes finance when `paid > 0`; membership manuals set `membershipId: cash_<email>`.
6. **`memberBook`** syncs `membership_credits.credits_used` from existing active lessons before admitting (prevents overshoot after cash/import history).
7. **`confirmPaid`** idempotency insert uses `ON CONFLICT DO NOTHING` for concurrent webhook retries.

### Local regressions

```
node --test --test-concurrency=1
# tests 374 | pass 372 | fail 0 | skipped 2
```

Skipped: two `mock.module` CAS tests (Node build limitation — pre-existing).  
Core booking/capacity/Stripe-hold/membership suites: **208/208 PASS** in isolation.

---

## 2. Remaining GAPs (not blockers for merge of readiness fixes; blockers for Production writes)

| ID | Gap | Severity | Mitigation before Production writes |
| --- | --- | --- | --- |
| G1 | Email delivery not webhook-retried (Resend fail → HTTP 200, `confirmation_sent` unset) | Medium | Verify Resend on Production; Coach `member-links` rescue; optional cron re-send later |
| G2 | Concurrent confirm page + webhook can double-send email (TOCTOU on `confirmation_sent`) | Low | Accept rare duplicate or add send lock later |
| G3 | Paid-but-unmirrored seats invisible under reads=1 after hold TTL (~31 min) if mirror outage persists | High for cutover window | Stripe→PG reconcile job + freeze checkouts if webhook 503s spike |
| G4 | Finance + members cards remain Blob by design | Info | Document ops; do not expect PG finance ledger |
| G5 | Preview Resend historically returned non-OK / 401-class failures when key/domain misaligned | Medium | Operator verify `RESEND_API_KEY` + verified From domain in Resend dashboard (**do not rotate in this audit**); send one approved non-booking test after approval |
| G6 | No live Production Stripe webhook soak yet | High | Sandbox E2E on Preview with writes on (authorized window) before Production |

Refunds: no in-app Stripe refund mutation exists today — **N/A** (ops via Stripe Dashboard).

---

## 3. PR #68–#73 merge sequence (safest)

```
main
 └─ #68 dual-store-rebase
     └─ #69 booking-capacity-rules
         ├─ #70 preview-cas-probe-api   ← SKIP for Production
         └─ #71 booking-postgres-preview
             └─ #72 booking-postgres-reads
                 └─ #73 booking-postgres-full   (S1–S12 evidence)
                     └─ this readiness branch (prod parity fixes)
```

**Recommended order to `main`:**

1. Merge **#68** (dual-store CAS foundation)  
2. Merge **#69** (Blob capacity + atomic reschedule)  
3. Merge **#71 → #72 → #73** (Postgres store → reads → gated writes + smoke reports)  
4. Merge **readiness PR** (this branch) onto #73 tip then to `main`  
5. **Do not merge #70** into Production path (HTTP CAS probe). Keep all `PROBE_*` unset.

**Avoid:** merging older superseded CAS commits, re-opening #63, or enabling `BOOKING_DUAL_WRITE_BLOB`.

After tip lands on `main` with defaults: Production stays Blob-authoritative until flags are set. #68/#69 Blob fixes activate immediately (desired).

---

## 4. Exact Production cutover plan (execute only after approvals)

### Phase A — Provision (no traffic change)

1. Create **new** Neon project/branch for Production booking (separate from Preview `withered-mud` / `ep-polished-moon`).  
2. Apply `db/schema.sql` only.  
3. Set Production secrets (names only): `BOOKING_DATABASE_URL` (+ pool/unpooled as needed), `BOOKING_STORE=postgres`, leave **`BOOKING_READS_ENABLED=0`**, **`BOOKING_WRITES_ENABLED=0`**.  
4. Confirm Production Stripe webhook endpoint + `STRIPE_WEBHOOK_SECRET` (live mode).  
5. Confirm `RESEND_API_KEY` + verified From domain.  
6. Take Blob snapshots backup: `lessons.json`, `manual-bookings.json`, `holds.json`, `members`, `finance`, settings/availability.

### Phase B — Import + reconcile (writes still off)

1. Export Production Blob capacity snapshots.  
2. Run import into Production PG (`importFromBlob` / booking-db import action) — **idempotent**.  
3. Reconcile Blob↔PG: active counts, per-slot occupancy, membership lesson attribution, finance `bookingId` coverage.  
4. Target: **0 mismatches** on active future lessons; document any intentional historical gaps.  
5. Protect customers: do **not** delete/rewrite Stripe PIs, memberships, or finance history; import is additive/upsert by id.

### Phase C — Read soak (still no PG writes)

1. Set Production `BOOKING_READS_ENABLED=1` only.  
2. Verify Coach Desk, `/api/slots` `occupancy_source=postgres`, member portal lessons, fail-closed behavior (no silent Blob capacity fallback when PG down).  
3. Keep Blob bridge for dual-period rows until writes on.  
4. Soak through peak booking window; watch Neon + Vercel errors.

### Phase D — Write cutover (short freeze)

1. Freeze new checkouts briefly (site status / capacity pause as used today).  
2. Final Blob→PG reconcile delta.  
3. Set `BOOKING_WRITES_ENABLED=1` on Production only; **never** `BOOKING_DUAL_WRITE_BLOB=1`.  
4. Unfreeze; run controlled smoke: one Sandbox/live-mode approved checkout, one cash book, one collect_payment, one membership reschedule.  
5. Confirm webhook idempotency (retry) and single PG row per PI.

### Phase E — Post-cutover

1. Keep Blob capacity files **immutable archive** (do not re-activate as authority).  
2. Run Stripe paid→PG reconcile scanner for the first 24–48h (or until webhook 503s are zero).  
3. Monitor: Neon, webhook 503 rate, Resend failures, Coach outstanding balances.

---

## 5. Customer data protection

| Asset | During cutover |
| --- | --- |
| Profiles / members cards | Remain on members Blob store; cash membership period fields preserved |
| Active Stripe memberships | Stripe is source of truth; PG mirrors lesson rows only |
| Remaining credits | Portal counts scheduled lessons; PG ledger synced on `memberBook` |
| Lesson histories | Imported by id; cancel/void semantics preserved |
| Finance records | Stay on finance Blob; new collects/coach paid books append |
| Future bookings | Imported before reads/writes flip; post-cutover all new capacity writes go to PG |

---

## 6. Rollback / recovery (never revive stale Blob capacity)

**If writes-on Production misbehaves:**

1. Immediately set `BOOKING_WRITES_ENABLED=0`.  
2. Keep `BOOKING_READS_ENABLED=1` if PG data is still correct (preferred).  
3. Freeze checkouts.  
4. Export PG actives → treat PG as the recovery source of truth.  
5. **Do not** re-enable Blob capacity writes from pre-cutover snapshots (stale). If Blob must temporarily accept writes again, first **re-import PG → Blob** (or restore from a Blob backup taken *after* the last successful PG reconcile), then disable PG reads.  
6. Never set `BOOKING_DUAL_WRITE_BLOB=1` as a “fix.”

---

## 7. PASS / FAIL checklist

| Item | Result |
| --- | --- |
| S1–S8 Preview smoke | **PASS** |
| S9–S12 Preview smoke | **PASS** |
| Preview writes disabled after smoke | **PASS** (`writes=false`, `reads=true`) |
| Standard capacity (2 matching focus) | **PASS** |
| Private exclusivity | **PASS** |
| Membership reschedule protections | **PASS** |
| Mutations transactional when writes on | **PASS** |
| Stripe confirm/webhook idempotency | **PASS** |
| collect_payment under PG writes | **PASS** (fixed) |
| Coach payment fields on schedule | **PASS** (fixed) |
| Cash-book email/response under PG writes | **PASS** (fixed) |
| Coach finance on paid create (PG) | **PASS** (fixed) |
| Credit ledger sync from existing lessons | **PASS** (fixed) |
| Local regression suite (clean env) | **PASS** 372/372 (2 skip) |
| CAS probe disabled | **PASS** |
| Production DB provisioned | **NOT DONE** (awaiting approval) |
| Production import/reconcile | **NOT DONE** |
| Production reads/writes enabled | **NOT DONE** |
| Live Resend Production verify | **GAP** (operator) |
| Stripe→PG reconcile job in prod | **GAP** (recommended before/at cutover) |

---

## 8. Approvals required before going live

Grant these explicitly, in order:

1. **Merge sequence** `#68 → #69 → #71 → #72 → #73 → readiness PR` to `main` (skip #70).  
2. **Provision Production Neon** + schema + Production `BOOKING_*` secrets with reads/writes **still 0**.  
3. **Blob backup + Production Blob→PG import + reconcile to 0 mismatches**.  
4. **Enable Production `BOOKING_READS_ENABLED=1`** soak.  
5. **Brief checkout freeze + enable Production `BOOKING_WRITES_ENABLED=1`** (reads stay 1; dual-write Blob never).  
6. **Authorized live/Sandbox verification** of checkout + webhook + email after cutover.  
7. **Resend Production verification** (confirm key/domain; optional single non-booking test send — no credential rotation in-agent).

---

## 9. Explicitly not done (per instructions)

- No Production database created or modified  
- No Production credentials rotated  
- No Blob stores modified  
- No PR merges; no Production deploy  
- Preview `BOOKING_WRITES_ENABLED` left **0**  
- No additional Preview smoke bookings/payments created during this audit  
- Old CAS probe left disabled  

---

## Files touched in this readiness branch

- `lib/bookingDb/postgresStore.js` — collect payment, credit sync, idempotency ON CONFLICT  
- `lib/bookingStore.js` — `dbCollectManualPayment`  
- `lib/bookings.js` — schedule payment field mapping  
- `api/coach.js` — collect_payment PG path; finance on create  
- `api/cash-book.js` — capacity gate; email + response parity; membershipId  
- `test/bookingStore.test.js` — new coverage  
- This report
