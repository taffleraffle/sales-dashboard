-- 095_editor_auth_and_notifications.sql
--
-- Ben (2026-05-23): "Bake in a login function for the editing dashboard,
-- where everyone on the team can see everyone else's projects, but they
-- need to be able to log in to the editor panel. Please bake this in so
-- that we can then assign everyone notifications, and they can get
-- notified when we give them feedback, when we update a video, or when
-- we assign them new videos."
--
-- Schema:
--   - lib_creative_editors gains email + auth_user_id so we can match
--     a Supabase Auth user to their editor row. email is the join key
--     between "admin invited editor with email X" and "editor logged in
--     with email X".
--   - lib_editor_notifications stores one row per notifiable event.
--     kind discriminates: 'feedback' / 'assignment' / 'reassignment' /
--     'source_replaced' / 'approved'. Writers (client or trigger) insert,
--     editor portal reads + marks read.
--
-- Notifications are deliberately NOT a Postgres trigger here. The writers
-- live in the client (SubmissionsPanel.saveFeedback fires the insert,
-- task assignment paths fire on the assignment write). This keeps the
-- payload-building logic where the context already is. Triggers would
-- require RPCs to look up creative_name etc which gets noisy.
--
-- Email delivery is separate (Phase 2: Resend Edge Function). For now
-- notifications surface in the editor portal bell.

BEGIN;

-- Editor authentication fields ---------------------------------------------

ALTER TABLE public.lib_creative_editors
  ADD COLUMN IF NOT EXISTS email         TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Unique email (case-insensitive via lower()) so we don't allow two
-- editors with the same address. Partial so existing pre-email rows are
-- not subject to the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lib_creative_editors_email_unique
  ON public.lib_creative_editors(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lib_creative_editors_auth_user_id
  ON public.lib_creative_editors(auth_user_id) WHERE auth_user_id IS NOT NULL;

-- Notifications table ------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lib_editor_notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  editor_id       UUID NOT NULL REFERENCES public.lib_creative_editors(id) ON DELETE CASCADE,
  -- Discriminator. Open-coded (not an enum) so we can add new kinds without
  -- a migration; UI dispatches on the string. Known values:
  --   feedback         - admin left feedback on one of the editor's submissions
  --   assignment       - new task assigned to this editor
  --   reassignment     - existing task moved to this editor (or away from them)
  --   source_replaced  - admin uploaded a new source for a creative this
  --                       editor is assigned to (their existing cut may be
  --                       out of sync)
  --   approved         - admin approved a submission (positive closure)
  kind            TEXT NOT NULL,
  -- Optional context references — UI uses these to navigate to the right
  -- task/submission when the editor clicks the notification.
  task_id         UUID REFERENCES public.lib_editing_tasks(id) ON DELETE SET NULL,
  creative_id    UUID REFERENCES public.lib_creative_library(id) ON DELETE SET NULL,
  submission_id  UUID REFERENCES public.lib_task_submissions(id) ON DELETE SET NULL,
  -- Display copy. title is the bell-list one-liner; body is the optional
  -- secondary line / preview.
  title           TEXT NOT NULL,
  body            TEXT,
  -- Deep-link path within /editor-view that opens the relevant thing.
  -- e.g. '/editor-view?task=<task_id>' so we can scope-route into the
  -- task detail modal.
  link_path       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at         TIMESTAMPTZ,
  -- email_sent_at tracks whether the Resend Edge Function has dispatched
  -- the corresponding email. NULL = pending, set = sent. Resend retry is
  -- handled by re-queueing if email_sent_at is still NULL after N min.
  email_sent_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lib_editor_notifications_unread
  ON public.lib_editor_notifications(editor_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lib_editor_notifications_pending_email
  ON public.lib_editor_notifications(created_at) WHERE email_sent_at IS NULL;

-- RLS: same allow-all pattern as the other lib_* tables (this is an
-- internal tool, no public surface). The editor portal's queries are
-- scoped to the logged-in editor on the client side via the resolved
-- editor_id.
ALTER TABLE public.lib_editor_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lib_editor_notifications: read"  ON public.lib_editor_notifications;
DROP POLICY IF EXISTS "lib_editor_notifications: write" ON public.lib_editor_notifications;
CREATE POLICY "lib_editor_notifications: read"  ON public.lib_editor_notifications FOR SELECT USING (TRUE);
CREATE POLICY "lib_editor_notifications: write" ON public.lib_editor_notifications FOR ALL    USING (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lib_editor_notifications TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
