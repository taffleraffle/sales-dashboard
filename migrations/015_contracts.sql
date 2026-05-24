-- 015_contracts.sql
-- Contracts feature: stores every PandaDoc agreement, the amendment history,
-- and the free-text policy doc the AI judge reads when a closer requests a
-- change. See sales-dashboard CLAUDE.md and Ben's spec from 2026-05-24.
--
-- Three tables:
--   contracts            -- one row per PandaDoc document (current live version)
--   contract_amendments  -- every requested change + AI verdict + Ben's decision
--   contract_policy      -- single active row of free-text policy, versioned
--                           via insert history (latest active = current rules)
--
-- All three live in public so PostgREST can serve them. RLS: admins see
-- everything; closers see only contracts assigned to them and amendments
-- they raised.

-- ── contracts ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contracts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name        text NOT NULL,
  client_email       text,
  client_company     text,
  closer_id          uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  pandadoc_id        text UNIQUE,                  -- current live document id
  pandadoc_template_id text,
  pandadoc_view_url  text,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN (
                       'draft','sent','viewed','signed','voided','superseded'
                     )),
  version            int  NOT NULL DEFAULT 1,
  fee_amount_usd     numeric(10,2),
  project_period_days int,
  scope_summary      text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contracts_closer_idx ON public.contracts(closer_id);
CREATE INDEX IF NOT EXISTS contracts_status_idx ON public.contracts(status);

-- ── contract_amendments ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_amendments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id         uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  closer_id           uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  -- what the closer asked for
  requested_change    text NOT NULL,
  clause_reference    text,              -- "Clause 4(b)(i)" etc, free-text
  original_excerpt    text,              -- the original clause text being amended
  -- AI judge verdict
  ai_verdict          text CHECK (ai_verdict IN ('allow','review','reject')),
  ai_reasoning        text,
  ai_proposed_redline text,
  ai_judged_at        timestamptz,
  -- Ben's decision (only set when verdict was 'review' or 'reject')
  ben_decision        text CHECK (ben_decision IN ('approve','reject')),
  ben_notes           text,
  decided_at          timestamptz,
  -- resulting PandaDoc document (when amendment is applied)
  new_pandadoc_id     text,
  new_version         int,
  applied_at          timestamptz,
  -- overall lifecycle
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending','judged','approved','rejected','applied','cancelled'
                      )),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contract_amendments_contract_idx ON public.contract_amendments(contract_id);
CREATE INDEX IF NOT EXISTS contract_amendments_status_idx   ON public.contract_amendments(status);
CREATE INDEX IF NOT EXISTS contract_amendments_pending_idx
  ON public.contract_amendments(status) WHERE status IN ('pending','judged');

-- ── contract_policy ─────────────────────────────────────────────────────────
-- Insert-only history; the most recently-inserted row with active=true is
-- the live policy. Rolling back = insert the prior text as a new active row.
CREATE TABLE IF NOT EXISTS public.contract_policy (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_text  text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  updated_by   uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contract_policy_active_idx
  ON public.contract_policy(created_at DESC) WHERE active = true;

-- Seed an empty policy so the editor has a row to load on first open.
-- Admin fills it in via /sales/contracts/policy.
INSERT INTO public.contract_policy (policy_text, active)
SELECT '', true
WHERE NOT EXISTS (SELECT 1 FROM public.contract_policy);

-- ── updated_at triggers ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.contracts_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS contracts_touch_updated_at ON public.contracts;
CREATE TRIGGER contracts_touch_updated_at
  BEFORE UPDATE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.contracts_touch_updated_at();

DROP TRIGGER IF EXISTS contract_amendments_touch_updated_at ON public.contract_amendments;
CREATE TRIGGER contract_amendments_touch_updated_at
  BEFORE UPDATE ON public.contract_amendments
  FOR EACH ROW EXECUTE FUNCTION public.contracts_touch_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.contracts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_amendments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_policy      ENABLE ROW LEVEL SECURITY;

-- Helper: is the current auth.uid() an admin team_member?
-- Mirrors the pattern used elsewhere in the dashboard.
CREATE OR REPLACE FUNCTION public.contracts_is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE auth_user_id = auth.uid()
      AND role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.contracts_current_team_member()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM public.team_members WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- contracts: admin sees all, closers see their own
DROP POLICY IF EXISTS contracts_read ON public.contracts;
CREATE POLICY contracts_read ON public.contracts
  FOR SELECT TO authenticated
  USING (
    public.contracts_is_admin()
    OR closer_id = public.contracts_current_team_member()
  );

DROP POLICY IF EXISTS contracts_write ON public.contracts;
CREATE POLICY contracts_write ON public.contracts
  FOR ALL TO authenticated
  USING (
    public.contracts_is_admin()
    OR closer_id = public.contracts_current_team_member()
  )
  WITH CHECK (
    public.contracts_is_admin()
    OR closer_id = public.contracts_current_team_member()
  );

-- amendments: same visibility rules as parent contract
DROP POLICY IF EXISTS contract_amendments_read ON public.contract_amendments;
CREATE POLICY contract_amendments_read ON public.contract_amendments
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

DROP POLICY IF EXISTS contract_amendments_insert ON public.contract_amendments;
CREATE POLICY contract_amendments_insert ON public.contract_amendments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.contracts_is_admin()
    OR closer_id = public.contracts_current_team_member()
  );

-- only admin (Ben) can decide on grey/blacklisted amendments
DROP POLICY IF EXISTS contract_amendments_update ON public.contract_amendments;
CREATE POLICY contract_amendments_update ON public.contract_amendments
  FOR UPDATE TO authenticated
  USING (public.contracts_is_admin())
  WITH CHECK (public.contracts_is_admin());

-- policy: everyone reads (so the judge function can fetch it), only admin writes
DROP POLICY IF EXISTS contract_policy_read ON public.contract_policy;
CREATE POLICY contract_policy_read ON public.contract_policy
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS contract_policy_write ON public.contract_policy;
CREATE POLICY contract_policy_write ON public.contract_policy
  FOR ALL TO authenticated
  USING (public.contracts_is_admin())
  WITH CHECK (public.contracts_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contracts           TO authenticated;
GRANT SELECT, INSERT, UPDATE          ON public.contract_amendments TO authenticated;
GRANT SELECT, INSERT, UPDATE          ON public.contract_policy     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contracts           TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_amendments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_policy     TO service_role;

NOTIFY pgrst, 'reload schema';
