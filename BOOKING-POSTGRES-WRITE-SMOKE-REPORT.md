# Preview PostgreSQL write smoke S1–S12 — results

**Date:** 2026-10-14  
**Branch:** `cursor/booking-postgres-full-f621`  
**Write window deploy:** `dpl` / `apacademywebsite-m4sxs94da-…` @ writes=`true`  
**Post-test deploy:** `apacademywebsite-r6shmdk6j-…` with **`BOOKING_WRITES_ENABLED=0`**, **`BOOKING_READS_ENABLED=1`**  
**DB:** Preview Neon only (`ep-polished-moon-b7cbl2y0…` / `withered-mud-40468222`)

---

## Overall: **STOPPED — S9 FAIL** (S1–S8 PASS)

Per authorization, testing stopped at the first failure. No corrections applied after S9. Writes have been disabled again; reads remain on.

| Step | Result |
| --- | --- |
| Pre-write reconcile | **PASS** — blob 4 / db 4 / mismatches 0 |
| Enable writes (Preview branch only) | **PASS** — status `writes=true`, `reads=true`, `vercel_env=preview` |
| S1–S8 | **PASS** |
| S9 member reschedule success | **FAIL** — member portal auth token rejected |
| S10–S12 | **NOT RUN** (stop-on-fail) |
| Disable writes after stop | **DONE** — `writes=false`, `reads=true` |

---

## PASS details (S1–S8)

Disposable future dates only. Existing imported `pi_3UP*` Oct lessons were not edited.

| ID | Case | Outcome |
| --- | --- | --- |
| S1 | Standard Hitting — 2 then deny 3rd | **PASS** — `2026-12-07 6:00 PM`, pg=2, seats=2, `occupancy_source=postgres`, 3rd “slot already taken” |
| S2 | Standard Fielding — 2 then deny 3rd | **PASS** — `2026-12-07 7:00 PM`, pg=2 |
| S3 | Standard Both — 2 matching; Hitting denied | **PASS** — `2026-12-14 6:00 PM`, focuses=`Both,Both` |
| S4 | Private Hitting exclusive | **PASS** — `2026-12-14 7:00 PM`, pg=1, `privacy=private` |
| S5 | Private Fielding exclusive | **PASS** — `2026-12-21 6:00 PM`, pg=1 |
| S6 | Private Both exclusive | **PASS** — `2026-12-21 7:00 PM`, pg=1 |
| S7 | Mixed drop-in + membership | **PASS** — `2026-12-28 6:00 PM`, types=`membership,single`, 3rd denied |
| S8 | Coach cash book + cancel | **PASS** — created `mb_mv8e7d1u_rbyz4m`, cancel ok, slot cleared |

Capacity outcomes were verified against **Postgres** (`bookings` active rows) and **`/api/slots`** (`occupancy_source=postgres`). Coach Desk create/cancel used the live Preview API with writes on.

---

## FAIL — S9 (stopped here)

**Intent:** Cash membership on `smoke.resched.member@example.com` with lesson `2027-01-04 6:00 PM`, then member-portal reschedule to `2027-01-05 6:00 PM`.

**Observed:**
- Coach membership create: **ok** (`memOk=true`)
- `GET/POST /api/member` with signed `k` token: **`Please sign in with the email on your membership.`**
- Move not attempted successfully; original lesson remained at old slot (`old=1`, `atOpen=0`)

**Likely cause:** token HMAC secret mismatch. `signMemberToken` uses `MEMBER_SECRET || COACH_PASS || STRIPE_SECRET_KEY`. Under `vercel env run`, secret values are pulled as `[SENSITIVE]` placeholders into the process env, so the locally signed token did not match Preview’s real `COACH_PASS`, while Coach Desk still accepted the explicitly passed default coach key.

**Not a Postgres capacity failure.** Membership row was created; portal auth for the smoke harness failed.

**S10–S12 not executed** after this stop.

---

## Cleanup / data integrity

- Smoke bookings cancelled via Coach Desk `cancel_booking` where IDs were tracked.
- Additional PG cleanup targeted only `email LIKE 'smoke.%@example.com'` (never imported `pi_3UP*`).
- Writes disabled; reads kept on.
- Pre-write imported set remains the authoritative Oct lessons (reconcile was clean before enable).

---

## Remaining / next approval needed

To finish S9–S12 without guessing secrets:

1. Re-enable Preview writes (`BOOKING_WRITES_ENABLED=1`) on this branch only.  
2. Fix smoke harness so member tokens are signed with the **same secret Preview uses** (pass coach pass into signer; do not use `[SENSITIVE]` placeholders from `env run`).  
3. Re-run **S9 → S10 → S11 → S12** only (or full suite if preferred).  
4. Disable writes again unless further approval.

I have **not** applied the harness fix yet, per “report the failure before attempting corrections.”

---

## Safety checklist

| Requirement | Honored |
| --- | --- |
| Preview DB only | Yes |
| No edits to imported Oct bookings | Yes |
| No Blob file modifications | Yes |
| No Production touch | Yes |
| No PR merges / Production deploy | Yes |
| CAS probe disabled | Yes |
| Reads kept on after rollback of writes | Yes |
| Writes disabled after stop | Yes |
