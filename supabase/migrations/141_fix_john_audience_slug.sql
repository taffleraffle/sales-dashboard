-- Migration 141: fix the override slug from migration 140 (Ben 2026-06-07).
--
-- 140 inserted ad_audience_overrides.audience_slug = 'electricians' (plural).
-- audience_definitions only has 'electrician' (singular), so
-- audience_display_name('electricians') returns NULL, the COALESCE in
-- lib_ad_audience falls through to the campaign-name parser, and John Ziello's
-- booking still shows as Restoration.
--
-- This migration:
--   1. Corrects the existing John override to the right slug.
--   2. Adds a CHECK constraint so future inserts can't store an unknown slug
--      silently — the next operator gets an immediate FK-style error instead
--      of a misattributed booking they have to chase down later.
--   3. Refreshes the matview so the tile picks up John's new audience.
--
-- Idempotent. Apply via Supabase SQL Editor.

BEGIN;

-- Fix the seeded row.
UPDATE public.ad_audience_overrides
   SET audience_slug = 'electrician',
       notes = 'Ben 2026-06-07: typeform utm_campaign carries "SCIO - Electricians - VSL - Fire Agency" but ads.campaign_name is "SCIO -Restoration - VSL - New SEO Rules - Images". Per-ad override pins to electrician until Meta data is reconciled. Slug fixed from electricians→electrician in migration 141.'
 WHERE ad_id = '120248310082800530';

-- If migration 140's INSERT actually rolled back (which is why the override
-- table was empty when we checked), insert the row now with the correct slug.
INSERT INTO public.ad_audience_overrides (ad_id, audience_slug, notes)
VALUES (
  '120248310082800530',
  'electrician',
  'Ben 2026-06-07: typeform utm_campaign carries "SCIO - Electricians - VSL - Fire Agency" but ads.campaign_name is "SCIO -Restoration - VSL - New SEO Rules - Images". Per-ad override pins to electrician until Meta data is reconciled.'
)
ON CONFLICT (ad_id) DO UPDATE
  SET audience_slug = EXCLUDED.audience_slug,
      notes         = EXCLUDED.notes,
      set_at        = NOW();

-- Add a FK-style guard so audience_slug must reference a real definition.
-- Without this, today's silent NULL-from-display_name bug recurs every time
-- someone fat-fingers a slug.
ALTER TABLE public.ad_audience_overrides
  DROP CONSTRAINT IF EXISTS ad_audience_overrides_slug_fk;

ALTER TABLE public.ad_audience_overrides
  ADD CONSTRAINT ad_audience_overrides_slug_fk
  FOREIGN KEY (audience_slug)
  REFERENCES public.audience_definitions (slug)
  ON UPDATE CASCADE ON DELETE RESTRICT;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- CONCURRENTLY refresh must run outside the transaction above.
REFRESH MATERIALIZED VIEW CONCURRENTLY lib_marketing_by_audience_daily_mv;
