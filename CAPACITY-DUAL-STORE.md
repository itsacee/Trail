# Dual-store capacity architecture

## Why

Vercel Blob access mode is **store-level**. A public store cannot host private
blobs, and `get({ useCache: false })` only bypasses CDN on **private** stores.
Capacity-critical CAS files therefore need a **separate private Blob store**.

## Stores

| Store | Env | Files |
|-------|-----|--------|
| Existing **public** | `BLOB_READ_WRITE_TOKEN`, `AVAILABILITY_URL` | `availability.json`, `settings.json`, `members.json`, `finance.json`, `followups.json`, `coach-status.json`, Instagram feed, etc. |
| New **private** | `PRIVATE_BLOB_READ_WRITE_TOKEN` | `holds.json`, `lessons.json`, `manual-bookings.json`, `capacity-cutover.json`, `backup/capacity-*` |

Do **not** remove or rename `BLOB_READ_WRITE_TOKEN`.

## Vercel setup (operator)

1. In Vercel → Storage → Create Blob store → Access **Private**.
2. Connect it to the project for **Preview** and/or **Production** as needed.
3. Copy that store’s read-write token into env var **`PRIVATE_BLOB_READ_WRITE_TOKEN`**.
4. Keep the existing public store token as **`BLOB_READ_WRITE_TOKEN`**.
5. For Preview isolation: use a **different** private store (or token) than
   Production. Do not set `CAPACITY_ALLOW_SHARED_STORE=1` unless you accept risk.
6. Stripe: Preview should use **test-mode** keys only.

## Cutover procedure (staging first — never auto)

Booking writes must be paused during cutover:

1. Set `CAPACITY_MIGRATION_PAUSE=1` (Preview or Production target).
2. Confirm private token is present and store ids differ:
   - `GET /api/capacity-migrate?key=COACH_PASS`
3. Dry plan looks correct (counts from public snapshots).
4. Execute (staging disposable data first):
   - `POST /api/capacity-migrate`  
     `{ "key":"…", "action":"migrate", "confirm":"MIGRATE-CAPACITY" }`
5. Verify response `ok: true` and counts/ids match.
6. Set `CAPACITY_BLOB_CUTOVER=1`.
7. Smoke-test holds/checkout/slots/member book (Stripe test mode).
8. Clear `CAPACITY_MIGRATION_PAUSE`.
9. Leave public capacity files untouched as cold backup until stable.

## Rollback

1. Set `CAPACITY_MIGRATION_PAUSE=1`.
2. `POST /api/capacity-migrate`  
   `{ "key":"…", "action":"rollback", "confirm":"ROLLBACK-CAPACITY" }`
3. Unset `CAPACITY_BLOB_CUTOVER`.
4. Keep pause until public store is confirmed authoritative again.
5. Do not delete `backup/capacity-*` in the private store.

## Runtime safety

- No automatic public→private rewrite on booking reads.
- Pre-cutover: if public still has reservations and private file is missing →
  fail closed (`unreachable`), never invent an empty schedule.
- Post-cutover: capacity reads/writes use the private store only.
- CAS: no unconditional overwrite fallthrough after failed `ifMatch`.
- Preview sharing the public store id with the private token is rejected.

## This agent will not

- Execute production migration
- Merge PR #62
- Deploy production
- Point test checkouts at production booking files without a disposable store
