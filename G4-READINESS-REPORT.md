# Gate G4 — READINESS VALIDATION (no Production write activation)

**Finished:** 2026-10-14T21:05:00Z  
**Scope authorized:** Readiness validation only — Phases 1–3  
**Hard stops honored:** Production `BOOKING_WRITES_ENABLED` / `CAPACITY_WRITES_ENABLED` remain off; Production checkout remains paused; no Production Stripe charges; no Production booking/credit/finance mutations; no Blob CAS probe; no merge/deploy of Production write flags.

---

## Overall verdict: **FAIL — one unresolved blocker (Coach Desk cash collect)**

Production read-only preflight is **PASS**. Preview booking/capacity/membership/Stripe-mirror workflows are **PASS** except Coach Desk `collect_payment` against Postgres-authored unpaid cash bookings (**FAIL / blocker**).

**Do not enable Production booking writes or reopen checkout until the E8 blocker is fixed and re-tested on Preview.**

---

## Phase 1 — Production read-only preflight: **PASS**

Artifact: `/opt/cursor/artifacts/g4-phase1-preflight.json`

| Check | Result | Evidence |
| --- | --- | --- |
| Correct Production Neon | **PASS** | `dark-base-01659888` / `ep-fragrant-credit…` / `apacademy-booking-production` |
| Postgres reads on, writes off | **PASS** | `mode=postgres`, `reads=true`, `writes=false`, `vercel_env=production`, `dual_write_blob=false` |
| Slots occupancy source | **PASS** | `occupancy_source=postgres` |
| Oct 15, 5 PM Mustang | **PASS** | Standard, focuses=`Both`, Full `count=2/seats=2`; PG rows Dylan `lsn_mv3zgqy2_zos8on` + Cooper `mb_muvxcb7c_1656bd` |
| Checkout / cash-book paused | **PASS** | both `capacityWritesPaused=true` (503) |
| Blob ↔ PG reconcile | **PASS** | active 51/51; missing_in_db=0; missing_in_blob=0; slot_mismatches=0 |
| DB counts | **PASS** | bookings=54 (active=51, cancelled=3); membership_credits=18; reconcile_alerts=0 |
| Membership credit audit | **PASS** | 0 mismatches |
| Coach Desk / calendar / member-links | **PASS** | reachable; calendar emits `VEVENT`s |
| Stripe paid reconcile (RO) | **PASS** | scanned=1, already=1, alerts=0, needsOperator=false |
| Blob hashes stable | **PASS** | lessons `1b9a4972…`, manual `4cb32a9e…` |

### Write-path audit (code, not activated)

| Route | When `BOOKING_WRITES_ENABLED=1` | While writes=0 (current Prod) |
| --- | --- | --- |
| `api/coach` create/cancel/move | `dbManualBook` / `dbCancelBooking` / `dbReschedule` | Blob mutators (paused by capacity freeze for customer paths) |
| `api/coach` collect_payment | **Intended:** `dbCollectManualPayment` — **Preview live FAIL (E8)** | Blob `mutateManualBookings` |
| `api/cash-book` | `dbManualBook` (bypasses capacity pause when booking writes on) | Paused unless capacity writes on |
| `api/member` book/cancel/reschedule | `dbMemberBook` / `dbCancelBooking` / `dbReschedule` | Blob mutators |
| `api/confirm` paid mirror | `dbConfirmPaid` + PG hold release | Blob lessons + Blob hold release |
| `lib/holds` reserve/release | `dbReserveHold` / `dbReleaseHold` | Blob holds (requires `CAPACITY_WRITES_ENABLED`) |
| `api/checkout` gate | Still requires `CAPACITY_WRITES_ENABLED=1` (does **not** honor booking writes alone) | Paused on Production |
| Members / finance ledgers | Remain Blob by design | Unchanged |
| Dual-write Blob capacity | Fenced (`BOOKING_DUAL_WRITE_BLOB` must not be `1`; status shows `dual_write_blob=false`) | n/a |

**Legacy risk while reads on / writes off:** checkout holds still use Blob when writes off; confirm mirrors still Blob; new Blob-only rows can diverge until re-import. Production checkout is paused, so this window is currently idle for new paid traffic.

---

## Phase 2 — Preview E2E: **PASS with 1 FAIL**

**DB:** Preview Neon only (`withered-mud-40468222` / `ep-polished-moon…`)  
**Write window:** `BOOKING_WRITES_ENABLED=1` on Preview branch `cursor/booking-postgres-full-f621` only → deploy `apacademywebsite-ppbmx6pv3-…`  
**Writes disabled after tests:** `BOOKING_WRITES_ENABLED=0` → deploy `apacademywebsite-c6x4hr4vo-…` (`writes=false`, `reads=true`)  
**Production untouched:** status still `writes=false`; checkout still paused.

### Booking rules / drop-ins (S1–S8): **ALL PASS**

| ID | Workflow | Result |
| --- | --- | --- |
| S1 | Standard Hitting max 2, deny 3rd | **PASS** |
| S2 | Standard Fielding max 2, deny 3rd | **PASS** |
| S3 | Standard Both matching; mixed Hitting denied | **PASS** |
| S4 | Private Hitting exclusive | **PASS** |
| S5 | Private Fielding exclusive | **PASS** |
| S6 | Private Both exclusive | **PASS** |
| S7 | Drop-in + membership share capacity | **PASS** |
| S8 | Coach cash book + cancel | **PASS** |

### Membership / portal / Stripe mirror / concurrency (S9–S12): **ALL PASS**

| ID | Workflow | Result |
| --- | --- | --- |
| S9 | Member reschedule success; credits unchanged | **PASS** |
| S10 | Failed reschedule preserves original + credits | **PASS** |
| S11 | `confirmPaid` idempotent retry → exactly one booking | **PASS** |
| S12 | Concurrent final seat → 1 win / 1 loss, pg=2 | **PASS** |

### Supplemental G4 workflows (E1–E10)

| ID | Workflow | Result |
| --- | --- | --- |
| E1 | Cancel membership lesson returns credit (`used 1→0`, `rem 3→4`) | **PASS** |
| E2 | Portal books second membership lesson (PG shows 2 actives) | **PASS** ※ |
| E3 | Mixed focus denied on occupied Hitting slot | **PASS** |
| E4 | Private reserves entire slot | **PASS** |
| E5 | Stripe **test-mode** Checkout session created (`url` + `sessionId`) | **PASS** |
| E6 | Payment confirmation idempotency (store `confirmPaid`) | **PASS** |
| E7 | Coach Desk move booking | **PASS** |
| E8 | Coach Desk cash collect on unpaid manual booking | **FAIL** |
| E9 | Failed reschedule preserves credits | **PASS** |
| E10 | Membership plans Hitting / Fielding / Both | **PASS** |

※ E2 note: Postgres correctly had 2 active lessons; member portal `used`/`remaining`/`lessons` fields lagged at `1/3/1` immediately after book. Slot occupancy and credit-return paths (E1/S9/S10) are correct. Treat portal summary refresh as a soft follow-up, not the E8-class blocker.

### Not exercised live (covered by prior local suites / fail-closed design; no Prod risk)

| Workflow | Status | Notes |
| --- | --- | --- |
| Failed card payment creates no paid booking | **PASS (design + local)** | Checkout hold only; confirm requires paid PI |
| Failed DB transaction does not consume credits | **PASS (S10/E9 + store tx)** | Denied reschedule leaves credits unchanged |
| DB outage fails closed | **PASS (prior authoritative-read suites)** | Reads/writes return 503; no Blob capacity fallback when reads on |
| Paid-session reconciliation recovery | **PASS (Prod RO + Preview S11)** | Prod reconcile clean; writes-off defers unpaid mirrors |
| Attendance recording | **NOT RUN live** | Code path exists (`lib/recordAttendance` → PG when writes on); not smoke-tested this gate |
| Full browser Stripe card confirm + webhook delivery | **PARTIAL** | Session create (E5) + idempotent confirmPaid (S11/E6); no end-to-end webhook listener fire in this window |

---

## Unresolved blockers

### BLOCKER-1 — Coach Desk `collect_payment` does not collect Postgres manual bookings (E8)

**Symptom:** With Preview `BOOKING_WRITES_ENABLED=1`, coach `create_booking` (cash) inserts `source=manual` unpaid row into Preview Postgres. Immediate `collect_payment` returns:

`Booking not found (only cash/manual bookings can be collected here.)`

Response shape has **no `code` field** (matches Blob fallback branch), while the row is present and collectable via local `store.collectManualPayment` against the same Preview DB.

**Impact if activated in Production:** Coach Desk cash tracking / outstanding collection for new PG-authored manuals would fail silently toward Blob lookup → unpaid balances stuck / finance drift.

**Required before G4 PASS:** Fix Preview coach collect path so `bookingWritesEnabled()` consistently uses `dbCollectManualPayment`, redeploy Preview, re-run E8 to PASS. Do **not** enable Production writes until then.

---

## Phase 3 — Production activation plan (PREPARE ONLY — do not execute)

### 1) Exact flags and deployment order

**Keep today (current safe state):**
- Production: `BOOKING_STORE=postgres`, `BOOKING_READS_ENABLED=1`, `BOOKING_ALLOW_NON_PREVIEW=1`
- Production: `BOOKING_WRITES_ENABLED` unset/`0`, `CAPACITY_WRITES_ENABLED` unset/`0`
- Production: `BOOKING_DUAL_WRITE_BLOB` must remain unset/`0`
- Checkout remains paused

**Only after BLOCKER-1 fixed + your explicit approval, in this order:**

1. Final Production RO preflight (re-run `scripts/g4-prod-preflight.mjs`) — must PASS.  
2. Neon Production backup/snapshot + export Blob `lessons.json` / `manual-bookings.json` / `holds.json` / `members.json` / `finance.json` hashes.  
3. Deploy code containing the E8 fix to Production **with writes still off**.  
4. Set Production `BOOKING_WRITES_ENABLED=1` (Secret). **Do not** set `BOOKING_DUAL_WRITE_BLOB`.  
5. Redeploy Production. Verify `/api/booking-db` → `writes=true`, `reads=true`, `dual_write_blob=false`.  
6. Unpause customer checkout by either:  
   - **Preferred code fix:** `api/checkout.js` allows traffic when `bookingWritesEnabled() || capacityWritesEnabled()` (so Blob CAS can stay off), **or**  
   - Set `CAPACITY_WRITES_ENABLED=1` only after confirming hold/lesson/manual writers are fully fenced by booking-writes branches (no Blob capacity mutate).  
7. Smoke one controlled live booking (below).  
8. Remove temporary maintenance endpoints/secrets after soak.

### 2) Pre-activation backups and consistency checks

- Neon point-in-time / branch snapshot of Production booking DB  
- Blob snapshot copy of lessons/manual/holds/members/finance + SHA256  
- Reconcile Blob↔PG: missing=0, slot_mismatches=0, credit audit=0  
- Stripe RO reconcile: openAlerts=0  
- Confirm Oct 15 5 PM (and any near-term full slots) still correct under PG reads

### 3) Fence / retire legacy Blob writes

- Never enable `BOOKING_DUAL_WRITE_BLOB`  
- With booking writes on: coach/member/confirm/holds must take PG early-return paths only  
- Keep `CAPACITY_WRITES_ENABLED=0` if checkout is patched to honor booking writes; otherwise enable capacity writes only with proof that `mutateLessons` / Blob hold CAS are unreachable for booking flows  
- After soak: leave Blob files as cold backup; stop treating them as capacity authority

### 4) Protect paid sessions and holds during activation

- Keep checkout paused until step 6  
- Drain/expire open Checkout sessions before cutover  
- After writes on: holds go to Postgres (`dbReserveHold`); confirm releases via `dbReleaseHold`  
- Run Stripe paid reconcile immediately post-cutover (writes on → can mirror eligible missing paid sessions)

### 5) Safe first live booking verification (no duplicate charges)

1. Coach Desk **cash** standard Hitting on a disposable future open slot (no Stripe).  
2. Cancel it; confirm slot clears in PG + Coach Desk.  
3. One real Stripe card booking for a low-risk open slot (or coach-assisted), watch webhook/confirm → **exactly one** PG row; hold released; confirmation email accurate.  
4. Re-run paid reconcile → already=1 for that PI, alerts=0.  
5. Only then advertise checkout reopen.

### 6) Monitoring

Watch for:
- Checkout 5xx / `schedule_unavailable` spikes  
- Overbooking (`slot_unavailable` floods + PG active seats > 2)  
- Membership credit mismatches (`credit_audit`)  
- Stripe webhook failures / reconcile `alerts` / `failed`  
- Neon connection errors / booking API 503 fail-closed  
- Coach collect failures (E8 class)

### 7) Stop conditions and rollback (no silent Blob revert)

**Stop / freeze checkout if:**
- Any overbook (active seats > capacity or mixed focus in one hour)  
- Duplicate booking for one payment intent  
- Credit ledger mismatch on a live membership  
- Stripe reconcile opens alerts that cannot be cleared  
- DB outage causing mass 503 during paid confirm

**Rollback:**
1. Set Production `BOOKING_WRITES_ENABLED=0` immediately; keep `BOOKING_READS_ENABLED=1`.  
2. Keep `CAPACITY_WRITES_ENABLED=0` and checkout paused.  
3. **Do not** re-enable Blob capacity writes as a silent fallback.  
4. Reconcile PG vs Stripe paid sessions; manually repair via controlled confirm/reconcile tools.  
5. Only after forensic PASS consider a new write enablement.

### 8) Remove temporary maintenance endpoints/secrets after migration

After soak + checkout stable:
- Remove or auth-harden `api/maintenance-privacy-fix*.js` and related secrets (`MAINTENANCE_*`, one-time execute confirms)  
- Delete Preview-only write smoke secrets if any temporary ones were added  
- Rotate any one-time maintenance credentials used during G2 privacy fix  
- Keep booking DB credentials in Vercel Secrets; no plaintext in repo

---

## Remaining steps before reopening AP Academy bookings

1. **Fix BLOCKER-1** (Coach `collect_payment` PG path) on Preview; E8 must PASS.  
2. Optional soft fix: member portal credit/lesson summary refresh after portal book (E2 observation).  
3. Optional hardening: `api/checkout.js` gate on `bookingWritesEnabled()` so Production can reopen checkout without enabling Blob `CAPACITY_WRITES`.  
4. Your **explicit approval** for Production write enablement (separate from this G4 readiness report).  
5. Execute Phase 3 sequence above (backup → deploy fix → enable `BOOKING_WRITES` → controlled smokes → then checkout unpause).  
6. Post-cutover: Stripe reconcile, credit audit, slot reconcile, remove maintenance endpoints.

---

## Safety checklist (this gate)

| Requirement | Honored |
| --- | --- |
| No Production `BOOKING_WRITES_ENABLED` | Yes (still false) |
| No Production `CAPACITY_WRITES_ENABLED` | Yes (checkout paused) |
| No Production checkout reopen | Yes |
| No Production Stripe charges | Yes |
| No Production booking/credit/finance edits | Yes |
| Preview ↔ Production isolated | Yes |
| Preview writes disabled after tests | Yes (`c6x4hr4vo`, writes=false) |
| No Blob CAS probe | Yes |
| No merge/deploy of Production write activation | Yes |

---

## STOP

G4 readiness validation is complete. **Awaiting your explicit approval** before enabling any Production write path (`BOOKING_WRITES_ENABLED`, `CAPACITY_WRITES_ENABLED`, or checkout reopen).
