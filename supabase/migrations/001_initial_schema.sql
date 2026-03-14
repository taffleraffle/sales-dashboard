-- OPT Sales Dashboard — Initial Schema
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/kjfaqhmllagbxjdxlopm/sql/new

-- Team members
CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  role VARCHAR(50) NOT NULL, -- 'closer' or 'setter'
  email VARCHAR(200),
  ghl_user_id VARCHAR(100),
  commission_rate NUMERIC(5,2) DEFAULT 10,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed team
INSERT INTO team_members (name, role) VALUES
  ('Daniel', 'closer'),
  ('Josh', 'closer'),
  ('Leandre', 'setter'),
  ('Austin', 'setter'),
  ('Valeria', 'setter');

-- Marketing daily (auto-synced from Meta Ads API)
CREATE TABLE IF NOT EXISTS marketing_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  campaign_id VARCHAR(100),
  campaign_name VARCHAR(300),
  adset_id VARCHAR(100),
  adset_name VARCHAR(300),
  spend NUMERIC(12,2) DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  leads INTEGER DEFAULT 0,
  cpc NUMERIC(10,4),
  cpl NUMERIC(10,4),
  ctr NUMERIC(8,4),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(date, campaign_id, adset_id)
);

-- Attribution daily (auto-synced from Hyros API)
CREATE TABLE IF NOT EXISTS attribution_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  campaign_id VARCHAR(100),
  campaign_name VARCHAR(300),
  revenue_attributed NUMERIC(12,2) DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  roas NUMERIC(10,4),
  event_tag VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(date, campaign_id, event_tag)
);

-- Closer EOD reports
CREATE TABLE IF NOT EXISTS closer_eod_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  closer_id UUID NOT NULL REFERENCES team_members(id),
  report_date DATE NOT NULL,
  nc_booked INTEGER DEFAULT 0,
  fu_booked INTEGER DEFAULT 0,
  nc_no_shows INTEGER DEFAULT 0,
  fu_no_shows INTEGER DEFAULT 0,
  live_nc_calls INTEGER DEFAULT 0,
  live_fu_calls INTEGER DEFAULT 0,
  reschedules INTEGER DEFAULT 0,
  offers INTEGER DEFAULT 0,
  closes INTEGER DEFAULT 0,
  deposits INTEGER DEFAULT 0,
  offer1_collected NUMERIC(10,2) DEFAULT 0,
  offer1_revenue NUMERIC(10,2) DEFAULT 0,
  offer2_collected NUMERIC(10,2) DEFAULT 0,
  offer2_revenue NUMERIC(10,2) DEFAULT 0,
  total_revenue NUMERIC(10,2) DEFAULT 0,
  total_cash_collected NUMERIC(10,2) DEFAULT 0,
  notes TEXT,
  is_confirmed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(closer_id, report_date)
);

-- Individual closer calls (child of closer_eod_reports)
CREATE TABLE IF NOT EXISTS closer_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  eod_report_id UUID NOT NULL REFERENCES closer_eod_reports(id) ON DELETE CASCADE,
  call_type VARCHAR(20),
  prospect_name VARCHAR(200),
  showed BOOLEAN,
  outcome VARCHAR(20),
  revenue NUMERIC(10,2),
  cash_collected NUMERIC(10,2),
  setter_lead_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Setter EOD reports
CREATE TABLE IF NOT EXISTS setter_eod_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setter_id UUID NOT NULL REFERENCES team_members(id),
  report_date DATE NOT NULL,
  total_leads INTEGER DEFAULT 0,
  outbound_calls INTEGER DEFAULT 0,
  pickups INTEGER DEFAULT 0,
  meaningful_conversations INTEGER DEFAULT 0,
  unqualified INTEGER DEFAULT 0,
  sets INTEGER DEFAULT 0,
  reschedules INTEGER DEFAULT 0,
  self_rating INTEGER,
  what_went_well TEXT,
  what_went_poorly TEXT,
  overall_performance INTEGER,
  daily_summary TEXT,
  is_confirmed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(setter_id, report_date)
);

-- Setter leads (attribution backbone)
CREATE TABLE IF NOT EXISTS setter_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setter_id UUID NOT NULL REFERENCES team_members(id),
  closer_id UUID REFERENCES team_members(id),
  lead_name VARCHAR(200) NOT NULL,
  lead_source VARCHAR(200),
  date_set DATE NOT NULL,
  appointment_date DATE,
  status VARCHAR(20) DEFAULT 'set',
  revenue_attributed NUMERIC(10,2),
  eod_report_id UUID REFERENCES setter_eod_reports(id),
  closer_eod_report_id UUID REFERENCES closer_eod_reports(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Closer transcripts (auto-pulled from Fathom API)
CREATE TABLE IF NOT EXISTS closer_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  closer_id UUID NOT NULL REFERENCES team_members(id),
  fathom_meeting_id VARCHAR(200) UNIQUE,
  prospect_name VARCHAR(200),
  prospect_email VARCHAR(200),
  meeting_date DATE,
  duration_seconds INTEGER,
  summary TEXT,
  transcript_url VARCHAR(500),
  objections JSONB,
  outcome VARCHAR(30),
  revenue NUMERIC(10,2),
  ghl_calendar_event_id VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Objection analysis (Claude-analyzed patterns per closer)
CREATE TABLE IF NOT EXISTS objection_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  closer_id UUID NOT NULL REFERENCES team_members(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  objection_category VARCHAR(200),
  occurrence_count INTEGER DEFAULT 0,
  example_quotes JSONB,
  win_rate NUMERIC(6,2),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(closer_id, period_start, period_end, objection_category)
);

-- Benchmarks
CREATE TABLE IF NOT EXISTS sales_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key VARCHAR(100) NOT NULL UNIQUE,
  target_value NUMERIC(12,4) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed default benchmarks
INSERT INTO sales_benchmarks (metric_key, target_value, direction) VALUES
  ('cpl', 250, 'below'),
  ('lead_to_booking_pct', 40, 'above'),
  ('show_rate', 70, 'above'),
  ('offer_rate', 80, 'above'),
  ('close_rate', 25, 'above'),
  ('cpa', 3250, 'below'),
  ('roas', 2.0, 'above'),
  ('ascension_rate', 70, 'above'),
  ('dials_per_set', 30, 'below'),
  ('leads_to_set_pct', 5, 'above'),
  ('mcs_to_set_pct', 40, 'above');

-- Enable Row Level Security (open for now — add auth later)
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE closer_eod_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE closer_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE setter_eod_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE setter_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE closer_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE objection_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_benchmarks ENABLE ROW LEVEL SECURITY;

-- Allow anon access (no auth for now)
CREATE POLICY "Allow all" ON team_members FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON marketing_daily FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON attribution_daily FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON closer_eod_reports FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON closer_calls FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON setter_eod_reports FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON setter_leads FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON closer_transcripts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON objection_analysis FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON sales_benchmarks FOR ALL USING (true) WITH CHECK (true);
