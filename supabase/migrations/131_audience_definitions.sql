-- Self-service audience management (Ben 2026-06-01).
--
-- Before this migration, audience parsing was hardcoded in 3 places:
--   1. SQL: audience_from_campaign_name() — keyword → display name CASE
--   2. SQL: lib_strategy_booking_resolved.form_audience — form_name keyword CASE
--   3. SQL: lib_marketing_by_audience_daily.ad_audience_n + lib_ad_audience —
--      lowercase slug → Title-Case display name CASE
--   …plus 4 JS constants (KANBAN_COLUMNS, KNOWN_AUDIENCES, CANONICAL_AUDIENCES,
--   UTM_CAMPAIGN_MAP).
--
-- Adding "Dentists" required touching 7 files. Now: one INSERT into
-- audience_definitions and every parser/view/UI picks it up.
--
-- New campaigns continue to auto-classify the moment they sync: the parser
-- ILIKEs the campaign name against every active audience's keyword list and
-- picks the lowest-sort-order match. Opaque campaign names that match no
-- keyword fall through to campaign_audience_overrides (1-click tag) as
-- before — no behaviour change for legacy data.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- audience_definitions: single source of truth for every audience.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audience_definitions (
  slug              text PRIMARY KEY,
  display_name      text NOT NULL UNIQUE,
  keywords          text[] NOT NULL DEFAULT '{}',  -- ILIKE '%kw%' on campaign_name / form_name
  color             text,                          -- hex, optional, for UI kanban + chips
  sort_order        int  NOT NULL DEFAULT 100,     -- lower = higher priority (TRADIES wins over electrician)
  calendar_ids      text[] NOT NULL DEFAULT '{}',  -- GHL strategy-calendar IDs that imply this audience
  example_utm       text,                          -- representative utm_campaign for the QA bulk-tag map
  is_active         boolean NOT NULL DEFAULT true,
  is_dq             boolean NOT NULL DEFAULT false, -- bookings on this audience's calendars count as DQ
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audience_definitions_active_sort_idx
  ON public.audience_definitions (is_active, sort_order);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.audience_definitions_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END
$$;
DROP TRIGGER IF EXISTS audience_definitions_touch_updated_at ON public.audience_definitions;
CREATE TRIGGER audience_definitions_touch_updated_at
  BEFORE UPDATE ON public.audience_definitions
  FOR EACH ROW EXECUTE FUNCTION public.audience_definitions_touch_updated_at();

GRANT SELECT ON public.audience_definitions TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.audience_definitions TO authenticated;

-- Seed: the 9 audiences currently hardcoded.
-- sort_order: TRADIES → Australia must beat electrician/plumbing because
-- "SCIO - Video Ads TRADIES" matches both 'tradies' AND 'video' but should
-- bucket Australia. Lower number = wins first.
INSERT INTO public.audience_definitions (slug, display_name, keywords, color, sort_order, example_utm)
VALUES
  ('australia',     'Australia',     ARRAY['tradies', 'tradie'],                       '#6b4ba0',  5,  'SCIO - TRADIES - VSL'),
  ('restoration',   'Restoration',   ARRAY['restoration', 'resto', 'remodel'],         '#b53e3e', 10,  'SCIO -Restoration - Application - 4/22 - New Videos'),
  ('electrician',   'Electricians',  ARRAY['electrician'],                             '#0e7c86', 20,  'SCIO - Electricians - VSL - 5/4 images - Relaunch'),
  ('accounting',    'Accounting',    ARRAY['accounting', 'bookkeep'],                  '#b86a0c', 30,  'SCIO - Accounting - VSL'),
  ('plumbing',      'Plumbing',      ARRAY['plumb'],                                   '#0e7c86', 40,  'SCIO - Plumbing - VSL'),
  ('hvac',          'HVAC',          ARRAY['hvac'],                                    '#1f4a8b', 50,  'SCIO - HVAC - VSL'),
  ('pool_builders', 'Pool Builders', ARRAY['pool'],                                    '#3e8a5e', 60,  'SCIO - Pool - VSL'),
  ('real_estate',   'Real Estate',   ARRAY['real estate', 'realtor'],                  '#5b3a8f', 70,  'SCIO - Real Estate - VSL'),
  ('roofing',       'Roofing',       ARRAY['roofing', 'roofer'],                       '#8c6f20', 80,  'SCIO - Roofing - VSL')
ON CONFLICT (slug) DO UPDATE
  SET keywords     = EXCLUDED.keywords,
      display_name = EXCLUDED.display_name,
      color        = EXCLUDED.color,
      sort_order   = EXCLUDED.sort_order,
      example_utm  = EXCLUDED.example_utm;

-- Backfill known strategy_calendar IDs from constants.js → audience.
UPDATE public.audience_definitions
   SET calendar_ids = ARRAY['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','woLoGzGKe5fPKZU1jxY7']
 WHERE slug = 'restoration';
UPDATE public.audience_definitions
   SET calendar_ids = ARRAY['aQsmGwANALCwJBI7G9vT']
 WHERE slug = 'plumbing';
UPDATE public.audience_definitions
   SET calendar_ids = ARRAY['StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j']
 WHERE slug = 'pool_builders';

-- ──────────────────────────────────────────────────────────────────────────
-- audience_from_campaign_name(text) — now reads keywords from the table.
-- Returns the display_name of the highest-priority (lowest sort_order)
-- active audience whose keyword list matches.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audience_from_campaign_name(p text)
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT display_name
    FROM public.audience_definitions a
   WHERE a.is_active
     AND p IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM unnest(a.keywords) kw
        WHERE p ILIKE '%' || kw || '%'
     )
   ORDER BY a.sort_order ASC
   LIMIT 1
$$;

-- Helper to look up display_name from a slug (used by JOINs).
CREATE OR REPLACE FUNCTION public.audience_display_name(p_slug text)
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT display_name FROM public.audience_definitions WHERE slug = p_slug LIMIT 1
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- lib_ad_audience — re-resolves audience for every ad via slug→display lookup.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.lib_ad_audience AS
WITH ad_resolved AS (
  SELECT a.ad_id, a.campaign_id, a.campaign_name,
         COALESCE(
           public.audience_display_name(o.audience_slug),
           public.audience_from_campaign_name(a.campaign_name),
           'Unknown'
         ) AS audience
    FROM ads a
    LEFT JOIN campaign_audience_overrides o ON o.campaign_id = a.campaign_id
)
SELECT * FROM ad_resolved;

GRANT SELECT ON public.lib_ad_audience TO anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- lib_strategy_booking_resolved — calendar hints now sourced from the table,
-- form_audience parser sourced from the same keyword list as campaigns.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.lib_strategy_booking_resolved AS
WITH
-- Unnest the table's calendar_ids into one row per (calendar_id, audience).
-- A calendar with is_dq=true on its audience flags every booking as DQ.
strategy_calendars AS (
  SELECT cid AS id, a.display_name AS audience_hint, a.is_dq
    FROM public.audience_definitions a, unnest(a.calendar_ids) AS cid
   WHERE a.is_active
  UNION ALL
  -- DQ-only calendars not tied to a vertical (the generic "DQ Calendly" flow).
  SELECT 'gohFzPCilzwBtVfaC6fu', NULL, TRUE
  UNION ALL
  SELECT 'T5Zif5GjDwulya6novU0', NULL, FALSE  -- generic Opt Digital Strategy (mixed)
),
bookings AS (
  SELECT DISTINCT ON (COALESCE(a.ghl_contact_id, a.contact_email))
         a.id,
         a.ghl_event_id,
         a.ghl_contact_id,
         a.contact_email,
         a.contact_phone,
         a.contact_name,
         TRIM(SPLIT_PART(a.contact_name, ' and ', 1)) AS prospect_name,
         a.calendar_name,
         (a.booked_at::date) AS booked_at,
         a.appointment_date,
         a.appointment_status,
         a.revenue_tier
    FROM ghl_appointments a
    JOIN strategy_calendars sc ON sc.id = a.calendar_name
   WHERE a.appointment_status <> 'cancelled'
   ORDER BY COALESCE(a.ghl_contact_id, a.contact_email), a.booked_at ASC
),
tf_by_email AS (
  SELECT DISTINCT ON (LOWER(tr.email))
         LOWER(tr.email) AS k, tr.ad_id,
         public.audience_from_campaign_name(tr.utm_campaign) AS audience_from_utm,
         tr.form_name
    FROM typeform_responses tr
   WHERE tr.email IS NOT NULL AND tr.email <> ''
   ORDER BY LOWER(tr.email), tr.submitted_at DESC
),
tf_by_phone AS (
  SELECT DISTINCT ON (REGEXP_REPLACE(tr.phone, '\D', '', 'g'))
         REGEXP_REPLACE(tr.phone, '\D', '', 'g') AS k, tr.ad_id,
         public.audience_from_campaign_name(tr.utm_campaign) AS audience_from_utm,
         tr.form_name
    FROM typeform_responses tr
   WHERE tr.phone IS NOT NULL
     AND LENGTH(REGEXP_REPLACE(tr.phone, '\D', '', 'g')) >= 7
   ORDER BY REGEXP_REPLACE(tr.phone, '\D', '', 'g'), tr.submitted_at DESC
),
tf_by_first AS (
  SELECT DISTINCT ON (LOWER(tr.first_name))
         LOWER(tr.first_name) AS k, tr.ad_id,
         public.audience_from_campaign_name(tr.utm_campaign) AS audience_from_utm,
         tr.form_name, tr.last_name
    FROM typeform_responses tr
   WHERE tr.first_name IS NOT NULL AND tr.first_name <> ''
   ORDER BY LOWER(tr.first_name), tr.submitted_at DESC
),
-- form_audience uses the SAME parser as campaigns — feed form_name through it.
form_audience AS (
  SELECT DISTINCT tr.form_name,
         public.audience_from_campaign_name(tr.form_name) AS aud
    FROM typeform_responses tr
   WHERE tr.form_name IS NOT NULL
),
match_picked AS (
  SELECT b.id,
         COALESCE(tfe.ad_id, tfp.ad_id, tff.ad_id) AS tf_ad_id,
         COALESCE(tfe.audience_from_utm, tfp.audience_from_utm, tff.audience_from_utm) AS audience_from_utm,
         COALESCE(tfe.form_name, tfp.form_name, tff.form_name) AS form_name,
         CASE
           WHEN tfe.ad_id IS NOT NULL OR tfe.audience_from_utm IS NOT NULL OR tfe.form_name IS NOT NULL THEN 'email'
           WHEN tfp.ad_id IS NOT NULL OR tfp.audience_from_utm IS NOT NULL OR tfp.form_name IS NOT NULL THEN 'phone'
           WHEN tff.ad_id IS NOT NULL OR tff.audience_from_utm IS NOT NULL OR tff.form_name IS NOT NULL THEN 'first_name'
           ELSE NULL
         END AS match_method
    FROM bookings b
    LEFT JOIN tf_by_email tfe ON tfe.k = LOWER(b.contact_email)
    LEFT JOIN tf_by_phone tfp ON tfp.k = REGEXP_REPLACE(COALESCE(b.contact_phone,''), '\D', '', 'g')
                                  AND LENGTH(REGEXP_REPLACE(COALESCE(b.contact_phone,''), '\D', '', 'g')) >= 7
    LEFT JOIN tf_by_first tff ON tff.k = LOWER(b.prospect_name)
                                  AND b.prospect_name <> ''
)
SELECT b.id,
       b.ghl_event_id,
       b.ghl_contact_id,
       b.contact_email,
       b.contact_name,
       b.calendar_name,
       b.booked_at,
       b.appointment_date,
       b.appointment_status,
       b.revenue_tier,
       sc.is_dq,
       COALESCE(
         aa.audience,
         NULLIF(mp.audience_from_utm, 'Unknown'),
         NULLIF(fa.aud, 'Unknown'),
         sc.audience_hint,
         'Unknown'
       ) AS audience,
       CASE
         WHEN aa.audience IS NOT NULL                  THEN 'typeform_ad_id(' || mp.match_method || ')'
         WHEN NULLIF(mp.audience_from_utm, 'Unknown') IS NOT NULL THEN 'typeform_utm(' || mp.match_method || ')'
         WHEN NULLIF(fa.aud, 'Unknown') IS NOT NULL    THEN 'typeform_form(' || mp.match_method || ')'
         WHEN sc.audience_hint IS NOT NULL             THEN 'calendar_hint'
         ELSE                                               'unresolved'
       END AS audience_source
  FROM bookings b
  JOIN strategy_calendars sc ON sc.id = b.calendar_name
  LEFT JOIN match_picked mp    ON mp.id = b.id
  LEFT JOIN lib_ad_audience aa ON aa.ad_id = mp.tf_ad_id
  LEFT JOIN form_audience fa   ON fa.form_name = mp.form_name;

GRANT SELECT ON public.lib_strategy_booking_resolved TO anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- lib_marketing_by_audience_daily — uses lib_ad_audience.audience directly
-- (no more inline ad_audience_n CASE).
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.lib_marketing_by_audience_daily AS
WITH
spend_d AS (
  SELECT s.date, aa.audience,
         SUM(s.spend) AS adspend,
         SUM(s.impressions) AS impressions,
         SUM(s.clicks) AS clicks
    FROM ad_daily_stats s
    JOIN lib_ad_audience aa ON aa.ad_id = s.ad_id
   GROUP BY 1, 2
),
leads_d AS (
  SELECT date_trunc('day', tr.submitted_at AT TIME ZONE 'UTC')::date AS date,
         aa.audience,
         COUNT(*) AS leads,
         COUNT(*) FILTER (WHERE tr.qualified) AS qualified_leads
    FROM typeform_responses tr
    JOIN lib_ad_audience aa ON aa.ad_id = tr.ad_id
   GROUP BY 1, 2
),
qual_bookings_d AS (
  SELECT b.booked_at AS date, b.audience,
         COUNT(*) AS qualified_bookings
    FROM lib_strategy_booking_resolved b
   WHERE NOT b.is_dq
   GROUP BY 1, 2
),
live_d AS (
  SELECT date_trunc('day', v.landed_at AT TIME ZONE 'UTC')::date AS date,
         COALESCE(aa.audience, public.audience_from_campaign_name(v.utm_campaign), 'Unknown') AS audience,
         COUNT(*) AS live_calls
    FROM lib_ghl_lives_detail v
    LEFT JOIN lib_ad_audience aa ON aa.ad_id = v.ad_id
   WHERE v.utm_campaign <> 'REFERRAL'
   GROUP BY 1, 2
),
close_d AS (
  SELECT date_trunc('day', c.created_at AT TIME ZONE 'UTC')::date AS date,
         COALESCE(aa.audience, public.audience_from_campaign_name(c.resolved_campaign), 'Unknown') AS audience,
         COUNT(*) AS closes,
         SUM(c.revenue) AS revenue,
         SUM(c.cash_collected) AS cash
    FROM lib_close_resolved c
    LEFT JOIN lib_ad_audience aa ON aa.ad_id = c.resolved_ad_id
   WHERE c.resolved_campaign <> 'REFERRAL'
   GROUP BY 1, 2
),
all_keys AS (
  SELECT date, audience FROM spend_d
  UNION SELECT date, audience FROM leads_d
  UNION SELECT date, audience FROM qual_bookings_d
  UNION SELECT date, audience FROM live_d
  UNION SELECT date, audience FROM close_d
)
SELECT k.date, k.audience,
       COALESCE(s.adspend, 0)             AS adspend,
       COALESCE(s.impressions, 0)         AS impressions,
       COALESCE(s.clicks, 0)              AS clicks,
       COALESCE(l.leads, 0)               AS leads,
       COALESCE(l.qualified_leads, 0)     AS qualified_leads,
       COALESCE(q.qualified_bookings, 0)  AS qualified_bookings,
       COALESCE(lv.live_calls, 0)         AS live_calls,
       COALESCE(c.closes, 0)              AS closes,
       COALESCE(c.revenue, 0)             AS trial_revenue,
       COALESCE(c.cash, 0)                AS trial_cash
  FROM all_keys k
  LEFT JOIN spend_d         s  ON s.date  = k.date AND s.audience  = k.audience
  LEFT JOIN leads_d         l  ON l.date  = k.date AND l.audience  = k.audience
  LEFT JOIN qual_bookings_d q  ON q.date  = k.date AND q.audience  = k.audience
  LEFT JOIN live_d          lv ON lv.date = k.date AND lv.audience = k.audience
  LEFT JOIN close_d         c  ON c.date  = k.date AND c.audience  = k.audience
  ORDER BY k.date DESC, k.audience;

GRANT SELECT ON public.lib_marketing_by_audience_daily TO anon, authenticated;

-- Schema reload so PostgREST exposes the new audience_definitions table.
NOTIFY pgrst, 'reload schema';

COMMIT;
