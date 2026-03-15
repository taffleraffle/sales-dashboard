import { supabase } from '../lib/supabase'
import { apiProxy } from '../lib/apiProxy'

// NZD → USD conversion rate (Meta reports in account currency which is NZD)
const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')

/**
 * Fetch ad insights from Meta Ads API and store in Supabase marketing_daily.
 * Pulls campaign-level and adset-level data for the given number of days.
 */
export async function syncMetaAds(days = 30) {
  const sinceStr = typeof days === 'number'
    ? (() => { const s = new Date(); s.setDate(s.getDate() - days); return s.toISOString().split('T')[0] })()
    : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`
  const untilStr = new Date().toISOString().split('T')[0]

  const json = await apiProxy('meta', 'insights', { since: sinceStr, until: untilStr })
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

  return { synced, skipped, total: synced + skipped }
}

// GHL config — keys are server-side only, accessed via apiProxy

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
  let allOpps = []
  try {
    const json = await apiProxy('ghl', 'opportunities', { pipelineId: SCIO_PIPELINE_ID, limit: '100' })
    allOpps = json.opportunities || []
  } catch {
    return {}
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
  if (pullFresh) {
    try { await syncMetaAds(days) } catch (err) { console.error('Meta sync skipped:', err.message) }
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

  // Step 6: upsert each date into marketing_tracker
  let upserted = 0
  for (const date of allDates) {
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
      .upsert(record, { onConflict: 'date', ignoreDuplicates: false })
    if (error) {
      console.error('Tracker upsert error for', date, error)
    } else {
      upserted++
    }
  }

  return { days: upserted, message: `Synced ${upserted} days (spend, leads, bookings)` }
}
