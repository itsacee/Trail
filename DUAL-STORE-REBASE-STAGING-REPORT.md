# AP ACADEMY — PR #63 SUCCESSOR REBASE + STAGING REPORT

**Status:** STOPPED — preparation and disposable staging tests complete  
**Owner approval honored:** Option 1 only (rebase + staging)  
**Production changes:** none  
**`CAPACITY_WRITES_ENABLED`:** not enabled  
**Cole:** unchanged (2 remaining; Oct 2 not restored)

---

## A. New PR number and commit

| Item | Value |
|---|---|
| Branch | `cursor/dual-store-rebase-f621` |
| Base | `main` @ `26a6dab` (PR #65) |
| Tip commit | `89c83ae` |
| New PR | https://github.com/itsacee/Trail/pull/68 (#68) |
| Supersedes | PR #63 (`cursor/dual-store-capacity-f621` @ `9dc8a7e`) — leave #63 closed/on hold |

---

## B. Merge-conflict resolution summary

Original PR #63 could not merge into `26a6dab` (conflicts in `lib/store.js`, `api/checkout.js`, `test/holdsOriginRead.test.js`, `test/store.test.js`).

**Resolution approach:** rebuild on current main rather than force-merge #63.

| Conflict area | Resolution |
|---|---|
| `lib/store.js` | New dual-store module that **keeps public capacity reads + `withSafeConditional` pre-cutover**, private origin CAS post-cutover, and **`CAPACITY_WRITES_ENABLED` pause** |
| `api/checkout.js` | Keep #64 early pause (`capacityWritesPaused`); add migration-pause block; fail-closed hold expire |
| `api/confirm.js` / `api/webhook.js` | **Untouched** — zero diff vs `26a6dab` |
| Tests | Updated for pre-cutover public reads; added `dualStoreStagingReadiness.test.js` |

---

## C. Confirmation that PR #64 and PR #65 protections remain intact

| Protection | Status |
|---|---|
| PR #64 public calendar recovery | **Intact** — pre-cutover `readCapacityVersioned` → public + `withSafeConditional` |
| PR #64 write pause | **Intact** — `capacityWritesEnabled()` requires `CAPACITY_WRITES_ENABLED=1` |
| PR #65 confirm fail-closed | **Intact** — `bookingMirrorFailed` / `recorded:false` / 503 unchanged |
| PR #65 webhook retries | **Intact** — webhook 503 on mirror failure unchanged |
| Memberships / finance on public store | **Intact** — not in capacity migration file set |
| Stripe payment references | **Intact** — lesson `sourceId` / ids copied as-is during migrate |

---

## D. Staging test results

**Environment:** in-process disposable memory Blob (`BLOB_MEMORY_STORE`) — **no production Blob, no live Stripe charges**.

| Suite | Result |
|---|---|
| Full `npm test` | **259 pass / 2 skip / 0 fail** |
| Dual-store unit (`dualStore.test.js`) | Pass (migrate, rollback, CAS, isolation, public pre-cutover reads) |
| Staging readiness (`dualStoreStagingReadiness.test.js`) | Pass — products, capacity rules, migration+rollback, membership credits, Stripe upsert idempotency, #65 source markers, write pause |
| Protection / holds / checkout / calendar suites | Pass as part of full run |

Covered behaviors (disposable data):

- Existing lesson / manual / hold migration with id verification  
- Membership credit preservation (4 credits, remaining math, period end)  
- Stripe purchase attribution (`sourceId` / `pi_*-1`)  
- Private-store CAS conflict (no overwrite)  
- Two Standard matching seats / Private exclusive hour  
- $80 / $100 / $280 / $360 product prices  
- Webhook retry idempotency (upsert no duplicates)  
- Migration failure without confirm (no private write)  
- Rollback keeps public snapshots; private post-cutover holds retained for recovery  

**Not run here (operator Preview still required):**

- Live Vercel Preview private Blob store  
- Live Stripe **test-mode** Checkout end-to-end  
- Coach `/api/capacity-migrate` against a real Preview store  

Artifact: `/opt/cursor/artifacts/dual-store-rebase-npm-test.txt`

---

## E. Private Blob configuration requirements

### Preview (required before any production cutover)

1. Create a **new Private** Vercel Blob store (disposable).  
2. Set Preview env `PRIVATE_BLOB_READ_WRITE_TOKEN` to that store only.  
3. **Do not** point Preview at the production private store.  
4. Keep Preview public token / `AVAILABILITY_URL` on a non-production public store when possible.  
5. Stripe Preview keys = **test mode** only.  
6. Leave `CAPACITY_WRITES_ENABLED` unset until Preview smoke.  
7. Optional: `CAPACITY_ALLOW_SHARED_STORE` must stay unset (rejects same store id).

### Production (later approval only)

1. Separate **Production** private Blob store + token.  
2. Never reuse Preview private token.  
3. Keep existing public `BLOB_READ_WRITE_TOKEN` / `AVAILABILITY_URL`.  
4. Cutover only after Preview green + owner approval.  
5. Keep `CAPACITY_WRITES_ENABLED` off until reopen approval.

Docs: `CAPACITY-DUAL-STORE.md`

---

## F. Production migration safety assessment

**Safe design properties:**

- No automatic migrate on booking reads  
- Explicit confirm tokens (`MIGRATE-CAPACITY` / `ROLLBACK-CAPACITY`)  
- Requires `CAPACITY_MIGRATION_PAUSE=1`  
- Byte + id verification before success  
- Private `backup/capacity-*` written first  
- Public capacity files left untouched as cold backup  
- Members / finance never migrated by this path  
- Deploying the PR **without** cutover keeps public calendar reads working  

**Residual risks (acceptable with procedure):**

- Operator must set the correct private token env  
- Cutover flag `CAPACITY_BLOB_CUTOVER=1` must only follow verified migrate  
- Concurrent public writes during migrate should be impossible while writes paused  

**Not executed against production.**

---

## G. Rollback safety assessment

1. `CAPACITY_MIGRATION_PAUSE=1`  
2. `POST /api/capacity-migrate` `{ action:"rollback", confirm:"ROLLBACK-CAPACITY" }`  
3. Unset `CAPACITY_BLOB_CUTOVER`  
4. Keep `CAPACITY_WRITES_ENABLED` off  
5. Public store becomes authoritative again for capacity reads  
6. Private backups retained (`backup/capacity-*`); post-cutover private rows remain for manual recovery if needed  

**Fixture proof:** staging test migrates → places new hold on private → rollback → public lessons still present; private hold still readable via `readPrivateCapacityFile`.

---

## H. Remaining blockers

1. Owner creates Preview private Blob store + sets Preview `PRIVATE_BLOB_READ_WRITE_TOKEN`  
2. Live Preview migrate/smoke/rollback with Stripe test mode (not done in this agent)  
3. Explicit approval to merge/deploy the successor PR (to Preview first)  
4. Separate later approvals for production migrate and `CAPACITY_WRITES_ENABLED=1`  
5. Close or supersede original PR #63 to avoid accidental merge of the old tip  

---

## I. Exact next owner approval required

Approve **one**:

**Next A (recommended):** Merge/deploy this successor PR to **Preview only**, configure disposable private Blob + Stripe test keys, run live Preview cutover smoke — still **no** production migrate / write enable.

**Next B:** Hold merge; owner creates Preview private store first, then ask agent to assist Preview smoke.

**Not requested / not done:** production merge, production migrate, write enable, Cole changes, membership resets.

---

**STOP AFTER PREPARATION AND TESTING. NO PRODUCTION CHANGES WITHOUT EXPLICIT OWNER APPROVAL.**
