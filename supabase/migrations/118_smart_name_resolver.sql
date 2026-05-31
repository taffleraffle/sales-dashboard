-- Smarter name-token resolver (Ben 2026-06-01).
--
-- Previous migration 117 over-corrected: it required second_tok non-empty
-- which dropped legitimate single-token-name attributions (e.g. Hector,
-- who has no last name in the call record because prospect_name is
-- "Hector  and Daniel Gomez De Le Vega" — and "and Daniel..." is the
-- closer's name, not Hector's last name).
--
-- The right fix uses TWO additional signals already in the data:
--   1. strip_call_suffix needs to strip "and X" / "x X" closer-name
--      tails so the prospect name comes out clean.
--   2. The calendar suffix in prospect_name literally names the audience
--      ("RestorationConnect Strategy Call", "RemodelerConnect Strategy
--      Call", "ServiceConnect Intro Call"). When present, we should prefer
--      contacts whose source matches the implied audience.
--
-- New matching rules in lib_ghl_lives_detail + lib_close_resolved:
--   (a) Strong: first_name AND last_name both match → take the most
--       recently added contact (same as before)
--   (b) Mid: first_name matches AND prospect's calendar suffix names an
--       audience (e.g. RestorationConnect) AND the contact's source matches
--       that audience → match
--   (c) Weak: first_name matches AND there's EXACTLY ONE contact with
--       that first_name → match (covers Hector if there's only one Hector
--       relevant, doesn't matter no last name)
--   (d) Drop to unattributed in all other cases (recover honesty over
--       making up data)
--
-- Audience extraction handled in a new helper function
-- audience_from_prospect_name(text).

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Improved strip_call_suffix — also strips " and X..." and " x X..." tails
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.strip_call_suffix(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  -- Order matters: strip " - X" then " and X" then " x X" because callers may
  -- combine them, e.g. "Hector and Daniel - RestorationConnect Strategy Call".
  -- The " - X" suffix (calendar name) goes first so we don't lose it before
  -- the audience parser runs.
  SELECT trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(COALESCE(p, ''), '\s*-\s*.*$', ''),
        '\s+and\s+.*$', '', 'i'
      ),
      '\s+x\s+.*$', '', 'i'
    )
  )
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- audience_from_prospect_name — parses 'RestorationConnect' etc. out of the
-- call name so we can bias name-match disambiguation toward source-matching
-- contacts. Returns one of:
--   'restoration' | 'remodeler' | 'electrician' | 'service' | NULL
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.audience_from_prospect_name(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p ILIKE '%restoration%' THEN 'restoration'
    WHEN p ILIKE '%remodel%'     THEN 'remodeler'
    WHEN p ILIKE '%electrician%' THEN 'electrician'
    WHEN p ILIKE '%service%'     THEN 'service'
    ELSE NULL
  END
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- contact_source_matches_audience — true when a ghl_contacts.source string
-- aligns with an audience hint. Tolerates "Typeform - Restoration Funnel",
-- "Facebook", "SCIO - Restoration ...", etc.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.contact_source_matches_audience(src text, hint text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN hint IS NULL THEN false
    WHEN src IS NULL  THEN false
    WHEN hint = 'restoration' THEN src ILIKE '%restoration%' OR src ILIKE '%restora%'
    WHEN hint = 'remodeler'   THEN src ILIKE '%remodel%'
    WHEN hint = 'electrician' THEN src ILIKE '%electrician%'
    WHEN hint = 'service'     THEN src ILIKE '%service%' OR src ILIKE '%restoration%'
    ELSE false
  END
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- lib_ghl_lives_detail — smart resolver
--
-- For each live closer_call, find at most one ghl_contact via the rule
-- ladder (strong → audience-biased → unique → drop):
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.lib_ghl_lives_detail AS
WITH live AS (
  SELECT cc.id AS closer_call_id,
         cc.prospect_name AS display_name,
         cc.created_at    AS landed_at,
         cc.outcome,
         cc.cash_collected,
         cc.revenue,
         name_first_token(strip_call_suffix(cc.prospect_name::text))  AS first_tok,
         name_second_token(strip_call_suffix(cc.prospect_name::text)) AS second_tok,
         audience_from_prospect_name(cc.prospect_name::text)          AS audience_hint
    FROM closer_calls cc
   WHERE cc.showed = true
      OR (cc.outcome::text = ANY (ARRAY['showed','closed','not_closed']::text[]))
),
candidates AS (
  -- One row per (call × candidate-contact). Scored 1 (best) → 4 (worst).
  -- Rank within each call and keep rank 1.
  SELECT
    li.closer_call_id, li.display_name, li.landed_at, li.outcome,
    li.cash_collected, li.revenue, li.audience_hint,
    g.ghl_contact_id, g.email, g.phone, g.first_name, g.last_name, g.source,
    g.last_ad_id, g.first_ad_id, g.date_added,
    CASE
      -- (a) strong: first AND last name both match
      WHEN li.second_tok <> ''
       AND lower(COALESCE(g.last_name, g.full_name, '')) ILIKE ('%' || li.second_tok || '%')
        THEN 1
      -- (b) mid: only first name matches BUT audience hint aligns with source
      WHEN li.second_tok = ''
       AND li.audience_hint IS NOT NULL
       AND contact_source_matches_audience(g.source, li.audience_hint)
        THEN 2
      -- (c) weak: first name matches and we'll check uniqueness in the next
      -- step (rank 3 here just to keep them for the count)
      WHEN li.second_tok = ''
        THEN 3
      ELSE 4
    END AS score
    FROM live li
    JOIN ghl_contacts g
      ON name_first_token(g.first_name) = li.first_tok
),
ranked AS (
  -- Pick best score per call. For ties prefer the most recently added contact
  -- (existing convention from old view).
  SELECT
    c.*,
    -- count how many rank-3 (weak) candidates exist per call so we can drop
    -- ambiguous weak matches.
    SUM(CASE WHEN c.score = 3 THEN 1 ELSE 0 END)
      OVER (PARTITION BY c.closer_call_id) AS weak_count,
    ROW_NUMBER() OVER (
      PARTITION BY c.closer_call_id
      ORDER BY c.score ASC, c.date_added DESC NULLS LAST
    ) AS rn
  FROM candidates c
),
matched AS (
  SELECT
    closer_call_id, display_name, landed_at, outcome, cash_collected, revenue,
    ghl_contact_id, email, phone, last_ad_id, first_ad_id,
    -- Only accept the row if the chosen score is OK:
    --   score 1 (strong) and 2 (audience match) always OK
    --   score 3 (weak) OK only when weak_count = 1 (single Hector etc.)
    --   score 4 dropped
    score, weak_count
  FROM ranked
  WHERE rn = 1
    AND (
      score = 1
      OR score = 2
      OR (score = 3 AND weak_count = 1)
    )
),
resolved AS (
  SELECT
    m.closer_call_id, m.display_name, m.landed_at, m.outcome,
    m.cash_collected, m.revenue,
    m.ghl_contact_id, m.email, m.phone,
    COALESCE(
      m.last_ad_id,
      m.first_ad_id,
      (SELECT t.ad_id
         FROM typeform_responses t
        WHERE t.ad_id IS NOT NULL
          AND ((m.email IS NOT NULL AND lower(t.email) = lower(m.email))
            OR (m.phone IS NOT NULL AND t.phone = m.phone))
        ORDER BY t.submitted_at DESC NULLS LAST
        LIMIT 1)
    ) AS resolved_ad_id
  FROM matched m
)
SELECT r.closer_call_id,
       r.display_name,
       r.landed_at,
       r.outcome,
       r.cash_collected,
       r.revenue,
       r.resolved_ad_id AS ad_id,
       a.adset_id,
       a.campaign_name  AS utm_campaign
  FROM resolved r
  LEFT JOIN ads a ON a.ad_id = r.resolved_ad_id
 WHERE r.resolved_ad_id IS NOT NULL;

GRANT SELECT ON public.lib_ghl_lives_detail TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- lib_close_resolved — same rule ladder applied to typeform + ghl + hyros
-- sub-matches. Same pattern as lib_ghl_lives_detail.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.lib_close_resolved AS
WITH closed AS (
  SELECT c.id AS closer_call_id,
         c.prospect_name,
         strip_call_suffix(c.prospect_name::text) AS clean_name,
         name_first_token(strip_call_suffix(c.prospect_name::text))  AS first_tok,
         name_second_token(strip_call_suffix(c.prospect_name::text)) AS second_tok,
         audience_from_prospect_name(c.prospect_name::text)          AS audience_hint,
         c.revenue, c.cash_collected, c.created_at
    FROM closer_calls c
   WHERE c.outcome::text = 'closed'
),
-- Typeform candidates (same ladder, treating tfr.utm_campaign / form_name as the source string)
tf_candidates AS (
  SELECT cd.closer_call_id, cd.audience_hint,
         tfr.ad_id, tfr.utm_term AS adset_id, tfr.utm_campaign,
         tfr.submitted_at,
         CASE
           WHEN cd.second_tok <> ''
            AND lower(COALESCE(tfr.last_name, tfr.first_name, '')) ILIKE ('%' || cd.second_tok || '%')
             THEN 1
           WHEN cd.second_tok = ''
            AND cd.audience_hint IS NOT NULL
            AND contact_source_matches_audience(
              COALESCE(tfr.utm_campaign, tfr.form_name), cd.audience_hint
            )
             THEN 2
           WHEN cd.second_tok = '' THEN 3
           ELSE 4
         END AS score
    FROM closed cd
    JOIN typeform_responses tfr
      ON name_first_token(tfr.first_name) = cd.first_tok
   WHERE tfr.ad_id IS NOT NULL OR tfr.utm_term IS NOT NULL OR tfr.utm_campaign IS NOT NULL
),
tf_ranked AS (
  SELECT *,
         SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (PARTITION BY closer_call_id ORDER BY score, submitted_at DESC NULLS LAST) AS rn
    FROM tf_candidates
),
typeform_match AS (
  SELECT closer_call_id, ad_id, adset_id, utm_campaign
    FROM tf_ranked
   WHERE rn = 1 AND (score IN (1,2) OR (score = 3 AND weak_count = 1))
),
-- GHL contacts candidates
ghl_candidates AS (
  SELECT cd.closer_call_id, cd.audience_hint,
         COALESCE(g.last_ad_id, g.first_ad_id) AS ad_id,
         g.last_adset_id::text AS adset_id,
         COALESCE(g.last_utm_campaign, g.first_utm_campaign, g.last_form_name, g.first_form_name) AS utm_campaign,
         g.date_added, g.source,
         CASE
           WHEN cd.second_tok <> ''
            AND lower(COALESCE(g.last_name, g.full_name, '')) ILIKE ('%' || cd.second_tok || '%')
             THEN 1
           WHEN cd.second_tok = ''
            AND cd.audience_hint IS NOT NULL
            AND contact_source_matches_audience(g.source, cd.audience_hint)
             THEN 2
           WHEN cd.second_tok = '' THEN 3
           ELSE 4
         END AS score
    FROM closed cd
    JOIN ghl_contacts g
      ON name_first_token(g.first_name) = cd.first_tok
   WHERE g.last_ad_id IS NOT NULL OR g.first_ad_id IS NOT NULL
      OR g.last_utm_campaign IS NOT NULL OR g.first_utm_campaign IS NOT NULL
      OR g.last_form_name IS NOT NULL OR g.first_form_name IS NOT NULL
),
ghl_ranked AS (
  SELECT *,
         SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (PARTITION BY closer_call_id ORDER BY score, date_added DESC NULLS LAST) AS rn
    FROM ghl_candidates
),
ghl_match AS (
  SELECT closer_call_id, ad_id, adset_id, utm_campaign
    FROM ghl_ranked
   WHERE rn = 1 AND (score IN (1,2) OR (score = 3 AND weak_count = 1))
),
-- Hyros candidates (same ladder; hyros has campaign_name as source-like string)
hy_candidates AS (
  SELECT cd.closer_call_id, cd.audience_hint,
         h.meta_ad_id AS ad_id, h.campaign_name,
         h.event_date,
         CASE
           WHEN cd.second_tok <> ''
            AND lower(COALESCE(h.last_name, ''::varchar)::text) ILIKE (cd.second_tok || '%')
             THEN 1
           WHEN cd.second_tok = ''
            AND cd.audience_hint IS NOT NULL
            AND contact_source_matches_audience(h.campaign_name::text, cd.audience_hint)
             THEN 2
           WHEN cd.second_tok = '' THEN 3
           ELSE 4
         END AS score
    FROM closed cd
    JOIN hyros_events h
      ON name_first_token(h.first_name::text) = cd.first_tok
   WHERE h.meta_ad_id IS NOT NULL OR h.campaign_name IS NOT NULL
),
hy_ranked AS (
  SELECT *,
         SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (PARTITION BY closer_call_id ORDER BY score, event_date DESC) AS rn
    FROM hy_candidates
),
hyros_match AS (
  SELECT closer_call_id, ad_id, campaign_name
    FROM hy_ranked
   WHERE rn = 1 AND (score IN (1,2) OR (score = 3 AND weak_count = 1))
)
SELECT cd.closer_call_id,
       cd.prospect_name,
       cd.clean_name,
       cd.revenue, cd.cash_collected, cd.created_at,
       COALESCE(ov.ad_id, tm.ad_id, gm.ad_id, hyros_ad.ad_id, ghl_ad.ad_id) AS resolved_ad_id,
       COALESCE(ov.adset_id, tm.adset_id, gm.adset_id, hyros_ad.adset_id, ghl_ad.adset_id) AS resolved_adset_id,
       COALESCE(ov.utm_campaign, tm.utm_campaign, gm.utm_campaign,
                hm.campaign_name::text, hyros_ad.campaign_name, ghl_ad.campaign_name) AS resolved_campaign,
       CASE
         WHEN ov.closer_call_id IS NOT NULL THEN 'manual'
         WHEN tm.closer_call_id IS NOT NULL THEN 'typeform'
         WHEN gm.closer_call_id IS NOT NULL THEN 'ghl'
         WHEN hm.closer_call_id IS NOT NULL THEN 'hyros'
         ELSE 'orphan'
       END AS attribution_source
  FROM closed cd
  LEFT JOIN close_attribution_overrides ov ON ov.closer_call_id = cd.closer_call_id
  LEFT JOIN typeform_match tm                ON tm.closer_call_id = cd.closer_call_id
  LEFT JOIN ghl_match       gm               ON gm.closer_call_id = cd.closer_call_id
  LEFT JOIN hyros_match     hm               ON hm.closer_call_id = cd.closer_call_id
  LEFT JOIN LATERAL (SELECT a.ad_id, a.adset_id, a.campaign_name FROM ads a WHERE a.ad_id = hm.ad_id LIMIT 1) hyros_ad ON true
  LEFT JOIN LATERAL (SELECT a.ad_id, a.adset_id, a.campaign_name FROM ads a WHERE a.ad_id = gm.ad_id LIMIT 1) ghl_ad   ON true;

GRANT SELECT ON public.lib_close_resolved TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
