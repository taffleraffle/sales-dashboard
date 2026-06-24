-- 139_editor_invoice_duration.sql
-- Editor per-minute invoicing.
--
-- Editors are paid per minute of finished video. The Editor portal grows an
-- "Invoice" tab that lists each task's most-recent APPROVED submission, tallies
-- the total video time, and (when a rate is set) shows the pay at the editor's
-- flat per-minute rate.
--
-- Two pieces of state were missing:
--   1. Duration of each submitted cut. We measure it client-side at upload from
--      the <video> metadata (duration_source='auto'); if an editor pasted an
--      external review link instead of uploading the file, they type the length
--      in the Invoice tab (duration_source='manual').
--   2. The editor's flat $/minute rate, set by an admin in Manage Editors.

alter table public.lib_task_submissions
  add column if not exists duration_seconds numeric,
  add column if not exists duration_source  text
    check (duration_source in ('auto', 'manual'));

comment on column public.lib_task_submissions.duration_seconds is
  'Length of the submitted cut in seconds. Measured from <video> metadata at upload (auto) or entered by the editor in the Invoice tab (manual).';
comment on column public.lib_task_submissions.duration_source is
  'auto = measured from the uploaded file; manual = entered by the editor (used for external review links where we can''t read the file).';

alter table public.lib_creative_editors
  add column if not exists rate_per_minute numeric(10, 2);

comment on column public.lib_creative_editors.rate_per_minute is
  'Flat pay rate in dollars per finished minute of approved video. Used by the Editor portal Invoice tab.';

grant all on public.lib_task_submissions to service_role;
grant all on public.lib_creative_editors to service_role;

notify pgrst, 'reload schema';
