# Dual-store capacity architecture (successor to PR #63)

Rebased onto production `main` / `26a6dab` (PR #64 + PR #65).

## Why

Vercel Blob access mode is **store-level**. A public store cannot host private
blobs, and `get({ useCache: false })` only bypasses CDN on **private** stores.
Capacity-critical CAS files therefore need a **separate private Blob store**.

## Protections preserved

| Protection | How |
|---|---|
| PR #64 calendar recovery | Pre-cutover capacity **reads** stay on the public store with `withSafeConditional` |
| PR #65 Stripe fail-closed | `api/confirm.js` / `api/webhook.js` unchanged — `503` + `bookingMirrorFailed` |
| Write pause | `CAPACITY_WRITES_ENABLED` must be `1` (default off in deployed envs) |
| Cutover pause | `CAPACITY_MIGRATION_PAUSE=1` blocks capacity writes during migrate |
| Memberships / finance | Stay on the **public** store — never rewritten by capacity migration |

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
7. Leave `CAPACITY_WRITES_ENABLED` unset/off until reopen is approved.

## Cutover procedure (staging first — never auto)

Booking **writes** must stay paused (`CAPACITY_WRITES_ENABLED` off and/or
`CAPACITY_MIGRATION_PAUSE=1`). Calendar **reads** remain on public until cutover.

1. Set `CAPACITY_MIGRATION_PAUSE=1` (Preview or Production target).
2. Confirm private token is present and store ids differ:
   - `GET /api/capacity-migrate?key=COACH_PASS`
3. Dry plan looks correct (counts from public snapshots).
4. Execute (staging disposable data first):
   - `POST /api/capacity-migrate`  
     `{ "key":"…", "action":"migrate", "confirm":"MIGRATE-CAPACITY" }`
5. Verify response `ok: true` and counts/ids match.
6. Set `CAPACITY_BLOB_CUTOVER=1`.
7. Smoke-test holds/checkout/slots/member book (Stripe test mode) **after** enabling writes in Preview only.
8. Clear `CAPACITY_MIGRATION_PAUSE`.
9. Leave public capacity files untouched as cold backup until stable.

## Rollback

1. Set `CAPACITY_MIGRATION_PAUSE=1` (and keep `CAPACITY_WRITES_ENABLED` off).
2. `POST /api/capacity-migrate`  
   `{ "key":"…", "action":"rollback", "confirm":"ROLLBACK-CAPACITY" }`
3. Unset `CAPACITY_BLOB_CUTOVER`.
4. Keep pause until public store is confirmed authoritative again.
5. Do not delete `backup/capacity-*` in the private store.

## Runtime safety

- No automatic public→private rewrite on booking reads.
- Pre-cutover: public capacity reads keep Coach Desk / slots populated.
- Post-cutover: capacity reads/writes use the private store only.
- CAS: no unconditional overwrite fallthrough after failed `ifMatch`.
- Preview sharing the public store id with the private token is rejected.
- Deploying this PR without private token / cutover does **not** blank calendars.

## This agent will not

- Execute production migration
- Enable production `CAPACITY_WRITES_ENABLED`
- Deploy production
- Point Preview at the production private Blob store
