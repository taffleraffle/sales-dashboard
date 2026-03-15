-- Fix RLS policies for marketing_tracker and marketing_benchmarks
-- These tables have RLS enabled but no policy for authenticated users

-- marketing_tracker: allow all authenticated users full access
CREATE POLICY "Allow authenticated read marketing_tracker"
  ON marketing_tracker FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated insert marketing_tracker"
  ON marketing_tracker FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Allow authenticated update marketing_tracker"
  ON marketing_tracker FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow authenticated delete marketing_tracker"
  ON marketing_tracker FOR DELETE TO authenticated USING (true);

-- marketing_benchmarks: allow all authenticated users full access
CREATE POLICY "Allow authenticated read marketing_benchmarks"
  ON marketing_benchmarks FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated insert marketing_benchmarks"
  ON marketing_benchmarks FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Allow authenticated update marketing_benchmarks"
  ON marketing_benchmarks FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow authenticated delete marketing_benchmarks"
  ON marketing_benchmarks FOR DELETE TO authenticated USING (true);
