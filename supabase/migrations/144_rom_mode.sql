-- Migration 144: ROM mode (script_mode = 'rom').
--
-- Ben 2026-06-09 (after validating 20 electrician + 20 restoration
-- scripts in this style): "save them to memory as ROM style, and log
-- them as an option so when I generate them on platform, I can do it
-- on platform too."
--
-- ROM style characteristics (validated batch):
--   - DIVERSE HOOK SHAPES per batch (insight reveal, AI shift,
--     mechanism reveal, pattern interrupt, story-led, mistake framing,
--     identity, qualifier-led, trend/future, outcome-led, agency
--     callouts — NEVER repeat a hook shape across a batch).
--   - LOCKED body skeleton — setup with $50K+/mo qualifier + named
--     real proof character + concrete result, then "Here's the truth
--     Google won't say out loud..." reveal, then offer line, then CTA.
--   - The "#1 in 90 days or money back" line is the OFFER at the close
--     — NEVER the hook. (Ben killed a previous batch where every hook
--     was that line: "real fucking shit".)
--   - Solution-aware audience only — no problem-aware stats, no
--     competitor framing, no branded mechanism names ("Get Found
--     engine", "Maps Mastery").
--
-- This migration:
--   1. Expands the script_examples.mode CHECK to allow 'rom'.
--   2. Seeds 2 reference examples (electrician + restoration) so the
--      edge function has concrete templates to ground generation.
--
-- The edge function / UI changes that surface ROM as a selectable mode
-- ship alongside this migration in the same PR.

BEGIN;

-- 1. Expand the mode CHECK constraint to include 'rom'.
ALTER TABLE public.script_examples
  DROP CONSTRAINT IF EXISTS script_examples_mode_check;

ALTER TABLE public.script_examples
  ADD CONSTRAINT script_examples_mode_check
  CHECK (mode IN ('educational', 'direct', 'hybrid', 'rom'));

-- 2. Seed ROM-style examples (cross-vertical reference).

INSERT INTO public.script_examples (slug, title, body, mode, script_type, offer_slug, audience_label, notes, source) VALUES

('ex-rom-electrician-insight-hamish',
 'ROM — Insight reveal + Hamish (electrician)',
 $$Most electricians don't know this yet. Google's AI now ranks Maps results by three specific signals on your business profile. Not your website. Not your backlinks. Three signals on your Google Business Profile.

If you do $50K+/month and you're not in the top 3 for "electrician near me," you're missing at least one. Hamish from HM Electrical went from zero direct calls to 90+ in 100 days after we installed his.

Here's the truth Google won't say out loud. Their AI doesn't rank you by your website anymore. It ranks you by proof — proof you serve the area, proof people pick you, proof you're still open. Most electrician profiles miss all three.

We'll make you the #1 company in your area in 90 days or your money back. No ads. No retainer.

If you're a $50K+/month electrician ready to be #1, click below.$$,
 'rom', 'hook_body', NULL, '$50K+/mo electrician',
 E'Canonical ROM script. Four beats: insight-reveal HOOK ("most don''t know this yet" + the actual reveal) → SETUP with $50K+/mo qualifier + Hamish proof → "Here''s the truth Google won''t say out loud" REVEAL → OFFER ("#1 in 90 days or money back, no ads, no retainer") → CTA. The reveal sentence is locked verbatim across every ROM script in a batch. Only the hook varies.',
 'Ben 2026-06-09'),

('ex-rom-restoration-mechanism-eric',
 'ROM — Mechanism reveal + Eric (restoration)',
 $$Three signals on your Google Business Profile decide which restoration company ranks #1 in your city. That's it. Not your crew. Not your years in business. Not your reviews.

If you do $50K+/month, you have the crew, the years, and the reviews. You don't have the signals installed. Eric from Complete Flood closed an extra $215,000 in 60 days after we put his in.

Here's the truth Google won't say out loud. Their AI doesn't rank you by your website anymore. It ranks you by proof — proof you serve the area, proof people pick you, proof you're still open. Most restoration profiles miss all three.

We'll make you the #1 company in your area in 90 days or your money back. No ads. No retainer.

If you're a $50K+/month restoration owner ready to be #1, click below.$$,
 'rom', 'hook_body', NULL, '$50K+/mo restoration',
 E'ROM with a mechanism-reveal HOOK shape — same locked body, different open. Demonstrates how the hook varies while the body stays fixed. Eric/Complete Flood is the validated restoration proof character (along with Jack/LA and Yeah We Know Mold Sucks).',
 'Ben 2026-06-09')

ON CONFLICT (slug) DO UPDATE
  SET title          = EXCLUDED.title,
      body           = EXCLUDED.body,
      mode           = EXCLUDED.mode,
      script_type    = EXCLUDED.script_type,
      audience_label = EXCLUDED.audience_label,
      notes          = EXCLUDED.notes,
      source         = EXCLUDED.source,
      updated_at     = NOW();

NOTIFY pgrst, 'reload schema';

COMMIT;
