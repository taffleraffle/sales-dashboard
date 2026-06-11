-- 150_unify_audience_islands.sql
--
-- Three views resolved audience with their own stale logic ("methodology
-- islands") instead of the unified chain (lib_ad_audience, which folds in
-- ad_audience_overrides + campaign_audience_overrides +
-- audience_from_campaign_name via audience_definitions):
--
--   1. lib_typeform_audience_resolved  - inline 8-vertical CASE, missing
--      australia (migration 129) and ad_audience_overrides (migration 140).
--   2. lib_attribution_ad_kanban       - same stale CASE duplicated.
--   3. lib_attribution_qa_queue        - prospect_name_audience_title first
--      (migration-126 logic) instead of the ad/campaign chain.
--
-- Also: lib_ghl_lives_per_ad / per_adset / per_campaign used an unscored
-- first-name match against ghl_contacts that never reconciled with
-- lib_ghl_lives_detail. They are now plain re-aggregations of
-- lib_ghl_lives_detail (verified: exactly one row per closer_call_id), so
-- per-ad/adset/campaign counts sum back to the detail view by construction.
--
-- All output columns (names, order, types) are preserved exactly, so
-- AttributionCoverage.jsx and the dependent views
-- (lib_attribution_unresolved_creatives / lib_attribution_unresolved_typeform)
-- keep working unchanged.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. lib_typeform_audience_resolved
--    Resolution order: response override > unified ad chain (lib_ad_audience
--    by COALESCE(override ad, typeform ad)) > campaign override keyed by raw
--    utm_campaign (legacy fallback, preserved) > keyword parse of
--    utm_campaign against audience_definitions (slug-level equivalent of
--    audience_from_campaign_name, same sort_order precedence, with a
--    deterministic slug tiebreak).
--    audience_source gains one new value, 'ad_resolved', for rows resolved
--    via the ad chain. lib_ad_audience emits 'Unknown' (never NULL) when an
--    ad exists but nothing resolves; 'Unknown' has no audience_definitions
--    row, so the display->slug lateral correctly yields NULL and falls
--    through.
-- ──────────────────────────────────────────────────────────────────────────
create or replace view public.lib_typeform_audience_resolved as
select
  tr.response_id,
  coalesce(ro.audience_slug, ad_slug.slug, co.audience_slug, utm_slug.slug) as audience_slug,
  case
    when ro.audience_slug is not null then 'response_override'
    when ad_slug.slug is not null then 'ad_resolved'
    when co.audience_slug is not null then 'campaign_override'
    when tr.utm_campaign is not null then 'parsed'
    else 'unknown'
  end as audience_source,
  coalesce(ro.ad_id, tr.ad_id) as ad_id
from typeform_responses tr
left join typeform_response_overrides ro on ro.response_id = tr.response_id
left join campaign_audience_overrides co on co.campaign_id = tr.utm_campaign
left join lib_ad_audience laa on laa.ad_id = coalesce(ro.ad_id, tr.ad_id)
left join lateral (
  select d.slug
  from audience_definitions d
  where d.display_name = laa.audience
  order by d.sort_order asc, d.slug asc
  limit 1
) ad_slug on true
left join lateral (
  select d.slug
  from audience_definitions d
  where d.is_active
    and tr.utm_campaign is not null
    and exists (
      select 1 from unnest(d.keywords) kw
      where tr.utm_campaign ilike '%' || kw || '%'
    )
  order by d.sort_order asc, d.slug asc
  limit 1
) utm_slug on true;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. lib_attribution_ad_kanban
--    creative_attributes.vertical stays the kanban's manual-override channel
--    (the page upserts there and relies on vertical_source = 'override').
--    The stale parse CASE is replaced with the unified per-ad chain
--    (lib_ad_audience -> slug). vertical_source keeps its exact value set
--    {override, parsed, unknown}: 'parsed' now also covers ads classified
--    purely by an ad/campaign override so they bucket into their column
--    instead of "unclassified".
-- ──────────────────────────────────────────────────────────────────────────
create or replace view public.lib_attribution_ad_kanban as
with spend_30d as (
  select ad_id, coalesce(sum(spend), 0::numeric) as spend
  from ad_daily_stats
  where date >= current_date - interval '30 days'
  group by ad_id
), leads_30d as (
  select ad_id, count(*)::integer as leads
  from typeform_responses
  where ad_id is not null
    and submitted_at >= now() - interval '30 days'
  group by ad_id
)
select
  a.ad_id,
  a.ad_name,
  a.campaign_name,
  a.adset_name,
  a.effective_status,
  a.thumbnail_url,
  a.asset_url,
  a.asset_type,
  a.destination_url,
  coalesce(s.spend, 0::numeric) as spend_30d,
  coalesce(l.leads, 0) as leads_30d,
  case
    when coalesce(l.leads, 0) > 0
    then round(coalesce(s.spend, 0::numeric) / l.leads::numeric, 2)
    else null::numeric
  end as cpl_30d,
  coalesce(ca.vertical, ad_slug.slug) as current_vertical,
  case
    when ca.vertical is not null then 'override'
    when ad_slug.slug is not null or a.campaign_name is not null then 'parsed'
    else 'unknown'
  end as vertical_source,
  ca.offer_slug,
  ca.vertical as override_vertical
from ads a
join spend_30d s on s.ad_id = a.ad_id
left join leads_30d l on l.ad_id = a.ad_id
left join creative_attributes ca on ca.ad_id = a.ad_id
left join lib_ad_audience laa on laa.ad_id = a.ad_id
left join lateral (
  select d.slug
  from audience_definitions d
  where d.display_name = laa.audience
  order by d.sort_order asc, d.slug asc
  limit 1
) ad_slug on true
where s.spend > 0::numeric
order by s.spend desc, a.ad_id asc;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. lib_attribution_qa_queue
--    Audience resolution reordered so the unified chain wins:
--      lib_ad_audience by the attributed ad_id (folds in overrides)
--      > audience_from_campaign_name(utm_campaign)
--      > prospect_name_audience_title(prospect_name)   -- last resort now
--    NULLIF guards lib_ad_audience's 'Unknown' sentinel so it falls through
--    instead of short-circuiting the COALESCE. qa_flag value set and all
--    output columns unchanged. Deterministic tiebreak added to ORDER BY.
-- ──────────────────────────────────────────────────────────────────────────
create or replace view public.lib_attribution_qa_queue as
with all_attributed_lives as (
  select
    cc.id as closer_call_id,
    cc.prospect_name,
    cc.created_at as landed_at,
    cc.outcome,
    cc.revenue,
    cc.cash_collected,
    v.ad_id,
    v.utm_campaign,
    v.match_confidence,
    case when cc.outcome::text = 'closed' then 'close' else 'live' end as row_type
  from closer_calls cc
  left join lib_ghl_lives_detail v on v.closer_call_id = cc.id
  where cc.created_at >= now() - interval '90 days'
    and (cc.showed or cc.outcome::text in ('showed', 'closed', 'not_closed'))
), resolved as (
  select
    l.*,
    coalesce(
      nullif(laa.audience, 'Unknown'),                       -- 1. unified ad chain
      audience_from_campaign_name(l.utm_campaign),           -- 2. campaign parse
      prospect_name_audience_title(l.prospect_name::text)    -- 3. name guess (last resort)
    ) as resolved_audience
  from all_attributed_lives l
  left join lib_ad_audience laa on laa.ad_id = l.ad_id
), flagged as (
  select
    r.closer_call_id,
    r.prospect_name,
    r.landed_at,
    r.outcome,
    r.revenue,
    r.cash_collected,
    r.ad_id,
    r.utm_campaign,
    r.row_type,
    case
      when r.ad_id is null and r.utm_campaign is null then 'orphan'
      when r.match_confidence = 'weak' then 'low_confidence'
      when r.resolved_audience is null then 'missing_audience'
      else 'ok'
    end as qa_flag,
    r.match_confidence,
    coalesce(r.resolved_audience, 'Unknown') as current_audience
  from resolved r
)
select
  closer_call_id,
  prospect_name,
  landed_at::date as d,
  outcome,
  revenue,
  cash_collected,
  row_type,
  qa_flag,
  match_confidence,
  current_audience,
  ad_id,
  utm_campaign
from flagged
where qa_flag <> 'ok'
order by landed_at desc, closer_call_id asc;

-- ──────────────────────────────────────────────────────────────────────────
-- 4-6. lib_ghl_lives_per_ad / per_adset / per_campaign
--    Replaced the unscored first-name x ghl_contacts match with straight
--    re-aggregations of lib_ghl_lives_detail (manual override > appointment
--    email chain > scored typeform > scored GHL). Detail is exactly one row
--    per closer_call_id, so these now reconcile with lib_ghl_lives_detail by
--    construction. Output columns/types unchanged (count(*) stays bigint).
-- ──────────────────────────────────────────────────────────────────────────
create or replace view public.lib_ghl_lives_per_ad as
select ad_id, count(*) as live_calls
from lib_ghl_lives_detail
where ad_id is not null
group by ad_id;

create or replace view public.lib_ghl_lives_per_adset as
select adset_id, count(*) as live_calls
from lib_ghl_lives_detail
where adset_id is not null
group by adset_id;

create or replace view public.lib_ghl_lives_per_campaign as
select utm_campaign, count(*) as live_calls
from lib_ghl_lives_detail
where utm_campaign is not null
group by utm_campaign;

-- Rebuild the trend matview so tiles pick up the unified numbers.
select public.refresh_marketing_trend_mv();
