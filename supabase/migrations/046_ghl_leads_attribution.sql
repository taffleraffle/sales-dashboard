-- 046_ghl_leads_attribution.sql
-- Add GHL-contact-attributed leads as a second source for the Leads
-- column on the perf dashboard. Today the dashboard only shows the 100
-- typeform_responses. The 1,539 ghl_contacts with Meta-lead-form
-- attribution (utmCampaign / adId stored at form-submit time) are
-- invisible. That's why most lead-form campaigns show "$2k spent, 0
-- leads, 1 close" — the leads exist, they just live in a different
-- table.
--
-- Same DISTINCT-style aggregation strategy as the close resolver:
-- one view per attribution level (ad / adset / campaign), grouped by
-- the strongest non-null identifier on the contact.
--
-- Idempotent. Apply via supabase db push.

BEGIN;

-- Per-ad lead count from GHL.
DROP VIEW IF EXISTS public.lib_ghl_leads_per_ad CASCADE;
CREATE VIEW public.lib_ghl_leads_per_ad AS
SELECT
  COALESCE(last_ad_id, first_ad_id)             AS ad_id,
  count(*)                                       AS leads,
  min(date_added)                                AS first_lead_at,
  max(date_added)                                AS last_lead_at
FROM public.ghl_contacts
WHERE COALESCE(last_ad_id, first_ad_id) IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_leads_per_ad TO anon, authenticated;

-- Per-adset.
DROP VIEW IF EXISTS public.lib_ghl_leads_per_adset CASCADE;
CREATE VIEW public.lib_ghl_leads_per_adset AS
SELECT
  COALESCE(last_adset_id, NULL)                  AS adset_id,
  count(*)                                       AS leads,
  min(date_added)                                AS first_lead_at,
  max(date_added)                                AS last_lead_at
FROM public.ghl_contacts
WHERE last_adset_id IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_leads_per_adset TO anon, authenticated;

-- Per-campaign (by readable name where available).
DROP VIEW IF EXISTS public.lib_ghl_leads_per_campaign CASCADE;
CREATE VIEW public.lib_ghl_leads_per_campaign AS
SELECT
  COALESCE(last_utm_campaign, first_utm_campaign) AS utm_campaign,
  count(*)                                        AS leads,
  min(date_added)                                 AS first_lead_at,
  max(date_added)                                 AS last_lead_at
FROM public.ghl_contacts
WHERE COALESCE(last_utm_campaign, first_utm_campaign) IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_leads_per_campaign TO anon, authenticated;

-- Detail view for the drill-down modal.
-- Returns per-contact GHL-attributed-lead rows so the modal can list
-- the actual prospects behind a Leads count.
DROP VIEW IF EXISTS public.lib_ghl_leads_detail CASCADE;
CREATE VIEW public.lib_ghl_leads_detail AS
SELECT
  ghl_contact_id,
  date_added                                        AS landed_at,
  COALESCE(NULLIF(trim(full_name), ''),
           NULLIF(trim(concat_ws(' ', first_name, last_name)), ''),
           email,
           ghl_contact_id)                          AS display_name,
  email,
  phone,
  company_name,
  COALESCE(last_ad_id, first_ad_id)                 AS ad_id,
  last_adset_id                                     AS adset_id,
  COALESCE(last_utm_campaign, first_utm_campaign)   AS utm_campaign,
  COALESCE(last_form_name, first_form_name)         AS form_name,
  source
FROM public.ghl_contacts
WHERE COALESCE(last_ad_id, first_ad_id) IS NOT NULL
   OR last_adset_id IS NOT NULL
   OR COALESCE(last_utm_campaign, first_utm_campaign) IS NOT NULL;
GRANT SELECT ON public.lib_ghl_leads_detail TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
