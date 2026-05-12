-- 049_ghl_attribution_via_ads_table.sql
-- Fix the GHL adset + campaign rollup views. They currently group by
-- `last_adset_id` / `last_utm_campaign` on ghl_contacts, but the GHL
-- contact sync only pulls the ad_id — adset_id and the campaign-name
-- string are both null on every contact. Result: all six adset/campaign
-- views return 0 rows even though we have 1,541 contacts w/ ad_id and
-- 1,093 appointments that resolve to a campaign.
--
-- Fix: resolve adset_id and campaign_name by joining ghl_contacts ->
-- ads via ad_id. The ad_id sync IS reliable; ads.adset_id and
-- ads.campaign_name come straight from Meta.
--
-- The per-ad views are unaffected (they already group by ad_id directly).
--
-- Idempotent. Apply via supabase db push.

BEGIN;

-- ─── 1. Leads per adset / campaign (via ad_id -> ads.*) ─────────────
DROP VIEW IF EXISTS public.lib_ghl_leads_per_adset CASCADE;
CREATE VIEW public.lib_ghl_leads_per_adset AS
SELECT
  a.adset_id,
  count(*) AS leads,
  min(c.date_added) AS first_lead_at,
  max(c.date_added) AS last_lead_at
FROM public.ghl_contacts c
JOIN public.ads a ON a.ad_id = COALESCE(c.last_ad_id, c.first_ad_id)
WHERE a.adset_id IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_leads_per_adset TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_ghl_leads_per_campaign CASCADE;
CREATE VIEW public.lib_ghl_leads_per_campaign AS
SELECT
  a.campaign_name AS utm_campaign,
  count(*) AS leads,
  min(c.date_added) AS first_lead_at,
  max(c.date_added) AS last_lead_at
FROM public.ghl_contacts c
JOIN public.ads a ON a.ad_id = COALESCE(c.last_ad_id, c.first_ad_id)
WHERE a.campaign_name IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_leads_per_campaign TO anon, authenticated;


-- ─── 2. Booked per adset / campaign ─────────────────────────────────
DROP VIEW IF EXISTS public.lib_ghl_booked_per_adset CASCADE;
CREATE VIEW public.lib_ghl_booked_per_adset AS
SELECT
  ad.adset_id,
  count(DISTINCT a.id) AS booked_calls
FROM public.ghl_appointments a
JOIN public.ghl_contacts  c ON c.ghl_contact_id = a.ghl_contact_id
JOIN public.ads          ad ON ad.ad_id = COALESCE(c.last_ad_id, c.first_ad_id)
WHERE ad.adset_id IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_booked_per_adset TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_ghl_booked_per_campaign CASCADE;
CREATE VIEW public.lib_ghl_booked_per_campaign AS
SELECT
  ad.campaign_name AS utm_campaign,
  count(DISTINCT a.id) AS booked_calls
FROM public.ghl_appointments a
JOIN public.ghl_contacts  c ON c.ghl_contact_id = a.ghl_contact_id
JOIN public.ads          ad ON ad.ad_id = COALESCE(c.last_ad_id, c.first_ad_id)
WHERE ad.campaign_name IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_booked_per_campaign TO anon, authenticated;


-- ─── 3. Lives per adset / campaign (via closer_calls + name match) ──
-- Note: same name-token match used in 047 — we just join the resolved
-- ad_id back through `ads` for adset/campaign rollup.
DROP VIEW IF EXISTS public.lib_ghl_lives_per_adset CASCADE;
CREATE VIEW public.lib_ghl_lives_per_adset AS
WITH live AS (
  SELECT
    cc.id,
    public.name_first_token (public.strip_call_suffix(cc.prospect_name)) AS first_tok,
    public.name_second_token(public.strip_call_suffix(cc.prospect_name)) AS second_tok
  FROM public.closer_calls cc
  WHERE cc.showed = TRUE OR cc.outcome IN ('showed','closed','not_closed')
),
matched AS (
  SELECT DISTINCT ON (li.id)
    li.id,
    COALESCE(g.last_ad_id, g.first_ad_id) AS ad_id
  FROM live li
  JOIN public.ghl_contacts g
    ON public.name_first_token(g.first_name) = li.first_tok
   AND (li.second_tok = ''
        OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || li.second_tok || '%')
  WHERE COALESCE(g.last_ad_id, g.first_ad_id) IS NOT NULL
  ORDER BY li.id, g.date_added DESC NULLS LAST
)
SELECT a.adset_id, count(*) AS live_calls
FROM matched m
JOIN public.ads a ON a.ad_id = m.ad_id
WHERE a.adset_id IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_lives_per_adset TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_ghl_lives_per_campaign CASCADE;
CREATE VIEW public.lib_ghl_lives_per_campaign AS
WITH live AS (
  SELECT
    cc.id,
    public.name_first_token (public.strip_call_suffix(cc.prospect_name)) AS first_tok,
    public.name_second_token(public.strip_call_suffix(cc.prospect_name)) AS second_tok
  FROM public.closer_calls cc
  WHERE cc.showed = TRUE OR cc.outcome IN ('showed','closed','not_closed')
),
matched AS (
  SELECT DISTINCT ON (li.id)
    li.id,
    COALESCE(g.last_ad_id, g.first_ad_id) AS ad_id
  FROM live li
  JOIN public.ghl_contacts g
    ON public.name_first_token(g.first_name) = li.first_tok
   AND (li.second_tok = ''
        OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || li.second_tok || '%')
  WHERE COALESCE(g.last_ad_id, g.first_ad_id) IS NOT NULL
  ORDER BY li.id, g.date_added DESC NULLS LAST
)
SELECT a.campaign_name AS utm_campaign, count(*) AS live_calls
FROM matched m
JOIN public.ads a ON a.ad_id = m.ad_id
WHERE a.campaign_name IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_lives_per_campaign TO anon, authenticated;


-- ─── 4. Booked detail view: resolve adset/campaign via ads too ──────
-- The current detail view reads them off ghl_contacts (all null). Fix
-- the same way.
DROP VIEW IF EXISTS public.lib_ghl_booked_detail CASCADE;
CREATE VIEW public.lib_ghl_booked_detail AS
SELECT
  a.id                                              AS appointment_id,
  a.appointment_date                                AS landed_at,
  a.contact_name                                    AS display_name,
  c.email,
  c.phone,
  COALESCE(c.last_ad_id, c.first_ad_id)             AS ad_id,
  ad.adset_id                                       AS adset_id,
  ad.campaign_name                                  AS utm_campaign,
  a.outcome
FROM public.ghl_appointments a
JOIN public.ghl_contacts c ON c.ghl_contact_id = a.ghl_contact_id
LEFT JOIN public.ads     ad ON ad.ad_id = COALESCE(c.last_ad_id, c.first_ad_id)
WHERE COALESCE(c.last_ad_id, c.first_ad_id) IS NOT NULL;
GRANT SELECT ON public.lib_ghl_booked_detail TO anon, authenticated;


-- ─── 5. Leads detail: resolve adset/campaign via ads too ────────────
DROP VIEW IF EXISTS public.lib_ghl_leads_detail CASCADE;
CREATE VIEW public.lib_ghl_leads_detail AS
SELECT
  c.ghl_contact_id,
  c.date_added                                        AS landed_at,
  COALESCE(NULLIF(trim(c.full_name), ''),
           NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
           c.email,
           c.ghl_contact_id)                          AS display_name,
  c.email,
  c.phone,
  c.company_name,
  COALESCE(c.last_ad_id, c.first_ad_id)               AS ad_id,
  ad.adset_id                                         AS adset_id,
  ad.campaign_name                                    AS utm_campaign,
  COALESCE(c.last_form_name, c.first_form_name)       AS form_name,
  c.source
FROM public.ghl_contacts c
LEFT JOIN public.ads ad ON ad.ad_id = COALESCE(c.last_ad_id, c.first_ad_id)
WHERE COALESCE(c.last_ad_id, c.first_ad_id) IS NOT NULL;
GRANT SELECT ON public.lib_ghl_leads_detail TO anon, authenticated;


NOTIFY pgrst, 'reload schema';

COMMIT;
