-- 154_creative_naming_labels.sql
-- Phase 1 of the creative-organisation overhaul: human nicknames + a
-- format/vibe axis that is separate from the editorial `type` (Hook/Body/…).
--
-- WHY: the library mixes two naming worlds. AI-described rows show a clean
-- structured display_name (e.g. BODY-RESTORATION-STOP-PAYING-OSO-T01); rows
-- that never went through the describe pass fall back to junk legacy labels
-- ("Raw Oso", "Drive Ingest"). Operators also have no way to hand-label a
-- clip, and no way to group by the *format* of the edit (talking-head vs
-- b-roll vs meme …). These two nullable columns add:
--   1. custom_name  — an operator nickname that becomes the PRIMARY label
--                     when set; the structured display_name drops to subtext.
--   2. style_format — a free-but-suggested format/vibe tag for filtering.
-- Both are additive and nullable; nothing changes for existing rows until
-- someone fills them in.

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS custom_name  TEXT,
  ADD COLUMN IF NOT EXISTS style_format TEXT;

COMMENT ON COLUMN public.lib_creative_library.custom_name IS
  'Operator-set human nickname. When non-empty it is the PRIMARY label shown in every list/card/modal; the structured display_name drops to subtext. NULL = use display_name.';
COMMENT ON COLUMN public.lib_creative_library.style_format IS
  'Format / vibe of the edit (talking-head, b-roll, meme, testimonial, skit, voiceover, screen-rec, ugc, street-interview, …). A separate axis from `type` (Hook/Body/Joined). Free text; the suggested set is enforced in the UI only.';

-- Filter / group by format quickly even on a large library.
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_style_format
  ON public.lib_creative_library (style_format)
  WHERE style_format IS NOT NULL;

-- PostgREST: pick up the new columns immediately.
NOTIFY pgrst, 'reload schema';
