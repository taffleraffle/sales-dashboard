import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { INTRO_CALENDARS } from '../utils/constants'

export function useMarketingTracker({ autoSync = false } = {}) {
  const [entries, setEntries] = useState([])
  const [benchmarks, setBenchmarks] = useState({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    try {
      const [trackerRes, bmRes] = await Promise.all([
        supabase.from('marketing_tracker').select('*').order('date', { ascending: false }),
        supabase.from('marketing_benchmarks').select('*'),
      ])
      if (trackerRes.error) console.error('Tracker load error:', trackerRes.error)
      if (bmRes.error) console.error('Benchmarks load error:', bmRes.error)
      setEntries(trackerRes.data || [])
      const map = {}
      ;(bmRes.data || []).forEach(b => { map[b.metric] = parseFloat(b.value) })
      setBenchmarks(map)
    } catch (err) {
      console.error('Marketing tracker load failed:', err)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    // Just load data — no auto-sync on page load
    // Sync only happens when user clicks "Sync Data" button
    load()
  }, [load])

  async function upsertEntry(entry) {
    const { error } = await supabase
      .from('marketing_tracker')
      .upsert({ ...entry, updated_at: new Date().toISOString() }, { onConflict: 'date' })
    if (error) throw error

    // Reverse-sync closer-related fields to closer_eod_reports
    // so the closer detail page reflects marketing dashboard edits
    const closerKeys = ['offers', 'closes', 'trial_cash', 'trial_revenue', 'live_calls', 'reschedules']
    const hasCloserData = closerKeys.some(k => entry[k] != null && entry[k] !== '')
    if (hasCloserData && entry.date) {
      const { data: closers } = await supabase
        .from('team_members')
        .select('id')
        .eq('role', 'closer')
        .eq('is_active', true)
      if (closers?.length === 1) {
        const patch = {
          closer_id: closers[0].id,
          report_date: entry.date,
          is_confirmed: true,
          updated_at: new Date().toISOString(),
        }
        if (entry.offers != null) patch.offers = parseInt(entry.offers) || 0
        if (entry.closes != null) patch.closes = parseInt(entry.closes) || 0
        if (entry.trial_cash != null) patch.total_cash_collected = parseFloat(entry.trial_cash) || 0
        if (entry.trial_revenue != null) patch.total_revenue = parseFloat(entry.trial_revenue) || 0
        if (entry.live_calls != null) patch.live_nc_calls = parseInt(entry.live_calls) || 0
        if (entry.reschedules != null) patch.reschedules = parseInt(entry.reschedules) || 0
        await supabase
          .from('closer_eod_reports')
          .upsert(patch, { onConflict: 'closer_id,report_date' })
      }
    }

    await load()
  }

  async function upsertMany(rows) {
    const records = rows.map(r => ({ ...r, updated_at: new Date().toISOString() }))
    const { error } = await supabase
      .from('marketing_tracker')
      .upsert(records, { onConflict: 'date' })
    if (error) throw error
    await load()
    return records.length
  }

  async function updateBenchmark(metric, value) {
    const { error } = await supabase
      .from('marketing_benchmarks')
      .upsert({ metric, value, updated_at: new Date().toISOString() }, { onConflict: 'metric' })
    if (error) throw error
    setBenchmarks(prev => ({ ...prev, [metric]: parseFloat(value) }))
  }

  async function deleteEntry(date) {
    const { error } = await supabase
      .from('marketing_tracker')
      .delete()
      .eq('date', date)
    if (error) throw error
    await load()
  }

  return { entries, benchmarks, loading, syncing, upsertEntry, upsertMany, updateBenchmark, deleteEntry, reload: load }
}

/**
 * Auto-pull closer EOD data for a given date range.
 * Returns { byDate: { '2026-03-14': { live_nc, live_fu, offers, closes } } }
 */
export async function fetchCloserEODTotals(sinceDate) {
  const { data } = await supabase
    .from('closer_eod_reports')
    .select('report_date, nc_booked, fu_booked, nc_no_shows, fu_no_shows, live_nc_calls, live_fu_calls, offers, closes, reschedules')
    .gte('report_date', sinceDate)
    .order('report_date', { ascending: false })

  const byDate = {}
  for (const r of (data || [])) {
    const d = r.report_date
    if (!byDate[d]) byDate[d] = { nc_booked: 0, fu_booked: 0, nc_no_shows: 0, fu_no_shows: 0, live_nc: 0, live_fu: 0, offers: 0, closes: 0, reschedules: 0 }
    byDate[d].nc_booked += r.nc_booked || 0
    byDate[d].fu_booked += r.fu_booked || 0
    byDate[d].nc_no_shows += r.nc_no_shows || 0
    byDate[d].fu_no_shows += r.fu_no_shows || 0
    byDate[d].live_nc += r.live_nc_calls || 0
    byDate[d].live_fu += r.live_fu_calls || 0
    byDate[d].offers += r.offers || 0
    byDate[d].closes += r.closes || 0
    byDate[d].reschedules += r.reschedules || 0
  }
  return byDate
}

/**
 * Sync all closer EOD reports into marketing_tracker.
 * Aggregates by date, fetches existing rows to merge (preserving adspend/leads/etc),
 * then upserts the EOD fields.
 */
export async function syncEODToTracker() {
  const { data: eods } = await supabase
    .from('closer_eod_reports')
    .select('id, report_date, offers, closes, total_cash_collected, total_revenue, deposits, live_nc_calls, live_fu_calls, nc_booked, fu_booked, nc_no_shows, fu_no_shows, reschedules')
    .eq('is_confirmed', true)

  if (!eods?.length) return 0

  // Aggregate EOD reports by date
  const byDate = {}
  const reportIdsByDate = {}
  for (const r of eods) {
    const d = r.report_date
    if (!byDate[d]) byDate[d] = { offers: 0, closes: 0, trial_cash: 0, trial_revenue: 0, ascensions: 0, live_calls: 0, booked: 0, no_shows: 0, reschedules: 0 }
    if (!reportIdsByDate[d]) reportIdsByDate[d] = []
    reportIdsByDate[d].push(r.id)
    byDate[d].offers += r.offers || 0
    byDate[d].closes += r.closes || 0
    byDate[d].trial_cash += parseFloat(r.total_cash_collected || 0)
    byDate[d].trial_revenue += parseFloat(r.total_revenue || 0)
    byDate[d].ascensions += r.deposits || 0
    byDate[d].live_calls += (r.live_nc_calls || 0) + (r.live_fu_calls || 0)
    byDate[d].booked += (r.nc_booked || 0) + (r.fu_booked || 0)
    byDate[d].no_shows += (r.nc_no_shows || 0) + (r.fu_no_shows || 0)
    byDate[d].reschedules += r.reschedules || 0
  }

  // Fetch all calls for ascension + finance splits
  const allReportIds = eods.map(r => r.id)
  const { data: allCalls } = await supabase
    .from('closer_calls')
    .select('eod_report_id, call_type, revenue, cash_collected, offered_finance, outcome')
    .in('eod_report_id', allReportIds)

  // Aggregate ascension + finance data by date
  const callAggByDate = {}
  for (const c of (allCalls || [])) {
    const date = Object.entries(reportIdsByDate).find(([, ids]) => ids.includes(c.eod_report_id))?.[0]
    if (!date) continue
    if (!callAggByDate[date]) callAggByDate[date] = { ascCash: 0, ascRevenue: 0, financeOffers: 0, financeAccepted: 0 }
    if (c.call_type === 'ascension') {
      callAggByDate[date].ascCash += parseFloat(c.cash_collected || 0)
      callAggByDate[date].ascRevenue += parseFloat(c.revenue || 0)
    }
    if (c.call_type === 'ascension') {
      if (c.offered_finance) callAggByDate[date].financeOffers++
      if (c.offered_finance && (c.outcome === 'closed' || c.outcome === 'ascended')) callAggByDate[date].financeAccepted++
    }
  }

  // Count auto bookings from GHL intro calendars by booked_at date (not appointment_date)
  // booked_at = when the lead actually booked, which is the marketing-relevant date
  const { data: autoAppts } = await supabase
    .from('ghl_appointments')
    .select('booked_at, calendar_name')
    .in('calendar_name', INTRO_CALENDARS)
    .neq('appointment_status', 'cancelled')
    .not('booked_at', 'is', null)
  const autoByDate = {}
  for (const a of (autoAppts || [])) {
    const d = (a.booked_at || '').split(' ')[0] || (a.booked_at || '').split('T')[0]
    if (d) autoByDate[d] = (autoByDate[d] || 0) + 1
  }

  // Merge auto booking dates into the date set
  const dates = [...new Set([...Object.keys(byDate), ...Object.keys(autoByDate)])]
  // Fetch all existing tracker rows for these dates
  const { data: existingRows } = await supabase
    .from('marketing_tracker')
    .select('*')
    .in('date', dates)
  const existingMap = {}
  for (const row of (existingRows || [])) existingMap[row.date] = row

  // Update only EOD-sourced fields — never overwrite CSV/manually-entered data
  // Only update a field if: (a) there's no existing value, or (b) the existing value
  // came from a previous EOD sync (not a CSV import with different numbers)
  let synced = 0
  for (const date of dates) {
    const existing = existingMap[date]
    const eod = byDate[date]
    const callAgg = callAggByDate[date] || { ascCash: 0, ascRevenue: 0, financeOffers: 0, financeAccepted: 0 }

    // Build patch: set fields from EOD data (use != null to allow zero values)
    const patch = { updated_at: new Date().toISOString() }
    // Auto bookings from GHL intro calendars
    if (autoByDate[date] != null) patch.auto_bookings = autoByDate[date]
    if (eod?.offers != null) patch.offers = eod.offers
    if (eod?.closes != null) patch.closes = eod.closes
    if (eod?.trial_cash != null) patch.trial_cash = eod.trial_cash
    if (eod?.trial_revenue != null) patch.trial_revenue = eod.trial_revenue
    if (eod?.ascensions != null) patch.ascensions = eod.ascensions
    if (callAgg.ascCash != null) patch.ascend_cash = callAgg.ascCash
    if (callAgg.ascRevenue != null) patch.ascend_revenue = callAgg.ascRevenue
    if (callAgg.financeOffers != null) patch.finance_offers = callAgg.financeOffers
    if (callAgg.financeAccepted != null) patch.finance_accepted = callAgg.financeAccepted
    if (eod?.live_calls != null) patch.live_calls = eod.live_calls
    if (eod?.booked != null) patch.calls_on_calendar = eod.booked
    // EOD booked calls ARE the qualified bookings — always overwrite GHL calendar count
    if (eod?.booked != null) patch.qualified_bookings = eod.booked
    if (eod?.no_shows != null) patch.no_shows = eod.no_shows
    if (eod?.reschedules != null) patch.reschedules = eod.reschedules

    if (existing) {
      // Only update fields that are non-zero from EOD — don't overwrite existing CSV data with 0
      const { error } = await supabase
        .from('marketing_tracker')
        .update(patch)
        .eq('date', date)
      if (error) console.error('EOD sync update failed for', date, error)
      else synced++
    } else {
      // New row
      const { error } = await supabase
        .from('marketing_tracker')
        .insert({ date, ...patch })
      if (error && error.code !== '23505') console.error('EOD sync insert failed for', date, error)
      else synced++
    }
  }
  return synced
}

/** Compute all derived metrics from aggregated raw totals */
export function computeMarketingStats(entries) {
  const t = entries.reduce((a, r) => ({
    adspend: a.adspend + parseFloat(r.adspend || 0),
    leads: a.leads + (r.leads || 0),
    auto_bookings: a.auto_bookings + (r.auto_bookings || 0),
    qualified_bookings: a.qualified_bookings + (r.qualified_bookings || 0),
    calls_on_calendar: a.calls_on_calendar + (r.calls_on_calendar || (r.net_new_calls || 0) + (r.net_fu_calls || 0)),
    live_calls: a.live_calls + (r.live_calls || r.net_live_calls || 0),
    no_shows: a.no_shows + (r.no_shows || 0),
    offers: a.offers + (r.offers || 0),
    closes: a.closes + (r.closes || 0),
    trial_cash: a.trial_cash + parseFloat(r.trial_cash || 0),
    trial_revenue: a.trial_revenue + parseFloat(r.trial_revenue || 0),
    ascensions: a.ascensions + (r.ascensions || 0),
    ascend_cash: a.ascend_cash + parseFloat(r.ascend_cash || 0),
    ascend_revenue: a.ascend_revenue + parseFloat(r.ascend_revenue || 0),
    finance_offers: a.finance_offers + (r.finance_offers || 0),
    finance_accepted: a.finance_accepted + (r.finance_accepted || 0),
    monthly_offers: a.monthly_offers + (r.monthly_offers || 0),
    monthly_accepted: a.monthly_accepted + (r.monthly_accepted || 0),
    ar_collected: a.ar_collected + parseFloat(r.ar_collected || 0),
    ar_defaulted: a.ar_defaulted + parseFloat(r.ar_defaulted || 0),
    refund_count: a.refund_count + (r.refund_count || 0),
    refund_amount: a.refund_amount + parseFloat(r.refund_amount || 0),
    reschedules: a.reschedules + (r.reschedules || 0),
    cancelled_dtf: a.cancelled_dtf + (r.cancelled_dtf || 0),
    cancelled_by_prospect: a.cancelled_by_prospect + (r.cancelled_by_prospect || 0),
  }), {
    adspend: 0, leads: 0, auto_bookings: 0, qualified_bookings: 0,
    calls_on_calendar: 0, live_calls: 0, no_shows: 0, reschedules: 0,
    cancelled_dtf: 0, cancelled_by_prospect: 0,
    offers: 0, closes: 0, trial_cash: 0, trial_revenue: 0,
    ascensions: 0, ascend_cash: 0, ascend_revenue: 0,
    finance_offers: 0, finance_accepted: 0, monthly_offers: 0, monthly_accepted: 0,
    ar_collected: 0, ar_defaulted: 0, refund_count: 0, refund_amount: 0,
  })

  const all_cash = t.trial_cash + t.ascend_cash + t.ar_collected
  const all_revenue = t.trial_revenue + t.ascend_revenue

  return {
    ...t,

    // Cost metrics
    cpl: t.leads > 0 ? t.adspend / t.leads : 0,
    lead_to_booking_pct: t.leads > 0 ? (t.qualified_bookings / t.leads) * 100 : 0,
    cpb: t.qualified_bookings > 0 ? t.adspend / t.qualified_bookings : 0,
    cost_per_auto_booking: t.auto_bookings > 0 ? t.adspend / t.auto_bookings : 0,

    // Show rates
    // Gross = live / booked (raw — just no-shows)
    // Net = live / (booked - cancels - reschedules) (only people expected to show)
    cancels: t.cancelled_dtf + t.cancelled_by_prospect,
    gross_show_rate: t.qualified_bookings > 0 ? (t.live_calls / t.qualified_bookings) * 100 : 0,
    net_show_rate: (() => {
      const net = t.qualified_bookings - (t.cancelled_dtf + t.cancelled_by_prospect) - t.reschedules
      return net > 0 ? (t.live_calls / net) * 100 : 0
    })(),
    show_rate: t.qualified_bookings > 0 ? (t.live_calls / t.qualified_bookings) * 100 : 0,
    // Use actual no-shows from closer EOD when available; derive only as fallback
    no_shows: t.no_shows > 0 ? t.no_shows : Math.max(0, t.qualified_bookings - t.live_calls - (t.cancelled_dtf + t.cancelled_by_prospect) - t.reschedules),
    no_show_rate: (() => {
      const ns = t.no_shows > 0 ? t.no_shows : Math.max(0, t.qualified_bookings - t.live_calls - (t.cancelled_dtf + t.cancelled_by_prospect) - t.reschedules)
      return t.qualified_bookings > 0 ? (ns / t.qualified_bookings) * 100 : 0
    })(),
    reschedules: t.reschedules,
    reschedule_rate: t.qualified_bookings > 0 ? (t.reschedules / t.qualified_bookings) * 100 : 0,
    cost_per_live_call: t.live_calls > 0 ? t.adspend / t.live_calls : 0,

    // Offer & close
    offer_rate: t.live_calls > 0 ? (t.offers / t.live_calls) * 100 : 0,
    cost_per_offer: t.offers > 0 ? t.adspend / t.offers : 0,
    close_rate: t.live_calls > 0 ? (t.closes / t.live_calls) * 100 : 0,
    cpa_trial: t.closes > 0 ? t.adspend / t.closes : 0,

    // Trial financials
    trial_cash_pct: t.trial_revenue > 0 ? (t.trial_cash / t.trial_revenue) * 100 : 0,
    trial_fe_roas: t.adspend > 0 ? t.trial_cash / t.adspend : 0,

    // Ascension
    ascend_rate: t.closes > 0 ? (t.ascensions / t.closes) * 100 : 0,
    cpa_ascend: t.ascensions > 0 ? t.adspend / t.ascensions : 0,
    ascend_cash_pct: t.ascend_revenue > 0 ? (t.ascend_cash / t.ascend_revenue) * 100 : 0,
    finance_pct: t.ascensions > 0 ? (t.finance_accepted / t.ascensions) * 100 : 0,
    finance_offer_pct: t.finance_offers > 0 ? (t.finance_accepted / t.finance_offers) * 100 : 0,
    monthly_offer_pct: t.monthly_offers > 0 ? (t.monthly_accepted / t.monthly_offers) * 100 : 0,
    net_fe_roas: t.adspend > 0 ? (t.trial_cash + t.ascend_cash) / t.adspend : 0,
    revenue_roas: t.adspend > 0 ? all_revenue / t.adspend : 0,

    // AR
    ar_success_rate: (t.ar_collected + t.ar_defaulted) > 0 ? (t.ar_collected / (t.ar_collected + t.ar_defaulted)) * 100 : 0,

    // All cash
    all_cash,
    all_cash_roas: t.adspend > 0 ? all_cash / t.adspend : 0,
  }
}
