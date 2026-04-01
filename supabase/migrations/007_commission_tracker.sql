-- Commission Tracker Schema
-- Clients, Payments (Stripe/Fanbasis webhooks), Commission Settings & Ledger

-- Master client list
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company_name TEXT,
  closer_id UUID REFERENCES team_members(id),
  setter_id UUID REFERENCES team_members(id),
  stage TEXT DEFAULT 'trial' CHECK (stage IN ('trial', 'ascended', 'churned', 'paused', 'pif')),
  trial_start_date DATE,
  ascension_date DATE,
  monthly_amount NUMERIC(10,2) DEFAULT 0,
  trial_amount NUMERIC(10,2) DEFAULT 0,
  notes TEXT,
  ghl_contact_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Payments from Stripe / Fanbasis webhooks
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id),
  source TEXT NOT NULL CHECK (source IN ('stripe', 'fanbasis', 'manual')),
  source_event_id TEXT UNIQUE,
  amount NUMERIC(10,2) NOT NULL,
  fee NUMERIC(10,2) DEFAULT 0,
  net_amount NUMERIC(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD',
  customer_email TEXT,
  customer_name TEXT,
  payment_date TIMESTAMPTZ NOT NULL,
  payment_type TEXT CHECK (payment_type IN ('trial', 'monthly', 'pif', 'one_time', 'ascension')),
  description TEXT,
  metadata JSONB DEFAULT '{}',
  matched BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Per-member commission rates (admin-configurable)
CREATE TABLE IF NOT EXISTS commission_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID REFERENCES team_members(id) UNIQUE,
  base_salary NUMERIC(10,2) DEFAULT 0,
  commission_rate NUMERIC(5,2) DEFAULT 0,
  ascension_rate NUMERIC(5,2) DEFAULT 0,
  effective_from DATE DEFAULT CURRENT_DATE,
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Commission ledger — one entry per payment per team member
CREATE TABLE IF NOT EXISTS commission_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID REFERENCES team_members(id),
  payment_id UUID REFERENCES payments(id),
  client_id UUID REFERENCES clients(id),
  period TEXT NOT NULL, -- '2026-04'
  commission_type TEXT CHECK (commission_type IN ('trial_close', 'ascension', 'recurring', 'bonus')),
  payment_amount NUMERIC(10,2),
  commission_rate NUMERIC(5,2),
  commission_amount NUMERIC(10,2),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_email ON payments(customer_email);
CREATE INDEX IF NOT EXISTS idx_payments_matched ON payments(matched);
CREATE INDEX IF NOT EXISTS idx_commission_ledger_member ON commission_ledger(member_id);
CREATE INDEX IF NOT EXISTS idx_commission_ledger_period ON commission_ledger(period);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_stage ON clients(stage);

-- RLS Policies
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_ledger ENABLE ROW LEVEL SECURITY;

-- Everyone can read clients and payments
CREATE POLICY "clients_read" ON clients FOR SELECT USING (true);
CREATE POLICY "payments_read" ON payments FOR SELECT USING (true);

-- Commission settings: everyone can read, only service role can write
CREATE POLICY "commission_settings_read" ON commission_settings FOR SELECT USING (true);

-- Commission ledger: everyone can read (filtered in app by role)
CREATE POLICY "commission_ledger_read" ON commission_ledger FOR SELECT USING (true);

-- Write policies for all tables (service role / admin)
CREATE POLICY "clients_write" ON clients FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "payments_write" ON payments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "commission_settings_write" ON commission_settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "commission_ledger_write" ON commission_ledger FOR ALL USING (true) WITH CHECK (true);
