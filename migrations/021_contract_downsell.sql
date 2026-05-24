-- 021_contract_downsell.sql
-- Downsell coaching feature. A closer can open a "downsell coach" thread on
-- any contract to work out how to save a churning / cost-pressured client.
-- The coach (Claude) reads a separate policy doc (kind='downsell') that
-- encodes the hard floors, mandatory items on churn, financing options, and
-- the standard $500/mo + hosting downsell package.
--
-- Three changes:
--   1. contract_policy gains a `kind` column ('amendment' | 'downsell') so
--      the two policies coexist. Index + uniqueness scoped by kind.
--   2. contract_downsell_threads — one thread per coaching conversation
--      (a contract can have multiple over its lifecycle if the situation
--      changes). Mirrors contract_amendments lifecycle (open -> locked).
--   3. contract_downsell_messages — back-and-forth chat. Mirrors
--      contract_amendment_messages exactly.

-- ── contract_policy.kind ──────────────────────────────────────────────────
ALTER TABLE public.contract_policy
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'amendment';

ALTER TABLE public.contract_policy
  DROP CONSTRAINT IF EXISTS contract_policy_kind_check;
ALTER TABLE public.contract_policy
  ADD CONSTRAINT contract_policy_kind_check
    CHECK (kind IN ('amendment','downsell'));

-- Old index ignored kind; rebuild it so "latest active per kind" is fast.
DROP INDEX IF EXISTS contract_policy_active_idx;
CREATE INDEX contract_policy_active_idx
  ON public.contract_policy(kind, created_at DESC) WHERE active = true;

-- Seed an empty downsell policy row so the editor has something to load on
-- first open. Admin fills it in via /sales/contracts/policy (Downsell tab).
INSERT INTO public.contract_policy (policy_text, active, kind)
  SELECT '', true, 'downsell'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.contract_policy WHERE kind = 'downsell'
  );

-- ── contract_downsell_threads ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_downsell_threads (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id              uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  closer_id                uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  -- opener: what kicked off the coaching session (free-text, like
  -- contract_amendments.requested_change)
  opening_context          text NOT NULL,
  -- structured recommendation that the coach refines turn-by-turn. Latest
  -- values reflect the most recently committed proposal (when the coach
  -- attaches a proposed_offer block to a turn, these update).
  recommended_summary      text,
  monthly_value_usd        numeric(10,2),
  upfront_value_usd        numeric(10,2),
  hosting_plan             text CHECK (hosting_plan IN ('monthly','annual','none')),
  payment_structure        text,        -- 'upfront' | 'split-2' | 'monthly' | 'finance-3mo' | free-text
  asset_handover_required  boolean,
  -- lifecycle
  status                   text NOT NULL DEFAULT 'open' CHECK (status IN (
                             'open','locked','applied','cancelled'
                           )),
  locked_at                timestamptz,
  admin_review_requested   boolean NOT NULL DEFAULT false,
  ben_notes                text,
  -- audit
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contract_downsell_threads_contract_idx
  ON public.contract_downsell_threads(contract_id);
CREATE INDEX IF NOT EXISTS contract_downsell_threads_status_idx
  ON public.contract_downsell_threads(status);
CREATE INDEX IF NOT EXISTS contract_downsell_threads_admin_review_idx
  ON public.contract_downsell_threads(admin_review_requested)
  WHERE admin_review_requested = true;

-- ── contract_downsell_messages ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_downsell_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES public.contract_downsell_threads(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('closer','coach')),
  content     text NOT NULL,
  -- optional structured payload the coach attaches (proposed offer fields,
  -- status_signal, hard-floor flags) without mutating parent until lock-in
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contract_downsell_messages_thread_idx
  ON public.contract_downsell_messages(thread_id, created_at);

-- ── updated_at trigger ────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS contract_downsell_threads_touch_updated_at
  ON public.contract_downsell_threads;
CREATE TRIGGER contract_downsell_threads_touch_updated_at
  BEFORE UPDATE ON public.contract_downsell_threads
  FOR EACH ROW EXECUTE FUNCTION public.contracts_touch_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.contract_downsell_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_downsell_messages ENABLE ROW LEVEL SECURITY;

-- Threads: admin sees all, closers see threads on their contracts
DROP POLICY IF EXISTS contract_downsell_threads_read ON public.contract_downsell_threads;
CREATE POLICY contract_downsell_threads_read ON public.contract_downsell_threads
  FOR SELECT TO authenticated
  USING (
    public.contracts_is_admin()
    OR closer_id = public.contracts_current_team_member()
    OR EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.id = contract_id
        AND c.closer_id = public.contracts_current_team_member()
    )
  );

DROP POLICY IF EXISTS contract_downsell_threads_insert ON public.contract_downsell_threads;
CREATE POLICY contract_downsell_threads_insert ON public.contract_downsell_threads
  FOR INSERT TO authenticated
  WITH CHECK (
    public.contracts_is_admin()
    OR closer_id = public.contracts_current_team_member()
    OR EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.id = contract_id
        AND c.closer_id = public.contracts_current_team_member()
    )
  );

-- Update: coach writes from service_role (bypasses RLS); closer can lock,
-- mark for admin review, cancel their own threads.
DROP POLICY IF EXISTS contract_downsell_threads_update ON public.contract_downsell_threads;
CREATE POLICY contract_downsell_threads_update ON public.contract_downsell_threads
  FOR UPDATE TO authenticated
  USING (
    public.contracts_is_admin()
    OR closer_id = public.contracts_current_team_member()
    OR EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.id = contract_id
        AND c.closer_id = public.contracts_current_team_member()
    )
  )
  WITH CHECK (
    public.contracts_is_admin()
    OR closer_id = public.contracts_current_team_member()
    OR EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.id = contract_id
        AND c.closer_id = public.contracts_current_team_member()
    )
  );

-- Messages: read scoped by parent thread visibility
DROP POLICY IF EXISTS contract_downsell_messages_read ON public.contract_downsell_messages;
CREATE POLICY contract_downsell_messages_read ON public.contract_downsell_messages
  FOR SELECT TO authenticated
  USING (
    public.contracts_is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.contract_downsell_threads t
      LEFT JOIN public.contracts c ON c.id = t.contract_id
      WHERE t.id = thread_id
        AND (
          t.closer_id = public.contracts_current_team_member()
          OR c.closer_id = public.contracts_current_team_member()
        )
    )
  );

-- Insert: closers can post their own turns; coach turns come via service_role
DROP POLICY IF EXISTS contract_downsell_messages_insert ON public.contract_downsell_messages;
CREATE POLICY contract_downsell_messages_insert ON public.contract_downsell_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    role = 'closer' AND (
      public.contracts_is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.contract_downsell_threads t
        LEFT JOIN public.contracts c ON c.id = t.contract_id
        WHERE t.id = thread_id
          AND (
            t.closer_id = public.contracts_current_team_member()
            OR c.closer_id = public.contracts_current_team_member()
          )
      )
    )
  );

GRANT SELECT, INSERT, UPDATE ON public.contract_downsell_threads  TO authenticated;
GRANT SELECT, INSERT         ON public.contract_downsell_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_downsell_threads  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_downsell_messages TO service_role;

NOTIFY pgrst, 'reload schema';
