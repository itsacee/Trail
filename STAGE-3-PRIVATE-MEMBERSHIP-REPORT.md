# STAGE 3 REPORT — Private Membership, Credits, and Stripe Integration

**Branch:** `cursor/stage2-booking-rules-f621`  
**Base Stage 2B:** `5a979d4`  
**Scope:** $360 Private Membership (`membership_private`) alongside $280 Standard Membership. No Stage 4. No deploy.

---

## A. Files modified

| Area | Files |
|------|--------|
| Tier helpers | `lib/membershipTypes.js` (new) |
| Pricing / privacy | `lib/settings.js`, `lib/schedule.js`, `js/booking-core.js` |
| Membership lookup / credits | `lib/members.js`, `lib/lessons.js`, `lib/membershipCapacity.js` |
| Stripe / APIs | `api/checkout.js`, `api/confirm.js`, `api/cash-book.js`, `api/coach.js`, `api/member.js` |
| Portal / book / coach UI | `js/main.js`, `js/account.js`, `book.html`, `coach.html` |
| Tests | `test/membershipPrivate.test.js` (new), `test/checkoutPricing.test.js`, `test/schedule.test.js`, `test/concurrency.test.js` |
| Report | `STAGE-3-PRIVATE-MEMBERSHIP-REPORT.md` |

Untracked preserved: `STAGE-1-INVESTIGATION-REPORT.md`

---

## B. Standard vs Private Membership architecture

| | Standard | Private |
|--|----------|---------|
| Type | `membership` (unchanged) | `membership_private` |
| Price | $280 (28000¢) | $360 (36000¢) |
| Credits | 4 / 30 days | 4 / 30 days |
| Privacy | `standard` | `private` |
| Capacity | Share hour (max 2, same focus) | Exclusive full hour, 1 athlete |
| Billing | One-time Checkout `mode=payment` | Same |

Legacy purchases without a tier → **standard**. Focus never decides privacy.

---

## C. Stripe checkout implementation

- `SESSION_TYPES.membership_private` with inline `price_data` ($360), `mode: "payment"`.
- Metadata: `type`, `privacy`, `membership_tier`, email, seats, focus, payment fields.
- No recurring subscriptions; no new permanent Stripe Price IDs.
- Deposit path remains **standard membership only**; private membership deposit returns 400 with a clear message.

---

## D. Membership credit calculations

- Still 4 credits / 30-day period; Hitting & Fielding = **one** credit.
- `membershipSummary` counts only lessons that `lessonBelongsToMembership` (subId / Stripe sourceId / tier match).
- Standard and private credits **do not combine** across overlapping purchases.
- Cancel/reschedule preserve tier + privacy via `makeMemberLesson` / portal mutators.

---

## E. Member portal behavior

- Summary exposes `membershipType`, `membershipTier`, `membershipLabel`, `privacy`, `exclusive`.
- UI labels Standard vs Private; private copy notes full-hour reservation.
- Slot picker uses account privacy (private → 2 seats / exclusive).

---

## F. Coach dashboard behavior

- Settings: Private Membership price field ($360 default).
- Create-booking type includes Private Membership.
- Member cards show membership label when known.
- Cash private memberships stamp `membershipType` / `privacy` on `members.json`.

---

## G. Cash and deposit handling

| Path | Standard | Private |
|------|----------|---------|
| Full cash | Supported | Supported |
| Card deposit ($80 + cash) | Supported (unchanged) | **Not offered** — needs business approval |
| Coach create | Supported | Supported |

**Business decision needed:** private membership deposit amount / whether to enable deposit at all.

---

## H. Existing customer compatibility

- Existing `type=membership` untouched; treated as standard.
- Legacy Stripe subscriptions still readable as standard; auto-renew stop unchanged.
- No migration to $360; no retroactive charges.
- Historical exclusive Both / explicit private bookings unchanged (Stage 2 rules).

---

## I. Membership capacity enforcement

- Hard limit **15** retained.
- Standard + private payments both count (shared pool).
- Still **one roster spot per email** (existing policy); renewals of an existing email remain admitted when full.
- Pre-create + post-create Stripe open-checkout admission unchanged; concurrent last-spot races still rely on that expire path. **[partially tested via mocks]**

---

## J. Concurrency and payment safety

- Stage 2B `mutateLessons` / `mutateManualBookings` CAS paths preserved.
- Confirm mirror still uses CAS upsert; duplicate confirmation does not duplicate lessons **[tested]**.
- Failed/incomplete payments do not activate credits (unchanged Stripe paid check).
- Concurrent private-membership last-seat race **[tested]** in memory Blob suite.

---

## K. Test results

| Command | Result |
|---------|--------|
| `npm test` | **195 passed**, **1 skipped** (`mock.module` / blobWrite fallthrough), **0 failed** |
| `node --check` on modified JS | Passed |

Covered: $280/$360 checkout + `mode=payment`, 4 credits, 30-day period, Both=1 credit, share vs exclusive, cross-tier block, cancel/reschedule privacy, expired book block, legacy standard, duplicate mirror, cash private tier, capacity 9+6, overlapping pick-newest, concurrent private member race, Stage 2B suite still green.

**Not run here:** live Stripe test-mode end-to-end with real keys; production Blob dual-writer load.

---

## L. Outstanding issues and business decisions

1. **Private membership deposit** — disabled until amount/policy approved.
2. **Overlapping standard + private for same email** — portal shows newest primary purchase; older purchase’s remaining credits wait until it becomes primary again (or expires). Documented; no cross-tier spend.
3. **Homepage pricing cards** — still Stage 4 (book page has both membership tabs for operation/testing).
4. **30-minute purchase** — still offered (Stage 4 removal).

---

## M. Stage 4 readiness

**Yes for Stage 4 presentation work** after external review: four-option homepage cards, copy cleanup, customer-facing 30-minute removal, full regression.

Do not start Stage 4 until approved.

---

## N. Git branch, commit, and working-tree status

**Stage 3 implementation commit:** `a7dec38`  
**Branch tip:** `892edb6` (report hash fix)  
**Branch:** `cursor/stage2-booking-rules-f621` (pushed; PR #61)  
Working tree clean aside from untracked `STAGE-1-INVESTIGATION-REPORT.md`.

---

STAGE 3 COMPLETE — AWAITING EXTERNAL REVIEW AND APPROVAL BEFORE STAGE 4.
