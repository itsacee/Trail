# STAGE 3 CORRECTION — Multiple Active Memberships and Credit Access

**Branch:** `cursor/stage2-booking-rules-f621`  
**Base Stage 3 implementation:** `a7dec38`  
**Scope:** Fix inaccessible older-membership credits when a customer holds more than one active purchase. No Stage 4. No deploy.

---

## A. Files modified

| Area | Files |
|------|--------|
| Attribution | `lib/membershipTypes.js` (`lessonBelongsToMembership` siblings disambiguation) |
| Summaries / day rule | `lib/members.js` (`membershipId`, `periodOpen`, `publicMembershipCard`, cross-purchase day conflict) |
| Schedule merge | `lib/lessons.js` (`scheduledFor` siblings, `scheduledAcrossMemberships`) |
| Member API | `api/member.js` (list all purchases; book with `membershipId`; cancel/reschedule by purchase) |
| Portal UI | `account.html`, `js/account.js`, `css/styles.css` |
| Tests | `test/multiMembership.test.js` (new), `test/concurrency.test.js` |
| Report | `STAGE-3-MULTI-MEMBERSHIP-CORRECTION.md` |

---

## B. How multiple active memberships are displayed

- `/api/member` returns `memberships[]`: each open purchase with label, remaining credits, expiration, privacy/exclusive flags, and its own lessons.
- Top-level summary fields remain for **backward compatibility** (newest/primary purchase).
- Portal shows a radio list when more than one period-open membership exists, plus a “Which membership are you using?” select on the book form.
- Single-membership customers see the same layout and copy as before (picker hidden).

---

## C. How credits are associated with purchases

- New portal bookings set `subId` to the selected purchase id (`makeMemberLesson`).
- Credit counts use `lessonBelongsToMembership(lesson, sub, siblings)` so Standard/Private and same-tier duplicates never combine.
- Booking requires `membershipId` when more than one bookable purchase exists; a lone open membership is selected implicitly.
- Expiration dates stay tied to each purchase’s own `current_period_*` — buying another membership never extends an older one.

---

## D. Cancellation and rescheduling behavior

- Cancel/reschedule locate the lesson across **all** purchases.
- Owner is resolved from `lesson.subId` (then Stripe `sourceId`, then unique belonging).
- Reschedule always rebooks against that same purchase (same tier/privacy/`subId`).
- Restored credits return only to the owning purchase’s remaining count.

---

## E. Backward compatibility

- Existing Standard memberships, legacy subscriptions, cash rows, and historical lessons unchanged in storage.
- Single-membership API shape preserved (`remaining`, `lastDay`, `membershipTier`, etc.).
- No Stripe price/billing changes; Private deposit remains disabled; $360 full checkout unchanged.
- No production data migration.

---

## F. Test results

| Command | Result |
|---------|--------|
| `npm test` | **208 passed**, **1 skipped** (`mock.module`), **0 failed** |

Added coverage: mixed tiers, same-tier duplicates, choose Standard vs Private (`subId`), cancel older purchase, reschedule preserves purchase, expired excluded, single-membership cards, one-lesson-per-day across purchases, concurrent last credit on one purchase, Stage 2B suite still green.

**Not run:** live Stripe test-mode portal E2E.

---

## G. Remaining risks

1. Legacy lessons with **no** `subId` / non-matching `sourceId` and multiple same-tier open purchases are attributed to the newest same-tier sibling (documented fallback) — new bookings always stamp `subId`.
2. Portal multi-membership UI is minimal (not Stage 4 redesign).
3. Capacity / deposit policies unchanged from Stage 3.

---

## H. Git commit and branch status

**Correction commit:** `518aa65` on `cursor/stage2-booking-rules-f621` (PR https://github.com/itsacee/Trail/pull/61).  
Untracked preserved: `STAGE-1-INVESTIGATION-REPORT.md`.

---

STAGE 3 CORRECTION COMPLETE — AWAITING STAGE 4 APPROVAL.
