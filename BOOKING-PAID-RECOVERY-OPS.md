# Paid booking recovery — operator procedure

Use when Stripe shows **paid** but Postgres has no active mirror, or when `/api/reconcile-paid` / Coach `booking-db?action=reconcile_alerts` reports open alerts.

## Automatic path (preferred)

1. Ensure Preview/Production BookingStore flags: `BOOKING_STORE=postgres`, reads on as intended.
2. Run reconcile (no new charges):
   - Cron: `GET/POST /api/reconcile-paid` (CRON_SECRET or coach key)
   - Coach: `POST /api/booking-db` `{ action: "reconcile_stripe_paid", key, lookbackHours: 48 }`
3. Outcomes:
   - `mirrored` / `already_mirrored` — done
   - `deferred` (writes off) — seat still held via Stripe paid search safety net while reads on; enable writes only in an approved window, then re-run
   - `alert_operator` — **manual recovery required** (see below)

## Manual recovery when capacity blocks the paid customer

**Never cancel another family’s active lesson to “make room” without speaking to them.**

1. Open alert: `GET /api/booking-db?action=reconcile_alerts&key=…`
2. Note `source_ref` (PaymentIntent), session, date/time, email, player.
3. In Stripe Dashboard, confirm payment succeeded (do not refund yet).
4. In Coach Desk / slots, inspect who occupies that hour.
5. Choose one:
   - **A. Offer the paid customer a different open hour** (same focus rules) → Coach create or member reschedule after documenting the PI in the note; mark alert `resolved`.
   - **B. If the seated booking is a clear duplicate/error of the same payment** → cancel only that erroneous row, re-run reconcile.
   - **C. Refund / makeup credit** if no acceptable slot — process refund in Stripe Dashboard; resolve alert as `ignored` with note.
6. Re-run reconcile to confirm no open alert remains for that `source_ref`.

## Credit / finance consistency checks

| Question | Where to look |
| --- | --- |
| Portal lessons left | Member portal / `membershipSummary` (counts scheduled lessons) |
| PG ledger | `GET /api/booking-db?action=credit_audit` — sync raises ledger to lesson count, never lowers |
| Cash collected | Coach collect_payment → PG payload + Blob `finance.json` |
| Card payments | Stripe + Blob finance entry on confirm |

## Authority reminder

- **Postgres:** booking capacity rows, holds (when writes on), credit ledger, reconcile alerts  
- **Stripe:** money captured, session metadata  
- **Blob:** members cards, finance ledger, settings  

Do **not** re-activate stale Blob capacity files as the schedule authority after a Postgres cutover.
