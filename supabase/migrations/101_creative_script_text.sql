-- 101_creative_script_text.sql
--
-- Ben (2026-05-28): "Scripts aren't available on the platform alongside the
-- footage. Need either scripts attached to footage, or a script library both
-- me and the editor can pull from." Chosen approach: free-text script attached
-- to each footage row. The admin pastes the script in the creative detail
-- modal; the editor sees it read-only on their task in the editor portal.
--
-- This adds a single nullable TEXT column. The UI lazy-loads it per-row (it's
-- deliberately NOT in the lean list query, since scripts can be large) and
-- self-heals if this migration hasn't been applied yet (the save + per-row
-- fetch both tolerate a missing column), so deploying the code ahead of this
-- migration is safe.

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS script_text TEXT;

NOTIFY pgrst, 'reload schema';
