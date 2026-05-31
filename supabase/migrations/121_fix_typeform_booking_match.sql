-- Fix qualified-booking attribution in lib_typeform_response_outcome
-- (Ben 2026-06-01).
--
-- Bug Ben caught: per-ad "Qual Booked" column was empty for most ads even
-- though qualified leads existed. Root cause is the same name-token issue
-- that bit lib_ghl_lives_detail, but on the other side: the cc (closer_call)
-- lateral join in lib_typeform_response_outcome requires BOTH first_name
-- AND last_name to appear in closer_calls.prospect_name. None of the
-- prospect_names contain the typeform last_name (calls are tagged like
-- "Jason and Daniel Gomez De Le Vega" — closer's name suffix, not lead's
-- last name). So is_booked / is_live stay false even when the call exists.
--
-- Live example: Hector Perez submitted Electrician Funnel typeform 5/26
-- (qualified). closer_call "Hector  and Daniel Gomez De Le Vega" exists on
-- 5/29 (live). prospect_name doesn't contain "Perez" → old join failed →
-- Hector showed as Qual=1, Booked=0, Qual_Booked=0. Wrong.
--
-- Fix: replace the cc lateral with the same ladder resolver we use in
-- lib_ghl_lives_detail (migrations 119+120):
--   Strong  : first + last both match (current behaviour)
--   Audience: first match + form_name aligns with call's audience hint
--   Weak    : first name match, accept when (a) unique OR (b) all
--             candidates share form_name (which is irrelevant here since
--             we're matching FROM typeform — but we still need uniqueness
--             on the call side: only one call within window matching this
--             typeform's first name + ±60 day window)
--
-- Same ±60d window around submitted_at as 119/120 used. Use call_audience
-- hint extracted from closer_calls.prospect_name to bias selection.

BEGIN;

CREATE OR REPLACE VIEW public.lib_typeform_response_outcome AS
WITH base AS (
  SELECT tfr.response_id,
         tfr.ad_id,
         tfr.utm_term AS adset_id,
         tfr.utm_campaign,
         tfr.qualified,
         tfr.first_name,
         tfr.last_name,
         tfr.email,
         tfr.phone,
         tfr.form_name,
         tfr.submitted_at
    FROM typeform_responses tfr
),
-- Appointment match by email or phone — unchanged
appt_match AS (
  SELECT b.response_id,
         a.ghl_event_id,
         a.outcome AS appt_outcome,
         a.revenue AS appt_revenue,
         a.cash_collected AS appt_cash
    FROM base b
    LEFT JOIN LATERAL (
      SELECT *
        FROM ghl_appointments a
       WHERE (b.email IS NOT NULL AND lower(a.contact_email) = lower(b.email))
          OR (digits_only(b.phone) IS NOT NULL
              AND digits_only(a.contact_phone) IS NOT NULL
              AND right(digits_only(b.phone), 10) = right(digits_only(a.contact_phone), 10))
       ORDER BY a.booked_at DESC NULLS LAST
       LIMIT 1
    ) a ON true
),
-- Closer-call candidates — smart resolver instead of the strict
-- "first+last in prospect_name" join. Score 1 strong, 2 audience-biased,
-- 3 first-name-only.
cc_candidates AS (
  SELECT
    b.response_id, b.first_name, b.form_name, b.submitted_at,
    c.id AS cc_id, c.prospect_name, c.showed, c.outcome,
    c.revenue, c.cash_collected, c.created_at,
    audience_from_prospect_name(c.prospect_name::text) AS call_audience,
    CASE
      WHEN b.first_name IS NOT NULL AND length(b.first_name) >= 2
       AND b.last_name IS NOT NULL  AND length(b.last_name)  >= 2
       AND c.prospect_name::text ILIKE (b.first_name || '%')
       AND c.prospect_name::text ILIKE ('%' || b.last_name || '%')
        THEN 1
      WHEN b.first_name IS NOT NULL AND length(b.first_name) >= 2
       AND c.prospect_name::text ILIKE (b.first_name || '%')
       AND form_name_matches_audience(b.form_name, audience_from_prospect_name(c.prospect_name::text))
        THEN 2
      WHEN b.first_name IS NOT NULL AND length(b.first_name) >= 2
       AND c.prospect_name::text ILIKE (b.first_name || '%')
        THEN 3
      ELSE 4
    END AS score
    FROM base b
    JOIN closer_calls c
      ON c.created_at >= (b.submitted_at - INTERVAL '60 days')
     AND c.created_at <= (b.submitted_at + INTERVAL '60 days')
),
cc_weak_stats AS (
  SELECT response_id, COUNT(*) AS weak_count
    FROM cc_candidates
   WHERE score = 3
   GROUP BY response_id
),
cc_ranked AS (
  SELECT c.*,
         COALESCE(s.weak_count, 0) AS weak_count,
         ROW_NUMBER() OVER (
           PARTITION BY c.response_id
           ORDER BY c.score ASC, c.created_at DESC
         ) AS rn
    FROM cc_candidates c
    LEFT JOIN cc_weak_stats s ON s.response_id = c.response_id
),
cc_match AS (
  SELECT response_id, cc_id, showed AS cc_showed, outcome AS cc_outcome,
         revenue AS cc_revenue, cash_collected AS cc_cash
    FROM cc_ranked
   WHERE rn = 1
     AND (
       score IN (1, 2)
       OR (score = 3 AND weak_count = 1)
     )
)
SELECT b.response_id,
       b.ad_id,
       b.adset_id,
       b.utm_campaign,
       b.qualified,
       am.ghl_event_id AS matched_event_id,
       am.appt_outcome,
       am.appt_revenue,
       am.appt_cash,
       cm.cc_showed,
       cm.cc_outcome,
       cm.cc_revenue,
       cm.cc_cash
  FROM base b
  LEFT JOIN appt_match am ON am.response_id = b.response_id
  LEFT JOIN cc_match   cm ON cm.response_id = b.response_id;

GRANT SELECT ON public.lib_typeform_response_outcome TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
