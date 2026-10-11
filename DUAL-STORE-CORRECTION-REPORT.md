# Dual-store correction report

**Branch:** `cursor/dual-store-capacity-f621` (PR #63)  
**Note:** PR #62 was already merged with the unsupported in-place private-on-public approach; this correction ships as a follow-up PR.  
**Status:** Implemented + automated tests green. **Not merged. Not production-migrated.**

---

## A. Architecture changes

Replaced invalid in-place public→private Blob conversion with a **supported dual-store** design:

| Store | Token | Files |
|-------|-------|-------|
| Existing **public** | `BLOB_READ_WRITE_TOKEN` + `AVAILABILITY_URL` | availability, settings, members, finance, followups, coach-status, etc. |
| New **private** | `PRIVATE_BLOB_READ_WRITE_TOKEN` | `holds.json`, `lessons.json`, `manual-bookings.json`, cutover marker, backups |

- Capacity reads use `get(..., { access: "private", useCache: false, token })` for origin-fresh ETags.
- Strict CAS: **no** unconditional overwrite after failed `ifMatch`.
- No automatic migration on booking reads.
- Pre-cutover: if public still has reservations and private file is missing → **unreachable** (fail closed).
- Explicit migration via `lib/capacityMigration.js` + coach API `api/capacity-migrate.js`.
- Preview isolation: reject when public/private token store ids match (unless `CAPACITY_ALLOW_SHARED_STORE=1`).

SDK confirmation: `@vercel/blob` accepts per-call `token` on `get` / `put` / `head`.

---

## B. Files modified

- `lib/store.js` — dual-store routing, cutover marker, isolation, CAS hardening
- `lib/capacityMigration.js` — plan / migrate / rollback
- `api/capacity-migrate.js` — coach-only migration API
- `api/checkout.js` — fail closed when capacity store missing/paused
- `test/dualStore.test.js` — new
- `test/holdsOriginRead.test.js` — updated
- `test/store.test.js` — updated for public vs capacity
- `test/bookings.test.js` — private memory seed for voids
- `test/membershipCapacityApi.test.js` — private memory seed
- `CAPACITY-DUAL-STORE.md` — operator procedure
- `DUAL-STORE-CORRECTION-REPORT.md` — this report
- Removed unsafe auto `migratePublicOriginBlob` path

---

## C. Environment variables required

| Variable | Purpose |
|----------|---------|
| `BLOB_READ_WRITE_TOKEN` | Existing public store (unchanged) |
| `AVAILABILITY_URL` | Public availability URL (unchanged) |
| **`PRIVATE_BLOB_READ_WRITE_TOKEN`** | **New** private store RW token |
| `CAPACITY_BLOB_CUTOVER=1` | Optional hard switch after verified migration |
| `CAPACITY_MIGRATION_PAUSE=1` | Pause booking capacity writes during cutover |
| `CAPACITY_ALLOW_SHARED_STORE=1` | Opt-in only; allows preview to share store id (discouraged) |

### What you must do in Vercel

1. Create a **new Private** Blob store.
2. Set `PRIVATE_BLOB_READ_WRITE_TOKEN` on Preview (disposable staging store) and later Production (dedicated private store).
3. Keep existing public store env vars as-is.
4. Use **Stripe test mode** on Preview.
5. Do **not** run migration against production until staging cutover is verified.

---

## D. Migration procedure

Documented in `CAPACITY-DUAL-STORE.md`. Summary:

1. Set `CAPACITY_MIGRATION_PAUSE=1`
2. `GET /api/capacity-migrate?key=COACH_PASS` (plan)
3. `POST` migrate with `confirm: "MIGRATE-CAPACITY"`
4. Verify counts/ids
5. Set `CAPACITY_BLOB_CUTOVER=1`
6. Smoke test
7. Clear pause

Rollback: pause → `confirm: "ROLLBACK-CAPACITY"` → unset cutover env → keep pause until public authoritative.

**Safe cutover requires temporarily pausing booking operations** (`CAPACITY_MIGRATION_PAUSE=1`).

**Not executed against production in this work.**

---

## E. Data preservation guarantees and limitations

**Guarantees (by design):**
- No auto rewrite of live public capacity files on read
- Migration copies exact public snapshot → private, then verifies byte equality + id/count checks
- Backups written under `backup/capacity-<timestamp>/` in the private store
- Pre-cutover refuses inventing empty private schedules when public has rows
- CAS conflicts reload/retry; no silent overwrite fallthrough on capacity writes

**Limitations:**
- Real Vercel Blob migration not executed here (no disposable store credentials in this VM)
- Until private token + cutover are configured, deployed checkout fail-closes holds (safe, but bookings paused until setup)
- Public capacity files are left as cold backup; operator must not delete them early

---

## F. Preview isolation

- Code rejects Preview when private token store id equals public store id
- Operator must attach a **separate disposable private store** to Preview
- Live preview checkout tests **not run** (SSO + no staging private store in this environment)

---

## G. Checkout test results

**Automated (memory dual-store):** `npm test` → **238 passed**, **1 skipped**, **0 failed**

Includes: token selection, private access, missing private config, CAS/412 conflict, migration verify, incomplete migration, rollback, pause, hold create/release, concurrency suite, checkout pricing, membership capacity.

**Live preview Stripe checkouts ($80/$100/$280/$360/deposit):** **not run** — requires your Vercel private store + Stripe test mode after env setup.

---

## H. Remaining risks

1. Operator mis-points Preview `PRIVATE_BLOB_READ_WRITE_TOKEN` at production private store
2. Cutover without pause could race with live checkouts
3. OIDC/`BLOB_STORE_ID` on Vercel could theoretically override token routing if misconfigured — migration API/docs use explicit RW tokens; verify dashboard wiring
4. Historical public capacity files remain until manually retired after stability window

---

## I. Git commit and PR status

- Commit on `cursor/stage2-booking-rules-f621`
- PR #62 updated
- **Not merged / not production deployed / no production migration executed**

---

## J. Ready for controlled staging test?

**YES — ready for controlled staging**, after you:

1. Create a disposable **private** Blob store  
2. Set Preview `PRIVATE_BLOB_READ_WRITE_TOKEN`  
3. Set Stripe **test** keys on Preview  
4. Run pause → migrate → cutover → smoke on Preview only  

**Not ready for production cutover** until staging smoke passes.
