-- 110_payments_stripe_columns.sql
-- The deployed `payments` table predates the columns the Stripe code expects,
-- so both the stripe-webhook AND the sync-stripe backfill were silently failing
-- their upserts (payments stuck at 4 rows). This brings the table up to the
-- schema the code already writes against. Additive + idempotent.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS source_event_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fee             NUMERIC(12,2) DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS net_amount      NUMERIC(12,2);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_date    TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS metadata        JSONB DEFAULT '{}';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_id       UUID REFERENCES clients(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS matched         BOOLEAN DEFAULT false;

-- Idempotency key for both the webhook (event id) and the backfill (charge id).
-- Plain unique index (not partial) so PostgREST upsert onConflict can target it;
-- Postgres treats NULLs as distinct, so legacy rows with NULL don't clash.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_source_event_id
  ON payments(source_event_id);

CREATE INDEX IF NOT EXISTS idx_payments_client    ON payments(client_id);
CREATE INDEX IF NOT EXISTS idx_payments_paydate   ON payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_source    ON payments(source);
