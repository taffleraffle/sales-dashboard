-- 048_fix_clips_perms_and_seed.sql
-- Two fixes:
--
-- 1. P0 — `lib_clips` and `lib_editors` were recreated `WITH (security_invoker
--    = on)` in migration 040, which broke anon/authenticated reads because
--    those roles don't have SELECT on the underlying `library.*` tables.
--    Drop the security_invoker flag so the view runs with its owner's
--    permissions (which is how migration 032's original view worked).
--
-- 2. Seed placeholder editors and ~16 placeholder clips so the Clips page
--    isn't empty for demos / first-load. All clips are tagged
--    `placeholder=true` in notes so they're easy to bulk-delete later.
--
-- Idempotent. Apply via supabase db push.

BEGIN;

-- ─── 1 · Fix the broken views ──────────────────────────────────────
DROP VIEW IF EXISTS public.lib_clips    CASCADE;
DROP VIEW IF EXISTS public.lib_editors  CASCADE;

CREATE VIEW public.lib_clips   AS SELECT * FROM library.clips;
CREATE VIEW public.lib_editors AS
  SELECT editor_id, label, status
  FROM library.editors
  WHERE status = 'active'
  ORDER BY label;

GRANT SELECT ON public.lib_clips   TO anon, authenticated;
GRANT SELECT ON public.lib_editors TO anon, authenticated;


-- ─── 2 · Seed editors ──────────────────────────────────────────────
INSERT INTO library.editors (editor_id, label) VALUES
  ('JONAS',   'Jonas'),
  ('ADITYA',  'Aditya'),
  ('LEO',     'Leo'),
  ('IN-HOUSE','In-house')
ON CONFLICT (editor_id) DO NOTHING;


-- ─── 3 · Seed placeholder clips ────────────────────────────────────
-- 16 clips covering all type × funnel combinations so the card grid
-- demonstrates every state. `notes` carries the 'placeholder' tag
-- so a future migration can DELETE FROM library.clips WHERE notes
-- LIKE '%[placeholder]%' to wipe them cleanly.

INSERT INTO library.clips
  (clip_id, clip_type, funnel_position, creator_id, editor,
   priority, duration_sec, description, section, notes,
   stage_raw, stage_rough_cut, stage_final_cut, stage_approved)
VALUES
  -- Top of funnel hooks
  ('H01-OSO-hook-flood',         'hook',        'top',    'OSO',     'Jonas',    'high', 18, 'Hook · "I lost 60k chasing flood leads"',                'top', '[placeholder]', true, true, true, true),
  ('H02-SOFIA-hook-truth',       'hook',        'top',    'SOFIA',   'Aditya',   'high', 14, 'Hook · "Truth about restoration ads in 2026"',          'top', '[placeholder]', true, true, true, false),
  ('H03-ADAM-hook-clickbait',    'hook',        'top',    'ADAM',    'Leo',      'med',  12, 'Hook · "Why most restoration ads fail in 7 days"',      'top', '[placeholder]', true, true, false, false),
  ('H04-NATALIE-hook-trust',     'hook',        'top',    'NATALIE', 'In-house', 'med',  16, 'Hook · "Stop trusting marketing agencies until..."',    'top', '[placeholder]', true, false, false, false),

  -- Top of funnel proof
  ('P01-CLIENT-proof-eric',      'hook_proof',  'top',    'CLIENT',  'Jonas',    'high', 22, 'Proof · Eric — "$340k extra revenue in 90 days"',       'top', '[placeholder]', true, true, true, true),
  ('P02-CLIENT-proof-storm',     'hook_proof',  'top',    'CLIENT',  'Jonas',    'high', 28, 'Proof · Storm restoration owner — 4x leads',            'top', '[placeholder]', true, true, true, true),

  -- Middle of funnel bodies (process / mechanism)
  ('B01-OSO-body-process',       'body',        'middle', 'OSO',     'Aditya',   'high', 45, 'Body · The 3-pillar restoration ad system',             'middle', '[placeholder]', true, true, true, false),
  ('B02-SOFIA-body-targeting',   'body',        'middle', 'SOFIA',   'Leo',      'med',  38, 'Body · Why broad targeting > interest stacking',        'middle', '[placeholder]', true, true, false, false),
  ('B03-RESTO-AI-body-funnel',   'body',        'middle', 'RESTO-AI','In-house', 'low',  52, 'Body · End-to-end funnel walkthrough',                  'middle', '[placeholder]', true, true, false, false),
  ('B04-MORGAN-body-creative',   'body',        'middle', 'MORGAN',  'Jonas',    'med',  41, 'Body · Creative testing matrix explained',              'middle', '[placeholder]', true, false, false, false),

  -- Middle of funnel frames
  ('F01-OSO-frame-quote-dennis', 'frame',       'middle', 'OSO',     'Jonas',    'med',  10, 'Frame · "What Dennis said after month 1"',              'middle', '[placeholder]', true, true, true, true),
  ('F02-RESTO-AI-frame-stat',    'frame',       'middle', 'RESTO-AI','Aditya',   'low',   9, 'Frame · "73% of contractors quit ads in 60 days"',      'middle', '[placeholder]', true, true, true, false),

  -- Bottom of funnel client testimonials
  ('C01-ERIC-client-money',      'client_clip', 'bottom', 'ERIC',    'Jonas',    'high', 35, 'Client · Eric on cash collected month 1',               'bottom', '[placeholder]', true, true, true, true),
  ('C02-CLIENT-rolando',         'client_clip', 'bottom', 'CLIENT',  'Leo',      'high', 42, 'Client · Rolando — water damage scaling',               'bottom', '[placeholder]', true, true, true, false),
  ('C03-CLIENT-matthew',         'client_clip', 'bottom', 'CLIENT',  'Aditya',   'med',  31, 'Client · Matthew — first 5 jobs from ads',              'bottom', '[placeholder]', true, true, false, false),
  ('C04-CLIENT-larry',           'client_clip', 'bottom', 'CLIENT',  'In-house', 'low',  27, 'Client · Larry — operator perspective on lead quality', 'bottom', '[placeholder]', true, false, false, false)
ON CONFLICT (clip_id) DO NOTHING;


NOTIFY pgrst, 'reload schema';

COMMIT;
