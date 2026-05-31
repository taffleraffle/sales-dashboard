-- Per-campaign audience override table for the Marketing tab filter
-- (Ben 2026-05-31).
--
-- Background: campaign names follow a "BRAND - VERTICAL - description"
-- convention so audience can be parsed from the name. ~85% of campaigns
-- match cleanly; the remaining ~15% have ambiguous names like
-- "OPT - CBO 3 ADSET" that need manual classification. This table is
-- the manual classification layer — keyed by campaign_id (the Meta-side
-- identifier that's stable across renames).
--
-- The Marketing page consults overrides FIRST, then falls back to the
-- name parser. A campaign with both an override and a parseable name
-- uses the override.

BEGIN;

CREATE TABLE IF NOT EXISTS public.campaign_audience_overrides (
  campaign_id      TEXT PRIMARY KEY,
  campaign_name    TEXT,              -- snapshot at override time (audit + searchability)
  audience_slug    TEXT NOT NULL,     -- e.g. 'restoration', 'electricians', 'accounting'
  set_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  set_by_user_id   UUID,              -- auth.users.id of whoever set it
  notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_campaign_audience_overrides_audience
  ON public.campaign_audience_overrides (audience_slug);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_audience_overrides TO authenticated;
GRANT SELECT ON public.campaign_audience_overrides TO anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
