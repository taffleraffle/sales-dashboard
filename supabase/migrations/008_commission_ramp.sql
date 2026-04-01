-- Add ramp pay type to commission_settings
ALTER TABLE commission_settings ADD COLUMN IF NOT EXISTS pay_type TEXT DEFAULT 'base' CHECK (pay_type IN ('base', 'ramp'));
ALTER TABLE commission_settings ADD COLUMN IF NOT EXISTS ramp_amount NUMERIC(10,2) DEFAULT 0;
