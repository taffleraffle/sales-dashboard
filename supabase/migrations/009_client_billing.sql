-- Add billing/renewal tracking to clients
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_day INTEGER; -- day of month retainer is due (1-28)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS next_billing_date DATE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_count INTEGER DEFAULT 0; -- how many payments received (0=none, 1=trial, 2=month1, etc)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS current_payment_number INTEGER DEFAULT 0; -- which payment they're on

-- Add payment_number to payments table so we know which payment this was
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_number INTEGER; -- 0=trial, 1=month1, 2=month2, 3=month3

-- Grant access
GRANT ALL ON clients TO anon, authenticated, service_role;
GRANT ALL ON payments TO anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
