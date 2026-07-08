-- 032_bug_reports.sql
-- Troubleshoot tab: Ron / Ben / Jonas (any authenticated team member) file a
-- bug report with as much optional context as they want plus drag-and-drop
-- screenshots. Submitting fires the notify-bug-report Edge Function, which
-- posts the full report into #optimus-qa as Optimus.

CREATE TABLE IF NOT EXISTS public.bug_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  requester_auth_id  uuid REFERENCES auth.users(id),
  requester_name     text NOT NULL,
  title              text NOT NULL,
  urgency            text NOT NULL DEFAULT 'medium'
                       CHECK (urgency IN ('low','medium','high','critical')),
  page_location      text,
  what_happened      text,
  expected_behavior  text,
  steps_to_reproduce text,
  reproducibility    text CHECK (reproducibility IN ('every_time','sometimes','once', NULL)),
  browser_device     text,
  extra_notes        text,
  screenshot_paths   text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','in_progress','fixed','closed')),
  slack_ts           text,
  notified_at        timestamptz
);

CREATE INDEX IF NOT EXISTS bug_reports_created_at_idx ON public.bug_reports (created_at DESC);

ALTER TABLE public.bug_reports ENABLE ROW LEVEL SECURITY;

-- Whole team can see every report — QA is a shared surface.
DROP POLICY IF EXISTS "bug_reports select" ON public.bug_reports;
CREATE POLICY "bug_reports select"
  ON public.bug_reports FOR SELECT TO authenticated
  USING (true);

-- Anyone logged in can file a report, but only as themselves.
DROP POLICY IF EXISTS "bug_reports insert" ON public.bug_reports;
CREATE POLICY "bug_reports insert"
  ON public.bug_reports FOR INSERT TO authenticated
  WITH CHECK (requester_auth_id = auth.uid());

-- Requester or admin/manager can update (status changes, corrections).
DROP POLICY IF EXISTS "bug_reports update" ON public.bug_reports;
CREATE POLICY "bug_reports update"
  ON public.bug_reports FOR UPDATE TO authenticated
  USING (
    requester_auth_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.auth_user_id = auth.uid() AND up.role IN ('admin','manager')
    )
  );

GRANT SELECT, INSERT, UPDATE ON public.bug_reports TO authenticated;

-- ── Storage bucket for screenshots ─────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bug-screenshots',
  'bug-screenshots',
  false,                   -- private; viewed via signed URLs
  10485760,                -- 10 MB per image
  ARRAY['image/png','image/jpeg','image/gif','image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types,
    public             = EXCLUDED.public;

DROP POLICY IF EXISTS "bug-screenshots insert" ON storage.objects;
CREATE POLICY "bug-screenshots insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'bug-screenshots');

DROP POLICY IF EXISTS "bug-screenshots select" ON storage.objects;
CREATE POLICY "bug-screenshots select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'bug-screenshots');

DROP POLICY IF EXISTS "bug-screenshots delete" ON storage.objects;
CREATE POLICY "bug-screenshots delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'bug-screenshots' AND owner = auth.uid());

NOTIFY pgrst, 'reload schema';
