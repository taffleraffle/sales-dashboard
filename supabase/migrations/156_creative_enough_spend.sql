-- 156: manual "enough spend to judge?" grade on a creative.
-- The creative-library edit modal lets the operator dictate whether a run
-- creative got enough spend to fairly call it a winner/loser, separate from
-- the win/loss grade itself. true = enough, false = not enough, null = undecided.

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS enough_spend boolean;

NOTIFY pgrst, 'reload schema';
