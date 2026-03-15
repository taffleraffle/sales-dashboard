-- Marketing Performance Tracker — full funnel daily entries
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/kjfaqhmllagbxjdxlopm/sql/new

-- Drop old table if it exists (safe — no prod data yet)
DROP TABLE IF EXISTS marketing_tracker;

CREATE TABLE marketing_tracker (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL UNIQUE,

  -- ═══ Ad Spend & Leads (auto-pullable from Meta Ads) ═══
  adspend NUMERIC(12,2) DEFAULT 0,
  leads INTEGER DEFAULT 0,

  -- ═══ Bookings & Cancellations (manual) ═══
  qualified_bookings INTEGER DEFAULT 0,
  cancelled_dtf INTEGER DEFAULT 0,           -- cancelled due to fit
  cancelled_by_prospect INTEGER DEFAULT 0,   -- cancelled/rescheduled by prospect

  -- ═══ Calls (auto-pullable from GHL + closer EODs) ═══
  net_new_calls INTEGER DEFAULT 0,           -- new calls on calendar
  net_fu_calls INTEGER DEFAULT 0,            -- follow-up calls on calendar
  new_live_calls INTEGER DEFAULT 0,          -- new calls actually taken (closer EOD live_nc)
  net_live_calls INTEGER DEFAULT 0,          -- total live calls taken (closer EOD live_nc + live_fu)

  -- ═══ Offers & Closes (auto-pullable from closer EODs) ═══
  offers INTEGER DEFAULT 0,
  closes INTEGER DEFAULT 0,

  -- ═══ Trial Financials (manual — finance team) ═══
  trial_cash NUMERIC(12,2) DEFAULT 0,
  trial_revenue NUMERIC(12,2) DEFAULT 0,     -- contracted revenue

  -- ═══ Ascension (manual) ═══
  ascensions INTEGER DEFAULT 0,
  ascend_cash NUMERIC(12,2) DEFAULT 0,
  ascend_revenue NUMERIC(12,2) DEFAULT 0,    -- contracted revenue

  -- ═══ AR & Refunds (manual — finance team) ═══
  ar_collected NUMERIC(12,2) DEFAULT 0,
  ar_defaulted NUMERIC(12,2) DEFAULT 0,
  refund_count INTEGER DEFAULT 0,
  refund_amount NUMERIC(12,2) DEFAULT 0,

  -- ═══ Meta ═══
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Benchmarks — one row per metric, editable from dashboard
CREATE TABLE IF NOT EXISTS marketing_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric VARCHAR(100) NOT NULL UNIQUE,
  value NUMERIC(12,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed default benchmarks
INSERT INTO marketing_benchmarks (metric, value) VALUES
  ('cpl', 42),
  ('lead_to_booking', 10),
  ('cpb', 425),
  ('show_rate_new', 70),
  ('show_rate_net', 70),
  ('close_rate', 25),
  ('offer_rate', 80),
  ('cpa_trial', 637),
  ('trial_fe_roas', 2),
  ('trial_uf_cash_pct', 48),
  ('ascend_rate', 50),
  ('cpa_ascend', 2000),
  ('ascend_uf_cash_pct', 200),
  ('net_fe_roas', 3.5),
  ('revenue_roas', 5),
  ('all_cash_roas', 4),
  ('ar_success_rate', 90)
ON CONFLICT (metric) DO NOTHING;

-- RLS
ALTER TABLE marketing_tracker ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_benchmarks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for anon" ON marketing_tracker FOR ALL TO anon USING (true) WITH CHECK (true);
DO $$ BEGIN
  CREATE POLICY "Allow all for anon" ON marketing_benchmarks FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_marketing_tracker_date ON marketing_tracker(date DESC);
