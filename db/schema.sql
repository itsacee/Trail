-- AP Academy authoritative booking store (Preview-first).
-- Apply only to a Preview-dedicated database. Never point Preview at Production.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- One row per hour slot; locked with FOR UPDATE during admission.
CREATE TABLE IF NOT EXISTS slot_locks (
  location_key text NOT NULL,
  slot_date date NOT NULL,
  time_label text NOT NULL,
  PRIMARY KEY (location_key, slot_date, time_label)
);

CREATE TABLE IF NOT EXISTS bookings (
  id text PRIMARY KEY,
  source text NOT NULL,
  source_ref text,
  status text NOT NULL CHECK (status IN ('held', 'active', 'cancelled', 'voided')),
  slot_date date NOT NULL,
  time_label text NOT NULL,
  mins integer NOT NULL DEFAULT 60 CHECK (mins > 0),
  location_key text NOT NULL DEFAULT 'mustang',
  focus text NOT NULL DEFAULT '',
  privacy text NOT NULL DEFAULT 'standard' CHECK (privacy IN ('standard', 'private')),
  seats integer NOT NULL CHECK (seats >= 1 AND seats <= 2),
  email text,
  player text,
  player2 text,
  parent text,
  phone text,
  booking_type text,
  membership_id text,
  stripe_pi text,
  stripe_session text,
  athletes integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  hold_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);

CREATE INDEX IF NOT EXISTS bookings_slot_active_idx
  ON bookings (location_key, slot_date, time_label)
  WHERE status IN ('held', 'active');

CREATE INDEX IF NOT EXISTS bookings_email_idx
  ON bookings (lower(email))
  WHERE status IN ('held', 'active');

CREATE INDEX IF NOT EXISTS bookings_stripe_session_idx
  ON bookings (stripe_session)
  WHERE stripe_session IS NOT NULL;

CREATE INDEX IF NOT EXISTS bookings_source_ref_idx
  ON bookings (source_ref)
  WHERE source_ref IS NOT NULL;

-- Stripe / confirm idempotency (safe webhook retries).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text PRIMARY KEY,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Membership credit ledger used with booking transactions.
CREATE TABLE IF NOT EXISTS membership_credits (
  membership_id text PRIMARY KEY,
  email text NOT NULL,
  tier text NOT NULL DEFAULT 'standard',
  credits_total integer NOT NULL DEFAULT 4 CHECK (credits_total >= 0),
  credits_used integer NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (credits_used <= credits_total)
);

INSERT INTO schema_migrations (id) VALUES ('001_booking_core')
ON CONFLICT (id) DO NOTHING;
