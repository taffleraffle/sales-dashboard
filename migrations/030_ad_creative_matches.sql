-- 030_ad_creative_matches.sql
-- Optional link between a Meta ad and the creative-library clip it was cut from,
-- so the Ad Library can show the real file name (Meta only stores "1, 2, 3" + a
-- hashed CDN url). There is no shared key, so links are produced either by the
-- perceptual-hash matcher (scripts/match-ad-creatives.mjs, source='auto') or set
-- by hand (source='manual'). Manual always wins — the matcher never clobbers it.
--
-- NOTE (Ben 2026-06-29): the auto matcher is currently low-yield because the
-- running ads are full VSL videos while the library holds short hook/body clips —
-- different artifacts, so nearest-neighbour dHash distances sit at 12-20/64 (a
-- true same-clip match is <=6). Table is kept for a future manual-link UI; it is
-- intentionally left empty rather than populated with wrong matches.
CREATE TABLE IF NOT EXISTS ad_creative_matches (
  ad_id       TEXT PRIMARY KEY,
  creative_id UUID,
  distance    INT,
  source      TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

GRANT ALL ON ad_creative_matches TO anon, authenticated, service_role;
ALTER TABLE ad_creative_matches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS acm_all ON ad_creative_matches;
CREATE POLICY acm_all ON ad_creative_matches FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
