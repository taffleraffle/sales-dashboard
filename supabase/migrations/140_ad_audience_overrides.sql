-- Migration 140: per-ad audience overrides (Ben 2026-06-07).
--
-- Problem: `lib_ad_audience` derives a booking's audience by joining the
-- `ads` table's `campaign_name` (or a per-campaign override). But Meta lets
-- the same ad_id be moved between campaigns OR carry a stale campaign_name
-- after a duplication. John Ziello's typeform on 2026-06-07 captured
-- utm_campaign="SCIO - Electricians - VSL - Fire Agency" against
-- ad_id=120248310082800530, but the ads table currently shows that ad as
-- "SCIO -Restoration - VSL - New SEO Rules - Images". The campaign-level
-- override table (migration 113's `campaign_audience_overrides`) can't fix
-- this without flipping every ad in that campaign — too coarse.
--
-- Solution: a per-ad override layer that takes precedence over both the
-- campaign override AND the campaign-name parser. The resolver ladder
-- becomes:
--   1. ad_audience_overrides.audience_slug          (per-ad — NEW)
--   2. campaign_audience_overrides.audience_slug    (per-campaign — 113)
--   3. audience_from_campaign_name(campaign_name)   (parser)
--   4. 'Unknown'
--
-- This is idempotent. Applying it twice is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ad_audience_overrides (
  ad_id           TEXT PRIMARY KEY REFERENCES public.ads(ad_id) ON DELETE CASCADE,
  audience_slug   TEXT NOT NULL,
  set_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  set_by_user_id  UUID,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_ad_audience_overrides_audience
  ON public.ad_audience_overrides (audience_slug);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_audience_overrides TO authenticated;
GRANT SELECT ON public.ad_audience_overrides TO anon;

-- ──────────────────────────────────────────────────────────────────────────
-- Replace lib_ad_audience so the per-ad override is consulted first.
-- Mirrors migration 131's shape exactly, just adds the ao join + COALESCE step.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.lib_ad_audience AS
WITH ad_resolved AS (
  SELECT a.ad_id, a.campaign_id, a.campaign_name,
         COALESCE(
           public.audience_display_name(ao.audience_slug),
           public.audience_display_name(co.audience_slug),
           public.audience_from_campaign_name(a.campaign_name),
           'Unknown'
         ) AS audience
    FROM ads a
    LEFT JOIN ad_audience_overrides ao ON ao.ad_id = a.ad_id
    LEFT JOIN campaign_audience_overrides co ON co.campaign_id = a.campaign_id
)
SELECT * FROM ad_resolved;

GRANT SELECT ON public.lib_ad_audience TO anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Seed the known mismatches we've found so far.
-- ad_id=120248310082800530 — John Ziello case (2026-06-07): ad shows as
-- Restoration in Meta's current campaign assignment but every typeform
-- attribution against it is "SCIO - Electricians - VSL - Fire Agency".
-- Either the ad was moved between campaigns or this is a duplicated ad.
-- Pin to electricians until Meta-side data is corrected.
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO public.ad_audience_overrides (ad_id, audience_slug, notes)
VALUES (
  '120248310082800530',
  'electricians',
  'Ben 2026-06-07: typeform utm_campaign="SCIO - Electricians - VSL - Fire Agency" but ads.campaign_name="SCIO -Restoration - VSL - New SEO Rules - Images". Per-ad override pins to electricians until Meta data is reconciled.'
)
ON CONFLICT (ad_id) DO UPDATE
  SET audience_slug = EXCLUDED.audience_slug,
      notes         = EXCLUDED.notes,
      set_at        = NOW();

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ──────────────────────────────────────────────────────────────────────────
-- Refresh the marketing trend matview so the override propagates to the
-- KPI tiles immediately. CONCURRENTLY can't run inside a transaction, so
-- this is outside the BEGIN/COMMIT above.
-- ──────────────────────────────────────────────────────────────────────────
REFRESH MATERIALIZED VIEW CONCURRENTLY lib_marketing_by_audience_daily_mv;
