# STAGE 4 REPORT — Final Website Presentation, Regression Testing, and Launch Readiness

**Branch:** `cursor/stage2-booking-rules-f621`  
**Base Stage 3 correction:** `9d052e9`  
**Scope:** Four purchase options, retire public 30-minute sales, label cleanup, regression tests, deployment checklist. No deploy. No live customer data changes.

---

## A. Files modified

| Area | Files |
|------|--------|
| Homepage / preview pricing | `index.html`, `preview/index.html`, `preview/pricing.html` |
| Booking UI | `book.html`, `js/main.js`, `css/styles.css` |
| Public APIs | `api/checkout.js`, `api/cash-book.js`, `api/confirm.js` |
| Coach / FAQ copy | `coach.html`, `faq.html`, `preview/faq.html` |
| Tests | `test/stage4Presentation.test.js` (new), `test/checkoutPricing.test.js` |
| Report | `STAGE-4-LAUNCH-READINESS-REPORT.md` |

Untracked preserved: `STAGE-1-INVESTIGATION-REPORT.md`

---

## B. Final pricing presentation

Four primary cards (homepage + preview + booking tabs):

1. **Standard Drop-In — $80** — 60 min, up to 2 athletes, matching focus  
2. **Private One-on-One Drop-In — $100** — 60 min, exclusive, 1 athlete  
3. **Standard Membership — $280** — 4 lessons / 30 days (~$70), shareable, no auto-renew  
4. **Private One-on-One Membership — $360** — 4 lessons / 30 days (~$90), exclusive, no auto-renew  

All four support Hitting, Fielding, Hitting & Fielding. Copy uses “30 days” / “does not auto-renew,” not subscription language.

---

## C. Removal of 30-minute customer purchases

| Layer | Behavior |
|-------|----------|
| Homepage / book tabs / preview | 30-min cards/tabs removed |
| `js/main.js` | `thirty` removed from public `SESSIONS`; `?type=thirty` redirects to Standard Drop-In |
| `api/checkout.js` | `type:"thirty"` → **400** `thirty_retired` |
| `api/cash-book.js` | `type:"thirty"` → **400** `thirty_retired` (before cash-allow check) |
| Historical parsers | `durationFor("thirty")` = 30; schedule overlap unchanged |
| Coach Desk | Can still create/price legacy 30-min admin lessons; labeled “30 min (legacy)” |

---

## D. Booking rules verified

Automated coverage retained/extended for: shareable Standard (max 2, same focus), Private exclusive, focus mismatch, Stage 2B CAS races, membership credit rules, multi-membership selection (Stage 3 correction). Hitting & Fielding = one membership credit (prior suite).

---

## E. Membership portal verified

Stage 3 correction preserved: multi-membership list/select, per-purchase credits/expiration, cancel/reschedule bound to `subId`, cross-purchase one-lesson-per-day. Labels Standard vs Private. Copy only lightly aligned; no redesign.

---

## F. Coach dashboard verified

Labels: Standard Drop-In, Private Drop-In, Standard/Private Membership, 30 min (legacy). Prices include $360 Private Membership. Private deposit remains disabled on public checkout; Standard deposit unchanged. Combined capacity 15 unchanged. Coach may still add legacy 30-min for admin/history.

---

## G. Stripe/payment verification

| Product | Amount | Mode |
|---------|--------|------|
| Standard Drop-In | 8000¢ | `payment` |
| Private Drop-In | 10000¢ | `payment` |
| Standard Membership | 28000¢ | `payment` |
| Private Membership | 36000¢ | `payment` |

Automated: checkout amounts, private deposit rejection, duplicate mirror idempotency (prior tests).  
**Not run:** live Stripe test-mode end-to-end with real keys.

---

## H. Security checks

- Public `thirty` blocked at checkout + cash-book (not UI-only).  
- Coach create remains coach-auth path (`/api/coach`); public cash cannot create thirty.  
- Membership portal still token-authenticated.  
- Server sets privacy/price from purchase type (client cannot override amounts).  
- No secrets added to browser JS.  
**Manual/unverified:** full coach-auth matrix against production secrets.

---

## I. Test results

| Command | Result |
|---------|--------|
| `npm test` | **216 passed**, **1 skipped** (`mock.module`), **0 failed** |
| `node --check` on modified JS | Passed |

**Automated:** four options presentation, amounts, public thirty rejection, historical thirty duration, privacy mapping, cash thirty rejection, Stage 2/2B/3 suites still green.  
**Not automated:** visual mobile QA in a real browser; live Stripe; production Blob 412 under load.

---

## J. Mobile responsiveness

CSS: pricing grid 4 columns ≥960px, auto-fit wrap below; booking tabs already 2-column on small screens.  
**Manual check recommended** on iPhone / tablet before deploy (cards, tabs, membership selector, coach sheets).

---

## K. Remaining risks

1. **Vercel Blob 412 / CAS** — in-memory tests do not prove production Blob conditional writes under dual-writer load.  
2. **Legacy lessons without `subId`** — multi-membership fallback attributes to newest same-tier sibling (documented Stage 3 correction).  
3. **Private membership deposit** — still disabled pending business decision.  
4. **Coach 30-min admin path** — intentionally retained; not sold publicly.  
5. **No live Stripe test-mode smoke** in this agent run.

---

## L. Deployment checklist

Do **not** deploy from this report alone. Before production:

1. Confirm env vars: `STRIPE_SECRET_KEY` (live), webhook secret, `BLOB_READ_WRITE_TOKEN`, Resend/`FROM_EMAIL`, coach auth secrets.  
2. Stripe **test-mode** smoke: all four checkouts, membership confirm, deposit (Standard only), failed/cancel release hold.  
3. Verify Vercel Blob conditional writes in staging (force concurrent member books; watch for 412 / lost updates).  
4. Backup production Blob JSON (`lessons`, `manual-bookings`, `members`, settings).  
5. Code review + merge of `cursor/stage2-booking-rules-f621` → `main`.  
6. Staging smoke: homepage 4 cards, book tabs, `type=thirty` redirect + API 400, member multi-select, coach labels.  
7. Rollback: redeploy previous Vercel deployment; Blob backup restore if data corrupted.  
8. Post-release: monitor checkout errors, webhook failures, Blob write errors, membership capacity.

---

## M. Git branch, commit, and working-tree status

**Stage 4 commit:** `ca141a7` on `cursor/stage2-booking-rules-f621` (PR https://github.com/itsacee/Trail/pull/61).

---

## N. Final launch recommendation

**Conditionally ready for final human review** after staging Stripe test-mode smoke and a Blob concurrency check.  
**Not cleared for unsupervised production deploy** from this agent run alone — live Stripe and production Blob behavior were not verified here.

---

STAGE 4 COMPLETE — AWAITING FINAL REVIEW AND DEPLOYMENT APPROVAL.
