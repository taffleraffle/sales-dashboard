-- 018_amendment_chat.sql
-- Turns each amendment into a back-and-forth conversation rather than a
-- one-shot verdict. The closer can push back on the judge ("what if we
-- countered with X?"), the judge can suggest counter-positions, and the
-- thread stays open until the closer hits "Lock in" to freeze the agreed
-- position and trigger DOCX regen.
--
-- Three changes:
--   1. New table contract_amendment_messages — role ('closer'|'judge') +
--      content. RLS mirrors parent amendment visibility.
--   2. New columns on contract_amendments:
--        - locked_at timestamptz — set when closer freezes the conversation
--        - final_clause_text text — agreed wording at lock-in (feeds DOCX regen)
--   3. Backfill: for every existing amendment, seed message 1 (closer,
--      requested_change) and message 2 (judge, ai_reasoning) if there is one.

-- ── Messages table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_amendment_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amendment_id  uuid NOT NULL REFERENCES public.contract_amendments(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('closer','judge')),
  content       text NOT NULL,
  -- optional structured payload the judge may attach (verdict shift, proposed
  -- clause language) without mutating the parent amendment until lock-in
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contract_amendment_messages_amendment_idx
  ON public.contract_amendment_messages(amendment_id, created_at);

-- ── Lock-in columns on parent ────────────────────────────────────────────
ALTER TABLE public.contract_amendments
  ADD COLUMN IF NOT EXISTS locked_at         timestamptz,
  ADD COLUMN IF NOT EXISTS final_clause_text text;

-- ── Backfill existing amendments as 2-message threads ────────────────────
INSERT INTO public.contract_amendment_messages (amendment_id, role, content, created_at)
SELECT a.id, 'closer', a.requested_change, a.created_at
FROM public.contract_amendments a
WHERE NOT EXISTS (
  SELECT 1 FROM public.contract_amendment_messages m
  WHERE m.amendment_id = a.id AND m.role = 'closer'
);

INSERT INTO public.contract_amendment_messages (amendment_id, role, content, metadata, created_at)
SELECT
  a.id,
  'judge',
  a.ai_reasoning,
  jsonb_build_object(
    'verdict',           a.ai_verdict,
    'proposed_clause',   COALESCE(a.ai_proposed_redline, ''),
    'backfilled',        true
  ),
  COALESCE(a.ai_judged_at, a.created_at + interval '1 second')
FROM public.contract_amendments a
WHERE a.ai_reasoning IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.contract_amendment_messages m
    WHERE m.amendment_id = a.id AND m.role = 'judge'
  );

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.contract_amendment_messages ENABLE ROW LEVEL SECURITY;

-- Read: same visibility rules as the parent amendment
DROP POLICY IF EXISTS contract_amendment_messages_read ON public.contract_amendment_messages;
CREATE POLICY contract_amendment_messages_read ON public.contract_amendment_messages
  FOR SELECT TO authenticated
  USING (
    public.contracts_is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.contract_amendments a
      LEFT JOIN public.contracts c ON c.id = a.contract_id
      WHERE a.id = amendment_id
        AND (
          a.closer_id = public.contracts_current_team_member()
          OR c.closer_id = public.contracts_current_team_member()
        )
    )
  );

-- Insert: closer can insert their own messages; judge messages come from
-- the Edge function via service_role which bypasses RLS.
DROP POLICY IF EXISTS contract_amendment_messages_insert ON public.contract_amendment_messages;
CREATE POLICY contract_amendment_messages_insert ON public.contract_amendment_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    role = 'closer' AND (
      public.contracts_is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.contract_amendments a
        LEFT JOIN public.contracts c ON c.id = a.contract_id
        WHERE a.id = amendment_id
          AND (
            a.closer_id = public.contracts_current_team_member()
            OR c.closer_id = public.contracts_current_team_member()
          )
      )
    )
  );

GRANT SELECT, INSERT ON public.contract_amendment_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_amendment_messages TO service_role;

NOTIFY pgrst, 'reload schema';
