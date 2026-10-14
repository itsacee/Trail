# Production release preparation — PASS/FAIL report

**Date:** 2026-10-14  
**Tip audited:** `cursor/booking-paid-reconcile-f621` (PR #75 tip; contains #68+#69+#71+#72+#73+#74+#75)  
**Excluded:** PR #70 (HTTP CAS probe) — **not** in tip ancestry  
**Constraints honored:** No merges, no Production deploy, no Production DB/resources, no env var changes, no booking writes enablement, no live payments, no customer data changes.

---

## Executive verdict: **PASS** for release *preparation*

The stack is merge-ready for a **controlled, gated** rollout. Merging the tip to `main` alone does **not** enable Production PostgreSQL reads or writes. The **first action requiring your approval** is listed at the end.

| Gate | Result |
| --- | --- |
| PR stack integrity (#68–#75 excl. #70) | **PASS** |
| No unexpected PG cutover on merge | **PASS** |
| Production defaults reads=0 / writes=0 | **PASS** |
| Live Production site functional under defaults | **PASS** |
| Rollback SOP avoids stale Blob authority | **PASS** (with mandatory rules) |
| Reconcile/recovery authorization | **PASS** |
| No double-count of paid-unmirrored seats | **PASS** |
| Local regression suite | **PASS** — 383 pass / 0 fail / 2 skip |

---

## 1. PR stack audit

```
main
 └─ #68 dual-store-rebase
     └─ #69 booking-capacity-rules
         ├─ #70 preview-cas-probe-api     ← EXCLUDE (NOT in tip)
         └─ #71 booking-postgres-preview
             └─ #72 booking-postgres-reads
                 └─ #73 booking-postgres-full
                     └─ #74 booking-prod-readiness
                         └─ #75 booking-paid-reconcile   ← tip
```

| PR | In tip ancestry? | Role |
| --- | --- | --- |
| #68 | Yes | Dual-store Blob CAS + paid-mirror hold release |
| #69 | Yes | Capacity rules audit + atomic Blob membership reschedule |
| #70 | **No** | HTTP CAS probe — skip |
| #71 | Yes | Postgres BookingStore (writes gated off by default) |
| #72 | Yes | Authoritative reads path (flag-gated) |
| #73 | Yes | Full write wiring + Preview S1–S12 evidence |
| #74 | Yes | Coach collect/finance/cash-book parity |
| #75 | Yes | Stripe paid reconcile + occupancy safety net |

All of #68–#69 and #71–#75 are `MERGEABLE`. Tip contains `main`.

### Obsolete / overlapping / risky items

| Item | Assessment |
| --- | --- |
| PR #70 HTTP probe (`api/probe-private-cas.js`, etc.) | **Absent from tip** — correct. Do not merge. |
| `scripts/probe-private-cas.mjs` + `test/probePrivateCas.test.js` | From **#68** (CLI/lab tooling). Not an HTTP route; **not auto-run**. Keep; do not set any `PROBE_*` on Production. |
| Superseded PR #63 | Historical; tip uses #68 rebase. Leave alone. |
| Overlap `api/confirm.js` / `lib/holds.js` (#68 + Postgres stack) | Resolved in tip: PG path behind `bookingWritesEnabled()`; Blob path retained when writes off. |
| #69 Blob atomic reschedule vs #73 PG `dbReschedule` | Complementary (flag-selected), not conflicting. |
| Preview-only `BOOKING_*` secrets on git branches | Do **not** copy Preview DB URLs to Production. |

---

## 2. Safest merge sequence

Merge **bottom-up** (or squash-merge the tip after the same order is reviewed):

1. **#68** → `main`  
2. **#69** → `main`  
3. **#71** → `main`  
4. **#72** → `main`  
5. **#73** → `main`  
6. **#74** → `main`  
7. **#75** → `main`  

**Skip #70 entirely.**

Alternative equivalent: retarget #75 to `main` and merge once (tip already contains #68–#69+#71–#74). Bottom-up is safer for review checkpoints.

### Merge cannot enable Production PG automatically — **PASS**

Code defaults (`lib/bookingDb/flags.js`):

| Env unset (Production today) | Result |
| --- | --- |
| `BOOKING_STORE` | `"blob"` |
| `BOOKING_READS_ENABLED` | **false** (requires store≠blob **and** `"1"`) |
| `BOOKING_WRITES_ENABLED` | **false** (requires store≠blob **and** `"1"`; killed by `BOOKING_DUAL_WRITE_BLOB=1`) |
| `assertPreviewDbAllowed(production)` | **blocked** unless `BOOKING_ALLOW_NON_PREVIEW=1` |

`vercel.json` has **no** `BOOKING_*` overrides.  
Production Vercel env listing: **no** `BOOKING_*` or `PROBE_*` variables present.

---

## 3. Production defaults confirmation — **PASS**

| Flag | Production today | After merge tip (no env change) |
| --- | --- | --- |
| `BOOKING_STORE` | unset → blob | unset → blob |
| `BOOKING_READS_ENABLED` | unset → **0/off** | unset → **0/off** |
| `BOOKING_WRITES_ENABLED` | unset → **0/off** | unset → **0/off** |
| Auto PG cutover | None | None |

---

## 4. Live Production functional check (read-only) — **PASS**

| URL | HTTP |
| --- | --- |
| `https://www.apacademybsb.com/` | 200 |
| `/coach.html` | 200 |
| `/account.html` | 200 |
| `/api/availability` | 200 |
| `/api/slots?date=2026-10-20` | 200 (`booked:[]` shape OK) |
| `/api/booking-db` | 404 (not on Production — expected) |
| `/api/probe-private-cas` | 404 (not on Production — expected) |

Under current Production (Blob-authoritative, no PG flags), customer booking, memberships, credits, Stripe, and Coach Desk continue on existing paths. Merging tip without env changes preserves that.

---

## 5. Rollback procedure review — **PASS** with mandatory rules

Unsafe pattern (documented, must never use after PG writes were live):

- Set `BOOKING_READS_ENABLED=0` while newer bookings exist only in Postgres → **stale Blob hides PG lessons**.

Safe rollback (from readiness docs; still required at cutover time):

1. Freeze checkouts.  
2. Set `BOOKING_WRITES_ENABLED=0` first.  
3. Keep `BOOKING_READS_ENABLED=1` if PG data is good.  
4. Export PG actives before any Blob restore.  
5. **Never** re-activate pre-cutover Blob capacity as authority without re-exporting PG → Blob (or using a Blob backup taken *after* last good reconcile).  
6. Never use `BOOKING_DUAL_WRITE_BLOB=1` as a fix.

---

## 6. Stripe recovery authorization — **PASS**

| Endpoint | Auth |
| --- | --- |
| `/api/reconcile-paid` | `Authorization: Bearer CRON_SECRET` **or** `x-vercel-cron` **or** coach pass |
| `/api/booking-db` reconcile/credit/alert actions | Coach pass **and** `assertPreviewDbAllowed` (Production blocked unless explicitly allowed) |

Unauthenticated callers get **401**. Mode `blob` → reconcile no-ops. No public trigger for mirror writes.

---

## 7. Paid-unmirrored capacity double-count — **PASS**

- Postgres occupancy loads first when reads/writes on.  
- Stripe paid search runs after; `occupancyHasStripeSource` skips PI already present as `${pi}-N` / `sourceRef`.  
- Covered by `test/stripePaidReconcile.test.js` (occupancy + unmirrored seat tests).

---

## 8. Local regression suite — **PASS**

```
node --test --test-concurrency=1
# tests 385
# pass 383
# fail 0
# skipped 2   (mock.module CAS tests — Node build limitation)
```

---

## 9. Step-by-step release checklist (stop gates)

Each step requires **explicit approval** before proceeding to the next.

| Step | Action | Stop gate — do not proceed until |
| --- | --- | --- |
| **G0** | This prep report accepted | Owner confirms sequence |
| **G1** | Merge #68→#69→#71→#72→#73→#74→#75 to `main` (**skip #70**); deploy Production **without** adding `BOOKING_*` | Production still Blob-only; smoke homepage/slots/coach |
| **G2** | Production Blob backup (lessons, manual, holds, members, finance, settings, availability) | Backup verified/restorable |
| **G3** | Create **new** Production Neon DB; apply `db/schema.sql`; set `BOOKING_DATABASE_URL` (+ pool vars); set `BOOKING_STORE=postgres`; keep **`BOOKING_READS_ENABLED=0`**, **`BOOKING_WRITES_ENABLED=0`** | Status proves reads=false, writes=false |
| **G4** | Blob→PG import (idempotent); Blob↔PG reconcile to **0** mismatches on active future lessons | Reconcile report clean |
| **G5** | Enable Production **`BOOKING_READS_ENABLED=1` only** (writes stay 0) | Coach/slots `occupancy_source=postgres`; fail-closed verified |
| **G6** | Read soak (peak window); wire `/api/reconcile-paid` cron + alert watch | No occupancy/credit anomalies |
| **G7** | Resend + Stripe live webhook verification (no credential rotation in-agent) | Confirm email + webhook OK |
| **G8** | Brief checkout freeze; final delta import/reconcile | Freeze acknowledged |
| **G9** | Enable Production **`BOOKING_WRITES_ENABLED=1`** (never `BOOKING_DUAL_WRITE_BLOB`) | Controlled smoke: checkout, cash, collect, reschedule |
| **G10** | Unfreeze; 24–48h monitor (webhook 503s, reconcile alerts, Neon) | Stable |

---

## 10. Precise first action that requires your approval

**Approve merge of the stack to `main` in order `#68 → #69 → #71 → #72 → #73 → #74 → #75` (skip `#70`), with Production deploy that does NOT add any `BOOKING_*` environment variables.**

That is **G1** only. It does not create a Production database, does not enable reads/writes, and does not migrate data.

---

## Explicitly not done

- No PR merges  
- No Production deploy  
- No Production database creation  
- No Production/Preview env var changes  
- No booking writes enabled  
- No live payments  
- No customer/Blob data modifications  
