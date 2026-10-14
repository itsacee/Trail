# Writer-fencing matrix — `lessons.json` / `manual-bookings.json`

**Scope:** Production one-time privacy correction (`lsn_mv3zgqy2_zos8on`, `mb_muvxcb7c_1656bd`)  
**Branch:** `cursor/privacy-fix-maintenance-f621`  
**Status:** Implementation + local tests only. No deploy. No Production env/Blob changes.

## Required write freeze (entire maintenance window)

| Control | Required state | How verified |
| --- | --- | --- |
| `CAPACITY_WRITES_ENABLED` | **unset / not `1`** | Production env audit + handler gate `write_freeze_required` |
| `BOOKING_WRITES_ENABLED` | **unset / not `1`** | Handler gate |
| Checkout / cash-book | Remain 503 (`capacityWritesPaused`) | Live probe before dry_run |
| Maintenance flag | `MAINTENANCE_PRIVACY_FIX` unset until owner enables for the window | Default 404 |
| G2B / Postgres writes | Remain off | Separate gate; not part of this handler |

Handler **refuses execute** if capacity or booking writes are enabled. Normal CAS writers stay paused; this handler is a separate privileged path that does **not** reopen `CAPACITY_WRITES_ENABLED`.

---

## Production writers (audit)

| Writer | Path / entry | Files touched | Fence while `CAPACITY_WRITES_ENABLED` unset | Can fence? | Notes |
| --- | --- | --- | --- | --- | --- |
| Member portal book | `api/member.js` → `mutateLessons` | `lessons.json` | CAS returns `{ paused: true }` — **cannot commit** | Yes | Also blocked if checkout path unused |
| Member cancel / move | `api/member.js` → `mutateLessons` / `mutateManualBookings` | both | Paused CAS | Yes | |
| Coach Desk book / move / cancel / collect | `api/coach.js` → `mutateLessons` / `mutateManualBookings` | both | Paused CAS | Yes | Coach UI may appear to error; no Blob commit |
| Cash book | `api/cash-book.js` → early pause + `mutateManualBookings` | `manual-bookings.json` | Explicit 503 + paused CAS | Yes | |
| Stripe checkout hold | `api/checkout.js` → `placeHold` | `holds.json` | Explicit 503 before hold | Yes | Does not write lessons/manual when paused |
| Stripe confirm mirror | `api/confirm.js` → `mutateLessons` / `upsertStripeLessons` | `lessons.json` | Fail-closed / paused CAS | Yes | Webhook → `deliverConfirmation` same path |
| Stripe webhook | `api/webhook.js` → `deliverConfirmation` | `lessons.json` (via confirm) | Same as confirm | Yes | Paid intents do not get schedule mirror while paused |
| Record attendance | `api/record-lesson.js` → `recordMemberLessons` → `mutateLessons` | `lessons.json` | Paused CAS | Yes | Admin/coach path |
| Capacity migration | `api/capacity-migrate.js` | holds/lessons/manual | Separate coach + pause confirm; not used in this op | Yes | Do not run during privacy fix |
| Reconcile paid | `api/reconcile-paid.js` | (Stripe / confirm helpers) | Does not bypass capacity pause for Blob capacity files | Yes | Audit: no direct lessons/manual CAS in this file |
| Reminders cron | `api/reminders.js` (daily cron) | `followups.json` / Stripe metadata | **Does not write** lessons/manual | N/A (read + followups) | Safe during freeze |
| Instagram / apply / pricing / slots / calendar / schedule | read-only or non-capacity | — | No capacity writes | N/A | |
| Postgres booking store | `lib/bookingDb/*` | Neon | Off when `BOOKING_*` unset | Yes | G2B not resumed |
| Import-from-Blob scripts | `lib/bookingDb/importFromBlob.js` | Neon (reads Blob) | Operator-triggered; **do not run** | Procedural | Not an always-on writer |
| Older Vercel deployments | Prior aliases still serving | same APIs | Same env vars on Production project | Yes if env shared | Confirm no preview with Production Blob RW + writes enabled |
| Direct Blob console / CLI | Human / agent with token | any | **Cannot be fenced in code** | **No** | Rely on process: no manual Blob UI edits; agent has no Prod RW token |
| CDN / public GET | Readers | none (read) | N/A | N/A | ABA risk mitigated by origin head-bookend + content SHA pins |
| **This maintenance handler** | `api/maintenance-privacy-fix.js` | both (allowlist only) | Sole intended writer; create-only once-lock | Self | Disabled by default; remove after use |

### Writers that cannot be fully fenced in software

1. **Human / CLI / dashboard Blob puts** using Production `BLOB_READ_WRITE_TOKEN` — out-of-band. Mitigation: operational freeze, single operator, once-lock, hash pins, post-verify.
2. **Any forgotten deployment** that still has an old build **and** a distinct env with `CAPACITY_WRITES_ENABLED=1` pointing at the same public store — mitigate by confirming Production project env and that no alternate alias uses write-enabled config against `apacademy-blob`.
3. **Vercel platform / store-side operations** — not applicable in normal ops; treat as out-of-band.

---

## Maintenance safety controls (implemented)

| # | Requirement | Implementation |
| --- | --- | --- |
| 1 | Writer audit + unfenceable docs | This matrix |
| 2 | Verified write freeze | `assertWriteFreeze` + live 503 probes (ops) |
| 3 | Strict ID allowlist + expected source hashes | Hard-coded IDs; execute requires dry_run SHAs |
| 4 | Fresh origin reads + full-doc verify | Head-bookend read; identity + patch purity |
| 5 | Recoverable immutable backups | Create-only `backup/privacy-fix/<runId>/…` |
| 6 | Atomic one-time lock | Create-only `maintenance/privacy-fix-oct15-2026.lock` |
| 7 | Two-file recoverable partial states | Explicit `partial_*` states + recovery text |
| 8 | Never auto-overwrite sibling file | Serial writes; no compensate path |
| 9 | Owner-approved restore + sibling drift check | `mode=restore` + `PRIVACY-FIX-RESTORE` + other SHA |
| 10 | Post-fix occupancy Standard Both Full 2/2 | `evaluateTargetSlotOccupancy` |
| 11 | No secrets/etags/PII in logs/responses | Fingerprints + `sanitizeMaintenanceReport` |
| 12 | Disabled by default; removable | `MAINTENANCE_PRIVACY_FIX≠1` → 404; delete file after |

---

## Concise deployment / dry-run plan (NOT authorized yet)

**Do not execute until owner approval after PR review.**

1. Merge/deploy this PR to Production **with flags unset** (endpoint stays 404).
2. Owner sets temporary Sensitive env: `MAINTENANCE_PRIVACY_FIX=1`, `MAINTENANCE_PRIVACY_FIX_SECRET=<entropy≥24>`; leave `CAPACITY_WRITES_ENABLED` unset.
3. Re-verify freeze: checkout/cash-book 503; capacity writes unset.
4. Take fresh public backups of lessons/manual (+ holds/members/finance) to artifacts; record sha256.
5. `POST` `mode=dry_run` with Bearer + coach key → review fingerprints, before SHAs, occupancy_expected Full 2/2.
6. Owner approves execute with those exact `expected_*_sha256` values + confirm `PRIVACY-FIX-OCT15-2026-STANDARD`.
7. `POST` `mode=execute` → expect `execute_ok`, both privacy standard, occupancy Full 2/2.
8. On partial failure: **STOP**; do not auto-fix; owner-only `restore` after fresh sibling-hash verify.
9. Unset maintenance env vars; deploy follow-up PR deleting `api/maintenance-privacy-fix.js` (+ lib/tests if desired).
10. Separate approval required before G2B / checkout reopen.

**Explicitly out of scope for this PR stage:** deploy, Production env changes, Blob mutations, G2B, booking enablement.
