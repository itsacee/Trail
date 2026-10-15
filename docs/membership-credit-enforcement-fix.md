# Membership credit enforcement fix

## Problem
Stripe checkout-mirrored membership lessons could be stored with `stripe_pi` set and `membership_id` empty. Postgres `memberBook` counted only `membership_id`, so the ledger could lag (e.g. 3 used / 1 remaining) while the real schedule had 4 attributed lessons — a latent path to a fifth booking.

## Fix (this PR)
1. Attribute membership checkouts at `confirmPaid` time: set `membership_id` to the payment intent / subscription id.
2. Count active lessons for a purchase via `membership_id` **or** `stripe_pi` (and membership `source_ref`), without pooling by email.
3. Re-count after insert; roll back if attributed lessons would exceed 4.
4. Serialize per-membership booking in-process (plus existing `FOR UPDATE`).
5. Cancel/restore and audit/sync helpers use the same attribution.
6. Portal post-mutation display never lets a lagging ledger inflate remaining above the schedule count.

## Not in this PR
- Production data backfills (separate owner-approved plan)
- Production deploy / env flag changes
- Cancelling or moving customer lessons
