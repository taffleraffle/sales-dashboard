import { supabase } from '../lib/supabase'
import { INTRO_CALENDARS as INTRO_CALL_CALENDARS, STRATEGY_CALL_CALENDARS } from '../utils/constants'

const ACCOUNT_ID = import.meta.env.VITE_META_ADS_ACCOUNT_ID
const ACCESS_TOKEN = import.meta.env.VITE_META_ADS_ACCESS_TOKEN
const BASE_URL = 'https://graph.facebook.com/v21.0'

// NZD → USD conversion rate (Meta reports in account currency which is NZD)
const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')

/**
 * Fetch ad insights from Meta Ads API and store in Supabase marketing_daily.
 * Pulls campaign-level and adset-level data for the given number of days.
 */
export async function syncMetaAds(days = 30) {
  if (!ACCOUNT_ID || !ACCESS_TOKEN) {
    throw new Error('Meta Ads credentials not configured')
  }

  const sinceStr = typeof days === 'number'
    ? (() => { const s = new Date(); s.setDate(s.getDate() - days); return s.toISOString().split('T')[0] })()
    : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`
  const untilStr = new Date().toISOString().split('T')[0]

  // Fetch adset-level insights (includes campaign info)
  const params = new URLSearchParams({
    access_token: ACCESS_TOKEN,
    level: 'adset',
    fields: 'campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,actions,cost_per_action_type,cpc,ctr',
    time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
    time_increment: 1, // daily breakdown
    limit: '500',
  })

  const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?${params}`
  const metaController = new AbortController()
  const metaTimeout = setTimeout(() => metaController.abort(), 20000)
  let res
  try {
    res = await fetch(url, { signal: metaController.signal })
  } catch (e) {
    clearTimeout(metaTimeout)
    throw new Error(`Meta Ads API request failed: ${e.message}`)
  }
  clearTimeout(metaTimeout)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Meta Ads API error: ${err.error?.message || res.status}`)
  }

  const json = await res.json()
  const rows = json.data || []

  let synced = 0
  let skipped = 0

  for (const row of rows) {
    // Extract lead count from actions array
    const leadAction = (row.actions || []).find(a => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead')
    const leads = leadAction ? parseInt(leadAction.value) : 0

    // Extract CPL from cost_per_action_type
    const cplAction = (row.cost_per_action_type || []).find(a => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead')
    const cpl = cplAction ? parseFloat(cplAction.value) * NZD_TO_USD : (leads > 0 ? (parseFloat(row.spend) * NZD_TO_USD) / leads : null)

    const record = {
      date: row.date_start,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      adset_id: row.adset_id,
      adset_name: row.adset_name,
      spend: parseFloat(row.spend || 0) * NZD_TO_USD,
      impressions: parseInt(row.impressions || 0),
      clicks: parseInt(row.clicks || 0),
      leads: leads,
      cpc: row.cpc ? parseFloat(row.cpc) * NZD_TO_USD : null,
      cpl: cpl,
      ctr: row.ctr ? parseFloat(row.ctr) : null,
    }

    // Upsert on unique constraint (date, campaign_id, adset_id)
    const { error } = await supabase
      .from('marketing_daily')
      .upsert(record, { onConflict: 'date,campaign_id,adset_id' })

    if (error) {
      console.error('Meta ads upsert error:', error)
      skipped++
    } else {
      synced++
    }
  }

  // Handle pagination if there are more results
  let nextUrl = json.paging?.next
  let pageNum = 2
  while (nextUrl) {
    const nextCtrl = new AbortController()
    const nextTimeout = setTimeout(() => nextCtrl.abort(), 20000)
    let nextRes
    try {
      nextRes = await fetch(nextUrl, { signal: nextCtrl.signal })
    } catch (e) {
      clearTimeout(nextTimeout)
      throw new Error(`Meta Ads API page ${pageNum} request failed: ${e.message}`)
    }
    clearTimeout(nextTimeout)
    if (!nextRes.ok) {
      const errBody = await nextRes.json().catch(() => ({}))
      throw new Error(`Meta Ads API page ${pageNum} returned ${nextRes.status}: ${errBody.error?.message || nextRes.statusText}`)
    }
    pageNum++
    const nextJson = await nextRes.json()
    const nextRows = nextJson.data || []

    for (const row of nextRows) {
      const leadAction = (row.actions || []).find(a => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead')
      const leads = leadAction ? parseInt(leadAction.value) : 0
      const cplAction = (row.cost_per_action_type || []).find(a => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead')
      const cpl = cplAction ? parseFloat(cplAction.value) * NZD_TO_USD : (leads > 0 ? (parseFloat(row.spend) * NZD_TO_USD) / leads : null)

      const record = {
        date: row.date_start,
        campaign_id: row.campaign_id,
        campaign_name: row.campaign_name,
        adset_id: row.adset_id,
        adset_name: row.adset_name,
        spend: parseFloat(row.spend || 0) * NZD_TO_USD,
        impressions: parseInt(row.impressions || 0),
        clicks: parseInt(row.clicks || 0),
        leads: leads,
        cpc: row.cpc ? parseFloat(row.cpc) * NZD_TO_USD : null,
        cpl: cpl,
        ctr: row.ctr ? parseFloat(row.ctr) : null,
      }

      const { error } = await supabase
        .from('marketing_daily')
        .upsert(record, { onConflict: 'date,campaign_id,adset_id' })

      if (error) skipped++
      else synced++
    }

    nextUrl = nextJson.paging?.next
  }

  return { synced, skipped, total: synced + skipped }
}

import { BASE_URL as GHL_BASE, GHL_LOCATION_ID, ghlFetch } from './ghlClient'

// `GHL_API_KEY` is still referenced for the sanity check below; the actual
// Authorization header lives in the shared ghlClient module.
const GHL_API_KEY = import.meta.env.VITE_GHL_API_KEY

// SCIO PIPELINE (USA) — opportunities here are the real leads
const SCIO_PIPELINE_ID = 'ZN1DW9S9qS540PNAXSxa'

// Calendar ID lists (intro + strategy) live in src/utils/constants.js so the
// sync code in ghlCalendar.js can scan them too. Imported above.

/**
 * Pull leads from GHL pipeline opportunities (SCIO USA).
 * Returns { 'YYYY-MM-DD': count } by opportunity createdAt date.
 */
async function fetchGHLLeadsByDate(sinceStr) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    throw new Error('GHL credentials missing — set VITE_GHL_API_KEY and VITE_GHL_LOCATION_ID in Render env vars')
  }

  let allOpps = []
  let startAfterId = null, startAfter = null
  // GHL caps /opportunities/search at limit=100 per page — 500 returns 400.
  // Outer cap of 50 pages = 5000 opps, more than enough for SCIO pipeline.
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({
      location_id: GHL_LOCATION_ID,
      pipeline_id: SCIO_PIPELINE_ID,
      limit: '100',
    })
    if (startAfterId) {
      params.set('startAfterId', startAfterId)
      params.set('startAfter', String(startAfter))
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    let res
    try {
      res = await ghlFetch(
        `${GHL_BASE}/opportunities/search?${params}`,
        { signal: controller.signal }
      )
    } catch (e) {
      clearTimeout(timeout)
      throw new Error(`GHL pipeline fetch failed on page ${page + 1}: ${e.message}`)
    }
    clearTimeout(timeout)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GHL pipeline ${res.status} ${res.statusText} on page ${page + 1}${body ? ': ' + body.slice(0, 200) : ''}`)
    }
    const json = await res.json()
    const opps = json.opportunities || []
    allOpps = allOpps.concat(opps)
    if (!json.meta?.startAfterId || opps.length === 0) break
    startAfterId = json.meta.startAfterId
    startAfter = json.meta.startAfter
  }

  const byDate = {}
  for (const o of allOpps) {
    const d = (o.createdAt || '').split('T')[0]
    if (d && d >= sinceStr) byDate[d] = (byDate[d] || 0) + 1
  }
  console.log(`[fetchGHLLeadsByDate] Fetched ${allOpps.length} opportunities; bucketed ${Object.keys(byDate).length} distinct dates with leads since ${sinceStr}.`)

  // Mirror every opportunity into public.ghl_opportunities so the dashboard
  // can join bookings→leads via ghl_contact_id and bucket bookings by the
  // lead's createdAt. Without this mirror the Marketing dashboard's L→Q%
  // was forced to compare DIFFERENT cohorts (leads bucketed by lead-create
  // vs bookings bucketed by booked_at) which produced impossible numbers
  // like 8 leads + 13 bookings in a 7d window. With this mirror, the
  // marketing page re-buckets bookings to their lead's createdAt so the
  // ratio is a true conversion rate.
  if (allOpps.length) {
    const records = []
    for (const o of allOpps) {
      if (!o.id || !o.contactId || !o.createdAt) continue
      records.push({
        id: o.id,
        ghl_contact_id: o.contactId,
        pipeline_id: o.pipelineId || null,
        stage_id: o.pipelineStageId || null,
        name: o.name || null,
        status: o.status || null,
        source: o.source || null,
        created_at: o.createdAt,
        updated_at: o.updatedAt || null,
        last_synced_at: new Date().toISOString(),
      })
    }
    // Chunk to avoid hitting payload limits on large pipelines.
    const CHUNK = 500
    let upserted = 0
    for (let i = 0; i < records.length; i += CHUNK) {
      const slice = records.slice(i, i + CHUNK)
      const { error } = await supabase
        .from('ghl_opportunities')
        .upsert(slice, { onConflict: 'id' })
      if (error) {
        // Don't fail the whole sync — mirror is a non-critical enhancement.
        // The leads count returned to the caller is still correct.
        console.warn(`[fetchGHLLeadsByDate] mirror upsert chunk ${i}-${i + slice.length} failed:`, error.message)
      } else {
        upserted += slice.length
      }
    }
    console.log(`[fetchGHLLeadsByDate] mirrored ${upserted}/${records.length} opportunities to ghl_opportunities`)
  }
  return byDate
}

/**
 * Aggregate marketing data and upsert into marketing_tracker.
 * Pulls: adspend from Meta Ads, leads from GHL pipeline,
 * auto_bookings from Intro Call calendars, qualified_bookings from Strategy Call calendars.
 */
export async function syncMetaToTracker(days = 30, { pullFresh = true } = {}) {
  // Step 1: pull fresh Meta Ads data
  if (pullFresh) {
    if (!ACCOUNT_ID || !ACCESS_TOKEN) {
      throw new Error('Meta Ads credentials missing — set VITE_META_ADS_ACCOUNT_ID and VITE_META_ADS_ACCESS_TOKEN in Render env vars')
    }
    await syncMetaAds(days)
  }

  const trackerSince = typeof days === 'number'
    ? (() => { const s = new Date(); s.setDate(s.getDate() - days); return s.toISOString().split('T')[0] })()
    : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`

  // Marketing tracker rows should only exist for dates that have already happened.
  // A strategy call scheduled for next week shouldn't create a future-dated row
  // in marketing_tracker — the dashboard then shows future dates with 0 spend
  // but non-zero Q.BOOK, which pollutes the trailing-period rates.
  const trackerUntil = new Date().toISOString().split('T')[0]

  // Step 2: aggregate adspend from marketing_daily
  const { data: dailyRows, error: dailyErr } = await supabase
    .from('marketing_daily')
    .select('date, spend')
    .gte('date', trackerSince)
  if (dailyErr) throw new Error(`marketing_daily read failed: ${dailyErr.message}`)

  const byDate = {}
  for (const r of (dailyRows || [])) {
    if (!byDate[r.date]) byDate[r.date] = { adspend: 0 }
    byDate[r.date].adspend += parseFloat(r.spend || 0)
  }

  // Step 3: pull leads from GHL pipeline (more accurate than Meta)
  const leadsByDate = await fetchGHLLeadsByDate(trackerSince)

  // Step 4: pull auto_bookings from Intro Call calendars.
  // Fall back to appointment_date when booked_at is NULL — historical rows
  // synced before migration 022 don't have booked_at populated, so filtering
  // strictly on booked_at returns zero. Union filter covers both sides.
  const { data: introAppts, error: introErr } = await supabase
    .from('ghl_appointments')
    .select('booked_at, appointment_date, calendar_name, ghl_contact_id')
    .or(`booked_at.gte.${trackerSince},appointment_date.gte.${trackerSince}`)
    .neq('appointment_status', 'cancelled')
    .in('calendar_name', INTRO_CALL_CALENDARS)
  if (introErr) throw new Error(`ghl_appointments (intro) read failed: ${introErr.message}`)

  const autoBookingsByDate = {}
  for (const a of (introAppts || [])) {
    // Prefer booked_at (actual booking timestamp — aligns with ad-spend day).
    // Fall back to appointment_date for legacy rows missing booked_at.
    const raw = a.booked_at || a.appointment_date
    if (!raw) continue
    const d = String(raw).split(' ')[0].split('T')[0]
    if (d < trackerSince || d > trackerUntil) continue
    autoBookingsByDate[d] = (autoBookingsByDate[d] || 0) + 1
  }
  console.log(`[syncMetaToTracker] Auto bookings: ${introAppts?.length || 0} intro appointments, ${Object.keys(autoBookingsByDate).length} dates with bookings.`)

  // Step 5: pull qualified_bookings from Strategy Call calendars.
  //
  // Bucket by booked_at (when the lead actually booked the strategy call) so
  // qualified_bookings aligns with `leads` (which is bucketed by opportunity
  // createdAt). Without this, leads vs bookings can flip in trailing windows
  // — a 7d window contains all the new leads from the last 7d but ALSO the
  // bookings of leads that came in WEEKS ago, so bookings can outrun leads.
  // Bucketing both by their funnel-entry date makes lead_to_booking_pct sane.
  //
  // Show-rate math (live_calls / qualified_bookings) becomes approximate at
  // the daily level — a booking made Apr 28 for a call held May 4 lives on
  // different rows. Over any trailing window of >5 days the per-row drift
  // averages out. Show rates are also capped at 100% in useMarketingTracker.js
  // as a safety net for the leftover daily mismatch.
  //
  // We also still pull the appointment_date column (used to clip out future-
  // dated rows: a call scheduled for next week shouldn't drag the row totals
  // until the call actually happens).
  const { data: stratAppts, error: stratErr } = await supabase
    .from('ghl_appointments')
    .select('booked_at, appointment_date, calendar_name, ghl_contact_id')
    .or(`booked_at.gte.${trackerSince},appointment_date.gte.${trackerSince}`)
    .neq('appointment_status', 'cancelled')
    .in('calendar_name', STRATEGY_CALL_CALENDARS)
  if (stratErr) throw new Error(`ghl_appointments (strategy) read failed: ${stratErr.message}`)

  const qualBookingsByDate = {}
  for (const a of (stratAppts || [])) {
    // Prefer booked_at; fall back to appointment_date for legacy rows that
    // were synced before booked_at was populated. (As of migration 022 +
    // backfill, ~all strategy rows have booked_at.)
    const raw = a.booked_at || a.appointment_date
    if (!raw) continue
    const d = String(raw).split(' ')[0].split('T')[0]
    if (d < trackerSince || d > trackerUntil) continue
    qualBookingsByDate[d] = (qualBookingsByDate[d] || 0) + 1
  }
  console.log(`[syncMetaToTracker] Qualified bookings: ${stratAppts?.length || 0} strategy appointments, ${Object.keys(qualBookingsByDate).length} dates with bookings.`)

  // Merge all dates
  const allDates = new Set([
    ...Object.keys(byDate),
    ...Object.keys(leadsByDate),
    ...Object.keys(autoBookingsByDate),
    ...Object.keys(qualBookingsByDate),
  ])

  // Step 6: fetch existing rows to merge (preserve closes, cash, etc.)
  const allDatesList = [...allDates]
  const { data: existingRows } = allDatesList.length > 0
    ? await supabase.from('marketing_tracker').select('*').in('date', allDatesList)
    : { data: [] }
  const existingMap = {}
  for (const row of (existingRows || [])) existingMap[row.date] = row

  // Step 7: upsert each date — ONLY update adspend, leads, auto_bookings
  // qualified_bookings only set if no existing value (CSV/manual data takes priority)
  let upserted = 0
  for (const date of allDates) {
    const existing = existingMap[date]

    if (existing) {
      // Row exists — only PATCH the auto-sync fields, never touch manually-entered data.
      // Use `!= null` (presence check) instead of truthy check so $0 / 0-leads / 0-bookings
      // days still overwrite stale values and don't get silently skipped.
      const patch = { updated_at: new Date().toISOString() }
      if (byDate[date]?.adspend != null) patch.adspend = byDate[date].adspend
      if (leadsByDate[date] != null) patch.leads = leadsByDate[date]
      if (autoBookingsByDate[date] != null) patch.auto_bookings = autoBookingsByDate[date]
      // GHL strategy calendar is the source of truth for qualified_bookings —
      // always overwrite so stale counts get corrected when new bookings land.
      if (qualBookingsByDate[date] != null) patch.qualified_bookings = qualBookingsByDate[date]

      const { error } = await supabase
        .from('marketing_tracker')
        .update(patch)
        .eq('date', date)
      if (error) console.error('Tracker update error for', date, error)
      else upserted++
    } else {
      // New row — insert with all available data
      const record = {
        date,
        adspend: byDate[date]?.adspend || 0,
        leads: leadsByDate[date] || 0,
        auto_bookings: autoBookingsByDate[date] || 0,
        qualified_bookings: qualBookingsByDate[date] || 0,
        updated_at: new Date().toISOString(),
      }
      const { error } = await supabase
        .from('marketing_tracker')
        .insert(record)
      if (error) {
        // May already exist from race condition — try patch instead
        if (error.code === '23505') {
          await supabase.from('marketing_tracker').update({ adspend: record.adspend, leads: record.leads, updated_at: record.updated_at }).eq('date', date)
        } else {
          console.error('Tracker insert error for', date, error)
        }
      }
      upserted++
    }
  }

  return { days: upserted, message: `Synced ${upserted} days (spend, leads, bookings)` }
}

// ─── Ad-level (per-creative) sync ──────────────────────────────────────────
//
// READ-ONLY consumer of the Meta Graph API. Every request below uses GET; this
// codebase never mutates Meta state. The two endpoints we hit are:
//   1. /act_{ACCOUNT_ID}/insights at level=ad — daily per-ad stats
//   2. /{ad_id}?fields=creative{...} — creative metadata (image / video / copy)
// Output goes to Supabase tables `ads` and `ad_daily_stats` (see migration 011).

// `video_3_sec_watched_actions` was removed by Meta — derive 3-sec views from
// the `actions` array (action_type='video_view') instead. Thruplay + avg-time
// fields remain valid as standalone fields.
const META_FIELDS_INSIGHTS = [
  'ad_id', 'ad_name', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name',
  'spend', 'impressions', 'reach', 'frequency',
  'clicks', 'unique_clicks', 'ctr', 'cpc', 'cpm',
  'actions', 'cost_per_action_type',
  'video_thruplay_watched_actions',
  'video_avg_time_watched_actions',
].join(',')

const META_FIELDS_CREATIVE = [
  'name', 'status', 'effective_status', 'creative_id',
  'creative{id,image_url,video_id,thumbnail_url,body,title,object_type,call_to_action_type,object_story_spec}',
].join(',')

function detectAssetType(creative) {
  if (!creative) return 'unknown'
  if (creative.video_id || creative.object_type === 'VIDEO') return 'video'
  if (creative.image_url) return 'image'
  if (creative.object_type === 'SHARE' && creative.object_story_spec?.link_data?.child_attachments) return 'carousel'
  return 'unknown'
}

function extractCreativeMeta(creative, raw) {
  if (!creative) return {}
  const linkData = creative.object_story_spec?.link_data
  const videoData = creative.object_story_spec?.video_data
  const headline = creative.title || linkData?.name || videoData?.title || null
  const primary_text = creative.body || linkData?.message || videoData?.message || null
  const description = linkData?.description || creative.object_story_spec?.link_data?.description || null
  const cta_type = creative.call_to_action_type || linkData?.call_to_action?.type || videoData?.call_to_action?.type || null
  const destination_url = linkData?.link || videoData?.call_to_action?.value?.link || null
  return { headline, primary_text, description, cta_type, destination_url }
}

/**
 * Fetch per-ad daily insights from Meta and upsert into `ad_daily_stats`.
 * Also collects the unique ad IDs seen so the caller can fetch creatives.
 *
 * @param {number} days - lookback window
 * @returns {Promise<{ rowsUpserted: number, adIds: Set<string>, errors: number }>}
 */
async function fetchAdLevelInsights(days = 90) {
  if (!ACCOUNT_ID || !ACCESS_TOKEN) {
    throw new Error('Meta Ads credentials missing — set VITE_META_ADS_ACCOUNT_ID and VITE_META_ADS_ACCESS_TOKEN')
  }
  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceStr = since.toISOString().split('T')[0]
  const untilStr = new Date().toISOString().split('T')[0]

  const params = new URLSearchParams({
    access_token: ACCESS_TOKEN,
    level: 'ad',
    fields: META_FIELDS_INSIGHTS,
    time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
    time_increment: '1',
    limit: '500',
  })

  const adIds = new Set()
  let rowsUpserted = 0
  let errors = 0
  let pageNum = 0
  const startedAt = Date.now()
  let url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?${params}`

  console.log(`[meta-sync] insights: ${days}d window, paginating...`)

  while (url) {
    pageNum++
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    let res
    try {
      res = await fetch(url, { signal: controller.signal })
    } catch (e) {
      clearTimeout(timeout)
      throw new Error(`Meta ad-level insights fetch failed: ${e.message}`)
    }
    clearTimeout(timeout)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Meta ad-level insights ${res.status}: ${err.error?.message || res.statusText}`)
    }
    const json = await res.json()
    const rows = json.data || []

    // Build the page's batch — one upsert call per Meta page (~500 rows max)
    // instead of one round-trip per row. Cuts 90d × 369ads from ~30min to ~30s.
    const batch = []
    for (const row of rows) {
      if (!row.ad_id) continue
      adIds.add(row.ad_id)

      const v3sAction     = (row.actions || []).find(a => a.action_type === 'video_view')
      const thruAction    = (row.video_thruplay_watched_actions || []).find(a => a.action_type === 'video_view')
      const avgTimeAction = (row.video_avg_time_watched_actions || []).find(a => a.action_type === 'video_view')
      const resultAction  = (row.actions || []).find(a => ['lead','offsite_conversion.fb_pixel_lead','onsite_conversion.lead_grouped'].includes(a.action_type))
      const costPerResult = (row.cost_per_action_type || []).find(a => ['lead','offsite_conversion.fb_pixel_lead','onsite_conversion.lead_grouped'].includes(a.action_type))

      batch.push({
        ad_id: row.ad_id,
        date: row.date_start,
        // The OPT ad account bills in NZD. Convert at sync time so the
        // dashboard never has to know about the currency mismatch — every
        // spend / cpc / cpm value in ad_daily_stats is USD.
        spend: parseFloat(row.spend || 0) * NZD_TO_USD,
        impressions: parseInt(row.impressions || 0),
        reach: parseInt(row.reach || 0),
        frequency: parseFloat(row.frequency || 0),
        clicks: parseInt(row.clicks || 0),
        unique_clicks: parseInt(row.unique_clicks || 0),
        ctr: row.ctr != null ? parseFloat(row.ctr) : null,
        cpc: row.cpc != null ? parseFloat(row.cpc) * NZD_TO_USD : null,
        cpm: row.cpm != null ? parseFloat(row.cpm) * NZD_TO_USD : null,
        video_3s_views: v3sAction ? parseInt(v3sAction.value) : 0,
        video_thruplays: thruAction ? parseInt(thruAction.value) : 0,
        video_avg_time_watched: avgTimeAction ? parseFloat(avgTimeAction.value) : null,
        results: resultAction ? parseInt(resultAction.value) : 0,
        cost_per_result: costPerResult ? parseFloat(costPerResult.value) * NZD_TO_USD : null,
        raw_payload: row,
        synced_at: new Date().toISOString(),
      })
    }

    if (batch.length) {
      const { error } = await supabase
        .from('ad_daily_stats')
        .upsert(batch, { onConflict: 'ad_id,date' })
      if (error) {
        console.error('[ad_daily_stats] batch upsert failed (page', pageNum, '):', error)
        errors += batch.length
      } else {
        rowsUpserted += batch.length
      }
    }

    console.log(`[meta-sync] insights page ${pageNum}: ${batch.length} rows upserted (${rowsUpserted} total, ${adIds.size} unique ads, ${((Date.now() - startedAt) / 1000).toFixed(1)}s elapsed)`)

    url = json.paging?.next || null
  }

  console.log(`[meta-sync] insights done: ${rowsUpserted} rows, ${adIds.size} ads, ${errors} errors, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  return { rowsUpserted, adIds, errors }
}

/**
 * Fetch creative metadata for a list of ad IDs and upsert into `ads`.
 * Calls /{ad_id}?fields=... with read-only GETs.
 *
 * @param {Iterable<string>} adIds
 * @returns {Promise<{ adsUpserted: number, errors: number }>}
 */
async function fetchAdCreatives(adIds) {
  const ids = [...adIds]
  const total = ids.length
  if (!total) return { adsUpserted: 0, errors: 0 }

  console.log(`[meta-sync] fetching ${total} creatives in parallel (concurrency=8)...`)
  const startedAt = Date.now()

  // Fetch one ad's creative + transform to `ads` row.
  // No video-source secondary fetch — Meta restricts that field for unpublished
  // ad videos so it returned nothing useful while doubling network time.
  const fetchOne = async (ad_id) => {
    const params = new URLSearchParams({
      access_token: ACCESS_TOKEN,
      fields: META_FIELDS_CREATIVE,
    })
    const url = `${BASE_URL}/${ad_id}?${params}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)
    try {
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        console.error('[ad creative]', ad_id, res.status, err.error?.message || res.statusText)
        return { error: true }
      }
      const json = await res.json()
      const creative = json.creative || null
      const meta = extractCreativeMeta(creative, json)
      const asset_type = detectAssetType(creative)
      // Prefer the full-res `facebook.com/ads/image/?d=...` poster from
      // object_story_spec.video_data.image_url for videos. The legacy
      // creative.thumbnail_url is hard-capped at 64×64 via the `stp=...p64x64`
      // signed param, which can't be safely stripped without breaking the URL.
      const ossVideoImage = creative?.object_story_spec?.video_data?.image_url || null
      const thumbnail_url = ossVideoImage || creative?.image_url || creative?.thumbnail_url || null
      const asset_url = ossVideoImage || creative?.image_url || null
      const archived = ['DELETED', 'ARCHIVED'].includes(json.effective_status || json.status)

      return {
        record: {
          ad_id,
          platform: 'meta',
          ad_name: json.name || null,
          status: json.status || null,
          effective_status: json.effective_status || null,
          creative_id: creative?.id || json.creative_id || null,
          asset_type,
          asset_url,
          thumbnail_url,
          ...meta,
          raw_payload: json,
          last_synced_at: new Date().toISOString(),
          archived_at: archived ? new Date().toISOString() : null,
        }
      }
    } catch (e) {
      clearTimeout(timeout)
      console.error('[ad creative] fetch failed for', ad_id, e.message)
      return { error: true }
    }
  }

  // Run with bounded concurrency. 8 in flight = ~46 batches for 369 ads,
  // ~600ms per round-trip = ~30s total instead of ~3-6 min sequential.
  const concurrency = 8
  const records = []
  let errors = 0
  let done = 0
  for (let i = 0; i < ids.length; i += concurrency) {
    const slice = ids.slice(i, i + concurrency)
    const results = await Promise.all(slice.map(fetchOne))
    for (const r of results) {
      if (r.error) errors++
      else if (r.record) records.push(r.record)
    }
    done += slice.length
    if (done % 50 < concurrency || done === ids.length) {
      console.log(`[meta-sync] creatives: ${done}/${total} (${((Date.now() - startedAt) / 1000).toFixed(1)}s elapsed)`)
    }
  }

  // Single batch upsert into ads (Supabase handles thousands of rows fine)
  let adsUpserted = 0
  if (records.length) {
    console.log(`[meta-sync] upserting ${records.length} ads in one batch...`)
    const { error } = await supabase
      .from('ads')
      .upsert(records, { onConflict: 'ad_id' })
    if (error) {
      console.error('[ads] batch upsert failed:', error)
      errors += records.length
    } else {
      adsUpserted = records.length
    }
  }

  console.log(`[meta-sync] creative fetch done: ${adsUpserted} upserted, ${errors} errors, ${((Date.now() - startedAt) / 1000).toFixed(1)}s total`)
  return { adsUpserted, errors }
}

/**
 * Backfill campaign / adset names on `ads` from the latest insights row.
 * Insights endpoint returns campaign_id, campaign_name, adset_id, adset_name
 * that the creative endpoint does not — fold them in after both syncs run.
 */
async function backfillAdContext(adIds) {
  const ids = [...adIds]
  if (!ids.length) return { backfilled: 0 }
  const { data, error } = await supabase
    .from('ad_daily_stats')
    .select('ad_id, raw_payload')
    .in('ad_id', ids)
    .order('date', { ascending: false })
  if (error) {
    console.error('[ad context] backfill read failed:', error)
    return { backfilled: 0, error: error.message }
  }
  const seen = new Set()
  let backfilled = 0
  for (const row of data || []) {
    if (seen.has(row.ad_id)) continue
    seen.add(row.ad_id)
    const r = row.raw_payload || {}
    const patch = {
      campaign_id: r.campaign_id || null,
      campaign_name: r.campaign_name || null,
      adset_id: r.adset_id || null,
      adset_name: r.adset_name || null,
    }
    if (!patch.campaign_id && !patch.adset_id) continue
    const { error: upErr } = await supabase
      .from('ads')
      .update(patch)
      .eq('ad_id', row.ad_id)
    if (!upErr) backfilled++
  }
  return { backfilled }
}

/**
 * Fast status-only refresh. Pulls every ad on the account from
 * /act_{ACCOUNT_ID}/ads?fields=id,effective_status,status and updates
 * the `ads` table. Unlike syncMetaAdsAtAdLevel, this does NOT depend on
 * the ad having recent insights — so paused-with-zero-spend ads still
 * have their status refreshed. Cheap to call frequently (~1-2s total)
 * because creative metadata is skipped.
 *
 * READ-ONLY against Meta.
 */
export async function syncMetaAdStatuses() {
  if (!ACCOUNT_ID || !ACCESS_TOKEN) {
    throw new Error('Meta Ads credentials missing — set VITE_META_ADS_ACCOUNT_ID and VITE_META_ADS_ACCESS_TOKEN')
  }
  const startedAt = Date.now()
  // Default scope = everything except DELETED. Includes ACTIVE / PAUSED /
  // CAMPAIGN_PAUSED / ADSET_PAUSED / PREAPPROVED / PENDING_REVIEW /
  // DISAPPROVED / PENDING_BILLING_INFO / IN_PROCESS / WITH_ISSUES so a
  // single endpoint hit covers every visible ad in the account.
  const params = new URLSearchParams({
    access_token: ACCESS_TOKEN,
    fields: 'id,effective_status,status',
    limit: '500',
  })
  let url = `${BASE_URL}/act_${ACCOUNT_ID}/ads?${params}`
  const records = []
  let pages = 0
  while (url) {
    pages++
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)
    let res
    try { res = await fetch(url, { signal: controller.signal }) }
    catch (e) { clearTimeout(timeout); throw new Error(`Meta status sync page ${pages} failed: ${e.message}`) }
    clearTimeout(timeout)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Meta status sync ${res.status}: ${err.error?.message || res.statusText}`)
    }
    const json = await res.json()
    for (const ad of (json.data || [])) {
      if (!ad.id) continue
      records.push({
        ad_id: ad.id,
        status: ad.status || null,
        effective_status: ad.effective_status || null,
        last_synced_at: new Date().toISOString(),
      })
    }
    url = json.paging?.next || null
  }

  if (!records.length) {
    return { adsUpdated: 0, durationMs: Date.now() - startedAt, pages }
  }

  // Chunked UPDATE-only path so we don't accidentally create rows for ads
  // that don't yet exist in `ads` (which would NULL out ad_name, creative_id,
  // etc.). Upsert with onConflict:'ad_id' is unsafe here because the partial
  // record would clobber NOT NULL'd creative columns on insert.
  let updated = 0
  for (const r of records) {
    const { error, count } = await supabase
      .from('ads')
      .update({
        status: r.status,
        effective_status: r.effective_status,
        last_synced_at: r.last_synced_at,
      }, { count: 'exact' })
      .eq('ad_id', r.ad_id)
    if (!error && (count || 0) > 0) updated++
  }
  console.log(`[meta-sync] status-only: ${updated}/${records.length} ads updated in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${pages} pages)`)
  return { adsSeen: records.length, adsUpdated: updated, durationMs: Date.now() - startedAt, pages }
}

/**
 * Top-level: pull ad-level insights + creative metadata from Meta and persist.
 * READ-ONLY against Meta. No POST/PUT/PATCH/DELETE is ever sent.
 *
 * @param {number} days - lookback window for insights (default 90)
 * @param {{ creativeRefresh?: boolean }} opts - if creativeRefresh is true,
 *   fetch creative metadata for every ad seen in insights (slower). Default
 *   false fetches only ads not already in `ads` or last-synced > 7 days ago.
 */
export async function syncMetaAdsAtAdLevel(days = 90, { creativeRefresh = false } = {}) {
  const startedAt = Date.now()
  const insights = await fetchAdLevelInsights(days)

  // Decide which ad IDs need creative fetched
  const allIds = [...insights.adIds]
  let toFetch = allIds
  if (!creativeRefresh && allIds.length) {
    const { data: existing, error } = await supabase
      .from('ads')
      .select('ad_id, last_synced_at')
      .in('ad_id', allIds)
    if (error) {
      console.warn('[sync] ad lookup failed, refreshing all creatives:', error.message)
    } else {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
      const fresh = new Set(
        (existing || [])
          .filter(r => r.last_synced_at && new Date(r.last_synced_at).getTime() > sevenDaysAgo)
          .map(r => r.ad_id)
      )
      toFetch = allIds.filter(id => !fresh.has(id))
    }
  }

  const creatives = await fetchAdCreatives(toFetch)
  const ctx = await backfillAdContext(insights.adIds)

  // Refresh the library materialized views so newly-mirrored performance_daily
  // rows show up in component_performance / cohort_hook_body. RPC is throttled
  // in migration 013: skips if last refresh was < 60s ago, returns JSONB with
  // { refreshed, skipped, reason?, last_refresh_age_sec }.
  let viewRefresh = { ok: false, skipped: false, error: null, ageSec: null }
  try {
    const { data: rpcData, error: rpcErr } = await supabase.rpc('refresh_ad_library_views')
    if (rpcErr) {
      console.warn('[ad sync] materialized view refresh failed:', rpcErr.message)
      viewRefresh.error = rpcErr.message
    } else {
      // rpcData is the JSONB the function returns. Falls back gracefully if
      // the older VOID-returning version is still installed (rpcData is null).
      viewRefresh.ok = true
      viewRefresh.skipped = rpcData?.skipped === true
      viewRefresh.ageSec = rpcData?.last_refresh_age_sec ?? null
    }
  } catch (e) {
    console.warn('[ad sync] materialized view refresh exception:', e.message)
    viewRefresh.error = e.message
  }

  return {
    durationMs: Date.now() - startedAt,
    days,
    ads_seen: allIds.length,
    creatives_fetched: toFetch.length,
    daily_rows_upserted: insights.rowsUpserted,
    ads_upserted: creatives.adsUpserted,
    context_backfilled: ctx.backfilled,
    insights_errors: insights.errors,
    creative_errors: creatives.errors,
    view_refresh: viewRefresh,
  }
}
