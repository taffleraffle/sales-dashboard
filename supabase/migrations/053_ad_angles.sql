-- 053_ad_angles.sql
-- Adds the angle-testing primitives so Ben can name + label a messaging
-- angle, assign creatives to it, and track aggregate performance to
-- decide winner / loser. Lives in the Messaging "Testing" tab.
--
-- ad_angles: one row per angle being tested.
-- ad_angle_assignments: m2m link from angle → ads (an ad can belong to
--   multiple angles, e.g. "Objection: time-poor owner" + "Proof: 90-day
--   case study").
--
-- Idempotent. Apply via supabase db push.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ad_angles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  label       TEXT,                                            -- short tag, e.g. "OBJ-TIME"
  hypothesis  TEXT,                                            -- what we expect this angle to prove
  status      TEXT NOT NULL DEFAULT 'testing'
              CHECK (status IN ('testing','winner','loser','paused','archived')),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_angles_status     ON public.ad_angles(status);
CREATE INDEX IF NOT EXISTS idx_ad_angles_created_at ON public.ad_angles(created_at DESC);

CREATE TABLE IF NOT EXISTS public.ad_angle_assignments (
  angle_id    UUID NOT NULL REFERENCES public.ad_angles(id) ON DELETE CASCADE,
  ad_id       TEXT NOT NULL,                                   -- matches ads.ad_id (Meta numeric id stored as text)
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (angle_id, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_ad_angle_assignments_ad_id ON public.ad_angle_assignments(ad_id);

-- updated_at trigger so we can sort by recent activity.
CREATE OR REPLACE FUNCTION public.touch_ad_angles_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ad_angles_updated_at ON public.ad_angles;
CREATE TRIGGER trg_ad_angles_updated_at
  BEFORE UPDATE ON public.ad_angles
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_ad_angles_updated_at();

-- RLS — the Sales dashboard runs with the anon key, so we grant
-- read+write to anon and authenticated. (Mirrors the rest of the
-- internal tables in this project; this is not a multi-tenant app.)
ALTER TABLE public.ad_angles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_angle_assignments  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all" ON public.ad_angles;
DROP POLICY IF EXISTS "Allow all" ON public.ad_angle_assignments;

CREATE POLICY "Allow all" ON public.ad_angles            FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON public.ad_angle_assignments FOR ALL USING (true) WITH CHECK (true);

GRANT ALL ON public.ad_angles            TO anon, authenticated;
GRANT ALL ON public.ad_angle_assignments TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
