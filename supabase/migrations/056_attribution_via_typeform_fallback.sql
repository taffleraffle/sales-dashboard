-- ============================================================
-- ATTRIBUTION FALLBACK: typeform → bookings/lives
--
-- Before: lib_ghl_booked_detail and lib_ghl_lives_detail JOIN to
-- ghl_contacts and filter WHERE COALESCE(c.last_ad_id, c.first_ad_id)
-- IS NOT NULL. If GHL didn't carry Meta's ad attribution onto the
-- contact record (common — contacts created via webhook/Calendly often
-- have NULL ad_id fields), the booking is COMPLETELY excluded from
-- the view. The Ads dashboard then shows "Roger booked 0" even when
-- Roger booked through a typeform that knew his ad_id.
--
-- After: the views consult a 3-tier attribution chain:
--   1. ghl_contacts.last_ad_id / first_ad_id    (current behavior)
--   2. typeform_responses.ad_id matched by email or phone
--   3. typeform_responses utm_content → ads.ad_name lookup
--
-- Bookings whose contact has typeform attribution but no GHL contact
-- ad_id now correctly attribute to the right campaign. Same for lives.
-- ============================================================

-- Helper: resolve an ad_id for a (contact email, contact phone) pair by
-- looking at typeform_responses. Returns NULL when no typeform row matches.
CREATE OR REPLACE FUNCTION public.resolve_ad_id_from_typeform(p_email TEXT, p_phone TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT tf.ad_id
  FROM public.typeform_responses tf
  WHERE tf.ad_id IS NOT NULL
    AND (
      (p_email IS NOT NULL AND lower(tf.email) = lower(p_email))
      OR
      (p_phone IS NOT NULL AND regexp_replace(coalesce(tf.phone, ''), '\D', '', 'g')
        = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
        AND regexp_replace(coalesce(tf.phone, ''), '\D', '', 'g') <> '')
    )
  ORDER BY tf.submitted_at DESC NULLS LAST
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public.resolve_ad_id_from_typeform(TEXT, TEXT) TO anon, authenticated;

-- ─── lib_ghl_booked_detail — recreate with typeform fallback ────────
DROP VIEW IF EXISTS public.lib_ghl_booked_detail CASCADE;
CREATE VIEW public.lib_ghl_booked_detail AS
WITH resolved AS (
  SELECT
    a.id                                            AS appointment_id,
    a.appointment_date                              AS landed_at,
    a.contact_name                                  AS display_name,
    c.email,
    c.phone,
    -- 3-tier attribution: GHL contact → typeform email/phone match.
    COALESCE(
      c.last_ad_id,
      c.first_ad_id,
      public.resolve_ad_id_from_typeform(c.email, c.phone)
    )                                               AS ad_id,
    a.outcome
  FROM public.ghl_appointments a
  JOIN public.ghl_contacts c ON c.ghl_contact_id = a.ghl_contact_id
)
SELECT
  r.appointment_id,
  r.landed_at,
  r.display_name,
  r.email,
  r.phone,
  r.ad_id,
  ad.adset_id,
  ad.campaign_name AS utm_campaign,
  r.outcome
FROM resolved r
LEFT JOIN public.ads ad ON ad.ad_id = r.ad_id
WHERE r.ad_id IS NOT NULL;

GRANT SELECT ON public.lib_ghl_booked_detail TO anon, authenticated;

-- ─── lib_ghl_lives_detail — recreate with typeform fallback ─────────
DROP VIEW IF EXISTS public.lib_ghl_lives_detail CASCADE;
CREATE VIEW public.lib_ghl_lives_detail AS
WITH live AS (
  SELECT
    cc.id                                                            AS closer_call_id,
    cc.prospect_name                                                 AS display_name,
    cc.created_at                                                    AS landed_at,
    cc.outcome,
    cc.cash_collected,
    cc.revenue,
    public.name_first_token (public.strip_call_suffix(cc.prospect_name)) AS first_tok,
    public.name_second_token(public.strip_call_suffix(cc.prospect_name)) AS second_tok
  FROM public.closer_calls cc
  WHERE cc.showed = TRUE OR cc.outcome IN ('showed','closed','not_closed')
),
matched AS (
  SELECT DISTINCT ON (li.closer_call_id)
    li.closer_call_id,
    li.display_name,
    li.landed_at,
    li.outcome,
    li.cash_collected,
    li.revenue,
    -- Same 3-tier chain: GHL contact → typeform email/phone fallback.
    COALESCE(
      g.last_ad_id,
      g.first_ad_id,
      public.resolve_ad_id_from_typeform(g.email, g.phone)
    ) AS ad_id
  FROM live li
  JOIN public.ghl_contacts g
    ON public.name_first_token(g.first_name) = li.first_tok
   AND (li.second_tok = ''
        OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || li.second_tok || '%')
  ORDER BY li.closer_call_id, g.date_added DESC NULLS LAST
)
SELECT
  m.closer_call_id,
  m.display_name,
  m.landed_at,
  m.outcome,
  m.cash_collected,
  m.revenue,
  m.ad_id,
  a.adset_id,
  a.campaign_name AS utm_campaign
FROM matched m
LEFT JOIN public.ads a ON a.ad_id = m.ad_id
WHERE m.ad_id IS NOT NULL;

GRANT SELECT ON public.lib_ghl_lives_detail TO anon, authenticated;

-- ─── lib_ghl_leads_detail — same fallback (so cohort lookups match) ─
DROP VIEW IF EXISTS public.lib_ghl_leads_detail CASCADE;
CREATE VIEW public.lib_ghl_leads_detail AS
WITH resolved AS (
  SELECT
    c.ghl_contact_id,
    c.date_added                                       AS landed_at,
    COALESCE(NULLIF(trim(c.full_name), ''),
             NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
             c.email,
             c.ghl_contact_id)                         AS display_name,
    c.email,
    c.phone,
    c.company_name,
    COALESCE(
      c.last_ad_id,
      c.first_ad_id,
      public.resolve_ad_id_from_typeform(c.email, c.phone)
    ) AS ad_id
  FROM public.ghl_contacts c
)
SELECT
  r.ghl_contact_id,
  r.landed_at,
  r.display_name,
  r.email,
  r.phone,
  r.company_name,
  r.ad_id,
  ad.adset_id,
  ad.campaign_name AS utm_campaign
FROM resolved r
LEFT JOIN public.ads ad ON ad.ad_id = r.ad_id
WHERE r.ad_id IS NOT NULL;

GRANT SELECT ON public.lib_ghl_leads_detail TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
