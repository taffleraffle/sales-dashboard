-- 181: remember which lead posts we have already chased (Ben, 7 Sep 2026)
--
-- "If a lead comes through and they don't have a meeting booked within 3
-- minutes, mention me in that lead message in the Marketing Oz leads channel."
--
-- The alerter reads the channel's own messages rather than hooking each lead
-- source, so it covers Typeform leads, Facebook lead-form leads and anything
-- added later without further plumbing. This table is the idempotency ledger:
-- one row per Slack message we have replied to, so nobody gets chased twice.

CREATE TABLE IF NOT EXISTS public.lead_unbooked_alerts (
    message_ts   text PRIMARY KEY,          -- Slack ts of the original lead post
    channel_id   text NOT NULL,
    lead_email   text,
    lead_phone   text,
    lead_name    text,
    posted_at    timestamptz,               -- when the lead post appeared
    alerted_at   timestamptz NOT NULL DEFAULT now(),
    outcome      text NOT NULL              -- chased | booked_in_time | skipped
);

CREATE INDEX IF NOT EXISTS lead_unbooked_alerts_alerted_idx
    ON public.lead_unbooked_alerts (alerted_at DESC);
CREATE INDEX IF NOT EXISTS lead_unbooked_alerts_email_idx
    ON public.lead_unbooked_alerts (lower(lead_email));

-- Only the edge function (service role) touches this. RLS on so the anon key
-- cannot read lead contact details from the browser bundle.
ALTER TABLE public.lead_unbooked_alerts ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.lead_unbooked_alerts TO service_role;

NOTIFY pgrst, 'reload schema';
