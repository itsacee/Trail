# Manual-only privacy fix — Production dry-run procedure (ZERO writes)

**Status:** Implementation + local tests only. **No deploy. No Production write. No env flags.**  
**Scope:** Cooper `mb_muvxcb7c_1656bd` only. Never write `lessons.json`. Never touch original once-lock.

---

## Proposed hashes (from partial-failure investigation)

| Object | Role | SHA-256 |
| --- | --- | --- |
| `lessons.json` | Sibling pin (Dylan already corrected; **read-only**) | `1b9a49724f00d5de7028fa0f20285eec5b2876673031284ba4b603ce6c549dfe` |
| `manual-bookings.json` | Before (must be unchanged) | `8ab78033204966f117563e22b344986470a42f08b8fbe32e7df2bb43dd92180a` |
| `manual-bookings.json` | After (only Cooper `privacy: "standard"`) | `4cb32a9e0a82ffb58f52a146a56ca8a947e2d3bd469f6ad09b0493999ba2e46f` |

**Permitted field diff:** on booking `mb_muvxcb7c_1656bd` only, add/set `privacy: "standard"`. Every other field and every other record unchanged. `lessons.json` byte-identical before and after.

**Slot outcome after completion:** Oct 15 5:00 PM Mustang — two Standard Hitting + Fielding (Both) bookings, Full 2/2, not Private.

---

## Authentication & authorization safeguards

| Gate | Requirement |
| --- | --- |
| Feature flag | `MAINTENANCE_PRIVACY_FIX_MANUAL=1` (default unset → API **404**) |
| Environment | `VERCEL_ENV=production` (`MAINTENANCE_ALLOW_TEST` must be unset in Prod) |
| Bearer | `Authorization: Bearer <MAINTENANCE_PRIVACY_FIX_MANUAL_SECRET>` (≥24 chars, distinct from original secret) |
| Coach | Body `key` = Production `COACH_PASS` |
| Confirm (execute) | Exact phrase `PRIVACY-FIX-OCT15-2026-MANUAL-ONLY` |
| Confirm (restore) | Exact phrase `PRIVACY-FIX-MANUAL-RESTORE` |
| Write freeze | `CAPACITY_WRITES_ENABLED` and `BOOKING_WRITES_ENABLED` must **not** be `1` |
| Hash pins | Live lessons SHA = Dylan after-SHA; live manual SHA = before-SHA; execute body must echo both |
| Once-lock | Create-only `maintenance/privacy-fix-oct15-2026-manual.lock` (independent; original lock left held) |
| Backup | Create-only `backup/privacy-fix-manual/<runId>/manual-bookings.json` before put |
| Verify | Origin bookend + SDK get; **no public CDN fallback**; bounded retries; `verify_pending_stale_read` ≠ put failure |

Original confirm phrase `PRIVACY-FIX-OCT15-2026-STANDARD` does **not** authorize this path.

---

## Deployment requirements (NOT authorized in this turn)

1. Merge/deploy code with **all maintenance flags unset** (endpoint 404).  
2. Separately authorize: configure `MAINTENANCE_PRIVACY_FIX_MANUAL` + secret (do not enable yet for smoke).  
3. Separately authorize: Production dry_run (below).  
4. Separately authorize: one execute with explicit one-time permission + confirmation phrase.

Do **not** delete or reuse `maintenance/privacy-fix-oct15-2026.lock`. Do **not** resume G2B or reopen checkout. Do **not** run the discontinued CAS probe.

---

## Dry-run procedure (ZERO storage writes)

Prerequisites (read-only checks before calling):

1. Confirm Production write freeze still holds.  
2. Re-read origin (not CDN-only) `lessons.json` / `manual-bookings.json` SHAs; must match table above.  
3. Confirm original lock still held; manual lock **absent**.  
4. Confirm `MAINTENANCE_PRIVACY_FIX_MANUAL` is configured for the dry_run window only after separate auth; this document does not enable it.

Request (after separate authorization to configure flags):

```http
POST /api/maintenance-privacy-fix-manual
Authorization: Bearer <MANUAL_SECRET>
Content-Type: application/json

{
  "key": "<COACH_PASS>",
  "mode": "dry_run"
}
```

**Pass criteria:**

- HTTP 200, `code: "dry_run_ok"`, `writes: "none"`, `state: "dry_run"`  
- `before.lessons_sha256` / `before.manual_sha256` match pins above  
- `expected_after.manual_sha256` = after pin; `expected_after.lessons_sha256` = lessons pin (unchanged)  
- `occupancy_expected`: `standard_count=2`, `private_count=0`, `full=true`, `seats_used=2`  
- Blob inventory unchanged: no new backup, no new manual lock, `lessons.json` / `manual-bookings.json` SHAs unchanged  
- Re-fetch both capacity files after dry_run; SHAs identical to before

**Fail → STOP.** Do not execute.

---

## Execute (explicitly unauthorized here)

Requires a **new** human message with: verified freeze, strong authorization, exact confirm phrase, and one-time permission. Handler will refuse without them. On `verify_pending_stale_read` after put OK: **do not auto-retry**; re-read later; never restore lessons.
