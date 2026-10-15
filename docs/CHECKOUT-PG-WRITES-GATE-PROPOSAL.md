# Proposal: Checkout gate for Postgres booking writes (no Blob capacity writes)

**Status:** Superseded in part by `PUBLIC_BOOKING_ENABLED` (see `lib/publicBooking.js`).  
Customer-facing checkout/cash-book/member mutations now require **both**
`BOOKING_WRITES_ENABLED=1` and `PUBLIC_BOOKING_ENABLED=1`. Capacity writes alone
cannot reopen public booking.  
**Related:** G4 readiness / E8 collect fix PR.

## Problem

Production checkout is paused by:

```js
if (storeConfigured() && !capacityWritesEnabled()) {
  // 503 capacityWritesPaused
}
```

`CAPACITY_WRITES_ENABLED` gates **legacy Blob CAS** for holds/lessons/manual.  
Re-enabling it in Production to unpause checkout would reopen unsafe Blob capacity mutations.

When `BOOKING_WRITES_ENABLED=1`:

- `lib/holds.js` already reserves/releases holds via `dbReserveHold` / `dbReleaseHold` (Postgres).
- Confirm/webhook mirrors via `dbConfirmPaid`.
- Coach/member/cash-book mutations use BookingStore.

So checkout does **not** need Blob capacity writes once booking writes are on.

## Recommended gate (minimal)

In `api/checkout.js`, allow checkout when **either** Postgres booking writes are enabled **or** legacy capacity writes are enabled:

```js
import { bookingWritesEnabled } from "../lib/bookingDb/flags.js";

// Replace capacity-only pause with:
if (storeConfigured() && !capacityWritesEnabled() && !bookingWritesEnabled()) {
  res.status(503).json({
    error:
      "Online booking is temporarily paused while we restore the calendar. No payment was taken — please try again shortly or call (405) 819-4401.",
    code: "schedule_unavailable",
    capacityWritesPaused: true,
  });
  return;
}
```

## Safe Production activation order (after G4 blockers cleared)

1. Keep `CAPACITY_WRITES_ENABLED` **unset/0** in Production forever for capacity files (or until Blob is fully retired).  
2. Deploy this checkout gate change with writes still off (no behavior change).  
3. Enable `BOOKING_WRITES_ENABLED=1` only.  
4. Checkout unpauses because `bookingWritesEnabled()` is true; holds go to Postgres.  
5. Never set `BOOKING_DUAL_WRITE_BLOB=1`.  
6. Do not re-enable Blob CAS / capacity writes as a rollback.

## Why this is safer than enabling CAPACITY_WRITES

| Approach | Holds | Lessons/manual | Blob CAS risk |
| --- | --- | --- | --- |
| Enable `CAPACITY_WRITES` only | Blob | Blob (if booking writes off) | **High** |
| Enable `BOOKING_WRITES` + this gate | Postgres | Postgres | **None** (Blob capacity stays paused) |
| Enable both | Postgres (holds prefer booking writes) | Postgres | Residual if any path still calls Blob mutators |

## Out of scope for this proposal

- Enabling any Production flags  
- Dual-write to Blob  
- Changing Stripe keys or webhook endpoints  

## Suggested follow-up PR

Title: `Checkout: allow traffic when BOOKING_WRITES_ENABLED without CAPACITY_WRITES`  
Diff: ~5 lines in `api/checkout.js` + one unit test asserting pause when both flags off and allow when booking writes on.  
Do not merge until G4 E8 is fixed and Production write activation is explicitly approved.
