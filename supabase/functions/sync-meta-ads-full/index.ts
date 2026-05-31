// sync-meta-ads-full — full Meta Ads sync, called by pg_cron daily +
// the "Refresh from Meta" button on /sales/ads/performance.
//
// Pulls the last N days (default 30) of ad-level insights, fetches creative
// metadata per ad, and writes to:
//   public.ads             — per-ad metadata (name, campaign, adset, status,
//                             creative, thumbnail, destination_url, ...)
//   public.ad_daily_stats  — per-ad-per-day spend/impressions/clicks/results
//
// Ports `scripts/sync-meta-ads-now.mjs` (CLI) to Deno. Required because
// stale ad data on the Performance page was 19 days behind before this
// shipped (Ben 2026-06-01).
//
//   POST /functions/v1/sync-meta-ads-full { days?: number }
//
// Returns { ok, ads_synced, stat_rows, errors, duration_ms }.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ACCOUNT_ID   = Deno.env.get('META_ADS_ACCOUNT_ID')!
const META_TOKEN   = Deno.env.get('META_ADS_ACCESS_TOKEN')!

const BASE = 'https://graph.facebook.com/v21.0'

const INSIGHT_FIELDS = [
  'ad_id','ad_name','campaign_id','campaign_name','adset_id','adset_name',
  'spend','impressions','reach','frequency','clicks','unique_clicks','ctr','cpc','cpm',
  'actions','cost_per_action_type','video_thruplay_watched_actions','video_avg_time_watched_actions',
].join(',')

const CREATIVE_FIELDS = [
  'name','status','effective_status',
  'creative{id,image_url,video_id,thumbnail_url,body,title,object_type,call_to_action_type,object_story_spec}',
].join(',')

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const startedAt = Date.now()
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  const DAYS = Math.max(1, Math.min(90, parseInt(body.days ?? '30')))

  if (!SUPABASE_URL || !SERVICE_KEY || !ACCOUNT_ID || !META_TOKEN) {
    return json({ ok: false, error: 'Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / META_ADS_ACCOUNT_ID / META_ADS_ACCESS_TOKEN' }, 500)
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  const since = new Date()
  since.setUTCDate(since.getUTCDate() - DAYS)
  const sinceStr = since.toISOString().split('T')[0]
  const untilStr = new Date().toISOString().split('T')[0]

  console.log(`[sync-meta-ads-full] window: ${sinceStr} → ${untilStr}`)

  // ─── Phase 1: insights ─────────────────────────────────────────────────
  const adIds = new Set<string>()
  // Campaign/adset metadata snapshot keyed by ad_id — the /{ad_id} creative
  // endpoint we hit next doesn't return these, so we capture them here.
  const adMeta: Record<string, {campaign_id: string|null, campaign_name: string|null, adset_id: string|null, adset_name: string|null}> = {}
  const allInsightBatches: any[][] = []
  let url: string | null = `${BASE}/act_${ACCOUNT_ID}/insights?` + new URLSearchParams({
    access_token: META_TOKEN,
    level: 'ad',
    fields: INSIGHT_FIELDS,
    time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
    time_increment: '1',
    limit: '500',
  }).toString()

  let pageNum = 0
  while (url) {
    pageNum++
    const res = await fetch(url)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return json({ ok: false, error: `Insights HTTP ${res.status}: ${err.error?.message || res.statusText}` }, 502)
    }
    const j: any = await res.json()
    const rows = j.data || []
    const batch: any[] = []
    for (const row of rows) {
      if (!row.ad_id) continue
      adIds.add(row.ad_id)
      if (!adMeta[row.ad_id]) {
        adMeta[row.ad_id] = {
          campaign_id:   row.campaign_id   ?? null,
          campaign_name: row.campaign_name ?? null,
          adset_id:      row.adset_id      ?? null,
          adset_name:    row.adset_name    ?? null,
        }
      }
      const find = (arr: any[], types: string[]) => (arr || []).find(a => types.includes(a.action_type))
      const v3sAction     = find(row.actions, ['video_view'])
      const thruAction    = find(row.video_thruplay_watched_actions, ['video_view'])
      const avgTimeAction = find(row.video_avg_time_watched_actions, ['video_view'])
      const leadTypes = ['lead','offsite_conversion.fb_pixel_lead','onsite_conversion.lead_grouped']
      const resultAction  = find(row.actions, leadTypes)
      const costPerResult = find(row.cost_per_action_type, leadTypes)
      batch.push({
        ad_id: row.ad_id,
        date: row.date_start,
        spend: parseFloat(row.spend || 0),
        impressions: parseInt(row.impressions || 0),
        reach: parseInt(row.reach || 0),
        frequency: parseFloat(row.frequency || 0),
        clicks: parseInt(row.clicks || 0),
        unique_clicks: parseInt(row.unique_clicks || 0),
        ctr: row.ctr != null ? parseFloat(row.ctr) : null,
        cpc: row.cpc != null ? parseFloat(row.cpc) : null,
        cpm: row.cpm != null ? parseFloat(row.cpm) : null,
        video_3s_views: v3sAction ? parseInt(v3sAction.value) : 0,
        video_thruplays: thruAction ? parseInt(thruAction.value) : 0,
        video_avg_time_watched: avgTimeAction ? parseFloat(avgTimeAction.value) : null,
        results: resultAction ? parseInt(resultAction.value) : 0,
        cost_per_result: costPerResult ? parseFloat(costPerResult.value) : null,
        raw_payload: row,
        synced_at: new Date().toISOString(),
      })
    }
    allInsightBatches.push(batch)
    console.log(`[sync-meta-ads-full] insights p${pageNum}: ${batch.length} rows (ads seen=${adIds.size})`)
    url = j.paging?.next || null
  }

  // ─── Phase 2: creatives in parallel ─────────────────────────────────────
  const ids = [...adIds]
  const records: any[] = []
  let creativeErrors = 0
  const concurrency = 8
  for (let i = 0; i < ids.length; i += concurrency) {
    const slice = ids.slice(i, i + concurrency)
    const results = await Promise.all(slice.map(async (ad_id) => {
      try {
        const r = await fetch(`${BASE}/${ad_id}?access_token=${META_TOKEN}&fields=${CREATIVE_FIELDS}`)
        if (!r.ok) return null
        return await r.json()
      } catch { return null }
    }))
    for (const j of results) {
      if (!j || !j.id) { creativeErrors++; continue }
      const c = j.creative || null
      const oss = c?.object_story_spec || {}
      const linkData = oss.link_data
      const videoData = oss.video_data
      const headline = c?.title || linkData?.name || videoData?.title || null
      const primary_text = c?.body || linkData?.message || videoData?.message || null
      const description = linkData?.description || null
      const cta_type = c?.call_to_action_type || linkData?.call_to_action?.type || videoData?.call_to_action?.type || null
      const destination_url = linkData?.link || videoData?.call_to_action?.value?.link || null
      const asset_type = (c?.video_id || c?.object_type === 'VIDEO') ? 'video'
                       : c?.image_url ? 'image'
                       : (c?.object_type === 'SHARE' && linkData?.child_attachments) ? 'carousel'
                       : 'unknown'
      const thumbnail_url = c?.thumbnail_url || c?.image_url || null
      const archived = ['DELETED','ARCHIVED'].includes(j.effective_status || j.status)
      const meta = adMeta[j.id] || { campaign_id: null, campaign_name: null, adset_id: null, adset_name: null }
      records.push({
        ad_id: j.id,
        platform: 'meta',
        ad_name: j.name || null,
        campaign_id: meta.campaign_id,
        campaign_name: meta.campaign_name,
        adset_id: meta.adset_id,
        adset_name: meta.adset_name,
        status: j.status || null,
        effective_status: j.effective_status || null,
        creative_id: c?.id || null,
        asset_type,
        asset_url: c?.image_url || null,
        thumbnail_url,
        headline, primary_text, description, cta_type, destination_url,
        raw_payload: j,
        last_synced_at: new Date().toISOString(),
        archived_at: archived ? new Date().toISOString() : null,
      })
    }
  }

  // ─── Phase 3: write ads, then write stats (FK order matters) ────────────
  let adsErr: string | null = null
  if (records.length) {
    const { error } = await supabase.from('ads').upsert(records, { onConflict: 'ad_id' })
    if (error) adsErr = error.message
  }
  if (adsErr) {
    return json({ ok: false, error: `ads upsert: ${adsErr}` }, 500)
  }

  let totalRows = 0
  let totalErrors = 0
  for (const batch of allInsightBatches) {
    if (!batch.length) continue
    const { error } = await supabase.from('ad_daily_stats').upsert(batch, { onConflict: 'ad_id,date' })
    if (error) {
      console.error('[sync-meta-ads-full] stats batch error:', error.message)
      totalErrors += batch.length
    } else {
      totalRows += batch.length
    }
  }

  const duration_ms = Date.now() - startedAt
  console.log(`[sync-meta-ads-full] DONE — ${totalRows} stat rows, ${records.length} ads, ${totalErrors + creativeErrors} errors, ${duration_ms}ms`)

  return json({
    ok: true,
    window: { since: sinceStr, until: untilStr },
    ads_synced: records.length,
    stat_rows: totalRows,
    errors: { stats: totalErrors, creatives: creativeErrors },
    duration_ms,
  })
})

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
