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
  while (nextUrl) {
    const nextRes = await fetch(nextUrl)
    if (!nextRes.ok) break
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
