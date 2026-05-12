-- 042_ghl_contacts_attribution.sql
-- GHL stores the full Meta-lead ad attribution on every contact in
-- `attributionSource` / `lastAttributionSource` — adId, adSetId,
-- campaignId, utmCampaign, utmContent, formName, formId, etc. The data
-- has been in our nightly contact cache the whole time and we never
-- read from it.
--
-- Example contact (Shain Mann) carries:
--   adId          120244658154470530
--   adSetId       120244658154480530
--   campaignId    120244656406280530
--   utmCampaign   "OPT - ABO 3 ADSET 17/4"
--   formName      "SCIO - Water Restoration - Franchise Qualifier"
--
-- This migration:
--   1. Creates public.ghl_contacts (rich, per-contact attribution snapshot).
--   2. Adds a 3rd attribution tier to lib_close_resolved that joins
--      closed closer_calls → ghl_contacts by name → uses last_ad_id /
--      last_campaign for attribution. This recovers ~all paid-lead closes
--      that aren't in HYROS and not in typeform (e.g. Joseph Guaracino,
--      Dennis Sullivan, Rolando Suarez).
--   3. Updates the orphan view so we only flag genuine orphans (not just
--      "haven't joined yet").
--
-- Sync flow:
--   supabase/functions/sync-ghl-contacts pulls all GHL contacts page-by-
--   page, extracts the attribution from raw_payload, upserts here.
--
-- Idempotent. Apply via supabase db push.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ghl_contacts (
  ghl_contact_id      TEXT PRIMARY KEY,
  first_name          TEXT,
  last_name           TEXT,
  full_name           TEXT,
  email               TEXT,
  phone               TEXT,
  source              TEXT,
  company_name        TEXT,
  date_added          TIMESTAMPTZ,
  date_updated        TIMESTAMPTZ,
  tags                TEXT[],
  -- last-touch attribution (lastAttributionSource on the GHL contact)
  last_ad_id          TEXT,
  last_adset_id       TEXT,
  last_campaign_id    TEXT,
  last_utm_source     TEXT,
  last_utm_medium     TEXT,
  last_utm_campaign   TEXT,
  last_utm_content    TEXT,
  last_form_id        TEXT,
  last_form_name      TEXT,
  last_session_source TEXT,
  -- first-touch (attributionSource — kept separately for cohort work)
  first_ad_id         TEXT,
  first_campaign_id   TEXT,
  first_utm_campaign  TEXT,
  first_utm_content   TEXT,
  first_form_name     TEXT,
  raw_payload         JSONB,
  synced_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_ghlc_email_lower    ON public.ghl_contacts(lower(email));
CREATE INDEX IF NOT EXISTS ix_ghlc_phone          ON public.ghl_contacts(phone);
CREATE INDEX IF NOT EXISTS ix_ghlc_last_ad_id     ON public.ghl_contacts(last_ad_id)        WHERE last_ad_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ghlc_last_campaign  ON public.ghl_contacts(last_utm_campaign) WHERE last_utm_campaign IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ghlc_first_name     ON public.ghl_contacts(lower(first_name)) WHERE first_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ghlc_full_name      ON public.ghl_contacts(lower(full_name))  WHERE full_name IS NOT NULL;

ALTER TABLE public.ghl_contacts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY ghlc_read_auth ON public.ghl_contacts FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY ghlc_all_service ON public.ghl_contacts FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT ON public.ghl_contacts TO anon, authenticated;
GRANT ALL    ON public.ghl_contacts TO service_role;

-- ─── Update lib_close_resolved to use GHL attribution ──────────────
-- Tier order:
--   1. typeform_responses     (strongest — explicit form submission)
--   2. ghl_contacts (paid-lead attribution stored at form submit time)
--   3. hyros_events           (HYROS click attribution)
--   4. otherwise: orphan

DROP VIEW IF EXISTS public.lib_close_resolved CASCADE;
CREATE VIEW public.lib_close_resolved AS
WITH closed AS (
  SELECT
    c.id AS closer_call_id,
    c.prospect_name,
    public.strip_call_suffix(c.prospect_name) AS clean_name,
    c.revenue,
    c.cash_collected,
    c.created_at
  FROM public.closer_calls c
  WHERE c.outcome = 'closed'
),
typeform_match AS (
  SELECT
    cd.closer_call_id,
    (
      SELECT tfr.ad_id FROM public.typeform_responses tfr
      WHERE tfr.ad_id IS NOT NULL
        AND public.name_first_token(tfr.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(tfr.last_name, tfr.first_name, '')) ILIKE '%' || public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY tfr.submitted_at DESC NULLS LAST LIMIT 1
    ) AS ad_id,
    (
      SELECT tfr.utm_term FROM public.typeform_responses tfr
      WHERE tfr.utm_term IS NOT NULL
        AND public.name_first_token(tfr.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(tfr.last_name, tfr.first_name, '')) ILIKE '%' || public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY tfr.submitted_at DESC NULLS LAST LIMIT 1
    ) AS adset_id,
    (
      SELECT tfr.utm_campaign FROM public.typeform_responses tfr
      WHERE tfr.utm_campaign IS NOT NULL
        AND public.name_first_token(tfr.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(tfr.last_name, tfr.first_name, '')) ILIKE '%' || public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY tfr.submitted_at DESC NULLS LAST LIMIT 1
    ) AS utm_campaign
  FROM closed cd
),
ghl_match AS (
  SELECT
    cd.closer_call_id,
    (
      SELECT g.last_ad_id FROM public.ghl_contacts g
      WHERE g.last_ad_id IS NOT NULL
        AND (
          lower(g.email) = lower(cd.clean_name)  -- email-as-clean (rare) is harmless
          OR public.name_first_token(g.first_name) = public.name_first_token(cd.clean_name)
        )
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY g.date_added DESC NULLS LAST LIMIT 1
    ) AS ad_id,
    (
      SELECT g.last_adset_id FROM public.ghl_contacts g
      WHERE g.last_adset_id IS NOT NULL
        AND public.name_first_token(g.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY g.date_added DESC NULLS LAST LIMIT 1
    ) AS adset_id,
    (
      SELECT g.last_utm_campaign FROM public.ghl_contacts g
      WHERE g.last_utm_campaign IS NOT NULL
        AND public.name_first_token(g.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY g.date_added DESC NULLS LAST LIMIT 1
    ) AS utm_campaign
  FROM closed cd
),
hyros_match AS (
  SELECT
    cd.closer_call_id,
    (
      SELECT h.meta_ad_id FROM public.hyros_events h
      WHERE h.meta_ad_id IS NOT NULL
        AND public.name_first_token(h.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(h.last_name,'')) ILIKE public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY h.event_date DESC LIMIT 1
    ) AS ad_id,
    (
      SELECT h.campaign_name FROM public.hyros_events h
      WHERE h.campaign_name IS NOT NULL
        AND public.name_first_token(h.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(h.last_name,'')) ILIKE public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY h.event_date DESC LIMIT 1
    ) AS campaign_name
  FROM closed cd
)
SELECT
  cd.closer_call_id,
  cd.prospect_name,
  cd.clean_name,
  cd.revenue,
  cd.cash_collected,
  cd.created_at,
  COALESCE(tm.ad_id,        gm.ad_id,    hyros_ad.ad_id)        AS resolved_ad_id,
  COALESCE(tm.adset_id,     gm.adset_id, hyros_ad.adset_id)     AS resolved_adset_id,
  COALESCE(tm.utm_campaign, gm.utm_campaign, hm.campaign_name, hyros_ad.campaign_name) AS resolved_campaign,
  CASE
    WHEN tm.ad_id IS NOT NULL OR tm.adset_id IS NOT NULL OR tm.utm_campaign IS NOT NULL THEN 'typeform'
    WHEN gm.ad_id IS NOT NULL OR gm.adset_id IS NOT NULL OR gm.utm_campaign IS NOT NULL THEN 'ghl'
    WHEN hm.ad_id IS NOT NULL OR hm.campaign_name IS NOT NULL                            THEN 'hyros'
    ELSE 'orphan'
  END AS attribution_source
FROM closed cd
LEFT JOIN typeform_match tm ON tm.closer_call_id = cd.closer_call_id
LEFT JOIN ghl_match      gm ON gm.closer_call_id = cd.closer_call_id
LEFT JOIN hyros_match    hm ON hm.closer_call_id = cd.closer_call_id
-- Resolve ad context from public.ads when HYROS-only attribution lacks adset/campaign.
LEFT JOIN LATERAL (
  SELECT a.ad_id, a.adset_id, a.campaign_name
  FROM public.ads a
  WHERE a.ad_id = hm.ad_id
  LIMIT 1
) hyros_ad ON true;

GRANT SELECT ON public.lib_close_resolved TO anon, authenticated;

-- Rebuild dependent rollup views on top of the refreshed close-resolver.
DROP VIEW IF EXISTS public.lib_close_per_ad CASCADE;
CREATE VIEW public.lib_close_per_ad AS
SELECT resolved_ad_id AS ad_id, count(*) AS closes,
  COALESCE(sum(revenue),0)        AS revenue,
  COALESCE(sum(cash_collected),0) AS cash,
  max(created_at)                 AS last_close_at
FROM public.lib_close_resolved WHERE resolved_ad_id IS NOT NULL GROUP BY resolved_ad_id;
GRANT SELECT ON public.lib_close_per_ad TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_close_per_adset CASCADE;
CREATE VIEW public.lib_close_per_adset AS
SELECT resolved_adset_id AS adset_id, count(*) AS closes,
  COALESCE(sum(revenue),0)        AS revenue,
  COALESCE(sum(cash_collected),0) AS cash,
  max(created_at)                 AS last_close_at
FROM public.lib_close_resolved WHERE resolved_adset_id IS NOT NULL GROUP BY resolved_adset_id;
GRANT SELECT ON public.lib_close_per_adset TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_close_per_campaign CASCADE;
CREATE VIEW public.lib_close_per_campaign AS
SELECT resolved_campaign AS utm_campaign, count(*) AS closes,
  COALESCE(sum(revenue),0)        AS revenue,
  COALESCE(sum(cash_collected),0) AS cash,
  max(created_at)                 AS last_close_at
FROM public.lib_close_resolved WHERE resolved_campaign IS NOT NULL GROUP BY resolved_campaign;
GRANT SELECT ON public.lib_close_per_campaign TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_orphan_closes CASCADE;
CREATE VIEW public.lib_orphan_closes AS
SELECT closer_call_id, prospect_name, clean_name, revenue, cash_collected, created_at
FROM public.lib_close_resolved WHERE attribution_source = 'orphan'
ORDER BY created_at DESC;
GRANT SELECT ON public.lib_orphan_closes TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
