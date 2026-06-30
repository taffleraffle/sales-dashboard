-- 157: faststart playback proxy for the EDITED cut on a library row.
-- preview_proxy_url is the proxy of the RAW (preview_url). When an edit lives
-- on the row's final_cut_url WITHOUT a matching lib_task_submissions row (e.g.
-- a direct "replace original" cut, not an editor task upload), there was
-- nowhere to store a fast proxy for the edit, so the detail modal fell back to
-- streaming the heavy non-faststart original. This column holds the edit's
-- 720p faststart proxy; scripts/transcode-proxies.mjs --table library_edit
-- fills it and the player prefers it over the original.

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS final_cut_proxy_url text;

NOTIFY pgrst, 'reload schema';
