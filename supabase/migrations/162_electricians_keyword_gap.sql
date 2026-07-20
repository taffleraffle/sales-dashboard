-- 162: fix the Electricians audience keyword gap (Ben 2026-07-20).
--
-- audience_from_campaign_name() classifies a campaign by matching
-- audience_definitions.keywords with ILIKE '%kw%'. The Electricians row only
-- had the keyword "electrician" (full word), but the ad account names its
-- campaigns with "ELEC", "Electrical", and even the typo "ELECTRICAN"
-- (e.g. "Scale// Electrical - MAIN", "11 Jul | TEST | ELEC | ANDROMEDA",
-- "OPTS | IMG - WIN - ELEC", "OPT - VSL - #1 ELECTRICAN - VIDEOS"). Those all
-- fell through to Unknown, so ~$16k of electrician ad spend was mis-bucketed
-- and the Electricians audience tab under-reported spend (~$3.3k shown vs ~$20k
-- real).
--
-- Add "elec" — the substring subsumes elec / electrical / electrician /
-- electrican. Verified no non-electrician campaign name contains "elec", and no
-- campaign double-matches another vertical, so this only rescues Unknown →
-- Electricians (no flips). Restoration/Plumbing/Pool/Roofing already have
-- abbreviated keywords (resto/plumb/pool/roof), so only Electricians needed it.

UPDATE public.audience_definitions
   SET keywords = ARRAY['electrician','elec']
 WHERE slug = 'electrician';

NOTIFY pgrst, 'reload schema';
