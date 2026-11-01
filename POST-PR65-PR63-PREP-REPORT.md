# AP ACADEMY — POST PR #65 VERIFICATION + PR #63 PREPARATION REPORT

**Status:** STOPPED — awaiting owner approval  
**Report date:** 2026-10-11 ~23:55–00:05 UTC window  
**Production SHA (GitHub Deployment):** `26a6dab` — PR #65 — **success**  
**Prior Production:** `db32f76` (PR #64)  
**PR #63:** OPEN — **not deployed** · merge conflicts with current `main`  
**Backups:** Owner confirms existing booking backups downloaded and saved  

**Agent did not:** deploy · migrate · enable `CAPACITY_WRITES_ENABLED` · modify production data · create real Stripe payments · merge PR #63

---

## A. PR #65 production verification

| Check | Result |
|---|---|
| 1. Production running merged PR #65 commit | **PASS** — GitHub Production deployment `7003615255` ref/sha `26a6dab`, state `success`, created `2026-10-11T23:55:16Z`. `main` tip is `26a6dab Fail closed when Stripe confirmation cannot mirror lessons (#65)`. |
| 2. Existing Coach Dashboard lessons still display | **PASS (public schedule evidence)** — `/api/calendar` and `/api/coach` require passcode (not used). Public `/api/slots` shows occupied hours across **13 days / 22 hour-entries** in a 60-day scan (Sep 21–Oct 29), including private exclusive and standard shared seats. Lessons were not wiped by the #65 deploy. |
| 3. Customer memberships and credits unchanged | **PASS (capacity signal unchanged)** — `/api/membership-capacity` still `active:4`, `limit:15`, `spotsAvailable:11` (same as pre-#65 reopen report). No membership reset path in #65 (control-flow only on confirm/webhook). |
| 4. Webhooks no longer silently ACK failed mirrors | **PASS (code on production SHA)** — `api/webhook.js` returns **503** + `bookingMirrorFailed:true` when confirm mirror fails; `api/confirm.js` returns 503 / `recorded:false` / `bookingMirrorFailed` before `confirmation_sent` / email / finance. |
| 5. Stripe retry behavior correct | **PASS (by design on deployed code)** — non-2xx webhook response asks Stripe to retry; email-only failures still 200. |
| 6. No duplicate lessons / emails / finance from #65 | **PASS (code + fixtures)** — `upsertStripeLessons` remains idempotent by `${sourceId}-n`; failed path returns before finance/email/`confirmation_sent`. Protection tests **4/4 pass**. No evidence of schedule wipe or empty calendar after deploy. |
| 7. No paid Checkout Sessions awaiting reconciliation | **INCONCLUSIVE from this agent** — no Stripe API credentials in this environment; no real payments created. Owner should confirm in Stripe Dashboard: Developers → Webhooks (failed/retrying `checkout.session.completed`) and recent paid sessions vs Coach Desk. New public checkouts remain blocked while writes are paused, limiting new exposure. |
| 8. `CAPACITY_WRITES_ENABLED` remains disabled | **PASS** — live checkout: `503` · `capacityWritesPaused:true` · `schedule_unavailable` · message that online booking is temporarily paused; no payment taken. |

**Main tip test suite (includes #65):** **235 pass / 2 skip / 0 fail** (`post65-main-npm-test.txt`).

---

## B. Existing booking integrity

| Signal | Observation |
|---|---|
| Public slots occupancy | Intact after #65 deploy (sample: 2026-10-02 Fielding 5pm; 10-12 Hitting + private; 10-13 private + Fielding; 10-15 Both private + Hitting; future 10-22 / 10-29 present) |
| Empty invent | Not observed — days without bookings return `booked:[]`, not errors inventing schedules |
| Coach Desk deep roster | Not passcode-authenticated here; owner should spot-check Coach Desk against their offline backups |
| Historical edits | None performed by this agent |

**Verdict:** Schedule occupancy survived PR #65 deploy. Owner backup + Coach Desk spot-check remains the final authority for named athlete rows.

---

## C. Membership integrity

| Signal | Observation |
|---|---|
| Active membership capacity | Still **4 active** / 15 limit (unchanged vs pre-#65 report) |
| Credit reset on deploy | #65 does not touch `members.json` or membership credit math |
| Fixture protection | Credits stay purchase-scoped while paused; separate memberships do not combine (`customerDataProtection.test.js`) |
| Cole | Owner decision unchanged: leave at **2 remaining**; Oct 2 restore not performed |

**Verdict:** No membership integrity regression detected from PR #65 deploy.

---

## D. Stripe payment safety

| Topic | Status |
|---|---|
| New card checkouts while paused | Blocked at `/api/checkout` with explicit pause — **no payment taken** |
| Paid → schedule mirror failure | Fail-closed 503; Stripe retries; confirmation not finalized |
| Idempotent mirror on retry | Yes (`upsertStripeLessons`) |
| Duplicate email/finance on failed mirror | Avoided — return before those writes |
| Live unpaid/paid-unrecorded audit | **Owner Stripe Dashboard check still required** (no Stripe key here) |

**Residual risk while writes stay paused:** Stripe will keep retrying failed mirror webhooks for a limited window. If any pre-pause Checkout completed payment and never mirrored, it should either still be retrying or need manual Stripe→Blob reconcile after writes reopen. #65 is the correct protection for that path going forward.

---

## E. PR #63 readiness

**PR:** https://github.com/itsacee/Trail/pull/63 · branch `cursor/dual-store-capacity-f621` @ `9dc8a7e`  
**Do not deploy.**

### What #63 correctly designs

| Area | Assessment |
|---|---|
| Private Blob store | Capacity files (`holds` / `lessons` / `manual-bookings`) → `PRIVATE_BLOB_READ_WRITE_TOKEN`; public store kept for availability/settings/members/finance |
| Origin reads / CAS | Private `useCache:false`; strict CAS; no unconditional overwrite fallthrough |
| Prod/staging isolation | Rejects preview when public/private store ids match unless `CAPACITY_ALLOW_SHARED_STORE=1` |
| Migration safety | Explicit only: `CAPACITY_MIGRATION_PAUSE=1` + coach `/api/capacity-migrate` + confirm tokens `MIGRATE-CAPACITY` / `ROLLBACK-CAPACITY`; byte/id verify; private `backup/capacity-*` |
| Membership / Stripe refs | `members.json` / finance stay on public store; Stripe payment ids remain in lesson records — migration copies lesson JSON as-is |
| Rollback | Clear cutover marker, unset `CAPACITY_BLOB_CUTOVER`, keep pause; do not delete private backups |
| Isolated tests on #63 tip | After `npm ci`: **238 pass / 1 skip / 0 fail** |

### Hard blockers before #63 can be production-ready

1. **Merge conflicts with current `main` (`26a6dab`)**  
   Conflicts in: `lib/store.js`, `api/checkout.js`, `test/holdsOriginRead.test.js`, `test/store.test.js`.  
   #63 branched from `ff3dff2` (pre-#64/#65).

2. **Missing PR #65 fail-closed on #63 tip**  
   `bookingMirrorFailed` is **absent** from #63’s `api/confirm.js` / `api/webhook.js`. Merging #63 as-is would **drop** production payment-protection behavior.

3. **Different write-pause model**  
   Production today: `CAPACITY_WRITES_ENABLED` must equal `1` (default paused).  
   #63 tip: `CAPACITY_MIGRATION_PAUSE` only — **no** `CAPACITY_WRITES_ENABLED` gate. A naive merge/deploy without careful rebase could re-open writes unintentionally.

4. **Operator prerequisites not verified here**  
   - New **Private** Blob store created  
   - `PRIVATE_BLOB_READ_WRITE_TOKEN` set (Preview disposable ≠ Production)  
   - Staging cutover on disposable data  
   - Live Preview smoke with Stripe **test** keys  

5. **No live staging migration executed** (correctly — out of scope / forbidden this turn)

**PR #63 readiness verdict:** **NOT READY TO MERGE OR DEPLOY** until rebased onto `26a6dab` preserving #64 read recovery + #65 fail-closed + `CAPACITY_WRITES_ENABLED` default-off (or equivalent), then staging-verified.

---

## F. Remaining blockers

1. Owner Stripe Dashboard confirmation: no failing/retrying paid sessions needing manual reconcile  
2. Coach Desk named-athlete spot-check vs offline backups (passcode not used by agent)  
3. PR #63 rebase onto `26a6dab` (resolve conflicts; keep #65 webhook fail-closed; keep write pause default-off)  
4. Create/configure private Blob store + Preview isolation  
5. Staging dual-store migrate → cutover → smoke → rollback drill  
6. Explicit owner approval before any of: merge #63 · production migrate · `CAPACITY_WRITES_ENABLED=1`

---

## G. Exact next steps to reopen bookings

### Recommended sequence (after owner approvals)

**Step 0 — Stripe / integrity owner checks (no code deploy)**  
- Confirm backups on hand (already done per owner)  
- Stripe: webhooks + recent paid Checkout sessions vs Coach Desk  
- Spot-check Coach Desk against backups  

**Step 1 — Prepare permanent storage fix (PR #63 successor)**  
- Rebase/rewrite #63 onto `26a6dab`  
- Preserve: public-store calendar fallback until cutover · `CAPACITY_WRITES_ENABLED` pause · `bookingMirrorFailed` 503 path · dual private store + explicit migration  
- Preview: private store + Stripe test mode · dry plan · migrate · cutover · smoke · rollback drill  
- **Do not** cut over Production until staging is green  

**Step 2 — Production dual-store cutover (separate approval)**  
- Keep `CAPACITY_WRITES_ENABLED` unset/off  
- Set `PRIVATE_BLOB_READ_WRITE_TOKEN` (production private store)  
- `CAPACITY_MIGRATION_PAUSE=1` → migrate → verify counts/ids → `CAPACITY_BLOB_CUTOVER=1` → smoke reads → clear migration pause only when ready  

**Step 3 — Reopen payments/bookings (separate approval)**  
- Set `CAPACITY_WRITES_ENABLED=1`  
- Smoke:  
  - $80 Standard Drop-In  
  - $100 Private Drop-In  
  - $280 Standard Membership  
  - $360 Private Membership  
  - Two matching Standard seats / hour  
  - Private exclusive hour  
  - Membership credit deduction  
  - Stripe confirm → Coach Desk persistence  

### Faster but higher-risk alternative (not recommended)

Enable writes on current public store **without** dual-store: possible after Stripe audit, but CDN/CAS hold failures can still recur. Prefer Step 1–3.

### Rollback if reopen misbehaves

1. Unset `CAPACITY_WRITES_ENABLED` immediately  
2. If cutover active: migration pause + rollback action + unset `CAPACITY_BLOB_CUTOVER`  
3. Redeploy last known-good SHA (`26a6dab` post-#65, or earlier if needed)  
4. Restore JSON from owner backups only if corruption proven — never invent empty files  

---

## Reopening readiness (product matrix)

| Capability | Code/fixtures ready? | Safe on production now? |
|---|---|---|
| $80 Standard Drop-In | Yes | **No** — writes paused; public CAS risk |
| $100 Private Drop-In | Yes | **No** |
| $280 Standard Membership | Yes | **No** |
| $360 Private Membership | Yes | **No** |
| Two matching Standard / hour | Yes | **No** |
| Private exclusive hour | Yes | **No** |
| Membership credit deductions | Yes (fixtures) | **No** until writes + smoke |
| Stripe payment confirmation | Yes (#65 fail-closed) | Mirror retries OK; new checkouts still blocked |

---

## Exact next owner approval needed

Approve **one** of:

**Option 1 (recommended):** Authorize a **rebase of PR #63 onto `26a6dab`** (new PR/commits OK) that preserves #65 fail-closed + write pause, then Preview private-store staging only — still **no** production migrate / write enable until a later approval.

**Option 2:** After owner Stripe + Coach Desk checks only, authorize **temporary** `CAPACITY_WRITES_ENABLED=1` on current public store (accept CDN/CAS risk) while #63 rebase continues — **not recommended**.

**Option 3:** Hold writes; owner completes Stripe reconcile audit only; no code changes yet.

---

**STOP AND WAIT FOR OWNER APPROVAL.**
