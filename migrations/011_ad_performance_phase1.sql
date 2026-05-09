-- Phase 1 of the Ad Performance + Creative Library feature.
-- Adds two tables: `ads` (catalog of ads pulled from Meta) and `ad_daily_stats`
-- (per-ad daily insights). Schema is platform-agnostic via the `platform` column
-- so TikTok / Google / YouTube can plug in later without a migration.
--
-- Read-only consumer of Meta API. No writes to Meta from this codebase.

-- ── ads ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads (
  ad_id            TEXT PRIMARY KEY,
  platform         TEXT NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta', 'tiktok', 'google', 'youtube', 'microsoft')),
  ad_name          TEXT,
  campaign_id      TEXT,
  campaign_name    TEXT,
  adset_id         TEXT,
  adset_name       TEXT,
  status           TEXT,                                  -- ACTIVE / PAUSED / DELETED / ARCHIVED
  effective_status TEXT,                                  -- finer-grained status from platform
  creative_id      TEXT,                                  -- platform-side creative ID
  asset_type       TEXT CHECK (asset_type IN ('image', 'video', 'carousel', 'unknown')),
  asset_url        TEXT,                                  -- video source / image / carousel manifest
  thumbnail_url    TEXT,
  headline         TEXT,
  primary_text     TEXT,
  description      TEXT,
  cta_type         TEXT,
  destination_url  TEXT,
  raw_payload      JSONB,                                 -- full platform response for forensic reads
  first_seen_at    TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at   TIMESTAMPTZ DEFAULT NOW(),
  archived_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ads_platform_campaign ON ads(platform, campaign_id, adset_id);
CREATE INDEX IF NOT EXISTS idx_ads_adset ON ads(adset_id);                  -- attribution joins (Phase 4)
CREATE INDEX IF NOT EXISTS idx_ads_last_synced ON ads(last_synced_at DESC);

-- ── ad_daily_stats ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_daily_stats (
  ad_id                  TEXT NOT NULL REFERENCES ads(ad_id) ON DELETE CASCADE,
  date                   DATE NOT NULL,
  spend                  NUMERIC(12, 2) DEFAULT 0,        -- in account currency (NZD for Meta); convert at read time
  impressions            INTEGER DEFAULT 0,
  reach                  INTEGER DEFAULT 0,
  frequency              NUMERIC(8, 4) DEFAULT 0,
  clicks                 INTEGER DEFAULT 0,
  unique_clicks          INTEGER DEFAULT 0,
  ctr                    NUMERIC(8, 4),                   -- pct (0-100)
  cpc                    NUMERIC(10, 4),
  cpm                    NUMERIC(10, 4),
  video_3s_views         INTEGER DEFAULT 0,
  video_thruplays        INTEGER DEFAULT 0,
  video_avg_time_watched NUMERIC(10, 2),
  results                INTEGER DEFAULT 0,               -- platform conversion-event count
  cost_per_result        NUMERIC(12, 4),
  raw_payload            JSONB,
  synced_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ad_id, date)
);

CREATE INDEX IF NOT EXISTS idx_ad_daily_stats_date ON ad_daily_stats(date DESC);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_daily_stats ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Allow authenticated read ads" ON ads
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow authenticated insert ads" ON ads
    FOR INSERT TO authenticated WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow authenticated update ads" ON ads
    FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Hard-delete is service-role only. Use `archived_at` for soft-deletes;
-- the Meta sync sets it when an ad's effective_status becomes DELETED/ARCHIVED.

DO $$ BEGIN
  CREATE POLICY "Allow authenticated read ad_daily_stats" ON ad_daily_stats
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow authenticated insert ad_daily_stats" ON ad_daily_stats
    FOR INSERT TO authenticated WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow authenticated update ad_daily_stats" ON ad_daily_stats
    FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ad_daily_stats: hard-delete is service-role only — daily insights are
-- effectively immutable historical records.

-- Reload PostgREST schema so the new tables are immediately queryable.
NOTIFY pgrst, 'reload schema';
