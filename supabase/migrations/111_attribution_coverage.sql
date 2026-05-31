-- Attribution Coverage Report (Ben 2026-05-31).
--
-- One function + two views that power /sales/marketing/coverage. The page is
-- the single pane of glass for "how bulletproof is our attribution chain right
-- now" so every later fix (Meta URL macros, VSL UTM forwarding, Lead-Form
-- mirror) moves a visible number here.
--
-- See: bulletproof-attribution-architecture.md memory for the architecture
-- decisions this consumes.
--
-- The chain (Meta ad → VSL page → Typeform → GHL contact → call → showed →
-- sale → paid) is computed end-to-end here. Each stage reports total /
-- traced / gap_value / coverage_pct so the user can see exactly where the
-- leaks are.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Function: attribution_coverage(p_from, p_to)
-- Returns one row per stage of the attribution chain for the date window.
-- ───────────────────────────────────────────────────────────────────────────

-- SECURITY DEFINER so anon can call it without each underlying table needing
-- a permissive RLS policy (most do not — they have service-role-only access).
-- The function returns only aggregate counts, no PII.
CREATE OR REPLACE FUNCTION public.attribution_coverage(
  p_from date,
  p_to date
)
RETURNS TABLE (
  stage_order   int,
  stage_key     text,
  stage_label   text,
  total         numeric,
  traced        numeric,
  gap           numeric,
  coverage_pct  numeric,
  unit          text          -- 'usd' or 'count'
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH
    -- 1. Spend window
    spend AS (
      SELECT
        COALESCE(SUM(spend), 0)::numeric AS total_spend,
        COUNT(DISTINCT ad_id) FILTER (WHERE spend > 0) AS spending_ads
      FROM ad_daily_stats
      WHERE date BETWEEN p_from AND p_to
    ),
    -- 2. Spend that has at least one typeform response resolved to ad_id
    spend_with_lead AS (
      SELECT COALESCE(SUM(ads_spend.spend), 0)::numeric AS traced_spend
      FROM (
        SELECT ad_id, SUM(spend) AS spend
        FROM ad_daily_stats
        WHERE date BETWEEN p_from AND p_to
        GROUP BY ad_id
      ) ads_spend
      WHERE ads_spend.ad_id IN (
        SELECT DISTINCT ad_id FROM typeform_responses
        WHERE ad_id IS NOT NULL
          AND submitted_at::date BETWEEN p_from AND p_to
      )
    ),
    -- 3. Typeform funnel — count-based stages
    tf AS (
      SELECT
        COUNT(*) AS total_submits,
        COUNT(*) FILTER (WHERE utm_campaign IS NOT NULL) AS with_utms,
        COUNT(*) FILTER (WHERE ad_id IS NOT NULL) AS with_ad_id
      FROM typeform_responses
      WHERE submitted_at::date BETWEEN p_from AND p_to
    ),
    -- 4. GHL contact match — typeform rows where the email exists in ghl_contacts
    ghl_match AS (
      SELECT COUNT(*) AS matched
      FROM typeform_responses tr
      WHERE tr.submitted_at::date BETWEEN p_from AND p_to
        AND tr.email IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ghl_contacts gc
          WHERE LOWER(gc.email) = LOWER(tr.email)
        )
    ),
    -- 5..8. Outcome stages — use the existing lib_typeform_response_outcome view
    outcomes AS (
      SELECT
        COUNT(*) FILTER (WHERE o.matched_event_id IS NOT NULL OR o.cc_outcome IS NOT NULL) AS booked,
        COUNT(*) FILTER (
          WHERE o.cc_showed = true
             OR o.appt_outcome IN ('showed','closed','not_closed')
             OR o.cc_outcome IN ('showed','closed','not_closed')
        ) AS showed,
        COUNT(*) FILTER (
          WHERE o.appt_outcome = 'closed' OR o.cc_outcome = 'closed'
        ) AS closed
      FROM lib_typeform_response_outcome o
      JOIN typeform_responses tr ON tr.response_id = o.response_id
      WHERE tr.submitted_at::date BETWEEN p_from AND p_to
    ),
    -- 9. Paid — typeform responses where the email shows up in payments
    paid AS (
      SELECT COUNT(*) AS paid
      FROM typeform_responses tr
      WHERE tr.submitted_at::date BETWEEN p_from AND p_to
        AND tr.email IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM payments p
          WHERE LOWER(p.customer_email) = LOWER(tr.email)
        )
    )
  -- Assemble rows. coverage_pct uses traced / total; null when total = 0.
  SELECT 1, 'spend_total',     'Spend in window',
         spend.total_spend, spend.total_spend, 0::numeric,
         CASE WHEN spend.total_spend > 0 THEN 100.0 ELSE NULL END,
         'usd'
  FROM spend
  UNION ALL
  SELECT 2, 'spend_with_lead', 'Spend on ads with ≥1 traced lead',
         spend.total_spend, spend_with_lead.traced_spend,
         (spend.total_spend - spend_with_lead.traced_spend),
         CASE WHEN spend.total_spend > 0
              THEN ROUND(100.0 * spend_with_lead.traced_spend / spend.total_spend, 1)
              ELSE NULL END,
         'usd'
  FROM spend, spend_with_lead
  UNION ALL
  SELECT 3, 'submits',         'Typeform submits',
         tf.total_submits, tf.total_submits, 0::numeric,
         CASE WHEN tf.total_submits > 0 THEN 100.0 ELSE NULL END,
         'count'
  FROM tf
  UNION ALL
  SELECT 4, 'submits_utms',    '→ with utm_campaign',
         tf.total_submits, tf.with_utms, (tf.total_submits - tf.with_utms),
         CASE WHEN tf.total_submits > 0
              THEN ROUND(100.0 * tf.with_utms / tf.total_submits, 1)
              ELSE NULL END,
         'count'
  FROM tf
  UNION ALL
  SELECT 5, 'submits_ad_id',   '→ resolved to ad_id',
         tf.total_submits, tf.with_ad_id, (tf.total_submits - tf.with_ad_id),
         CASE WHEN tf.total_submits > 0
              THEN ROUND(100.0 * tf.with_ad_id / tf.total_submits, 1)
              ELSE NULL END,
         'count'
  FROM tf
  UNION ALL
  SELECT 6, 'ghl_matched',     '→ matched to GHL contact',
         tf.total_submits, ghl_match.matched, (tf.total_submits - ghl_match.matched),
         CASE WHEN tf.total_submits > 0
              THEN ROUND(100.0 * ghl_match.matched / tf.total_submits, 1)
              ELSE NULL END,
         'count'
  FROM tf, ghl_match
  UNION ALL
  SELECT 7, 'booked',          '→ booked a call',
         tf.total_submits, outcomes.booked, (tf.total_submits - outcomes.booked),
         CASE WHEN tf.total_submits > 0
              THEN ROUND(100.0 * outcomes.booked / tf.total_submits, 1)
              ELSE NULL END,
         'count'
  FROM tf, outcomes
  UNION ALL
  SELECT 8, 'showed',          '→ showed up',
         tf.total_submits, outcomes.showed, (tf.total_submits - outcomes.showed),
         CASE WHEN tf.total_submits > 0
              THEN ROUND(100.0 * outcomes.showed / tf.total_submits, 1)
              ELSE NULL END,
         'count'
  FROM tf, outcomes
  UNION ALL
  SELECT 9, 'closed',          '→ closed sale',
         tf.total_submits, outcomes.closed, (tf.total_submits - outcomes.closed),
         CASE WHEN tf.total_submits > 0
              THEN ROUND(100.0 * outcomes.closed / tf.total_submits, 1)
              ELSE NULL END,
         'count'
  FROM tf, outcomes
  UNION ALL
  SELECT 10, 'paid',            '→ paid',
         tf.total_submits, paid.paid, (tf.total_submits - paid.paid),
         CASE WHEN tf.total_submits > 0
              THEN ROUND(100.0 * paid.paid / tf.total_submits, 1)
              ELSE NULL END,
         'count'
  FROM tf, paid
  ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.attribution_coverage(date, date) TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- View: lib_attribution_gap_ads
-- Active ads with spend in the last 30d but zero (or near-zero) traced
-- typeform leads. This is the "where to attack first" list.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.lib_attribution_gap_ads AS
WITH recent_spend AS (
  SELECT ad_id, COALESCE(SUM(spend), 0) AS spend_30d
  FROM ad_daily_stats
  WHERE date >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY ad_id
),
traced AS (
  SELECT ad_id, COUNT(*) AS traced_leads
  FROM typeform_responses
  WHERE ad_id IS NOT NULL
    AND submitted_at >= NOW() - INTERVAL '30 days'
  GROUP BY ad_id
)
SELECT
  rs.ad_id,
  a.ad_name,
  a.campaign_name,
  a.adset_name,
  a.effective_status,
  a.destination_url,
  rs.spend_30d::numeric AS spend_30d,
  COALESCE(t.traced_leads, 0) AS traced_leads_30d,
  CASE
    WHEN a.destination_url LIKE 'http://fb.me/%' THEN 'lead_form'
    WHEN a.destination_url IS NULL              THEN 'no_url'
    WHEN a.destination_url NOT LIKE '%utm_%'    THEN 'no_utms'
    WHEN a.destination_url NOT LIKE '%{{ad.id}}%' THEN 'missing_ad_id_macro'
    ELSE 'unknown'
  END AS leak_reason
FROM recent_spend rs
LEFT JOIN ads a ON a.ad_id = rs.ad_id
LEFT JOIN traced t ON t.ad_id = rs.ad_id
WHERE rs.spend_30d > 0
ORDER BY rs.spend_30d DESC;

GRANT SELECT ON public.lib_attribution_gap_ads TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- View: lib_attribution_unresolved_typeform
-- Recent typeform rows that DIDN'T resolve to an ad_id, with their raw UTM
-- fields so you can see exactly what Meta sent and triage manually.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.lib_attribution_unresolved_typeform AS
SELECT
  response_id,
  submitted_at,
  email,
  first_name,
  last_name,
  form_name,
  utm_source,
  utm_medium,
  utm_campaign,
  utm_term,
  utm_content,
  qualified,
  revenue_tier,
  CASE
    WHEN utm_campaign IS NULL AND utm_content IS NULL THEN 'no_utms_at_all'
    WHEN utm_content ~ '^[0-9]{10,}$'                  THEN 'looks_like_ad_id_but_no_match'
    WHEN utm_content IS NOT NULL                       THEN 'utm_content_is_creative_name'
    WHEN utm_campaign LIKE '%test%'                    THEN 'test_traffic'
    ELSE 'other'
  END AS likely_cause
FROM typeform_responses
WHERE ad_id IS NULL
  AND submitted_at >= NOW() - INTERVAL '90 days'
ORDER BY submitted_at DESC;

GRANT SELECT ON public.lib_attribution_unresolved_typeform TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Health probe: last sync ages
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.lib_attribution_freshness AS
SELECT
  'ad_daily_stats' AS source,
  MAX(date)::timestamptz AS last_data_at,
  (CURRENT_DATE - MAX(date))::int AS days_behind
FROM ad_daily_stats
UNION ALL
SELECT
  'typeform_responses' AS source,
  MAX(submitted_at) AS last_data_at,
  (CURRENT_DATE - MAX(submitted_at)::date)::int AS days_behind
FROM typeform_responses
UNION ALL
SELECT
  'ads' AS source,
  MAX(last_synced_at) AS last_data_at,
  (CURRENT_DATE - MAX(last_synced_at)::date)::int AS days_behind
FROM ads
UNION ALL
SELECT
  'payments' AS source,
  MAX(payment_date) AS last_data_at,
  (CURRENT_DATE - MAX(payment_date)::date)::int AS days_behind
FROM payments;

GRANT SELECT ON public.lib_attribution_freshness TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
