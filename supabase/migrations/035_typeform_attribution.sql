-- 035_typeform_attribution.sql
-- Typeform → ads attribution.
--
-- Stores every Typeform response (both restoration h4il4Sla and electrician
-- WndFLJux funnels), classifies the revenue tier, and exposes three rollup
-- views that join responses to the existing public.ads / ad_daily_stats /
-- ghl_appointments tables so /sales/ads/performance can show:
--
--   cost / lead          = spend(30d, USD)  / leads
--   cost / qual lead     = spend           / qualified leads
--   cost / booked        = spend           / leads that matched a GHL appt
--   cost / qual booked   = spend           / qualified leads that matched
--   cost / live          = spend           / appts with outcome IN (showed, closed, not_closed)
--   cost / close         = spend           / appts with outcome = closed
--
-- Lead → ad join key:  typeform_responses.utm_content == ads.ad_name (exact)
--                      fallback: typeform_responses.utm_term == ads.adset_id (adset-level only)
-- Lead → booking join: ghl_appointments matched by lower(email) → phone digits → fullname.
--
-- Idempotent.  Apply via: supabase db push.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1 · typeform_responses table
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.typeform_responses (
  response_id      TEXT PRIMARY KEY,
  form_id          TEXT NOT NULL,
  form_name        TEXT,
  landed_at        TIMESTAMPTZ,
  submitted_at     TIMESTAMPTZ,
  first_name       TEXT,
  last_name        TEXT,
  email            TEXT,
  phone            TEXT,
  revenue_tier     TEXT,
  tier             TEXT CHECK (tier IN ('qualified','unqualified','abandoned')),
  qualified        BOOLEAN GENERATED ALWAYS AS (tier = 'qualified') STORED,
  ending_screen    TEXT,
  utm_source       TEXT,
  utm_medium       TEXT,
  utm_campaign     TEXT,
  utm_term         TEXT,
  utm_content      TEXT,
  ad_id            TEXT,
  raw_payload      JSONB,
  synced_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_tfr_form        ON public.typeform_responses(form_id);
CREATE INDEX IF NOT EXISTS ix_tfr_campaign    ON public.typeform_responses(utm_campaign);
CREATE INDEX IF NOT EXISTS ix_tfr_content     ON public.typeform_responses(utm_content);
CREATE INDEX IF NOT EXISTS ix_tfr_term        ON public.typeform_responses(utm_term);
CREATE INDEX IF NOT EXISTS ix_tfr_ad_id       ON public.typeform_responses(ad_id) WHERE ad_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tfr_email_lower ON public.typeform_responses(lower(email));
CREATE INDEX IF NOT EXISTS ix_tfr_phone       ON public.typeform_responses(phone);
CREATE INDEX IF NOT EXISTS ix_tfr_submitted   ON public.typeform_responses(submitted_at DESC);

ALTER TABLE public.typeform_responses ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tfr_read_authenticated ON public.typeform_responses
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY tfr_all_service_role ON public.typeform_responses
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT ON public.typeform_responses TO anon, authenticated;
GRANT ALL    ON public.typeform_responses TO service_role;

-- ─────────────────────────────────────────────────────────────────
-- 2 · Helper: digits-only phone normalizer used in the view's join.
--     (regexp_replace inline twice would slow the planner.)
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.digits_only(t TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT NULLIF(regexp_replace(COALESCE(t,''), '\D', '', 'g'), '') $$;

-- ─────────────────────────────────────────────────────────────────
-- 3 · lib_typeform_ad_attribution  —  per ad_id rollup
-- ─────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.lib_typeform_ad_attribution CASCADE;
CREATE VIEW public.lib_typeform_ad_attribution AS
WITH lead_match AS (
  SELECT
    tfr.response_id,
    tfr.ad_id,
    tfr.utm_term     AS adset_id,
    tfr.utm_campaign,
    tfr.qualified,
    (
      SELECT a.ghl_event_id
      FROM public.ghl_appointments a
      WHERE
            (tfr.email IS NOT NULL AND lower(a.contact_email) = lower(tfr.email))
         OR (public.digits_only(tfr.phone) IS NOT NULL
             AND public.digits_only(a.contact_phone) IS NOT NULL
             AND right(public.digits_only(tfr.phone), 10) = right(public.digits_only(a.contact_phone), 10))
      ORDER BY a.booked_at DESC NULLS LAST
      LIMIT 1
    ) AS matched_event_id
  FROM public.typeform_responses tfr
),
joined AS (
  SELECT lm.*, a.outcome, a.revenue, a.cash_collected
  FROM lead_match lm
  LEFT JOIN public.ghl_appointments a ON a.ghl_event_id = lm.matched_event_id
)
SELECT
  ad_id,
  count(*)                                                                AS leads,
  count(*) FILTER (WHERE qualified)                                       AS qualified_leads,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL)                    AS booked_calls,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL AND qualified)      AS qualified_booked_calls,
  count(*) FILTER (WHERE outcome IN ('showed','closed','not_closed'))     AS live_calls,
  count(*) FILTER (WHERE outcome = 'closed')                              AS closes,
  COALESCE(sum(revenue)        FILTER (WHERE outcome = 'closed'), 0)      AS revenue_attributed,
  COALESCE(sum(cash_collected) FILTER (WHERE outcome = 'closed'), 0)      AS cash_attributed
FROM joined
WHERE ad_id IS NOT NULL
GROUP BY ad_id;

GRANT SELECT ON public.lib_typeform_ad_attribution TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 4 · lib_typeform_adset_attribution  —  per adset_id rollup
-- ─────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.lib_typeform_adset_attribution CASCADE;
CREATE VIEW public.lib_typeform_adset_attribution AS
WITH lead_match AS (
  SELECT
    tfr.response_id,
    tfr.utm_term AS adset_id,
    tfr.utm_campaign,
    tfr.qualified,
    (
      SELECT a.ghl_event_id
      FROM public.ghl_appointments a
      WHERE (tfr.email IS NOT NULL AND lower(a.contact_email) = lower(tfr.email))
         OR (public.digits_only(tfr.phone) IS NOT NULL
             AND public.digits_only(a.contact_phone) IS NOT NULL
             AND right(public.digits_only(tfr.phone), 10) = right(public.digits_only(a.contact_phone), 10))
      ORDER BY a.booked_at DESC NULLS LAST LIMIT 1
    ) AS matched_event_id
  FROM public.typeform_responses tfr
),
joined AS (
  SELECT lm.*, a.outcome, a.revenue, a.cash_collected
  FROM lead_match lm
  LEFT JOIN public.ghl_appointments a ON a.ghl_event_id = lm.matched_event_id
)
SELECT
  adset_id,
  count(*)                                                                AS leads,
  count(*) FILTER (WHERE qualified)                                       AS qualified_leads,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL)                    AS booked_calls,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL AND qualified)      AS qualified_booked_calls,
  count(*) FILTER (WHERE outcome IN ('showed','closed','not_closed'))     AS live_calls,
  count(*) FILTER (WHERE outcome = 'closed')                              AS closes,
  COALESCE(sum(revenue)        FILTER (WHERE outcome = 'closed'), 0)      AS revenue_attributed,
  COALESCE(sum(cash_collected) FILTER (WHERE outcome = 'closed'), 0)      AS cash_attributed
FROM joined
WHERE adset_id IS NOT NULL
GROUP BY adset_id;

GRANT SELECT ON public.lib_typeform_adset_attribution TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 5 · lib_typeform_campaign_attribution  —  per utm_campaign rollup
-- ─────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.lib_typeform_campaign_attribution CASCADE;
CREATE VIEW public.lib_typeform_campaign_attribution AS
WITH lead_match AS (
  SELECT
    tfr.response_id,
    tfr.utm_campaign,
    tfr.qualified,
    (
      SELECT a.ghl_event_id
      FROM public.ghl_appointments a
      WHERE (tfr.email IS NOT NULL AND lower(a.contact_email) = lower(tfr.email))
         OR (public.digits_only(tfr.phone) IS NOT NULL
             AND public.digits_only(a.contact_phone) IS NOT NULL
             AND right(public.digits_only(tfr.phone), 10) = right(public.digits_only(a.contact_phone), 10))
      ORDER BY a.booked_at DESC NULLS LAST LIMIT 1
    ) AS matched_event_id
  FROM public.typeform_responses tfr
),
joined AS (
  SELECT lm.*, a.outcome, a.revenue, a.cash_collected
  FROM lead_match lm
  LEFT JOIN public.ghl_appointments a ON a.ghl_event_id = lm.matched_event_id
)
SELECT
  utm_campaign,
  count(*)                                                                AS leads,
  count(*) FILTER (WHERE qualified)                                       AS qualified_leads,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL)                    AS booked_calls,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL AND qualified)      AS qualified_booked_calls,
  count(*) FILTER (WHERE outcome IN ('showed','closed','not_closed'))     AS live_calls,
  count(*) FILTER (WHERE outcome = 'closed')                              AS closes,
  COALESCE(sum(revenue)        FILTER (WHERE outcome = 'closed'), 0)      AS revenue_attributed,
  COALESCE(sum(cash_collected) FILTER (WHERE outcome = 'closed'), 0)      AS cash_attributed
FROM joined
WHERE utm_campaign IS NOT NULL
GROUP BY utm_campaign;

GRANT SELECT ON public.lib_typeform_campaign_attribution TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
