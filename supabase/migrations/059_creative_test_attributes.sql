-- 058_creative_test_attributes.sql
--
-- Creative Performance Analytics — Phase 1 schema.
--
-- Three new tables:
--   1. offers — vertical/offer abstraction so the generic script generator can
--      target any OPT offer (restoration today, home-service verticals tomorrow,
--      white-label later) without code changes.
--   2. creative_attribute_vocab — controlled vocabulary for the 11 test-variable
--      dimensions. UI dropdowns query this; Ben adds new values without DDL.
--   3. creative_attributes — 1:1 with public.ads. Stores LLM-extracted +
--      operator-overridden test-variable tags per ad. Pivot-friendly dense
--      columns, not EAV.
--
-- Pattern follows public.ad_angles (mig 053): public schema, RLS allow-all,
-- grants to anon + authenticated, idempotent, NOTIFY pgrst at end.
--
-- Apply via supabase db push.

BEGIN;

-- ─── 1. Offers ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.offers (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                      TEXT UNIQUE NOT NULL,
  name                      TEXT NOT NULL,
  vertical                  TEXT NOT NULL,
  mechanism_name            TEXT,
  primary_audience          TEXT,
  default_proof_characters  TEXT[] NOT NULL DEFAULT '{}',
  has_dual_guarantee        BOOLEAN NOT NULL DEFAULT FALSE,
  brand_voice_md            TEXT,
  kb_doc_url                TEXT,
  retired                   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offers_vertical ON public.offers(vertical) WHERE NOT retired;
CREATE INDEX IF NOT EXISTS idx_offers_retired  ON public.offers(retired);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_offers_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_offers_updated_at ON public.offers;
CREATE TRIGGER trg_offers_updated_at
  BEFORE UPDATE ON public.offers
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_offers_updated_at();

-- Seed (idempotent via ON CONFLICT)
INSERT INTO public.offers (slug, name, vertical, mechanism_name, primary_audience, default_proof_characters, has_dual_guarantee)
VALUES
  ('opt-restoration',
   'OPT Restoration (Direct Call Engine)',
   'restoration',
   'The Direct Call Engine',
   'Restoration company owners doing $50k+/mo, burned by generic local-SEO agencies, dependent on TPAs / Thumbtack / shared leads',
   ARRAY['Eric','Adam','Belinda','Morgan','Karen','Derek','Mike'],
   TRUE),
  ('opt-hvac-stub',
   'OPT HVAC (placeholder)',
   'hvac',
   NULL, NULL, ARRAY[]::TEXT[], FALSE),
  ('opt-electrical-stub',
   'OPT Electrical (placeholder)',
   'electrical',
   NULL, NULL, ARRAY[]::TEXT[], FALSE),
  ('opt-roofing-stub',
   'OPT Roofing (placeholder)',
   'roofing',
   NULL, NULL, ARRAY[]::TEXT[], FALSE),
  ('opt-whitelabel-template',
   'White-label template',
   'generic',
   NULL, NULL, ARRAY[]::TEXT[], FALSE)
ON CONFLICT (slug) DO NOTHING;


-- ─── 2. Controlled vocabulary ─────────────────────────────────────────
-- Each row is an allowed value for one attribute. UI dropdowns SELECT
-- WHERE attribute_name = X AND NOT retired ORDER BY sort_order.
CREATE TABLE IF NOT EXISTS public.creative_attribute_vocab (
  attribute_name   TEXT NOT NULL,
  attribute_value  TEXT NOT NULL,
  label            TEXT NOT NULL,
  description      TEXT,
  sort_order       INT NOT NULL DEFAULT 0,
  retired          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (attribute_name, attribute_value)
);

CREATE INDEX IF NOT EXISTS idx_creative_attribute_vocab_name
  ON public.creative_attribute_vocab(attribute_name) WHERE NOT retired;

-- Seed all 11 attribute enums
INSERT INTO public.creative_attribute_vocab (attribute_name, attribute_value, label, description, sort_order) VALUES
  -- hook_type
  ('hook_type', 'question',     'Question',     'Opens with a direct question to the prospect',                 10),
  ('hook_type', 'scene',        'Scene',        'Opens by painting a specific scene (e.g. ''Tuesday morning at Adam''s shop'')', 20),
  ('hook_type', 'dollar_pain',  'Dollar-pain',  'Leads with a specific dollar figure of waste or loss',         30),
  ('hook_type', 'diagnostic',   'Diagnostic',   'Piercing single-line diagnosis of the prospect''s situation',  40),
  ('hook_type', 'conditional',  'Conditional',  'If/then frame — ''If your phone rang less than five times…''', 50),

  -- message_frame
  ('message_frame', 'problem',      'Problem',      'Speaks to active pain — what''s broken or embarrassing right now', 10),
  ('message_frame', 'circumstance', 'Circumstance', 'Speaks to the specific business situation the prospect is in',     20),
  ('message_frame', 'outcome',      'Outcome',      'Paints the vivid end-state the prospect wants',                    30),

  -- mechanism_reveal
  ('mechanism_reveal', 'gated',     'GATED',     'Brand-named mechanism (e.g. ''The Direct Call Engine'') without revealing literal deliverable', 10),
  ('mechanism_reveal', 'explicit',  'EXPLICIT',  'Names the literal deliverable (e.g. ''Top 3 in Google Maps'')',                                 20),
  ('mechanism_reveal', 'hidden',    'HIDDEN',    'Mechanism not named at all — outcomes only',                                                    30),

  -- proof_character (extensible; new clients get added here)
  ('proof_character', 'eric',     'Eric (Complete Flood, San Antonio)',       'Restoration — $80k burned on 5 agencies → $250k/q direct',         10),
  ('proof_character', 'adam',     'Adam (We Know Mould)',                     'Restoration — full capacity, second van 4mo in',                   20),
  ('proof_character', 'belinda',  'Belinda (JSW)',                            'Restoration — 0 to 140 emergency calls/mo',                        30),
  ('proof_character', 'morgan',   'Morgan (Plumbing H2O)',                    'Restoration scaling — 1 van → 3 vans in 12mo',                     40),
  ('proof_character', 'karen',    'Karen Pierce (Coastal, Tampa) [PLACEHOLDER]',  'Adjuster-flip — was 80% adjuster-dependent → 11 adjusters call her direct',  50),
  ('proof_character', 'derek',    'Derek Walsh (Apex Commercial, Chicago) [PLACEHOLDER]', 'Commercial restoration — $40-80k tickets',          60),
  ('proof_character', 'mike',     'Mike Tan (Cornerstone, Phoenix) [PLACEHOLDER]', 'Recent (day 80) — first $8,400 direct mit call last Tuesday', 70),
  ('proof_character', 'none',     '— No named proof —',                       'Script uses no named proof character',                             99),

  -- pain_angle
  ('pain_angle', 'phone_not_ringing',  'Phone not ringing',   'Direct emergency calls aren''t landing', 10),
  ('pain_angle', 'agency_burn',        'Agency burn',         'Burned by previous marketing agencies', 20),
  ('pain_angle', 'tpa_referral_dep',   'TPA / Referral dep',  'Dependent on TPAs or referrals (someone else owns the calls)', 30),
  ('pain_angle', 'capacity_mismatch',  'Capacity mismatch',   'Premium crew running cheap residential work', 40),
  ('pain_angle', 'lead_platform',      'Lead platform',       'Thumbtack / HomeAdvisor / Angi / Networx fatigue', 50),
  ('pain_angle', 'storm_seasonal',     'Storm / seasonal',    'Storm season or storm-specific demand', 60),
  ('pain_angle', 'scaling_growth',     'Scaling / growth',    'Has crew & gear, just needs more calls (second van)', 70),
  ('pain_angle', 'speed_timeline',     'Speed / timeline',    '90-day timeline vs 12-18mo industry standard', 80),
  ('pain_angle', 'guarantee_proof',    'Guarantee / proof',   'Money-back guarantee mechanics, Day 91 worst case', 90),
  ('pain_angle', 'founder_identity',   'Founder identity',    'Founder-mode personal story (Pod G)',  100),
  ('pain_angle', 'commercial_tier',    'Commercial tier',     'Built for commercial, running residential', 110),
  ('pain_angle', 'adjuster_relations', 'Adjuster relations',  'Insurance adjuster relationship flip', 120),
  ('pain_angle', 'competitor_takeover','Competitor takeover', 'Newer competitor absorbing your metro''s demand', 130),
  ('pain_angle', 'last_objection',     'Last objection',      'Heard-this-before objection handling (Pod L)', 140),

  -- funnel_stage
  ('funnel_stage', 'tof',   'Top of Funnel (cold)',     'Cold prospecting',           10),
  ('funnel_stage', 'mof',   'Middle of Funnel (warm)',  'Warm retargeting',           20),
  ('funnel_stage', 'bof',   'Bottom of Funnel (hot)',   'Hot retargeting / objection-handling', 30),
  ('funnel_stage', 'cross', 'Cross-Funnel',             'Plays at multiple stages',   40),

  -- awareness_level (Schwartz 5 stages)
  ('awareness_level', 'unaware',        'Unaware',        'Doesn''t recognize the problem',                10),
  ('awareness_level', 'problem_aware',  'Problem-Aware',  'Knows they have a problem, not a solution',    20),
  ('awareness_level', 'solution_aware', 'Solution-Aware', 'Knows solutions exist, hasn''t picked yours',  30),
  ('awareness_level', 'product_aware',  'Product-Aware',  'Knows OPT specifically, hasn''t committed',    40),
  ('awareness_level', 'most_aware',     'Most-Aware',     'Knows everything; needs offer + deadline',     50),

  -- length_bucket
  ('length_bucket', 'under_60s',  'Under 60s', 'Under 60 seconds',  10),
  ('length_bucket', 'sixty_75s',  '60-75s',    '60 to 75 seconds',  20),
  ('length_bucket', 'over_75s',   '75s+',      '75 seconds or longer', 30),

  -- format
  ('format', 'talking_head', 'Talking Head', 'Founder or operator on camera direct-address', 10),
  ('format', 'ugc',          'UGC',          'Customer or operator style, less polished',    20),
  ('format', 'comparative',  'Comparative',  'Side-by-side / comparison format',             30),
  ('format', 'voiceover',    'Voiceover',    'No on-camera talent, VO + B-roll',             40),

  -- actor
  ('actor', 'ben',           'Ben',          'Ben on camera',                  10),
  ('actor', 'austin',        'Austin',       'Austin on camera',               20),
  ('actor', 'client',        'Client',       'A real OPT client on camera',    30),
  ('actor', 'voiceover_only','Voiceover only','No on-camera talent',           40),
  ('actor', 'other',         'Other / new',  'Someone not yet in the vocab',   90),

  -- vertical (mirrors offers.vertical for fast filtering)
  ('vertical', 'restoration', 'Restoration', 'Water mit / mold / fire / smoke', 10),
  ('vertical', 'hvac',        'HVAC',        'HVAC contractors',                20),
  ('vertical', 'electrical',  'Electrical',  'Electrical contractors',          30),
  ('vertical', 'roofing',     'Roofing',     'Roofing contractors',             40),
  ('vertical', 'plumbing',    'Plumbing',    'Plumbing contractors',            50),
  ('vertical', 'generic',     'Generic',     'White-label / non-OPT-specific',  90)
ON CONFLICT (attribute_name, attribute_value) DO NOTHING;


-- ─── 3. creative_attributes — one row per ad ──────────────────────────
CREATE TABLE IF NOT EXISTS public.creative_attributes (
  ad_id                    TEXT PRIMARY KEY REFERENCES public.ads(ad_id) ON DELETE CASCADE,
  offer_slug               TEXT REFERENCES public.offers(slug),

  -- LLM-extractable attributes
  hook_type                TEXT,
  message_frame            TEXT,
  mechanism_reveal         TEXT,
  proof_character          TEXT,
  pain_angle               TEXT,
  funnel_stage             TEXT,
  awareness_level          TEXT,
  length_bucket            TEXT,
  format                   TEXT,

  -- Operator-only attributes (LLM never sets these)
  actor                    TEXT,
  vertical                 TEXT,  -- denormalized from offers.vertical for fast pivot

  -- Winner state
  manual_winner_override   BOOLEAN,  -- NULL = no override; TRUE = forced winner; FALSE = forced loser
  winner_auto_detected     BOOLEAN NOT NULL DEFAULT FALSE,

  -- LLM provenance
  extracted_at             TIMESTAMPTZ,
  extracted_by_model       TEXT,
  extraction_confidence    JSONB,         -- { hook_type: 0.93, message_frame: 0.71, ... }
  raw_llm_response         JSONB,         -- full Claude response for re-parsing if vocab changes

  notes                    TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes optimized for the Insights page pivots
CREATE INDEX IF NOT EXISTS idx_creative_attributes_offer        ON public.creative_attributes(offer_slug);
CREATE INDEX IF NOT EXISTS idx_creative_attributes_hook_type    ON public.creative_attributes(hook_type)        WHERE hook_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_attributes_msg_frame    ON public.creative_attributes(message_frame)    WHERE message_frame IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_attributes_mech_reveal  ON public.creative_attributes(mechanism_reveal) WHERE mechanism_reveal IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_attributes_proof_char   ON public.creative_attributes(proof_character)  WHERE proof_character IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_attributes_pain_angle   ON public.creative_attributes(pain_angle)       WHERE pain_angle IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_attributes_funnel_stage ON public.creative_attributes(funnel_stage)     WHERE funnel_stage IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_attributes_vertical     ON public.creative_attributes(vertical)         WHERE vertical IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_attributes_winner       ON public.creative_attributes(winner_auto_detected, manual_winner_override);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_creative_attributes_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_creative_attributes_updated_at ON public.creative_attributes;
CREATE TRIGGER trg_creative_attributes_updated_at
  BEFORE UPDATE ON public.creative_attributes
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_creative_attributes_updated_at();


-- ─── 4. generated_scripts — output of the script generator ──────────
-- LLM-generated script drafts before they become real Meta ads.
-- Operator picks the best, films them, and the resulting Meta ad gets
-- tagged via creative_attributes (matching attributes carry over).
CREATE TABLE IF NOT EXISTS public.generated_scripts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_slug          TEXT REFERENCES public.offers(slug),
  ref                 TEXT,                  -- e.g. "M1"
  title               TEXT,
  frame               TEXT,                  -- PROBLEM | CIRCUMSTANCE | OUTCOME
  body                TEXT NOT NULL,
  target_attributes   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- hook_type, mechanism_reveal, etc
  status              TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','approved','filming','filmed','shipped','archived')),
  ad_id               TEXT REFERENCES public.ads(ad_id),    -- set when this becomes a real ad
  generated_by_model  TEXT,
  generation_params   JSONB,                  -- the input that produced this draft (for reproducibility)
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_scripts_offer  ON public.generated_scripts(offer_slug);
CREATE INDEX IF NOT EXISTS idx_generated_scripts_status ON public.generated_scripts(status);
CREATE INDEX IF NOT EXISTS idx_generated_scripts_ad_id  ON public.generated_scripts(ad_id) WHERE ad_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_generated_scripts_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generated_scripts_updated_at ON public.generated_scripts;
CREATE TRIGGER trg_generated_scripts_updated_at
  BEFORE UPDATE ON public.generated_scripts
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_generated_scripts_updated_at();


-- ─── 5. RLS + grants ──────────────────────────────────────────────────
ALTER TABLE public.offers                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creative_attribute_vocab  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creative_attributes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_scripts         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all" ON public.offers;
DROP POLICY IF EXISTS "Allow all" ON public.creative_attribute_vocab;
DROP POLICY IF EXISTS "Allow all" ON public.creative_attributes;
DROP POLICY IF EXISTS "Allow all" ON public.generated_scripts;

CREATE POLICY "Allow all" ON public.offers                   FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON public.creative_attribute_vocab FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON public.creative_attributes      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON public.generated_scripts        FOR ALL USING (true) WITH CHECK (true);

GRANT ALL ON public.offers                    TO anon, authenticated;
GRANT ALL ON public.creative_attribute_vocab  TO anon, authenticated;
GRANT ALL ON public.creative_attributes       TO anon, authenticated;
GRANT ALL ON public.generated_scripts         TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
