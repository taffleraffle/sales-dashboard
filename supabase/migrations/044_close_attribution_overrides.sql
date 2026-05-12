-- 044_close_attribution_overrides.sql
-- Manual attribution overrides. Some closes have correct ad attribution
-- only inside Ben's head — the prospect didn't fill out a typeform,
-- their GHL contact has no Meta attribution stored, and HYROS doesn't
-- carry it either. Examples surfaced 2026-05-12: Matthew Lomonte,
-- Dennis Sullivan, Rolando Suarez, Joseph Guaracino, Larry — all in
-- the orphan bucket, all genuinely came from specific Meta ads that
-- the operator knows by memory.
--
-- This table is the operator's manual override. The close resolver
-- checks it FIRST (Tier 0) so manual entries beat any of the automated
-- match tiers — useful both for these historical cases and any future
-- close where the system can't reach the right answer.
--
-- Add via UI on the orphan-closes side-drawer (next change) or RPC.
-- Idempotent. Apply via supabase db push.

BEGIN;

CREATE TABLE IF NOT EXISTS public.close_attribution_overrides (
  closer_call_id  UUID PRIMARY KEY REFERENCES public.closer_calls(id) ON DELETE CASCADE,
  ad_id           TEXT,
  adset_id        TEXT,
  utm_campaign    TEXT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_cao_ad_id      ON public.close_attribution_overrides(ad_id)        WHERE ad_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_cao_adset_id   ON public.close_attribution_overrides(adset_id)     WHERE adset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_cao_campaign   ON public.close_attribution_overrides(utm_campaign) WHERE utm_campaign IS NOT NULL;

ALTER TABLE public.close_attribution_overrides ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY cao_read_auth  ON public.close_attribution_overrides FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY cao_write_auth ON public.close_attribution_overrides FOR ALL    TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.close_attribution_overrides TO authenticated;
GRANT ALL                            ON public.close_attribution_overrides TO service_role;

-- ─── RPC: set / clear an override ────────────────────────────────
CREATE OR REPLACE FUNCTION public.lib_close_override_set(
  p_closer_call_id UUID,
  p_ad_id          TEXT DEFAULT NULL,
  p_adset_id       TEXT DEFAULT NULL,
  p_utm_campaign   TEXT DEFAULT NULL,
  p_note           TEXT DEFAULT NULL
) RETURNS public.close_attribution_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  out_row public.close_attribution_overrides;
BEGIN
  INSERT INTO public.close_attribution_overrides (closer_call_id, ad_id, adset_id, utm_campaign, note)
  VALUES (p_closer_call_id, p_ad_id, p_adset_id, p_utm_campaign, p_note)
  ON CONFLICT (closer_call_id) DO UPDATE SET
    ad_id        = EXCLUDED.ad_id,
    adset_id     = EXCLUDED.adset_id,
    utm_campaign = EXCLUDED.utm_campaign,
    note         = EXCLUDED.note,
    updated_at   = NOW()
  RETURNING * INTO out_row;
  RETURN out_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.lib_close_override_clear(p_closer_call_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.close_attribution_overrides WHERE closer_call_id = p_closer_call_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lib_close_override_set(UUID, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lib_close_override_clear(UUID)                       TO anon, authenticated;

-- ─── Rebuild lib_close_resolved with Tier 0 (manual override) ────
-- Tier order:
--   0. close_attribution_overrides  ← manual, wins everything
--   1. typeform_responses
--   2. ghl_contacts
--   3. hyros_events
--   4. orphan

DROP VIEW IF EXISTS public.lib_close_resolved CASCADE;
CREATE VIEW public.lib_close_resolved AS
WITH closed AS (
  SELECT
    c.id AS closer_call_id,
    c.prospect_name,
    public.strip_call_suffix(c.prospect_name)                                AS clean_name,
    public.name_first_token (public.strip_call_suffix(c.prospect_name))      AS first_tok,
    public.name_second_token(public.strip_call_suffix(c.prospect_name))      AS second_tok,
    c.revenue,
    c.cash_collected,
    c.created_at
  FROM public.closer_calls c
  WHERE c.outcome = 'closed'
),
typeform_match AS (
  SELECT DISTINCT ON (cd.closer_call_id)
    cd.closer_call_id,
    tfr.ad_id, tfr.utm_term AS adset_id, tfr.utm_campaign
  FROM closed cd
  JOIN public.typeform_responses tfr
    ON public.name_first_token(tfr.first_name) = cd.first_tok
   AND (cd.second_tok = ''
        OR lower(coalesce(tfr.last_name, tfr.first_name, '')) ILIKE '%' || cd.second_tok || '%')
  WHERE tfr.ad_id IS NOT NULL OR tfr.utm_term IS NOT NULL OR tfr.utm_campaign IS NOT NULL
  ORDER BY cd.closer_call_id, tfr.submitted_at DESC NULLS LAST
),
ghl_match AS (
  SELECT DISTINCT ON (cd.closer_call_id)
    cd.closer_call_id,
    g.last_ad_id AS ad_id, g.last_adset_id AS adset_id, g.last_utm_campaign AS utm_campaign
  FROM closed cd
  JOIN public.ghl_contacts g
    ON public.name_first_token(g.first_name) = cd.first_tok
   AND (cd.second_tok = ''
        OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || cd.second_tok || '%')
  WHERE g.last_ad_id IS NOT NULL OR g.last_adset_id IS NOT NULL OR g.last_utm_campaign IS NOT NULL
  ORDER BY cd.closer_call_id, g.date_added DESC NULLS LAST
),
hyros_match AS (
  SELECT DISTINCT ON (cd.closer_call_id)
    cd.closer_call_id,
    h.meta_ad_id AS ad_id, h.campaign_name
  FROM closed cd
  JOIN public.hyros_events h
    ON public.name_first_token(h.first_name) = cd.first_tok
   AND (cd.second_tok = ''
        OR lower(coalesce(h.last_name, '')) ILIKE cd.second_tok || '%')
  WHERE h.meta_ad_id IS NOT NULL OR h.campaign_name IS NOT NULL
  ORDER BY cd.closer_call_id, h.event_date DESC
)
SELECT
  cd.closer_call_id,
  cd.prospect_name,
  cd.clean_name,
  cd.revenue,
  cd.cash_collected,
  cd.created_at,
  -- Tier 0: manual override beats every automated tier.
  COALESCE(ov.ad_id,        tm.ad_id,        gm.ad_id,        hyros_ad.ad_id)        AS resolved_ad_id,
  COALESCE(ov.adset_id,     tm.adset_id,     gm.adset_id,     hyros_ad.adset_id)     AS resolved_adset_id,
  COALESCE(ov.utm_campaign, tm.utm_campaign, gm.utm_campaign, hm.campaign_name, hyros_ad.campaign_name) AS resolved_campaign,
  CASE
    WHEN ov.closer_call_id IS NOT NULL                                                   THEN 'manual'
    WHEN tm.closer_call_id IS NOT NULL                                                   THEN 'typeform'
    WHEN gm.closer_call_id IS NOT NULL                                                   THEN 'ghl'
    WHEN hm.closer_call_id IS NOT NULL                                                   THEN 'hyros'
    ELSE 'orphan'
  END AS attribution_source
FROM closed cd
LEFT JOIN public.close_attribution_overrides ov ON ov.closer_call_id = cd.closer_call_id
LEFT JOIN typeform_match tm  ON tm.closer_call_id = cd.closer_call_id
LEFT JOIN ghl_match      gm  ON gm.closer_call_id = cd.closer_call_id
LEFT JOIN hyros_match    hm  ON hm.closer_call_id = cd.closer_call_id
LEFT JOIN LATERAL (
  SELECT a.ad_id, a.adset_id, a.campaign_name
  FROM public.ads a WHERE a.ad_id = hm.ad_id LIMIT 1
) hyros_ad ON true;

GRANT SELECT ON public.lib_close_resolved TO anon, authenticated;

-- Rebuild rollup + orphan views.
DROP VIEW IF EXISTS public.lib_close_per_ad CASCADE;
CREATE VIEW public.lib_close_per_ad AS
SELECT resolved_ad_id AS ad_id, count(*) AS closes,
  COALESCE(sum(revenue),0)        AS revenue,
  COALESCE(sum(cash_collected),0) AS cash,
  max(created_at)                 AS last_close_at
FROM public.lib_close_resolved WHERE resolved_ad_id IS NOT NULL GROUP BY resolved_ad_id;
GRANT SELECT ON public.lib_close_per_ad TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_close_per_adset CASCADE;
CREATE VIEW public.lib_close_per_adset AS
SELECT resolved_adset_id AS adset_id, count(*) AS closes,
  COALESCE(sum(revenue),0)        AS revenue,
  COALESCE(sum(cash_collected),0) AS cash,
  max(created_at)                 AS last_close_at
FROM public.lib_close_resolved WHERE resolved_adset_id IS NOT NULL GROUP BY resolved_adset_id;
GRANT SELECT ON public.lib_close_per_adset TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_close_per_campaign CASCADE;
CREATE VIEW public.lib_close_per_campaign AS
SELECT resolved_campaign AS utm_campaign, count(*) AS closes,
  COALESCE(sum(revenue),0)        AS revenue,
  COALESCE(sum(cash_collected),0) AS cash,
  max(created_at)                 AS last_close_at
FROM public.lib_close_resolved WHERE resolved_campaign IS NOT NULL GROUP BY resolved_campaign;
GRANT SELECT ON public.lib_close_per_campaign TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_orphan_closes CASCADE;
CREATE VIEW public.lib_orphan_closes AS
SELECT closer_call_id, prospect_name, clean_name, revenue, cash_collected, created_at
FROM public.lib_close_resolved WHERE attribution_source = 'orphan'
ORDER BY created_at DESC;
GRANT SELECT ON public.lib_orphan_closes TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
