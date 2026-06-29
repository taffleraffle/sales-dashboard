-- 028_ad_outcome.sql
-- Manual win/loss tag per ad, set from the Ad Library so we can see which
-- running ads were winners vs losers at a glance (Ben 2026-06-29).
ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IN ('winner', 'loser'));

COMMENT ON COLUMN ads.outcome IS
  'Manual win/loss tag set from the Ad Library — winner | loser | NULL (unmarked).';

NOTIFY pgrst, 'reload schema';
