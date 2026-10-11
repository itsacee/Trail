# STAGE 2 REPORT — Safe Booking System Implementation

**Branch:** `cursor/stage2-booking-rules-f621`  
**Base:** `origin/main` at `e60cb17` (Stage 1 investigation commit; no material drift)  
**Working tree at completion:** see Git status section below  

**Not done (by design):** Stage 3 private memberships, Stripe billing architecture changes, 30‑minute purchase card removal, production deploy/merge.

---

## A. Files modified

| File | Purpose |
|------|---------|
| `lib/schedule.js` | Privacy helpers (`resolvePrivacy`, `privacyForPurchaseType`); Both no longer exclusive by focus for new `privacy:"standard"` bookings; seat summing across rows |
| `js/booking-core.js` | Client mirror of privacy + capacity math |
| `api/slots.js` | Propagate `privacy` from Stripe/holds/lessons/cash; legacy Both stays exclusive; new standard Both shareable |
| `api/checkout.js` | Stamp `privacy`; reject private siblings; capacity checks use privacy |
| `api/cash-book.js` | Same privacy + private-one-athlete rules |
| `api/coach.js` | Same for coach-created/moved bookings |
| `api/member.js` | Membership books/moves with `privacy:"standard"` |
| `lib/manualBookings.js` | Persist `privacy` on manual bookings |
| `lib/lessons.js` | `makeMemberLesson` stamps privacy (Stage 3–ready) |
| `lib/reschedule.js` | Preserve privacy; seatsOnLesson respects privacy |
| `lib/holds.js` | Store privacy; compare-and-set retries on hold writes |
| `lib/store.js` | `blobCompareAndSet` (no overwrite fallthrough on 412) |
| `lib/settings.js` | Comment: private pair pricing legacy-only |
| `js/main.js` | Private not pairable; UI copy; want()/chips use privacy |
| `js/account.js` | Member portal shareable Both + privacy want |
| `account.html` | Membership note: Both can share |
| `index.html` | Private card: one athlete only (no sibling copy) |
| `test/schedule.test.js` | Capacity / privacy / concurrency algorithm tests |
| `test/slots.test.js` | Legacy vs standard Both aggregation |
| `test/checkoutPricing.test.js` | Private sibling rejected; $100 solo |
| `test/reschedule.test.js` | seatsOnLesson privacy cases |

Untracked (preserved, not part of Stage 2 code): `STAGE-1-INVESTIGATION-REPORT.md`

---

## B. Booking algorithm changes

### Old behavior (post #60)
- `focus === "Both"` → treated as exclusive (locks hour)
- `type === "private"` → exclusive
- Hitting/Fielding standard → share up to 2 same focus
- Private could include 2 siblings at $80 each

### New behavior
- **Privacy from purchase type / explicit `privacy` field**, not focus alone
- New bookings stamp `privacy: "standard"` or `"private"` via `privacyForPurchaseType(type)`
- **Standard** (any focus including Both): max 2 athletes, same focus required, “1 spot left” after first
- **Private**: always 1 athlete, $100, locks entire overlapping hour
- **Legacy Both without `privacy`**: still exclusive (historical protection from #60 era)
- Seat occupancy summed across overlapping same-slot rows (safer than per-row-only checks)

---

## C. Private sibling exception

**New bookings blocked at:**
- UI: `SESSIONS.private.pair = false` (no “Add another athlete”)
- API: `api/checkout.js`, `api/cash-book.js`, `api/coach.js` return 400 if `player2` / athletes>1 on private
- `canPair("private")` → `false`

**Historical preserved:**
- Existing Stripe/manual rows with `athletes:2` / `player2` untouched
- `unitPriceFor(private, athletes>1)` still returns single rate for historical price checks only
- Schedule still reads explicit `seats` on those rows

---

## D. Historical booking compatibility

| Case | Handling |
|------|----------|
| Legacy Both, no `privacy` | `resolvePrivacy` → private; hour stays exclusive |
| New standard Both | `privacy:"standard"`; shareable (2) |
| Historical 30‑min (`thirty`) | Duration still 30; overlap math unchanged; still pairable as standard-length lesson type |
| Explicit private / `exclusive:true` / seats≥2 | Remain exclusive |
| Old membership lessons without privacy | Treated standard unless focus Both (legacy Both → exclusive) |
| Cancel one of two standard | Seat count drops; “1 spot left” returns (existing cancel paths) |

---

## E. Concurrency safety

### Mechanisms in use
1. Pre-checkout / pre-save `slotBlocked` against live `bookedTimes` (Stripe + open checkouts + holds + blob)
2. Open Stripe Checkout sessions counted as holds
3. Post-create recheck; expire conflicting Checkout (`checkoutPricing` test covers this)
4. Member/cash retry loops re-check capacity before save
5. **New:** `blobCompareAndSet` + hold save retries on ETag 412 (does **not** silently overwrite concurrent hold updates)

### Limitations (honest)
- Lesson/manual Blob writes still use unconditional overwrite (prior 412-forever Lock-in failure; not re-enabled without approval)
- Full cross-store atomicity (Stripe payment + Blob) is **not** guaranteed by Vercel Blob alone
- Strongest current guarantee for card bookings remains: open Checkout visibility + expire-on-conflict
- Algorithm unit test covers sequential oversell rejection; true distributed race needs production load verification

---

## F. Test results

| Command | Result |
|---------|--------|
| `npm test` | **161 passed**, 1 skipped (`blobWrite` ifMatch mock.module unavailable), **0 failed** |
| `node --check` on modified JS | **Passed** |
| Lint / typecheck / production build | **Not executed** — no such scripts in `package.json` |
| Live Stripe / browser E2E | **Not executed** |
| Production Blob audit of legacy Both rows | **Not executed** (no production credentials used) |

---

## G. Outstanding issues

1. Homepage/book still offer **30‑minute** purchase (Stage 4).
2. **$360 private membership** not implemented (Stage 3).
3. Production inventory of legacy Both bookings (how many stay exclusive) not audited.
4. Optional future hardening: conditional writes for `lessons.json` / `manual-bookings.json` (needs approval; previously broke Lock-in).
5. Coach Setup prices UI still describes private sibling pricing historically — booking path blocks it; Stage 4 copy polish may still help.

---

## H. Stage 3 readiness

**Yes, with clear extension points:**
- `privacy` field on Checkout metadata, holds, manual bookings, member lessons
- `privacyForPurchaseType()` / `resolvePrivacy()` can map `membership_private` → private without rebuilding slot math
- Standard membership remains $280 / 4 credits / 30 days / one-time — unchanged
- Capacity algorithm already distinguishes standard vs private occupancy

Stage 3 should add purchase type + pricing + portal booking path that stamps `privacy:"private"` for private membership credits.

---

## Git status

```
Branch: cursor/stage2-booking-rules-f621
Based on: e60cb17 (origin/main at Stage 2 start)
Untracked preserved: STAGE-1-INVESTIGATION-REPORT.md
```

Commit hash: `93d32c82a99a5b98389a5d6a2132c2f8ee05559b`

---

STAGE 2 COMPLETE — AWAITING EXTERNAL REVIEW AND APPROVAL BEFORE STAGE 3.
