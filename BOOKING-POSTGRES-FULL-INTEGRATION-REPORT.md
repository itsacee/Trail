# Booking PostgreSQL Full Integration Report

**Branch:** `cursor/booking-postgres-full-f621`  
**Base:** `cursor/two-instagram-clips-f621` (stack continues from postgres-reads)  
**Date:** 2026-10-14  
**Flags on Preview today (unchanged by this work):** `BOOKING_READS_ENABLED=1`, `BOOKING_WRITES_ENABLED=0`  
**This PR does not enable writes, create payments, mutate Preview Blob, or deploy Production.**

---

## Verdict

| Phase | Result | Notes |
| --- | --- | --- |
| Phase 1 — complete read integration | **PASS** (code + local tests) | Member portal, membership capacity, reminders, member-links, Coach Desk outstanding, record-lesson summaries all use authoritative Postgres reads with fail-closed behavior. Dual-period Blob bridge only while writes remain off. |
| Phase 2 — prepare write integration | **PASS** (code + local tests; writes still OFF) | Standard/Private drop-ins, memberships, Coach Desk book/cancel/move, member book/cancel/reschedule, confirm/webhook mirror, attendance recording, hold reserve/release are wired to `BookingStore` behind `BOOKING_WRITES_ENABLED`. |
| Preview live re-validation | **BLOCKED / NOT RUN** | No Preview redeploy or env change in this turn. Prior live PASS covered slots + Coach Desk only. |
| Enable Preview booking writes | **BLOCKED** | Requires explicit operator approval after Preview redeploy + reconcile + write smoke tests. |

---

## Endpoint coverage matrix

Legend: **PG** = Postgres-authoritative when `BOOKING_READS_ENABLED=1`. **PG-W** = Postgres write path when `BOOKING_WRITES_ENABLED=1` (still disabled). **Blob** = remains on Blob / existing store by design. **Bridge** = while reads on + writes off, Blob-only rows overlay Postgres (never when Postgres is down).

| Surface / endpoint | Read source (reads=1) | Write path (writes=1) | Fail-closed? | Status |
| --- | --- | --- | --- | --- |
| `GET /api/slots` / `bookedTimes` | **PG** occupancy (+ Blob/Stripe holds while writes off) | n/a | Yes | PASS (prior Preview + local) |
| `GET /api/coach` dashboard / schedule | **PG** via `fetchBookings` | n/a | Yes | PASS (prior Preview + local) |
| Coach outstanding balances (cash rows) | **PG** manual via `loadAuthoritativeManual` | n/a | Yes (no Blob fallback) | PASS (code + local) |
| Coach `create_booking` | capacity via `bookedTimes` → **PG** | **PG-W** `dbManualBook` | Yes | Wired; writes OFF |
| Coach `cancel_booking` | schedule via `fetchBookings` → **PG** | **PG-W** `dbCancelBooking` | Yes | Wired; writes OFF |
| Coach `move_booking` | capacity via `bookedTimes` → **PG**; peer snapshot authoritative | **PG-W** `dbReschedule` | Yes | Wired; writes OFF |
| `POST /api/cash-book` | capacity via `bookedTimes` → **PG** | **PG-W** `dbManualBook` | Yes | Wired; writes OFF |
| `GET/POST /api/member` portal | **PG** (+ Bridge) via `loadAuthoritativeBookingState` | **PG-W** `dbMemberBook` / `dbCancelBooking` / `dbReschedule` | Yes (503) | PASS (code + local) |
| `GET /api/membership-capacity` | **PG** lessons for credit counting | n/a | Yes (spotsAvailable=0) | PASS (code + local) |
| `GET /api/reminders` | **PG** lessons | n/a | Yes (503, no send) | PASS (code + local) |
| `GET /api/member-links` | **PG** lessons | n/a | Yes (503) | PASS (code + local) |
| `POST /api/record-lesson` + attendance | **PG** lessons for summaries; capacity **PG-W** | **PG-W** `dbMemberBook` | Yes | Wired; writes OFF |
| Confirm / Stripe webhook mirror | n/a | **PG-W** `dbConfirmPaid` + hold release | Yes (503, no confirmation_sent) | Wired; writes OFF |
| Checkout holds (`placeHold` / `releaseHold`) | holds: **Bridge** while writes off | **PG-W** `dbReserveHold` / `dbReleaseHold` | Hold soft-fail historic; confirm fail-closed | Writes OFF → Blob holds |
| `GET /api/calendar`, `GET /api/schedule` | **PG** via `fetchBookings` | n/a | Yes | Inherit Coach Desk path |
| `POST /api/booking-db` import/reconcile | Blob source of truth for import only | admin import (idempotent) | Preview-guarded | Ops tool (not customer path) |
| Member profiles / packages (`membersStore`) | **Blob** (by design) | **Blob** | n/a | Unchanged |
| Finance ledger (`finance.js`) | **Blob** (by design) | **Blob** | n/a | Unchanged |
| Settings / coach status / site pause | existing stores | existing stores | n/a | Unchanged |

### Still on Blob for capacity / booking state (while writes=0)

These are **expected** during the dual-period window (reads on, writes off):

1. **Checkout hold writes** → Blob `holds.json` (+ open Stripe Checkout sessions).
2. **Paid confirm / webhook mirror** → Blob `lessons.json` (Postgres confirm path exists but gated).
3. **Member book / cancel / reschedule mutations** → Blob mutators (Postgres path gated).
4. **Coach / cash-book mutations** → Blob mutators (Postgres path gated).
5. **Blob bridge overlays** for brand-new Blob rows not yet in Postgres (read visibility only).

When `BOOKING_WRITES_ENABLED=1`, items 1–4 move to Postgres and the Blob bridge is disabled for authoritative reads.

---

## Booking rules coverage (local `pg-mem` / BookingStore)

| Rule | Test evidence | Result |
| --- | --- | --- |
| Standard Hitting: 2 matching-focus / hour | `bookingStore.test.js` concurrent admits | PASS |
| Standard Fielding: same | capacity helper + prior rules suite | PASS |
| Standard Hitting+Fielding: 2 matching-focus / hour | `standard Hitting+Fielding shares of 2…` | PASS |
| Drop-ins + memberships share capacity | Both types in same-hour tests | PASS |
| Different focuses cannot share hour | `different focuses cannot share an hour` | PASS |
| Private exclusivity (all focuses) | `private lesson reserves entire hour` | PASS |
| Membership credits + failed reschedule preserves original | credit/reschedule tests + simultaneous reschedule | PASS |
| Stripe confirm idempotent retries | `payment retries are idempotent` | PASS |
| Manual / cash book capacity + idempotency | `manualBook enforces capacity…` | PASS |
| Write facade disabled by default | `db write facade stays disabled…` | PASS |
| Authoritative reads fail closed | `bookingAuthoritativeReads.test.js` + `bookingReads.test.js` | PASS |
| Dual-period Blob bridge | bridge overlays + skip-bridge when writes on | PASS |

Local suites run this turn (clean of write flags):  
`bookingAuthoritativeReads`, `bookingReads`, `bookingStore`, `bookingBusinessRules`, `bookingPersistenceFix`, `membershipCapacity` → **all PASS**.

---

## What must happen before Preview booking writes can safely be enabled

1. **Merge / deploy this branch to Preview** (do not merge #68–#72 stack conflicts blindly; rebase as needed onto the current Preview booking stack).
2. **Keep `BOOKING_WRITES_ENABLED=0`** on first deploy; confirm live reads for:
   - Member portal `/api/member`
   - `/api/membership-capacity`
   - `/api/reminders` (dry=1)
   - `/api/member-links?format=json`
   - Coach Desk + slots (regression)
3. **Re-run Blob→Postgres reconcile** after any dual-period Blob bookings created since the last import.
4. **Operator approval** to set `BOOKING_WRITES_ENABLED=1` on Preview only (never Production; CAS probe remains disabled; no `BOOKING_DUAL_WRITE_BLOB`).
5. **Write smoke (Preview only, controlled):**
   - Coach Desk cash book → cancel
   - Member membership book → reschedule fail path → cancel/credit restore
   - Confirm/webhook idempotent retry (no new real charges if avoidable; use existing test fixtures / dry paths)
   - Concurrent seat race on a standard hour
6. Only after Preview write soak: plan Production migration separately (out of scope here).

---

## Restrictions honored

- Did **not** set `BOOKING_WRITES_ENABLED=1`
- Did **not** create payments or bookings in Preview/Production
- Did **not** modify Preview Blob records or Production data
- Did **not** merge PRs #68–#72
- Did **not** deploy Production
- Did **not** enable the CAS probe
- Did **not** change database credentials / Preview env without approval
