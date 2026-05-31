-- Script angles + reusable template library for the AdsGenerator system.
--
-- Background (Ben 2026-05-31): the existing creative-generate-script
-- Edge Function uses a single locked prompt with 8 attribute filters
-- (hook_type, message_frame, pain_angle, etc) baked from 21 iterations
-- of ad-creative-kb. It writes "full scripts" without distinguishing
-- between Hook / Body / Joined as output types.
--
-- The new system layers structural templates ON TOP of those locked
-- principles:
--
--   - script_angles            — a positioning angle ("becoming the #1
--                                 restoration company in your city"). One
--                                 angle has its own qualifier, mechanism,
--                                 and proof character roster.
--   - script_proof_characters  — per-angle named-client proofs ("Metro
--                                 closed a $215k job in 90 days").
--   - script_hook_shapes       — GLOBAL catalog of opening-move shapes
--                                 (A: Direct offer, B: Hypothetical
--                                 question, ..., H: Trend/future).
--                                 Shared across all angles.
--   - script_body_skeletons    — GLOBAL catalog of body-beat structures.
--                                 Shared across all angles.
--
-- The Edge Function consumes these as few-shot examples + structural
-- constraints when generating Hook / Body / Joined output. Migration
-- 105 also seeds the first complete angle (becoming-1-in-city) plus
-- 8 hook shapes and the 7-beat body skeleton derived from Ben's
-- 2026-05-31 template drop.

BEGIN;

-- ── 1. Tables ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.script_angles (
  slug              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  -- Which offers (FK to offers.slug) this angle applies to. Empty / NULL
  -- means "any offer in the named vertical(s)" — read by the generator
  -- as a soft filter.
  offer_slugs       TEXT[] DEFAULT '{}',
  -- Audience qualifier (the opening filter line shape, e.g.
  -- "Restoration companies above $50k/month").
  qualifier         TEXT NOT NULL,
  -- The single core promise that every hook + body for this angle must
  -- deliver on (e.g. "become the #1 restoration company in your city").
  primary_promise   TEXT NOT NULL,
  -- The mechanism by which we deliver it. _short for hooks, _long for body
  -- mechanism reveals.
  mechanism_short   TEXT NOT NULL,
  mechanism_long    TEXT,
  -- The guarantee close (e.g. "Guaranteed or you don't pay").
  guarantee_close   TEXT NOT NULL,
  -- The CTA tee-up phrase the body opens with.
  cta_teeup         TEXT,
  -- The vertical-specific anchor vocab (water mit, mit crew, TPA, etc).
  -- Generator rotates these so the anchor itself doesn't become a tic.
  anchor_vocab      TEXT[] DEFAULT '{}',
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.script_proof_characters (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  angle_slug        TEXT NOT NULL REFERENCES public.script_angles(slug) ON DELETE CASCADE,
  name              TEXT NOT NULL,             -- "Metro", "JSW", "Silverleaf"
  -- One-line proof for hook use: "Metro closed a $215,000 job in 90 days"
  result_short      TEXT NOT NULL,
  -- Multi-sentence proof for body roster use, includes timeframe + before/after
  result_long       TEXT,
  -- Context flags so the generator can pick a fitting proof per shape
  industry_context  TEXT,                      -- "restoration", "accounting", etc.
  metric_kind       TEXT,                      -- "revenue_close", "calls_increase", "ranking", etc.
  display_order     INT DEFAULT 100,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (angle_slug, name)
);

CREATE INDEX IF NOT EXISTS idx_script_proof_characters_angle
  ON public.script_proof_characters (angle_slug, display_order);

CREATE TABLE IF NOT EXISTS public.script_hook_shapes (
  code              TEXT PRIMARY KEY,          -- A, B, C, ..., H
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,             -- one-sentence shape description
  -- The structural template the generator hands to Claude. Slot markers
  -- like {qualifier}, {promise}, {mechanism}, {proof}, {guarantee} get
  -- filled with the angle's data; everything else is the structural shape.
  structural_template TEXT NOT NULL,
  -- A worked example of this shape filled in for the becoming-1-in-city
  -- angle. Massively improves Claude's adherence to the shape.
  example_filled    TEXT,
  -- Which message frame each shape naturally fits (problem / outcome /
  -- circumstance / mixed). Used as a soft filter when the operator picks
  -- "message_frame=problem" in targeted mode.
  message_frame     TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  display_order     INT DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.script_body_skeletons (
  code              TEXT PRIMARY KEY,          -- B1, B2, ...
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  -- The beat structure as a string array. Generator joins these with
  -- newlines and prefixes "Beat N:" when handing to Claude.
  beat_structure    TEXT[] NOT NULL,
  -- A worked example of this skeleton filled in for the becoming-1-in-city
  -- angle (one of the two body variants Ben supplied).
  example_filled    TEXT,
  -- Target length bucket (under_60s, 60_75s, 75s_plus).
  length_bucket     TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  display_order     INT DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. RLS / grants ──────────────────────────────────────────────────
-- All four tables are read-write for authenticated (admins / coordinators
-- edit angles via Settings) and read-only for anon (the marketing site
-- if it ever wants to surface proof characters). No PII; minimal risk.

GRANT SELECT, INSERT, UPDATE ON public.script_angles            TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.script_proof_characters  TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.script_hook_shapes       TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.script_body_skeletons    TO authenticated;
GRANT SELECT ON public.script_angles            TO anon;
GRANT SELECT ON public.script_proof_characters  TO anon;
GRANT SELECT ON public.script_hook_shapes       TO anon;
GRANT SELECT ON public.script_body_skeletons    TO anon;

-- ── 3. Seed: the 8 hook shapes (A-H) ─────────────────────────────────
-- These are the structural shapes extracted from Ben's 2026-05-31 hook
-- examples (hooks 11-20). They're GLOBAL — any angle's content can fill
-- them. Each row carries one worked example using the becoming-1-in-city
-- angle's slot fills so Claude has a concrete reference.

INSERT INTO public.script_hook_shapes
  (code, name, description, structural_template, example_filled, message_frame, display_order)
VALUES
  ('A', 'Direct offer',
   'Open with the qualifier, state the offer + mechanism, close with guarantee. No proof character — pure value proposition.',
   '{qualifier}: If you want to {promise}, here''s what we''ll do for you. We''ll {mechanism_short}. {guarantee_close}',
   'Restoration companies above $50k/month: If you want to become the #1 restoration company in your city, here''s what we''ll do for you. We''ll rank you top 3 on Google and book out your crews without you spending a cent on ads. Guaranteed or you don''t pay.',
   'outcome', 10),
  ('B', 'Hypothetical question',
   'Open with the qualifier, ask "If we told you we could ___ like we did for ___, would you take us up on that?", end with conditional guarantee.',
   'Quick question for {qualifier_short}: If we told you we could put you in position to {promise} within {timeframe}, like we did for {proof.name} who {proof.result_short}, would you take us up on that? If we don''t deliver, you don''t pay.',
   'Quick question for restoration owners doing over $50k/month: If we told you we could put you in position to become the #1 restoration company in your city within 90 days, like we did for Metro who closed a $215,000 job in that same window, would you take us up on that? If we don''t deliver, you don''t pay.',
   'outcome', 20),
  ('C', 'Pain anchor',
   'Open with a conditional pain ("If you own X and you''re tired of Y while [competitor] Z..."), pivot to specific proof, close with guarantee.',
   'If you own {vertical} doing over {tier} and you''re tired of being {pain_position} while {competitor} take all the {high_value_work}, here''s what we''ll do for you. {proof.name} {proof.result_long_compressed}. We''ll do the same for your business, {guarantee_close}.',
   'If you own a restoration company doing over $50k/month and you''re tired of being the #3 or #4 option in your market while ServPro and the franchises take all the high-value work, here''s what we''ll do for you. Tuffnell doubled their calls from 30 to 60 in 120 days with us and are now the dominant player in their city. We''ll do the same for your business, guaranteed or you don''t pay.',
   'problem', 30),
  ('D', 'Reality statement',
   'Open with a flat truth that names the current state ("There''s only one #1 and it''s not you"), promise to change it, prove with named client, guarantee.',
   '{qualifier}: {flat_truth_about_current_state}. We''ll change that. {proof.name} {proof.result_long_compressed}. We''ll do the same for your business and {secondary_outcome}, or you don''t pay.',
   'Restoration owners doing over $50k/month: There''s only one #1 restoration company in your city, and right now it''s not you. We''ll change that. Silverleaf went from 1 call a month to 10+ in 40 days once we ranked them top 3 on Google. We''ll do the same for your business and book out your crews, or you don''t pay.',
   'circumstance', 40),
  ('E', 'Curiosity question',
   'Open with "How is it possible that some {audience} ___ while others stay stuck...?", give the one-sentence answer, prove with named client, guarantee.',
   'How is it possible that some {vertical} {desired_outcome} within a year while others stay stuck at {bad_state} for a decade? The answer is simple. {one_sentence_mechanism}. {proof.name} {proof.result_long_compressed}. We''ll get you there and {secondary_outcome}, {guarantee_close}.',
   'How is it possible that some restoration companies become the dominant name in their market within a year while others stay stuck at $50k a month for a decade? The answer is simple. They own the top 3 of Google. Metro closed a $215,000 job in their first 90 days with us by getting there. We''ll get you there and book out your crews, guaranteed or you don''t pay.',
   'mixed', 50),
  ('F', 'Reframe',
   'Open with "The {desired_thing} isn''t the {assumed_cause}, it''s the {actual_cause}", make actual cause concrete, prove with named client, guarantee.',
   '{qualifier}: The {desired_thing} isn''t the {assumed_cause}. It''s the {actual_cause_one_line}. We''ll make that {desired_thing} yours. {proof.name} {proof.result_long_compressed}. {guarantee_close}.',
   'Restoration companies above $50k/month: The #1 restoration company in any city isn''t the one with the best service. It''s the one homeowners find first when they Google "water damage near me" at 2am. We''ll make that company yours. JSW doubled their calls from 40 to 80 in 60 days with us doing exactly that. Guaranteed or you don''t pay.',
   'outcome', 60),
  ('G', 'Desire question',
   'Open with a direct "Want to be the {desired_identity}?", name a client who already is, deliver the mechanism + guarantee.',
   '{qualifier}: Want to be the {vertical} {desired_identity}? {proof.name} is. {proof.result_long_compressed}. We''ll make your business the {desired_identity} too. {mechanism_short}, {guarantee_close}.',
   'Restoration owners doing over $50k/month: Want to be the restoration company everyone in your city calls first? Tuffnell is. They doubled their calls from 30 to 60 in 120 days with us and are now booked solid for the entire year. We''ll make your business the #1 option in your market too. Top 3 on Google, crews booked out, guaranteed or you don''t pay.',
   'outcome', 70),
  ('H', 'Trend / future',
   'Open with a forward-looking truth ("The {vertical} dominating in {year} won''t be the ones with X, they''ll be the ones who Y"), prove with named client, mirror to viewer, guarantee.',
   '{qualifier}: The {vertical} that {dominate_verb} their markets in {future_year} won''t be the ones with {expected_cause}. They''ll be the ones who {actual_cause_one_line}. {proof.name} {proof.result_long_compressed} by getting there. We''ll make your business the {desired_identity} the same way, {guarantee_close}.',
   'Restoration owners doing over $50k/month: The restoration companies that dominate their markets in 2026 won''t be the ones with the biggest ad budgets. They''ll be the ones who own the top 3 of Google organically. Metro closed a $215,000 job in their first 90 days with us by getting there. We''ll make your business the #1 option in your city the same way, guaranteed or you don''t pay.',
   'mixed', 80)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      structural_template = EXCLUDED.structural_template,
      example_filled = EXCLUDED.example_filled,
      message_frame = EXCLUDED.message_frame,
      display_order = EXCLUDED.display_order;

-- ── 4. Seed: the canonical 7-beat body skeleton (B1) ─────────────────

INSERT INTO public.script_body_skeletons
  (code, name, description, beat_structure, example_filled, length_bucket, display_order)
VALUES
  ('B1', 'Pattern + Roster + Mechanism + 3-part HOW',
   'The canonical OPT restoration body. Opens with a CTA tee-up, lays out a pattern statement, runs the proof roster, reveals the mechanism, then breaks down the 3-part HOW (GBP rebuild + service-page optimization + authority signals), closes with guarantee + final CTA.',
   ARRAY[
     'Beat 1 — CTA tee-up: "So if that sounds {qualifier_adjective}, click the link below to book a call where we can talk and tell you more."',
     'Beat 2 — Pattern statement: state the underlying truth of the angle (e.g. every city has one X that gets called first). Stylistic variance allowed; the truth-claim is fixed.',
     'Beat 3 — Proof roster: name 3-4 proof characters with their specific result numbers, back-to-back. No hedging language. (Use proof_characters for this angle.)',
     'Beat 4 — Mechanism reveal: "None of them got there by {wrong_path}. They got there because we {mechanism_long}."',
     'Beat 5a — HOW part 1: Foundation rebuild (Google Business Profile / equivalent foundation system for this vertical).',
     'Beat 5b — HOW part 2: Surface optimization (website / service pages / equivalent customer-facing surface).',
     'Beat 5c — HOW part 3: Authority signals (the differentiator that beats the franchises / dominant competitor).',
     'Beat 6 — Guarantee: "{guarantee_close}, {secondary_outcome}, {refund_clause}."',
     'Beat 7 — Final CTA: re-state the qualifier + the desired_identity transition + click the link.'
   ],
   'So if that sounds fair, click the link below to book a call where we can talk and tell you more.

Now here''s the thing. Every city in America has one restoration company that gets called first. They land the biggest jobs. Their crews stay booked solid year-round. Their name is the one homeowners think of when something goes wrong. And it''s almost never decided by who''s the best at the actual restoration work. It''s decided by who shows up first when a homeowner Googles "water damage company near me" at 2am with a flooded basement.

That''s the position we put our clients in. Metro closed a $215,000 job in their first 90 days with us. JSW doubled their inbound calls from 40 to 80 in 60 days. Silverleaf went from 1 call a month to 10+ within 40 days. And Tuffnell doubled from 30 to 60 calls in 120 days and are now booked solid for the entire year.

None of them got there by outspending the franchises in their market. They got there because we put them in the top 3 of Google for every restoration search in their city.

Here''s how we do it. We take your Google Business Profile and we rebuild it from the ground up to compete in the local 3-pack. Then we optimize every service page on your website so Google ranks you for the exact restoration work homeowners are searching for. Then we build the authority signals Google trusts. This is what gets you ranked above ServPro, Servicemaster, and whatever franchise has been dominating your market for the last decade.

We guarantee you''ll be ranked top 3 on Google and your crews will be booked out from the inbound calls. If we don''t deliver, you don''t pay.

So if you run a restoration company doing $50k a month or more and you''re ready to take the #1 spot in your city away from whoever''s been holding it for years, click the link below to book a call.',
   '60_75s', 10)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      beat_structure = EXCLUDED.beat_structure,
      example_filled = EXCLUDED.example_filled,
      length_bucket = EXCLUDED.length_bucket,
      display_order = EXCLUDED.display_order;

-- ── 5. Seed: the becoming-1-in-city angle ────────────────────────────

INSERT INTO public.script_angles
  (slug, name, offer_slugs, qualifier, primary_promise, mechanism_short, mechanism_long,
   guarantee_close, cta_teeup, anchor_vocab, notes)
VALUES
  ('becoming-1-in-city',
   'Becoming the #1 restoration company in your city',
   ARRAY[]::TEXT[],                            -- applies to any restoration offer; left empty for now
   'Restoration companies above $50k/month',
   'become the #1 restoration company in your city',
   'rank you top 3 on Google and book out your crews without you spending a cent on ads',
   'put you in the top 3 of Google for every restoration search in your city — Google Business Profile rebuild for the local 3-pack, every service page optimized for water damage / fire / mold / sewage / smoke in every zip code you cover, and authority signals strong enough to outrank ServPro, Servicemaster, and whatever franchise has held the #1 spot in your market for years',
   'Guaranteed or you don''t pay',
   'So if that sounds fair',
   ARRAY['water mit', 'mit crew', 'mit shop', 'water-damage', 'mold', 'smoke response', 'TPA', 'insurance adjuster', 'basement flood', 'restoration phone', 'flooded basement', 'water damage near me'],
   'Seeded from Ben''s 2026-05-31 template drop. 10 hook examples + 2 body variants distilled into 8 hook shapes + 1 canonical body skeleton.')
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      qualifier = EXCLUDED.qualifier,
      primary_promise = EXCLUDED.primary_promise,
      mechanism_short = EXCLUDED.mechanism_short,
      mechanism_long = EXCLUDED.mechanism_long,
      guarantee_close = EXCLUDED.guarantee_close,
      cta_teeup = EXCLUDED.cta_teeup,
      anchor_vocab = EXCLUDED.anchor_vocab,
      notes = EXCLUDED.notes,
      updated_at = NOW();

-- ── 6. Seed: 4 proof characters for that angle ───────────────────────

INSERT INTO public.script_proof_characters
  (angle_slug, name, result_short, result_long, industry_context, metric_kind, display_order)
VALUES
  ('becoming-1-in-city', 'Metro',
   'closed a $215,000 job in their first 90 days',
   'closed a $215,000 job in their first 90 days with us by getting ranked above the franchises in their market',
   'restoration', 'revenue_close', 10),
  ('becoming-1-in-city', 'JSW',
   'doubled their inbound calls from 40 to 80 in 60 days',
   'doubled their inbound calls from 40 to 80 in 60 days with us doing exactly that',
   'restoration', 'calls_increase', 20),
  ('becoming-1-in-city', 'Silverleaf',
   'went from 1 call a month to 10+ in 40 days',
   'went from 1 call a month to 10+ in 40 days once we ranked them top 3 on Google',
   'restoration', 'calls_increase', 30),
  ('becoming-1-in-city', 'Tuffnell',
   'doubled their calls from 30 to 60 in 120 days',
   'doubled their calls from 30 to 60 in 120 days with us and are now the dominant player in their city, booked solid for the entire year',
   'restoration', 'calls_increase', 40)
ON CONFLICT (angle_slug, name) DO UPDATE
  SET result_short = EXCLUDED.result_short,
      result_long = EXCLUDED.result_long,
      industry_context = EXCLUDED.industry_context,
      metric_kind = EXCLUDED.metric_kind,
      display_order = EXCLUDED.display_order;

NOTIFY pgrst, 'reload schema';

COMMIT;
