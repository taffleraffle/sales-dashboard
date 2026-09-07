-- 182: run the unbooked-lead alerter every minute (Ben, 7 Sep 2026)
--
-- Chases Australian leads with no call booked 3 minutes after the lead posts
-- into #marketing-aus-leads. Checking every minute keeps the alert close to
-- that promise; the function is idempotent (lead_unbooked_alerts holds one row
-- per message it has replied to), so extra runs are no-ops.
--
-- Called the same way as the other scheduled functions here: net.http_get
-- against a function deployed with --no-verify-jwt. Unlike the others this one
-- posts to Slack, so it checks a shared secret passed as ?key=.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('unbooked-lead-alert')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'unbooked-lead-alert');

SELECT cron.schedule(
    'unbooked-lead-alert',
    '* * * * *',
    $job$
    SELECT net.http_get(
      url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/unbooked-lead-alert?key=__CRON_SECRET__',
      timeout_milliseconds := 25000
    );
    $job$
);
