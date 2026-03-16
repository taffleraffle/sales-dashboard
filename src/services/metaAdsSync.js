import { supabase } from '../lib/supabase'

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
  const res = await fetch(url)
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

// GHL config
const GHL_API_KEY = import.meta.env.VITE_GHL_API_KEY
const GHL_LOCATION_ID = import.meta.env.VITE_GHL_LOCATION_ID
const GHL_HEADERS = { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' }

// SCIO PIPELINE (USA) — opportunities here are the real leads
const SCIO_PIPELINE_ID = 'ZN1DW9S9qS540PNAXSxa'

// Introductory Call calendars → auto bookings
const INTRO_CALL_CALENDARS = [
  '5omixNmtgmGMWQfEL0fs', // (FB) RestorationConnect AI - Introductory Call
  'C5NRRAjwsy43nOyU6izQ', // RestorationConnect AI - Introductory Call
  'GpYh75LaFEJgpHYkZfN9', // PlumberConnect AI - Introductory Call
  'okWMyvLhnJ7sbuvSIzok', // Remodeling AI - Introductory Call
  'MvYStrHFsRTpunwTXIqT', // Intro Call
]

// Strategy Call calendars → qualified bookings (deduped per contact)
const STRATEGY_CALL_CALENDARS = [
  '9yoQVPBkNX4tWYmcDkf3', // Remodeling AI - Strategy Call
  'cEyqCFAsPLDkUV8n982h', // RestorationConnect AI - Strategy Call
  'HDsTrgpsFOXw9V4AkZGq', // (FB) RestorationConnect AI - Strategy Call
  'aQsmGwANALCwJBI7G9vT', // PlumberConnect AI - Strategy Call
  'StLqrES6WMO8f3Obdu9d', // PoolConnect AI - Strategy Call
  '3mLE6t6rCKDdIuIfvP9j', // (FB) PoolConnectAI - Strategy Call
]

/**
 * Pull leads from GHL pipeline opportunities (SCIO USA).
 * Returns { 'YYYY-MM-DD': count } by opportunity createdAt date.
 */
async function fetchGHLLeadsByDate(sinceStr) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) return {}

  let allOpps = []
  let startAfterId = null, startAfter = null
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
    const res = await fetch(
      `https://services.leadconnectorhq.com/opportunities/search?${params}`,
      { headers: GHL_HEADERS }
    )
    if (!res.ok) break
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
  return byDate
}

/**
 * Aggregate marketing data and upsert into marketing_tracker.
 * Pulls: adspend from Meta Ads, leads from GHL pipeline,
 * auto_bookings from Intro Call calendars, qualified_bookings from Strategy Call calendars.
 */
export async function syncMetaToTracker(days = 30, { pullFresh = true } = {}) {
  // Step 1: pull fresh Meta Ads data
  if (pullFresh && ACCOUNT_ID && ACCESS_TOKEN) {
    await syncMetaAds(days)
  }

  const trackerSince = typeof days === 'number'
    ? (() => { const s = new Date(); s.setDate(s.getDate() - days); return s.toISOString().split('T')[0] })()
    : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`

  // Step 2: aggregate adspend from marketing_daily
  const { data: dailyRows } = await supabase
    .from('marketing_daily')
    .select('date, spend')
    .gte('date', trackerSince)

  const byDate = {}
  for (const r of (dailyRows || [])) {
    if (!byDate[r.date]) byDate[r.date] = { adspend: 0 }
    byDate[r.date].adspend += parseFloat(r.spend || 0)
  }

  // Step 3: pull leads from GHL pipeline (more accurate than Meta)
  const leadsByDate = await fetchGHLLeadsByDate(trackerSince)

  // Step 4: pull auto_bookings from Intro Call calendars (by booked_at)
  const { data: introAppts } = await supabase
    .from('ghl_appointments')
    .select('booked_at, calendar_name, ghl_contact_id')
    .gte('booked_at', `${trackerSince} 00:00:00`)
    .neq('appointment_status', 'cancelled')
    .in('calendar_name', INTRO_CALL_CALENDARS)

  const autoBookingsByDate = {}
  for (const a of (introAppts || [])) {
    if (!a.booked_at) continue
    const d = a.booked_at.split(' ')[0].split('T')[0]
    autoBookingsByDate[d] = (autoBookingsByDate[d] || 0) + 1
  }

  // Step 5: pull qualified_bookings from Strategy Call calendars
  // Counted by appointment_date (when the call is scheduled), deduped per contact
  // appointment_date is more accurate than booked_at because calls booked in Feb for Mar
  // should show on the day they actually happen
  const { data: stratAppts } = await supabase
    .from('ghl_appointments')
    .select('appointment_date, calendar_name, ghl_contact_id')
    .gte('appointment_date', trackerSince)
    .neq('appointment_status', 'cancelled')
    .in('calendar_name', STRATEGY_CALL_CALENDARS)
    .order('appointment_date', { ascending: true })

  const qualBookingsByDate = {}
  const seenContacts = new Set()
  for (const a of (stratAppts || [])) {
    if (!a.appointment_date || !a.ghl_contact_id) continue
    // Only count first strategy call per contact
    if (seenContacts.has(a.ghl_contact_id)) continue
    seenContacts.add(a.ghl_contact_id)
    qualBookingsByDate[a.appointment_date] = (qualBookingsByDate[a.appointment_date] || 0) + 1
  }

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

  // Step 7: upsert each date — merge with existing data, never wipe other fields
  let upserted = 0
  for (const date of allDates) {
    const existing = existingMap[date] || {}
    const record = {
      ...existing,
      date,
      adspend: byDate[date]?.adspend || existing.adspend || 0,
      leads: leadsByDate[date] || existing.leads || 0,
      auto_bookings: autoBookingsByDate[date] || existing.auto_bookings || 0,
      qualified_bookings: qualBookingsByDate[date] || existing.qualified_bookings || 0,
      updated_at: new Date().toISOString(),
    }
    const { error } = await supabase
      .from('marketing_tracker')
      .upsert(record, { onConflict: 'date', ignoreDuplicates: false })
    if (error) {
      console.error('Tracker upsert error for', date, error)
    } else {
      upserted++
    }
  }

  return { days: upserted, message: `Synced ${upserted} days (spend, leads, bookings)` }
}
