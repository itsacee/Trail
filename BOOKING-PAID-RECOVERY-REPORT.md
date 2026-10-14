# Paid-booking recovery & customer-data consistency — PASS/FAIL report

**Date:** 2026-10-14  
**Branch:** `cursor/booking-paid-reconcile-f621` (stacked on `cursor/booking-prod-readiness-f621` / PR #74)  
**Constraints honored:** No PR merges (#68–#74), no Production DB/config, no Production deploy, no booking writes enabled, no Stripe charges, no customer/Blob mutations, Preview writes remain **off**, CAS probe off.

---

## Overall: **PASS** for Production **read soak** readiness  
## Overall: **CONDITIONAL PASS** for eventual **write cutover** (approvals still required)

Local protections for paid-unmirrored recovery, occupancy safety, conflict alerts, credit audit, and idempotency are implemented and tested. Production DB provision/import/cutover still requires separate approval.

---

## 1. Fixes implemented

| # | Item | Status | Implementation |
| --- | --- | --- | --- |
| 1 | Stripe→PG reconciliation for paid Checkout sessions | **PASS** | `lib/bookingDb/stripePaidReconcile.js`; Coach `booking-db?action=reconcile_stripe_paid`; cron `api/reconcile-paid.js` |
| 2 | Paid-unmirrored seats cannot vanish after hold TTL | **PASS** | `api/slots.js` keeps Stripe paid search when Postgres reads/writes on; dedupes against `${pi}-N` / `sourceRef` |
| 3 | Filled-slot conflict without double-book / eviction | **PASS** | Reconcile records `reconcile_alerts`; never deletes seated rows; conflict leaves PI unmirrored |
| 4 | Idempotent retries / no duplicate lessons / no double credit | **PASS** | `confirmPaid` idempotency + two-phase multi-slot admit; reconcile short-circuits on existing `source_ref` |
| 5 | Membership credit sync audit (PG lessons vs ledger) | **PASS** | `auditMembershipCredits` / `syncMembershipCreditsFromLessons`; `credit_audit` admin action |
| 6 | Coach collect / finance / cash / refunds audit | **PASS** (doc + prior #74 fixes) | Collect+finance on PG path (#74); refunds remain Stripe Dashboard (no in-app refund mutation) |
| 7 | Authority matrix Blob vs Postgres | **PASS** | `lib/bookingDb/authority.js` + report §3 |
| 8 | Regression tests | **PASS** | `test/stripePaidReconcile.test.js` (11/11) + full suite |
| 9 | Operator recovery procedure | **PASS** | `BOOKING-PAID-RECOVERY-OPS.md` + alert logging in `reconcile-paid` |
| 10 | Readiness for read soak / write cutover | **PASS / CONDITIONAL** | See §5 |

### Schema

- `reconcile_alerts` table (`db/schema.sql` migration `002_reconcile_alerts`)

### Partial-write hardening

- `confirmPaid` evaluates **all** lesson slots before inserting any (no partial multi-slot mirrors)

---

## 2. Authority matrix (exact)

| Record | Authoritative store |
| --- | --- |
| Lesson / hold / manual **capacity** (when writes on) | **PostgreSQL** |
| Occupancy reads (when reads on) | **PostgreSQL** (+ Stripe paid safety net for unmirrored PIs) |
| Stripe payment captured / PI metadata | **Stripe** |
| Members cards, cash membership periods, freezes | **Blob members** |
| Portal “lessons left” display | **Schedule lesson count** (`membershipSummary`) |
| PG `membership_credits` ledger | **PostgreSQL** (enforced on `memberBook`; sync raises to lesson count) |
| Finance ledger (cash/card totals) | **Blob finance.json** |
| Settings / availability / site status | **Blob / config** |

**Never:** auto-evict a seated customer; dual-write Blob capacity with writes on; treat Blob as occupancy authority when Postgres fail-closed.

---

## 3. Tests run

```
node --test --test-concurrency=1
# tests 385 | pass 383 | fail 0 | skipped 2
```

New coverage (`test/stripePaidReconcile.test.js`):

- Idempotent mirror / no duplicates  
- Conflict → alert, seated customers untouched  
- Multi-slot capacity failure leaves zero rows for that PI  
- Webhook-style retry idempotency  
- Credit audit mismatch + sync without double-spend  
- Writes-off deferral  
- `bookedTimes` keeps paid-unmirrored seat under Postgres reads  
- Batch reconcile surfaces open alerts  
- Paid-only session listing  

Preview status rechecked: `reads=true`, `writes=false`, `dual_write_blob=false`.

---

## 4. Remaining Production blockers (not done here)

| Blocker | Needed approval |
| --- | --- |
| Merge stack #68 → #69 → #71 → #72 → #73 → #74 → **this PR** (skip #70) | Merge approval |
| Provision Production Neon + schema + secrets (reads/writes **0**) | Explicit |
| Blob backup + Blob→PG import + reconcile to 0 mismatches | Explicit |
| Production `BOOKING_READS_ENABLED=1` soak | Explicit |
| Schedule `/api/reconcile-paid` cron + alert monitoring | Explicit |
| Verify Resend / Stripe live webhook | Explicit |
| Production `BOOKING_WRITES_ENABLED=1` cutover | Explicit (separate) |

---

## 5. Are protections sufficient?

### Production **read soak** — **YES (PASS)**

With reads on and writes off:

- Postgres owns schedule reads (fail closed)  
- Stripe paid search keeps paid-unmirrored seats occupied after hold expiry  
- Reconcile can scan and **defer** until writes are approved  
- No customer Blob/booking mutations required for the soak  

### Eventual **write cutover** — **CONDITIONAL PASS**

Safe to plan once blockers above are approved, because:

- Mirror path is idempotent; conflicts alert instead of overbooking  
- Credit ledger sync + collect/finance parity from #74  
- Operator runbook exists for irrecoverable capacity clashes  

Still require: Production import cleanliness, cron + alerting wired, and a short freeze window at write enablement.

---

## 6. Files changed

- `db/schema.sql` — `reconcile_alerts`  
- `lib/bookingDb/postgresStore.js` — two-phase confirmPaid; alerts; credit audit/sync  
- `lib/bookingDb/stripePaidReconcile.js` — new  
- `lib/bookingDb/authority.js` — new  
- `lib/bookingDb/capacity.js` — `sourceRef` on occupancy  
- `lib/bookingStore.js` — alert/credit facades  
- `api/slots.js` — paid safety net + dedupe  
- `api/booking-db.js` — reconcile/credit/alert/authority actions  
- `api/reconcile-paid.js` — cron entry  
- `test/stripePaidReconcile.test.js` — new  
- `BOOKING-PAID-RECOVERY-OPS.md`, `BOOKING-PAID-RECOVERY-REPORT.md`
