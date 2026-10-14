/**
 * Authoritative system of record for AP Academy booking cutover.
 *
 * When BOOKING_READS_ENABLED=1 and BOOKING_WRITES_ENABLED=1:
 *   - Lesson / hold / manual capacity rows → PostgreSQL
 *   - Stripe PaymentIntent / Checkout Session money state → Stripe
 *   - Members cards, freezes, cash membership period fields → Blob members store
 *   - Finance ledger (cash collected, card totals) → Blob finance.json
 *   - Settings / availability / site status → existing Blob/config stores
 *
 * When reads=1 and writes=0:
 *   - Occupancy reads → PostgreSQL (+ Blob bridge for Blob-only rows)
 *   - New capacity mutations → Blob (until writes enabled)
 *   - Stripe paid search remains a safety net for paid-unmirrored seats
 *
 * Reconciliation never deletes another customer's Postgres reservation.
 */

export const AUTHORITY = Object.freeze({
  bookingCapacity: {
    withWrites: "postgres",
    readsOnly: "postgres_with_blob_bridge",
    blobFallback: "forbidden_when_reads_fail_closed",
  },
  stripePayments: "stripe",
  membershipRosterCards: "blob_members",
  membershipCreditsPortal: "lesson_schedule_count", // membershipSummary / scheduledFor
  membershipCreditsLedger: "postgres_membership_credits", // enforced on memberBook
  financeLedger: "blob_finance",
  settingsAvailability: "blob_or_config",
});

export function authorityMatrix() {
  return {
    postgresAuthoritative: [
      "active/held/cancelled booking rows (capacity)",
      "checkout holds when BOOKING_WRITES_ENABLED=1",
      "membership_credits ledger for portal book/cancel",
      "reconcile_alerts for paid mirror conflicts",
      "idempotency_keys for confirmPaid / webhooks",
    ],
    stripeAuthoritative: [
      "payment_status / amount captured",
      "Checkout Session + PaymentIntent metadata",
      "subscription period for Stripe memberships",
      "confirmation_sent flag on PI/subscription metadata",
    ],
    blobAuthoritative: [
      "members cards (cash membership periods, freezes, balances)",
      "finance.json ledger entries",
      "settings / prices / site status",
      "availability.json",
    ],
    neverDo: [
      "Auto-evict a seated customer to seat a paid-unmirrored payment",
      "Dual-write Blob capacity when BOOKING_WRITES_ENABLED=1",
      "Treat Blob lessons as occupancy authority when Postgres reads fail (fail closed)",
      "Reactivate stale pre-cutover Blob capacity without re-exporting from Postgres",
    ],
  };
}
