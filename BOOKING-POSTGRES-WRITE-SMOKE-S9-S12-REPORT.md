# Preview PostgreSQL write smoke S9–S12 — results

**Date:** 2026-10-14  
**Branch:** `cursor/booking-postgres-full-f621`  
**Write-window deploy:** `apacademywebsite-7ubg2a4qu-…` @ `writes=true`, `reads=true` (cash membership period fix @ `9580cac`)  
**Post-test deploy:** `apacademywebsite-a6tdjbpfh-…` with **`BOOKING_WRITES_ENABLED=0`**, **`BOOKING_READS_ENABLED=1`**  
**DB:** Preview Neon only (`ep-polished-moon-b7cbl2y0…` / `withered-mud-40468222`)

---

## Overall: **ALL PASS (S9–S12)**

S1–S8 from the prior run remain **PASS**. This resume fixed Preview member-portal auth in the smoke harness and completed S9–S12 only.

| Step | Result |
| --- | --- |
| Preview DB isolation | **PASS** — host `ep-polished-moon-…neon.tech` |
| Imported Stripe actives intact | **PASS** — 4 × `pi_3UP*` / `pi_3UQ*` still `active` |
| No leftover active smoke bookings | **PASS** — `email LIKE 'smoke.%@example.com'` active/held = 0 |
| Enable writes (Preview branch only) | **PASS** — status `writes=true`, `reads=true`, `vercel_env=preview` |
| S9 member reschedule success | **PASS** |
| S10 failed reschedule preserves original | **PASS** |
| S11 confirmPaid idempotency | **PASS** |
| S12 concurrent final seat | **PASS** |
| Disable writes after tests | **DONE** — status `writes=false`, `reads=true` |

---

## Harness auth fix (authorized)

Root causes of the earlier S9 FAIL:

1. Local HMAC signing under `vercel env run` used `[SENSITIVE]` placeholders → token rejected.
2. Cash membership PG upsert used `periodStart` instead of `cashMembershipStart`/`End` → `fromCashMember` null (fixed in `9580cac`, already deployed).
3. Smoke POSTed `k` in JSON body; `tokenFromRequest` only reads `Authorization: Bearer` or `?k=` (same as `js/account.js`).
4. Lesson dates in 2027 were outside the ~30-day cash membership period → portal reschedule would be blocked even with valid auth.

**Fix:** Obtain Preview-signed tokens from `/api/member-links` (server-side `signMemberToken`; no secret export/print/rotate), call member APIs with **Bearer** auth, book inside the membership period, and parse `vercel curl` JSON past CLI noise. No `COACH_PASS` / `MEMBER_SECRET` hardcoded or logged.

---

## PASS details (S9–S12)

Disposable `smoke.%@example.com` records only. Imported Oct lessons untouched.

| ID | Case | Outcome |
| --- | --- | --- |
| S9 | Member reschedule success | **PASS** — membership `smoke.s9c.member@example.com` lesson `2026-10-19 6:00 PM` → `2026-10-21 6:00 PM`; `atOpen=1`, `atOld=0`; credits **unchanged** `used 1→1`, `remaining 3→3`; `occupancy_source=postgres` |
| S10 | Failed reschedule preserves original | **PASS** — move into private-blocked `2026-10-26 6:00 PM` denied (`Sorry — that time is full…`); original lesson still on `2026-10-21`; blocker `block=1`; credits **unchanged** `used 1→1`, `remaining 3→3` |
| S11 | Stripe Sandbox confirm/webhook idempotency | **PASS** — `confirmPaid` first `ok=true/idempotent=false`, retry `ok=true/idempotent=true`; exactly **1** active row for `smoke.s11.idem@example.com` on `2026-10-27 6:00 PM`; slots `occupancy_source=postgres`; no real Stripe charges |
| S12 | Concurrent final seat | **PASS** — seed filled 1 of 2 seats; two parallel coach creates → **wins=1**, **losses=1** (`That slot is already taken.`); Postgres active count **2** (seed + winner) |

---

## Cleanup / data integrity

- Smoke bookings cancelled via Coach Desk `cancel_booking` and PG cleanup restricted to `email LIKE 'smoke.%@example.com'`.
- Imported actives after tests:  
  `pi_3UPlSU…`, `pi_3UPlye…`, `pi_3UPm0I…`, `pi_3UQL0r…` — all **active**.
- Active smoke leftovers: **0**.
- No Preview Blob booking files edited; no Production touch; CAS probe remains disabled; no Blob capacity fallback.

---

## Writes disabled (proof)

| Check | Value |
| --- | --- |
| Branch secret update | `BOOKING_WRITES_ENABLED=0` on Preview `cursor/booking-postgres-full-f621` only |
| Post-test deploy | `https://apacademywebsite-a6tdjbpfh-nubulahfr4-4891s-projects.vercel.app` |
| `/api/booking-db?action=status` | `{"ok":true,"mode":"postgres","reads":true,"writes":false,"vercel_env":"preview","dual_write_blob":false}` |
| Reads kept on | `BOOKING_READS_ENABLED=1` unchanged |

---

## Safety checklist

| Requirement | Honored |
| --- | --- |
| Preview DB only | Yes |
| No edits to imported Oct bookings | Yes |
| No Blob file modifications for capacity/bookings | Yes |
| No Production touch | Yes |
| No PR merges / Production deploy | Yes |
| CAS probe disabled | Yes |
| Reads kept on after writes disabled | Yes |
| Writes disabled after S9–S12 | Yes |
| No tests beyond S9–S12 | Yes |
