-- 155: link a Meta ad to a library video creative.
-- The Ad Library lets you tie a run ad (ads.ad_id) to the short-form video it
-- used (lib_creative_library.id), so creatives carry their real ad performance
-- and bookings can later be credited through the link. One creative per ad;
-- ON DELETE SET NULL so removing a creative just unlinks (keeps the ad row).

ALTER TABLE public.ads
  ADD COLUMN IF NOT EXISTS linked_creative_id uuid
  REFERENCES public.lib_creative_library(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
