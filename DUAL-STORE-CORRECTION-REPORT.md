# Dual-store correction — rebased successor (post PR #64 / #65)

**Base:** production `main` @ `26a6dab`  
**Supersedes:** PR #63 tip `9dc8a7e` (conflicted with hotfix main)  
**Status:** Preparation + disposable staging tests only — **not merged / not deployed**

## What changed vs original PR #63

| Topic | Original #63 | This successor |
|---|---|---|
| Base commit | `ff3dff2` (pre-hotfix) | `26a6dab` (#64+#65) |
| Pre-cutover capacity reads | Fail closed / unreachable if public has rows | **Public reads preserved** (`withSafeConditional`) |
| Write pause | `CAPACITY_MIGRATION_PAUSE` only | **`CAPACITY_WRITES_ENABLED` default-off** + migration pause |
| Stripe fail-closed | Missing on #63 tip | **Kept** from #65 (`bookingMirrorFailed` / webhook 503) |
| Checkout pause | Removed early write pause | **Kept** #64 pause message + migration block |

## Architecture

- Public store: availability, settings, members, finance, …
- Private store (after cutover): `holds.json`, `lessons.json`, `manual-bookings.json`
- Explicit migrate API with confirm tokens; private `backup/capacity-*`
- Preview isolation rejects private token store id == public store id

## Operator requirements (Preview first)

1. Create a **new Private** Blob store (disposable for Preview — never production private token on Preview)
2. Set Preview `PRIVATE_BLOB_READ_WRITE_TOKEN`
3. Keep public `BLOB_READ_WRITE_TOKEN` / `AVAILABILITY_URL`
4. Stripe **test mode** on Preview
5. Leave production `CAPACITY_WRITES_ENABLED` unset

See `CAPACITY-DUAL-STORE.md`.
