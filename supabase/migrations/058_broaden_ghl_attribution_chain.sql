-- ============================================================
-- BROADEN GHL ATTRIBUTION CHAIN — Fix Roger / Michael / etc.
--
-- Bug: lib_ghl_booked_detail and lib_ghl_lives_detail both filtered
-- bookings/lives to ONLY those whose GHL contact record has
-- last_ad_id or first_ad_id populated. If GHL didn't carry the ad
-- attribution forward to the contact (which happens often — e.g.
-- contact created via Calendly direct without the ad context),
-- the booking was completely INVISIBLE to the dashboard even
-- though the prospect was a known lead via typeform.
--
-- Result: campaign rows showed "29 leads, 8 booked" when in reality
-- many of those leads (Roger, Michael @ Vet Restoration) had booked
-- calls — their bookings were just silently dropped from the views.
--
-- Fix: extend the attribution chain. For each booking/live, resolve
-- ad_id in this order:
--   1. ghl_contacts.last_ad_id (most recent)
--   2. ghl_contacts.first_ad_id (first-touch)
--   3. typeform_responses.ad_id (joined by email, then phone)
-- This catches every prospect who EVER had an ad attribution from
-- ANY of the sources we track, not just the GHL contact record.
-- ============================================================

BEGIN;

-- ─── lib_ghl_booked_detail v2 ──────────────────────────────────────
DROP VIEW IF EXISTS public.lib_ghl_booked_detail CASCADE;

CREATE VIEW public.lib_ghl_booked_detail AS
WITH resolved_attr AS (
  SELECT
    a.id                                              AS appointment_id,
    a.appointment_date                                AS landed_at,
    a.contact_name                                    AS display_name,
    c.email,
    c.phone,
    c.ghl_contact_id,
    -- Resolve ad_id via the broadest possible chain. The first
    -- non-null wins. ghl_contacts attribution comes first because
    -- it's the most up-to-date when populated; typeform fallback
    -- catches the "contact never had ad context propagated" case.
    COALESCE(
      c.last_ad_id,
      c.first_ad_id,
      (SELECT t.ad_id FROM public.typeform_responses t
        WHERE t.ad_id IS NOT NULL
          AND (
            (c.email IS NOT NULL AND lower(t.email) = lower(c.email)) OR
            (c.phone IS NOT NULL AND t.phone = c.phone)
          )
        ORDER BY t.submitted_at DESC NULLS LAST
        LIMIT 1)
    ) AS resolved_ad_id,
    a.outcome
  FROM public.ghl_appointments a
  JOIN public.ghl_contacts c ON c.ghl_contact_id = a.ghl_contact_id
)
SELECT
  appointment_id,
  landed_at,
  display_name,
  email,
  phone,
  ghl_contact_id,
  resolved_ad_id    AS ad_id,
  ad.adset_id       AS adset_id,
  ad.campaign_name  AS utm_campaign,
  outcome
FROM resolved_attr ra
LEFT JOIN public.ads ad ON ad.ad_id = ra.resolved_ad_id
WHERE ra.resolved_ad_id IS NOT NULL;

GRANT SELECT ON public.lib_ghl_booked_detail TO anon, authenticated;

-- ─── lib_ghl_lives_detail v2 ──────────────────────────────────────
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
    g.ghl_contact_id,
    g.email,
    g.phone,
    -- Same broadened attribution chain as the booked view.
    COALESCE(
      g.last_ad_id,
      g.first_ad_id,
      (SELECT t.ad_id FROM public.typeform_responses t
        WHERE t.ad_id IS NOT NULL
          AND (
            (g.email IS NOT NULL AND lower(t.email) = lower(g.email)) OR
            (g.phone IS NOT NULL AND t.phone = g.phone)
          )
        ORDER BY t.submitted_at DESC NULLS LAST
        LIMIT 1)
    ) AS resolved_ad_id
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
  m.resolved_ad_id    AS ad_id,
  a.adset_id          AS adset_id,
  a.campaign_name     AS utm_campaign
FROM matched m
LEFT JOIN public.ads a ON a.ad_id = m.resolved_ad_id
WHERE m.resolved_ad_id IS NOT NULL;

GRANT SELECT ON public.lib_ghl_lives_detail TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
