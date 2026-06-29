-- 029_drop_edited_raw.sql
-- Retire the confusing "Edited raw" state (Ben 2026-06-29). A raw clip that had
-- been used in a cut was flagged status='raw' + manually_marked_used=true and
-- surfaced as "EDITED RAW" in the library filter — two different status words
-- for one clip. Recode all of them to plain 'edited' and clear the flag; the
-- "EDITED RAW" filter option is removed from the UI in the same change.
UPDATE lib_creative_library
SET status = 'edited', manually_marked_used = false
WHERE status = 'raw' AND manually_marked_used = true;
