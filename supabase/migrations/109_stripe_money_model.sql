-- 109_stripe_money_model.sql
-- Subscription-aware money model. ROM sells mostly recurring subscriptions on
-- Stripe, so MRR/churn/AR cannot be derived from one-off charges. This adds the
-- tables the advanced sync-stripe function writes into: subscriptions (MRR),
-- invoices (recurring revenue + failed payments / AR), plus customer linkage and
-- a daily MRR snapshot for movement tracking (new / expansion / contraction / churn).

-- ---- client linkage + cached money-model fields -----------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS mrr_current      NUMERIC(12,2) DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS churn_date       DATE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_payment_date DATE;
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer ON clients(stripe_customer_id);

-- ---- subscriptions: the source of MRR ---------------------------------------
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  id                  TEXT PRIMARY KEY,            -- Stripe subscription id (sub_...)
  account_label       TEXT NOT NULL DEFAULT 'primary',
  stripe_customer_id  TEXT,
  client_id           UUID REFERENCES clients(id),
  customer_email      TEXT,
  customer_name       TEXT,
  status              TEXT,                        -- active|trialing|past_due|canceled|unpaid|incomplete
  mrr                 NUMERIC(12,2) DEFAULT 0,     -- normalized to monthly, USD
  currency            TEXT DEFAULT 'usd',
  interval            TEXT,                        -- month|year|week|day
  interval_count      INT DEFAULT 1,
  quantity            INT DEFAULT 1,
  unit_amount         NUMERIC(12,2),               -- price per interval (major units)
  product_name        TEXT,
  plan_nickname       TEXT,
  started_at          TIMESTAMPTZ,
  current_period_end  TIMESTAMPTZ,
  trial_end           TIMESTAMPTZ,
  canceled_at         TIMESTAMPTZ,
  raw                 JSONB DEFAULT '{}',
  synced_at           TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subs_status   ON stripe_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subs_client   ON stripe_subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_subs_customer ON stripe_subscriptions(stripe_customer_id);

-- ---- invoices: recurring revenue + AR + failed payments ---------------------
CREATE TABLE IF NOT EXISTS stripe_invoices (
  id                  TEXT PRIMARY KEY,            -- Stripe invoice id (in_...)
  account_label       TEXT NOT NULL DEFAULT 'primary',
  subscription_id     TEXT,
  stripe_customer_id  TEXT,
  client_id           UUID REFERENCES clients(id),
  customer_email      TEXT,
  status              TEXT,                        -- paid|open|void|uncollectible|draft
  amount_due          NUMERIC(12,2) DEFAULT 0,
  amount_paid         NUMERIC(12,2) DEFAULT 0,
  amount_remaining    NUMERIC(12,2) DEFAULT 0,
  currency            TEXT DEFAULT 'usd',
  period_start        TIMESTAMPTZ,
  period_end          TIMESTAMPTZ,
  due_date            TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  attempt_count       INT DEFAULT 0,
  raw                 JSONB DEFAULT '{}',
  synced_at           TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_status ON stripe_invoices(status);
CREATE INDEX IF NOT EXISTS idx_inv_client ON stripe_invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_inv_sub    ON stripe_invoices(subscription_id);

-- ---- link existing payments rows to Stripe objects --------------------------
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_invoice_id      TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS account_label          TEXT;

-- ---- daily MRR snapshot for movement (new/expansion/contraction/churn) ------
CREATE TABLE IF NOT EXISTS mrr_snapshots (
  snapshot_date  DATE NOT NULL,
  account_label  TEXT NOT NULL DEFAULT 'all',
  active_mrr     NUMERIC(12,2) DEFAULT 0,
  active_subs    INT DEFAULT 0,
  trialing_subs  INT DEFAULT 0,
  past_due_subs  INT DEFAULT 0,
  ar_outstanding NUMERIC(12,2) DEFAULT 0,   -- open + uncollectible invoice balance
  created_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (snapshot_date, account_label)
);

-- Daniel-only financial layer: lock these tables down at the DB level.
ALTER TABLE stripe_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_invoices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrr_snapshots        ENABLE ROW LEVEL SECURITY;
-- Service role (edge functions) bypasses RLS; app-facing read policies are added
-- in the Phase C financial-gating migration alongside the admin role check.
