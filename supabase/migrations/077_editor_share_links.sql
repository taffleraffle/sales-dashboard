-- 077_editor_share_links.sql
--
-- Shareable public links for editors to access /editor-view/<token>
-- without a full dashboard account.
--
-- Each token can optionally be bound to a lib_creative_editors row;
-- when bound, the editor's tasks become the default filter and they
-- can self-assign from the unassigned pile.

BEGIN;

CREATE TABLE IF NOT EXISTS public.lib_editor_share_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token         TEXT NOT NULL UNIQUE,
  label         TEXT,                -- human-readable: "Ahmed's link"
  editor_id     UUID REFERENCES public.lib_creative_editors(id) ON DELETE SET NULL,
  -- Lifecycle
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    TEXT,                -- email or 'system' for ops-generated
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lib_editor_share_links_token     ON public.lib_editor_share_links(token);
CREATE INDEX IF NOT EXISTS idx_lib_editor_share_links_editor_id ON public.lib_editor_share_links(editor_id);

ALTER TABLE public.lib_editor_share_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lib_editor_share_links: read"  ON public.lib_editor_share_links;
DROP POLICY IF EXISTS "lib_editor_share_links: write" ON public.lib_editor_share_links;
CREATE POLICY "lib_editor_share_links: read"  ON public.lib_editor_share_links FOR SELECT USING (TRUE);
CREATE POLICY "lib_editor_share_links: write" ON public.lib_editor_share_links FOR ALL    USING (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lib_editor_share_links TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
