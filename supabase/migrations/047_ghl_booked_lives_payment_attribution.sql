-- 047_ghl_booked_lives_payment_attribution.sql
-- Three new attribution layers wired to the GHL-contact bridge:
--
-- 1. lib_ghl_booked_per_ad     — appointments where the contact carries
--                                 Meta-ad attribution. Fills the Booked
--                                 column for paid-lead-form campaigns
--                                 (was 0 because typeform never saw them).
--
-- 2. lib_ghl_lives_per_ad      — closer_calls.showed=true rows whose
--                                 prospect matches a ghl_contact with ad
--                                 attribution. Same trick for the Live
--                                 column.
--
-- 3. lib_payment_attribution   — Stripe/Fanbasis payments matched by
--                                 customer_email to ghl_contact, then
--                                 resolved to ad_id. Real revenue
--                                 (vs closer-reported), creditable per ad.
--
-- Idempotent. Apply via supabase db push.

BEGIN;

-- ─── 1. GHL appointments → ad attribution ──────────────────────────
DROP VIEW IF EXISTS public.lib_ghl_booked_per_ad CASCADE;
CREATE VIEW public.lib_ghl_booked_per_ad AS
SELECT
  COALESCE(c.last_ad_id, c.first_ad_id)             AS ad_id,
  count(DISTINCT a.id)                              AS booked_calls,
  count(DISTINCT a.id) FILTER (WHERE a.appointment_date::date >= CURRENT_DATE - 30) AS booked_30d
FROM public.ghl_appointments a
JOIN public.ghl_contacts c ON c.ghl_contact_id = a.ghl_contact_id
WHERE COALESCE(c.last_ad_id, c.first_ad_id) IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_booked_per_ad TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_ghl_booked_per_adset CASCADE;
CREATE VIEW public.lib_ghl_booked_per_adset AS
SELECT
  c.last_adset_id                                   AS adset_id,
  count(DISTINCT a.id)                              AS booked_calls
FROM public.ghl_appointments a
JOIN public.ghl_contacts c ON c.ghl_contact_id = a.ghl_contact_id
WHERE c.last_adset_id IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_booked_per_adset TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_ghl_booked_per_campaign CASCADE;
CREATE VIEW public.lib_ghl_booked_per_campaign AS
SELECT
  COALESCE(c.last_utm_campaign, c.first_utm_campaign) AS utm_campaign,
  count(DISTINCT a.id)                                AS booked_calls
FROM public.ghl_appointments a
JOIN public.ghl_contacts c ON c.ghl_contact_id = a.ghl_contact_id
WHERE COALESCE(c.last_utm_campaign, c.first_utm_campaign) IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_ghl_booked_per_campaign TO anon, authenticated;

-- Detail view for the Booked drill-down.
DROP VIEW IF EXISTS public.lib_ghl_booked_detail CASCADE;
CREATE VIEW public.lib_ghl_booked_detail AS
SELECT
  a.id                                              AS appointment_id,
  a.appointment_date                                AS landed_at,
  a.contact_name                                    AS display_name,
  c.email,
  c.phone,
  COALESCE(c.last_ad_id, c.first_ad_id)             AS ad_id,
  c.last_adset_id                                   AS adset_id,
  COALESCE(c.last_utm_campaign, c.first_utm_campaign) AS utm_campaign,
  a.outcome
FROM public.ghl_appointments a
JOIN public.ghl_contacts c ON c.ghl_contact_id = a.ghl_contact_id
WHERE COALESCE(c.last_ad_id, c.first_ad_id) IS NOT NULL
   OR c.last_adset_id IS NOT NULL
   OR COALESCE(c.last_utm_campaign, c.first_utm_campaign) IS NOT NULL;
GRANT SELECT ON public.lib_ghl_booked_detail TO anon, authenticated;


-- ─── 2. closer_calls (live) → ad attribution via ghl_contact ─────
-- Match closer_calls to a ghl_contact by name (same algorithm as the
-- close resolver). If the ghl_contact has ad attribution, credit the
-- live call to that ad.
DROP VIEW IF EXISTS public.lib_ghl_lives_per_ad CASCADE;
CREATE VIEW public.lib_ghl_lives_per_ad AS
WITH live AS (
  SELECT
    cc.id,
    public.name_first_token (public.strip_call_suffix(cc.prospect_name)) AS first_tok,
    public.name_second_token(public.strip_call_suffix(cc.prospect_name)) AS second_tok
  FROM public.closer_calls cc
  WHERE cc.showed = TRUE OR cc.outcome IN ('showed','closed','not_closed')
),
matched AS (
  SELECT DISTINCT ON (li.id)
    li.id,
    COALESCE(g.last_ad_id, g.first_ad_id) AS ad_id
  FROM live li
  JOIN public.ghl_contacts g
    ON public.name_first_token(g.first_name) = li.first_tok
   AND (li.second_tok = ''
        OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || li.second_tok || '%')
  WHERE COALESCE(g.last_ad_id, g.first_ad_id) IS NOT NULL
  ORDER BY li.id, g.date_added DESC NULLS LAST
)
SELECT ad_id, count(*) AS live_calls
FROM matched WHERE ad_id IS NOT NULL GROUP BY 1;
GRANT SELECT ON public.lib_ghl_lives_per_ad TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_ghl_lives_per_adset CASCADE;
CREATE VIEW public.lib_ghl_lives_per_adset AS
WITH live AS (
  SELECT cc.id,
    public.name_first_token (public.strip_call_suffix(cc.prospect_name)) AS first_tok,
    public.name_second_token(public.strip_call_suffix(cc.prospect_name)) AS second_tok
  FROM public.closer_calls cc
  WHERE cc.showed = TRUE OR cc.outcome IN ('showed','closed','not_closed')
),
matched AS (
  SELECT DISTINCT ON (li.id) li.id, g.last_adset_id AS adset_id
  FROM live li
  JOIN public.ghl_contacts g
    ON public.name_first_token(g.first_name) = li.first_tok
   AND (li.second_tok = '' OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || li.second_tok || '%')
  WHERE g.last_adset_id IS NOT NULL
  ORDER BY li.id, g.date_added DESC NULLS LAST
)
SELECT adset_id, count(*) AS live_calls FROM matched WHERE adset_id IS NOT NULL GROUP BY 1;
GRANT SELECT ON public.lib_ghl_lives_per_adset TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_ghl_lives_per_campaign CASCADE;
CREATE VIEW public.lib_ghl_lives_per_campaign AS
WITH live AS (
  SELECT cc.id,
    public.name_first_token (public.strip_call_suffix(cc.prospect_name)) AS first_tok,
    public.name_second_token(public.strip_call_suffix(cc.prospect_name)) AS second_tok
  FROM public.closer_calls cc
  WHERE cc.showed = TRUE OR cc.outcome IN ('showed','closed','not_closed')
),
matched AS (
  SELECT DISTINCT ON (li.id) li.id, COALESCE(g.last_utm_campaign, g.first_utm_campaign) AS utm_campaign
  FROM live li
  JOIN public.ghl_contacts g
    ON public.name_first_token(g.first_name) = li.first_tok
   AND (li.second_tok = '' OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || li.second_tok || '%')
  WHERE COALESCE(g.last_utm_campaign, g.first_utm_campaign) IS NOT NULL
  ORDER BY li.id, g.date_added DESC NULLS LAST
)
SELECT utm_campaign, count(*) AS live_calls FROM matched WHERE utm_campaign IS NOT NULL GROUP BY 1;
GRANT SELECT ON public.lib_ghl_lives_per_campaign TO anon, authenticated;


-- ─── 3. Stripe/Fanbasis payments → ad attribution ────────────────
-- Match payments by customer_email to a ghl_contact, resolve to ad_id.
-- Real revenue creditable per creative. Sums net_amount (post-fees).
DROP VIEW IF EXISTS public.lib_payment_resolved CASCADE;
CREATE VIEW public.lib_payment_resolved AS
SELECT
  p.id                                              AS payment_id,
  p.payment_date,
  p.source,
  p.amount,
  p.net_amount,
  p.customer_email,
  p.customer_name,
  p.payment_type,
  COALESCE(c.last_ad_id, c.first_ad_id)             AS resolved_ad_id,
  c.last_adset_id                                   AS resolved_adset_id,
  COALESCE(c.last_utm_campaign, c.first_utm_campaign) AS resolved_campaign
FROM public.payments p
LEFT JOIN public.ghl_contacts c
  ON lower(c.email) = lower(p.customer_email)
WHERE p.customer_email IS NOT NULL;
GRANT SELECT ON public.lib_payment_resolved TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_payment_per_ad CASCADE;
CREATE VIEW public.lib_payment_per_ad AS
SELECT
  resolved_ad_id        AS ad_id,
  count(DISTINCT customer_email)                    AS paying_customers,
  count(*)                                          AS payment_count,
  COALESCE(sum(amount), 0)                          AS revenue,
  COALESCE(sum(net_amount), 0)                      AS net_revenue,
  max(payment_date)                                 AS last_payment_at
FROM public.lib_payment_resolved
WHERE resolved_ad_id IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_payment_per_ad TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_payment_per_adset CASCADE;
CREATE VIEW public.lib_payment_per_adset AS
SELECT
  resolved_adset_id     AS adset_id,
  count(DISTINCT customer_email)                    AS paying_customers,
  COALESCE(sum(amount), 0)                          AS revenue,
  COALESCE(sum(net_amount), 0)                      AS net_revenue
FROM public.lib_payment_resolved
WHERE resolved_adset_id IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_payment_per_adset TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_payment_per_campaign CASCADE;
CREATE VIEW public.lib_payment_per_campaign AS
SELECT
  resolved_campaign     AS utm_campaign,
  count(DISTINCT customer_email)                    AS paying_customers,
  COALESCE(sum(amount), 0)                          AS revenue,
  COALESCE(sum(net_amount), 0)                      AS net_revenue
FROM public.lib_payment_resolved
WHERE resolved_campaign IS NOT NULL
GROUP BY 1;
GRANT SELECT ON public.lib_payment_per_campaign TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
