# Preview PostgreSQL write-enablement preflight

**Date:** 2026-10-14  
**PR / branch:** [#73](https://github.com/itsacee/Trail/pull/73) `cursor/booking-postgres-full-f621`  
**Deployed tip:** `dpl_Hni3Zy35BConNejp7cjCobJRdZeP` @ `d4f8904` (docs) on code `9a71907`  
**Write flag:** still **`BOOKING_WRITES_ENABLED=0`** (not changed this phase)  
**Scope:** read-only preflight + smoke plan. No checkouts, payments, bookings, Blob edits, merges, or Production deploy.

---

## Overall preflight: **PASS with documented residual risks**

Capacity create / cancel / move / confirm / hold / member-book paths are Postgres-gated in PR #73. Reconcile is clean. Isolation holds.  
**Do not enable writes until you explicitly approve** after reviewing the residuals and smoke plan below.

| # | Check | Result |
| --- | --- | --- |
| 1 | Preview-only + exclusive `apacademy-booking-preview` | **PASS** |
| 2 | Deployed code includes PR #73 transactional write paths | **PASS** |
| 3 | Latest Blob ↔ Postgres reconcile | **PASS** |
| 4 | No Blob path can independently mutate capacity after writes=1 | **PASS** (capacity paths) / **WARN** (non-capacity cash collect) |
| 5 | Confirm + webhook cannot duplicate bookings / double credits | **PASS** |
| 6 | Member reschedule atomic; preserves original on failure | **PASS** |
| 7 | Rollback cannot silently revive stale Blob over newer PG | **CONDITIONAL** — safe only with mandatory rollback SOP |

Local evidence this turn: `bookingStore` + `bookingAuthoritativeReads` **24/24 PASS** (idempotency, concurrent seats, failed reschedule preservation, bridge skipped when writes on, write facade disabled).

---

## 1. Isolation — PASS

| Evidence | Value |
| --- | --- |
| Runtime `/api/booking-db?action=status` | `mode=postgres`, `reads=true`, `writes=false`, `vercel_env=preview`, `dual_write_blob=false` |
| Deploy target | Preview only (`dpl_Hni3Zy35BConNejp7cjCobJRdZeP`) |
| Neon | Preview env only: `BOOKING_NEON_PROJECT_ID=withered-mud-40468222`, host `ep-polished-moon-b7cbl2y0-pooler…neon.tech` (same Preview project as prior `apacademy-booking-preview` cutover) |
| Production `BOOKING_*` | **none** |
| CAS / private probe | **not enabled** |
| `BOOKING_WRITES_ENABLED` | still `0` for this branch |

---

## 2. Deployed write-path surface — PASS

Code SHA `9a71907` (present on current Preview tip) includes `PostgresBookingStore` methods:

`reserveHold`, `confirmPaid`, `memberBook`, `reschedule`, `manualBook`, `cancelBooking` — all transactional with `slot_locks` `FOR UPDATE` + in-process `enqueueSlot`.

API wiring (writes branch returns before Blob mutators):

| Mutation | PG entry | Blob only when writes=0 |
| --- | --- | --- |
| Checkout hold | `placeHold` → `dbReserveHold` | Blob holds |
| Confirm + webhook | `dbConfirmPaid` (`mirror:<sourceId>`) | `mutateLessons` + upsert |
| Hold release | `dbReleaseHold` | Blob holds |
| Member book / cancel / move | `dbMemberBook` / `dbCancelBooking` / `dbReschedule` | Blob mutators |
| Cash-book | `dbManualBook` | Blob manual |
| Coach create / cancel / move | `dbManualBook` / `dbCancelBooking` / `dbReschedule` | Blob mutators |
| Record attendance | `dbMemberBook` | Blob lessons |

When writes=1, authoritative reads **skip Blob bridge** (`origin=postgres` only).

---

## 3. Reconcile — PASS

`POST /api/booking-db` `action=reconcile` (Blob read-only):

```json
{
  "ok": true,
  "summary": {
    "blob_active": 4,
    "db_active": 4,
    "missing_in_db": 0,
    "missing_in_blob": 0,
    "slot_mismatches": 0
  }
}
```

No import required. **Stop condition not triggered.**

---

## 4. Blob bypass audit — PASS (capacity) / WARN (cash collect)

### Capacity mutations (create / cancel / move / confirm / hold)

All customer-facing capacity writers use `if (bookingWritesEnabled()) { … return; }` then Blob else-branch. After writes=1 they **cannot** independently create, cancel, move, or confirm capacity via Blob.

`CAPACITY_WRITES_ENABLED` remains `1` on Preview (Blob CAS still *physically* allowed), but gated call sites do not invoke Blob mutators when Postgres writes are on.

### Residual non-capacity Blob writer — WARN

| Endpoint | Behavior after writes=1 | Impact |
| --- | --- | --- |
| Coach `collect_payment` on a cash booking | Still `mutateManualBookings` only | Will **404** for Postgres-only cash rows; does **not** create capacity, but money-collection UX breaks until patched |

**Recommendation before broad Preview coach use:** patch `collect_payment` to update Postgres booking payload (or dual-read then PG update). Not required for the capacity smoke plan below (book + cancel only).

Members/finance/settings stores remain Blob by design (not capacity).

---

## 5. Confirm / webhook idempotency — PASS

- Browser confirm and Stripe webhook both call `deliverConfirmation`.
- Postgres path uses `idempotencyKey: mirror:<sourceId>` in `idempotency_keys` inside a transaction with slot locks.
- Retry returns `{ ok: true, idempotent: true }` without inserting a second active row (unit: `payment retries are idempotent`).
- Concurrent same-hour admits capped at 2 standard seats (unit: simultaneous booking tests).
- Membership portal credits: `memberBook` / `cancelBooking(restoreCredit)` under `FOR UPDATE` on `membership_credits`; failed `reschedule` does not change credits (unit).
- Stripe package first-day lessons via `confirmPaid` do not increment `membership_credits` (credit ledger is portal `memberBook`); confirm retries do not double insert active rows for the same lesson ids.

---

## 6. Atomic reschedule — PASS

`reschedule` locks booking row + old/new `slot_locks`, evaluates admission, updates in place only on success. On capacity failure returns error with **no row update** (original appointment + credit preserved). Covered by unit tests including simultaneous failed moves.

---

## 7. Rollback safety — CONDITIONAL

| Action | Effect |
| --- | --- |
| Keep `BOOKING_READS_ENABLED=1`, set `BOOKING_WRITES_ENABLED=0` | Reads stay Postgres (+ bridge). New mutations return to Blob → **dual-period divergence resumes**. Safe only as a short pause after freezing traffic / re-importing Blob→PG. |
| Set `BOOKING_READS_ENABLED=0` (with or without writes) | Slots/Coach Desk fall back to Blob → **stale Blob can hide newer Postgres bookings**. **Unsafe.** |
| Overwrite Postgres from Blob without reconcile | Can erase write-period PG rows. **Unsafe.** |

**Mandatory rollback SOP (must be followed if reversing writes):**

1. Freeze customer booking traffic (or set site pause).  
2. Keep **`BOOKING_READS_ENABLED=1`**.  
3. Set `BOOKING_WRITES_ENABLED=0`.  
4. Export/reconcile Postgres → operational copy; do **not** re-import Blob over PG without a diff review.  
5. Only disable reads after Blob has been rebuilt from Postgres (or accept outage).

There is **no automatic code interlock** preventing an operator from turning reads off. Treat that as an operational control, not a silent safety net.

---

## Controlled Preview-only write smoke plan

**Prerequisites (when you approve writes):**

1. You authorize setting Preview branch secret `BOOKING_WRITES_ENABLED=1` only (leave Production untouched; no `BOOKING_DUAL_WRITE_BLOB`).  
2. Redeploy / wait for env pickup on `cursor/booking-postgres-full-f621`.  
3. Confirm `/api/booking-db?action=status` → `writes=true`, `reads=true`, `vercel_env=preview`.  
4. Re-run reconcile; **stop if mismatches**.  
5. Use **Stripe Sandbox / Preview** only. Prefer Coach Desk cash + member portal credits where possible to avoid unnecessary card charges; any Sandbox checkout must be labeled test and cleaned up.

**Rules during smoke:** no Production; no Blob file edits; no CAS probe; do not merge PRs; restore/cancel test rows afterward; do not alter real customer membership credits (use a dedicated Preview test membership / cash card).

### Smoke matrix

| # | Case | How | Pass criteria |
| --- | --- | --- | --- |
| S1 | Standard Hitting — 2 seats | Coach Desk two cash/standard Hitting same hour | Both admit; third denied `slot_unavailable` / 409 |
| S2 | Standard Fielding — 2 seats | Same for Fielding | Same |
| S3 | Standard Hitting + Fielding (`Both`) — 2 seats | Same for Both | Same; Fielding/Hitting cannot join that hour |
| S4 | Private Hitting exclusive | One private Hitting | Second any-focus denied |
| S5 | Private Fielding exclusive | One private Fielding | Second denied |
| S6 | Private Both exclusive | One private Both | Second denied |
| S7 | Mixed drop-in + membership | 1 standard drop-in + 1 matching-focus membership in same hour | Both OK; third denied; focuses must match |
| S8 | Coach cash book + cancel | Create unpaid cash → cancel | Slot frees in `/api/slots` + Coach Desk; `origin=postgres` |
| S9 | Member reschedule success | Portal move to open hour | New time active; old free; credits unchanged |
| S10 | Member reschedule failure | Move into private/full hour | **409**; original date/time still active; credits unchanged |
| S11 | Sandbox confirm/webhook idempotency | One Sandbox checkout; hit confirm URL + webhook (or double confirm) | Single PG row; second `idempotent`; no double email if `confirmation_sent` set |
| S12 | Concurrent final seat | Two parallel books for last standard seat (script or two Coach creates) | Exactly one wins; one 409; `db_active` seat count = 2 for that hour |

**After smoke:** cancel/comp test bookings; reconcile again; leave `BOOKING_WRITES_ENABLED=1` only if all S1–S12 PASS; otherwise set writes back to `0` **while keeping reads=1** and report failures.

---

## Blockers before I ask you to enable writes

None that hard-stop a **controlled capacity smoke**, provided you accept:

1. **Rollback SOP** above (do not turn reads off).  
2. **Coach `collect_payment`** still Blob-backed (skip collecting cash on PG rows until patched).  
3. **Test membership** needed for S9–S10 (Preview Stripe membership or Coach cash membership on a test email — without touching real customer credits).  
4. Explicit **your approval** to set `BOOKING_WRITES_ENABLED=1` on Preview branch `cursor/booking-postgres-full-f621` only.

---

## Explicitly not done this phase

- Did **not** set `BOOKING_WRITES_ENABLED=1`  
- Did **not** create checkouts, payments, or bookings  
- Did **not** modify Preview/Production Blob  
- Did **not** merge #68–#73 or deploy Production  
- Did **not** enable CAS probe  
- Did **not** change credentials or customer membership credits  

---

## Approval request

When you are ready, reply authorizing:

> Enable Preview-only `BOOKING_WRITES_ENABLED=1` on branch `cursor/booking-postgres-full-f621`, then execute smoke S1–S12.

I will then flip that single Preview secret, redeploy/verify status, run the smoke plan, and report PASS/FAIL per case — still without Production changes or PR merges.
