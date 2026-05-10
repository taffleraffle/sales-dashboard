-- 029_utm_attribution_and_seed.sql
-- Two unrelated stage-gate changes batched into one paste:
--
--   1. UTM attribution columns on setter_leads + ghl_appointments — sets up
--      the schema so that when (a) Meta ad URL parameter template is set to
--      `utm_content={{ad.id}}` and (b) GHL captures the contact's UTM custom
--      fields, our sync can carry that signal through to the ad gallery's
--      KPI badges.
--
--      Until Meta + GHL are configured, these columns stay NULL and no harm
--      done. Schema is there for the day they turn on.
--
--   2. Re-seed the canonical 19 library.components — 027's seed apparently
--      didn't land (we see 0 rows in lib_components today), so the variant
--      tagging UI has nothing to pick from. Idempotent ON CONFLICT seed.
--
-- Apply by pasting into Supabase Studio SQL editor.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1 · UTM attribution columns
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.setter_leads
  ADD COLUMN IF NOT EXISTS utm_content  TEXT,
  ADD COLUMN IF NOT EXISTS utm_source   TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium   TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS utm_term     TEXT,
  ADD COLUMN IF NOT EXISTS attribution_captured_at TIMESTAMPTZ;

ALTER TABLE public.ghl_appointments
  ADD COLUMN IF NOT EXISTS utm_content  TEXT,
  ADD COLUMN IF NOT EXISTS utm_source   TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium   TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS utm_term     TEXT;

-- Index on utm_content so the gallery → setter_leads join is fast.
CREATE INDEX IF NOT EXISTS idx_setter_leads_utm_content
  ON public.setter_leads(utm_content) WHERE utm_content IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ghl_appointments_utm_content
  ON public.ghl_appointments(utm_content) WHERE utm_content IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- 2 · Re-seed canonical library.components
-- ─────────────────────────────────────────────────────────────────
-- Per OPT-MetaAd-Naming-SOP-v2 + AD-PERFORMANCE-PLAN.md:
--   • 7 body angles (BA-*)
--   • 7 scenes     (S-*)
--   • 5 creators   (creator IDs)
-- Hooks (H*) stay un-seeded since they're script-specific and need real text.
INSERT INTO library.components (component_id, type, label, description, status) VALUES
  -- Body angles
  ('BA-PROOF',      'body_angle', 'Proof',       'Social proof or case-study angle: real customer outcomes, before/after',                    'ready'),
  ('BA-DATA',       'body_angle', 'Data',        'Statistics / numbers-led: "we saved $X across N clients"',                                   'ready'),
  ('BA-STORY',      'body_angle', 'Story',       'Narrative arc: prospect transformation journey, "let me tell you about..."',                'ready'),
  ('BA-AUTHORITY',  'body_angle', 'Authority',   'Founder authority / track record / credentials',                                              'ready'),
  ('BA-TEACHING',   'body_angle', 'Teaching',    'Educational / how-to angle: "here are the 3 things"',                                         'ready'),
  ('BA-OFFER',      'body_angle', 'Offer',       'Direct offer pitch: pricing, guarantee, scarcity',                                            'ready'),
  ('BA-COMPETITOR', 'body_angle', 'Competitor',  'Anti-competitor: "stop hiring agencies that..."',                                             'ready'),

  -- Scenes
  ('S-OFFICE',     'scene', 'Office',     'Filmed in office / desk / workspace',                       'ready'),
  ('S-CAR',        'scene', 'Car',        'Filmed in car / vehicle',                                    'ready'),
  ('S-STUDIO',     'scene', 'Studio',     'Studio / clean white-wall talking head',                     'ready'),
  ('S-OUTDOOR',    'scene', 'Outdoor',    'Outdoor / on location / walking',                            'ready'),
  ('S-ONSITE',     'scene', 'Onsite',     'On a job site / construction / restoration property',       'ready'),
  ('S-PHONE',      'scene', 'Phone',      'Selfie / phone-held, casual',                                'ready'),
  ('S-WHITEBOARD', 'scene', 'Whiteboard', 'Whiteboard / diagram-driven explanation',                    'ready'),

  -- Creators
  ('OSO',      'creator', 'Oso',       'OSO — primary creator, restoration vertical',         'ready'),
  ('SOFIA',    'creator', 'Sofia',     'Sofia — creator, restoration vertical',               'ready'),
  ('NATALIE',  'creator', 'Natalie',   'Natalie — UGC creator',                                'ready'),
  ('RESTO-AI', 'creator', 'Resto-AI',  'AI-generated talking-head video (FORGE pipeline)',    'ready'),
  ('CLIENT',   'creator', 'Client',    'Direct client testimonial — actual OPT customer',     'ready')
ON CONFLICT (component_id) DO UPDATE SET
  type = EXCLUDED.type,
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  status = EXCLUDED.status,
  updated_at = NOW();

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ─────────────────────────────────────────────────────────────────
-- Post-apply verification (run separately)
-- ─────────────────────────────────────────────────────────────────
-- SELECT type, count(*) FROM library.components GROUP BY type ORDER BY type;
-- Expected: body_angle = 7, scene = 7, creator = 5
