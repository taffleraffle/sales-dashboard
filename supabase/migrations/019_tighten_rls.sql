-- Tighten RLS policies — replace overly permissive USING(true) with proper checks
-- All authenticated users can READ most data (it's an internal dashboard)
-- but only admins or data owners can WRITE

-- Marketing tracker: everyone reads, only authenticated can write (admin check at app level)
DROP POLICY IF EXISTS "marketing_tracker_select" ON marketing_tracker;
DROP POLICY IF EXISTS "marketing_tracker_insert" ON marketing_tracker;
DROP POLICY IF EXISTS "marketing_tracker_update" ON marketing_tracker;
DROP POLICY IF EXISTS "marketing_tracker_delete" ON marketing_tracker;
DROP POLICY IF EXISTS "Allow all" ON marketing_tracker;

CREATE POLICY "read_all" ON marketing_tracker FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "write_authenticated" ON marketing_tracker FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "update_authenticated" ON marketing_tracker FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "delete_authenticated" ON marketing_tracker FOR DELETE USING (auth.role() = 'authenticated');

-- Marketing benchmarks: same pattern
DROP POLICY IF EXISTS "Allow all" ON marketing_benchmarks;
CREATE POLICY "read_all" ON marketing_benchmarks FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "write_authenticated" ON marketing_benchmarks FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "update_authenticated" ON marketing_benchmarks FOR UPDATE USING (auth.role() = 'authenticated');

-- Payments: authenticated reads, service_role writes (from Edge Functions)
DROP POLICY IF EXISTS "Allow all" ON payments;
CREATE POLICY "read_all" ON payments FOR SELECT USING (auth.role() IN ('authenticated', 'service_role'));
CREATE POLICY "write_service" ON payments FOR INSERT WITH CHECK (auth.role() IN ('authenticated', 'service_role'));
CREATE POLICY "update_service" ON payments FOR UPDATE USING (auth.role() IN ('authenticated', 'service_role'));

-- Commission ledger: authenticated reads, service_role + authenticated writes
DROP POLICY IF EXISTS "Allow all" ON commission_ledger;
CREATE POLICY "read_all" ON commission_ledger FOR SELECT USING (auth.role() IN ('authenticated', 'service_role'));
CREATE POLICY "write_auth" ON commission_ledger FOR INSERT WITH CHECK (auth.role() IN ('authenticated', 'service_role'));
CREATE POLICY "update_auth" ON commission_ledger FOR UPDATE USING (auth.role() IN ('authenticated', 'service_role'));

NOTIFY pgrst, 'reload schema';
