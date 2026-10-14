# Preview Postgres full read validation — PASS/FAIL

**Date:** 2026-10-14  
**PR:** [#73](https://github.com/itsacee/Trail/pull/73)  
**Branch / SHA:** `cursor/booking-postgres-full-f621` @ `9a71907f1544d034da6519f6d9eb8ceb563ec68d`  
**Preview deploy:** `dpl_5PkQx6sqdBoFkkgwBGx1yfHgzrBL`  
**URL:** `https://apacademywebsite-lnlbgbsi9-nubulahfr4-4891s-projects.vercel.app`  
**Flags (runtime `/api/booking-db?action=status`):** `mode=postgres`, `reads=true`, `writes=false`, `vercel_env=preview`, `dual_write_blob=false`

---

## Overall: **PASS**

Phase 1 read integration is live on Preview. Reconcile is clean. Writes remain disabled. No Blob mutations, no payments, no Production changes.

---

## Isolation

| Check | Result |
| --- | --- |
| Runtime flags | **PASS** — postgres / reads on / writes off |
| Preview Neon linkage | **PASS** — `BOOKING_DATABASE_URL` present on Preview only; host `ep-polished-moon-b7cbl2y0-pooler…neon.tech`; `BOOKING_NEON_PROJECT_ID=withered-mud-40468222` (same Preview project as prior cutover / `apacademy-booking-preview`) |
| Production `BOOKING_*` | **PASS** — none |
| Blob mutation | **PASS** — reconcile/import not used to write Blob; no Blob edits |
| Stripe checkouts / charges / new bookings | **PASS** — none created |
| CAS probe | **PASS** — still disabled (no Production/Preview probe enablement) |
| PR merges | **PASS** — #68–#73 not merged |

---

## Reconcile (read-only Blob → compare Postgres)

`POST /api/booking-db` `action=reconcile` (Blob read only):

| Metric | Value |
| --- | --- |
| `blob_active` | **4** |
| `db_active` | **4** |
| `missing_in_db` | **0** |
| `missing_in_blob` | **0** |
| `slot_mismatches` | **0** |
| Result | **PASS** — no import required |

### Imported / active booking set (all `origin=postgres` on Coach Desk)

| Lesson | Date / time | Focus | Privacy | Slots API |
| --- | --- | --- | --- | --- |
| `pi_3UPlSU…` | 2026-10-13 6:00 PM | Hitting | standard | postgres, shared hour |
| `pi_3UPlye…` | 2026-10-13 6:00 PM | Hitting | standard | same hour **seats=2**, exclusive (full) |
| `pi_3UPm0I…` | 2026-10-20 7:00 PM | Fielding | standard | postgres, seats=1 |
| `pi_3UQL0r…` | 2026-10-28 6:00 PM | Hitting | standard | postgres, seats=1 |

Empty future date `2026-11-18` → `occupancy_source=postgres`, `booked=[]` (**PASS**).

---

## API / workflow PASS/FAIL

| Surface | Expected source | Live result | Notes |
| --- | --- | --- | --- |
| Public `/api/slots` | Postgres occupancy | **PASS** | `occupancy_source=postgres`; sources `origin=postgres` |
| Coach Desk `/api/coach` schedule | Postgres | **PASS** | 4/4 sessions `origin=postgres` |
| Coach Desk cash outstanding | Postgres manual (+ membersStore balances) | **PASS** | `finance.outstanding=[]`, `outstandingCents=0` (no unpaid cash); path did not fail closed |
| `/api/schedule` | Postgres via `fetchBookings` | **PASS** | 4 sessions |
| `/api/membership-capacity` | Postgres lessons for credit counts | **PASS** | `limit=15`, `active=0`, `pending=0`, `spotsAvailable=15`, `available=true` (no 503) |
| `/api/reminders?dry=1` | Postgres lessons | **PASS** | `ok=true`, `dryRun=true`, no sends; uses `loadAuthoritativeLessons` |
| `/api/member-links?format=json` | Postgres lessons | **PASS** | `members=0`, `spotsAvailable=15` (no active Stripe memberships with credits) |
| `/api/member` portal | Postgres booking state when membership exists | **PASS*** | Auth works; `elijahalexander1502@…` and drop-in emails return **404 no active membership** (Stripe has 0 memberships). Lesson-list PG path not exercisable live without a membership; same read facade exercised by reminders/capacity (**PASS** locally + those APIs). |
| `/api/record-lesson` | Postgres summaries after write | **PASS** (gate) | Invalid POST rejected (`Name at least one player`) — no lessons written. Full summary path needs a membership write (blocked by writes=0 / no-create rule). |
| Book UI focuses | Hitting / Fielding / Both | **PASS** | All three present; `fieldingOnly=false` |
| Standard capacity (2 matching-focus) | Postgres | **PASS** | 10/13 Hitting hour seats=2 exclusive |
| Different focuses | Postgres | **PASS** (live data) | Hitting vs Fielding on different hours; unit tests cover same-hour conflict |
| Hitting + Fielding (`Both`) capacity | Postgres rules | **N/A live / PASS unit** | No `Both` row in current Preview set; `bookingStore` / business-rules tests cover share-of-2 |
| Private exclusivity | Postgres rules | **N/A live / PASS unit** | No private row in current Preview set; store tests cover exclusive hour |
| Local regression | — | **PASS** | 77/77 (`bookingAuthoritativeReads`, `bookingReads`, `bookingStore`, `bookingBusinessRules`, `bookingPersistenceFix`, `membershipCapacity`) |

\*Member portal lesson calendar: code + local fail-closed/bridge tests **PASS**; live membership lesson list blocked by zero active memberships in Preview Stripe (not a Postgres failure).

---

## Mixed-source / remaining Blob dependencies (before writes)

These remain by design while `BOOKING_WRITES_ENABLED=0`:

1. **Checkout holds** → Blob `holds.json` + open Stripe Checkout sessions (slots still merges these when writes off).
2. **Paid confirm / webhook mirror** → Blob `lessons.json` (Postgres `dbConfirmPaid` gated).
3. **Member / coach / cash mutations** → Blob mutators (Postgres write APIs gated).
4. **Dual-period Blob bridge** on reads → Blob-only rows overlay Postgres for visibility until writes cut over.

**Risk if writes were enabled without soak:** new holds/confirms would leave Blob while reads become Postgres-only (bridge off when writes=1) — availability could diverge until all mutation paths use Postgres. That is why writes stay off.

Profiles, package metadata, and finance remain on existing stores (not booking capacity).

---

## Remaining blockers before enabling Preview writes

1. **Operator approval** to set `BOOKING_WRITES_ENABLED=1` on Preview only (never Production; no `BOOKING_DUAL_WRITE_BLOB`).
2. **Optional:** create/use a Preview test membership (or seed) so member-portal lesson list can be live-checked immediately before/after write enable — not required for reconcile/slots/coach.
3. **Write smoke plan (Preview only, controlled):** Coach cash book→cancel; member book→failed reschedule→cancel/credit; confirm/webhook idempotent retry; concurrent standard-seat race.
4. **Re-reconcile** immediately before enabling writes if any dual-period Blob bookings appear.
5. Do **not** merge #68–#73 or deploy Production as part of write enablement.

---

## Explicitly not done

- `BOOKING_WRITES_ENABLED` remains **0**
- No Stripe checkouts, charges, customer bookings, or membership changes
- No Preview Blob record modifications
- No Production deploy / data / settings changes
- PRs #68–#73 not merged
- CAS probe still disabled
- Credentials not exposed
