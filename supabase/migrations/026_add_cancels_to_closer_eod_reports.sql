-- Add nc_cancels + fu_cancels columns to closer_eod_reports.
--
-- Previously closers had no way to mark a call as "canceled" — only no_show,
-- rescheduled, not_closed, closed, ascended. So a prospect who explicitly
-- cancelled (before the call happened) was being marked as a no-show, which
-- artificially dragged show rates down.
--
-- The Marketing page already has cancelled_dtf + cancelled_by_prospect
-- columns and net_show_rate already subtracts cancels from the denominator —
-- this migration just lets the closer EOD form feed cancels into that path.

ALTER TABLE closer_eod_reports
  ADD COLUMN IF NOT EXISTS nc_cancels INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fu_cancels INT DEFAULT 0;

NOTIFY pgrst, 'reload schema';
