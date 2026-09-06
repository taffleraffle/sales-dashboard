import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { dateRangeBoundsET } from '../lib/dateUtils'

/*
  ONE source of truth for sales numbers (Ben, 6 Sep 2026: "all pages the
  same unified data").

  Company totals come from lib_marketing_by_audience_daily_mv, the same
  view the Marketing page is built on, summed over the ET date window:
    adspend   ad_daily_stats (Meta, NZD -> USD at VITE_NZD_TO_USD)
    leads     typeform_responses, minus lead_excluded
    bookings  strategy calendar, not DQ, not spam, not booking_excluded
    lives     closer_calls new calls with outcome closed / not_closed on a
              CONFIRMED EOD, minus closer_call_excluded
    offers    the count typed on each confirmed EOD header (the per-call flag
              is never set by the form)
    closes, cash, revenue   the resolved close rows
    no_shows, reschedules, cancels, fu_lives, ascensions

  Per-closer numbers come from the same closer_calls rows (confirmed, not
  excluded) grouped by the closer who filed them, so the per-closer table
  sums to the company total. Per-closer bookings come from the calendar
  too: strategy bookings joined to ghl_appointments.closer_id, falling back
  to the closer's new-call rows when the appointment has no closer.

  Nothing here reads the hand-typed EOD header fields (nc_booked, closes,
  total_cash_collected...) or marketing_tracker. That is deliberate: those
  are the two sources that made every page disagree.
*/

const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')
const PAGE = 1000
const cache = new Map()
const TTL = 2 * 60 * 1000

async function fetchAll(build) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

const LIVE = new Set(['closed', 'not_closed'])
const num = (v) => parseFloat(v || 0) || 0

export const EMPTY_TOTALS = {
  adspend: 0, leads: 0, qualifiedBookings: 0, lives: 0, fuLives: 0, closes: 0,
  trialCash: 0, trialRevenue: 0, ascendCash: 0, ascendRevenue: 0, ascensions: 0,
  noShows: 0, reschedules: 0, cancels: 0, offers: 0, ncRows: 0,
  confShowed: 0, confNoShow: 0, unconfShowed: 0, unconfNoShow: 0, confCalls: 0, unconfCalls: 0,
}

export function rates(t) {
  const cash = t.trialCash + t.ascendCash
  const revenue = t.trialRevenue + t.ascendRevenue
  const pct = (n, d) => d > 0 ? parseFloat(((n / d) * 100).toFixed(1)) : 0
  return {
    cash, revenue,
    showRate: pct(t.lives, t.qualifiedBookings || t.ncRows),
    closeRate: pct(t.closes, t.lives),                 // Ben's rule: closes / live new calls
    offerRate: pct(t.offers, t.lives + t.fuLives),
    offerCloseRate: pct(t.closes, t.offers),
    noShowRate: pct(t.noShows, t.qualifiedBookings || t.ncRows),
    rescheduleRate: pct(t.reschedules, t.qualifiedBookings || t.ncRows),
    cashCollectRate: pct(cash, revenue),
    // Confirmed vs unconfirmed show rate (booking_call_status marks x closer outcomes)
    confShowRate: (t.confShowed + t.confNoShow) > 0 ? pct(t.confShowed, t.confShowed + t.confNoShow) : null,
    unconfShowRate: (t.unconfShowed + t.unconfNoShow) > 0 ? pct(t.unconfShowed, t.unconfShowed + t.unconfNoShow) : null,
    // Share of marked calls that were confirmed before the call (same definition as the Marketing page)
    confirmedShare: (t.confCalls + t.unconfCalls) > 0 ? pct(t.confCalls, t.confCalls + t.unconfCalls) : null,
    cpl: t.leads > 0 && t.adspend > 0 ? t.adspend / t.leads : null,
    costPerBooked: t.qualifiedBookings > 0 && t.adspend > 0 ? t.adspend / t.qualifiedBookings : null,
    costPerLive: t.lives > 0 && t.adspend > 0 ? t.adspend / t.lives : null,
    cac: t.closes > 0 && t.adspend > 0 ? t.adspend / t.closes : null,
    feRoas: t.adspend > 0 ? t.trialCash / t.adspend : null,
    revenueRoas: t.adspend > 0 ? revenue / t.adspend : null,
    leadToClose: pct(t.closes, t.leads),
    leadToBooked: pct(t.qualifiedBookings, t.leads),
    bookedToLive: pct(t.lives, t.qualifiedBookings),
    revPerLead: t.leads > 0 ? revenue / t.leads : null,
    revPerBooked: t.qualifiedBookings > 0 ? revenue / t.qualifiedBookings : null,
    avgDeal: t.closes > 0 ? t.trialRevenue / t.closes : null,
  }
}

async function load(range) {
  const { startStr, endStr } = dateRangeBoundsET(range)

  // Each source loads independently: if one table is unreadable the rest of
  // the page still gets its numbers, and the failure is reported, not hidden.
  const problems = []
  const safe = (label, fn) => fn().catch(err => { problems.push(`${label}: ${err?.message || err}`); return [] })
  const [mvRows, reports, excluded, bookings, bookingExcluded, confRows] = await Promise.all([
    safe('marketing view', () => fetchAll(() => supabase.from('lib_marketing_by_audience_daily_mv').select('*').gte('date', startStr).lte('date', endStr).order('date'))),
    safe('EOD reports', () => fetchAll(() => supabase.from('closer_eod_reports').select('id, closer_id, report_date, is_confirmed, offers').gte('report_date', startStr).lte('report_date', endStr).order('report_date'))),
    safe('call exclusions', () => fetchAll(() => supabase.from('closer_call_excluded').select('closer_call_id').order('closer_call_id'))),
    safe('calendar bookings', () => fetchAll(() => supabase.from('lib_strategy_booking_resolved').select('id, ghl_event_id, ghl_contact_id, contact_name, contact_email, booked_at, appointment_date, appointment_status, audience, revenue_tier, is_dq, is_spam').gte('booked_at', startStr).lte('booked_at', endStr).order('booked_at'))),
    safe('booking exclusions', () => fetchAll(() => supabase.from('booking_excluded').select('booking_id').order('booking_id'))),
    safe('call confirmations', () => fetchAll(() => supabase.from('lib_call_confirmation_by_closer').select('closer_id, report_date, confirmed_calls, unconfirmed_calls, confirmed_showed, confirmed_noshow, unconfirmed_showed, unconfirmed_noshow').gte('report_date', startStr).lte('report_date', endStr).order('report_date'))),
  ])

  // ── Company totals from the matview ──
  const totals = { ...EMPTY_TOTALS }
  for (const r of mvRows) {
    totals.adspend += num(r.adspend) * NZD_TO_USD
    totals.leads += num(r.leads)
    totals.qualifiedBookings += num(r.qualified_bookings)
    totals.lives += num(r.live_calls)
    totals.fuLives += num(r.fu_lives)
    totals.closes += num(r.closes)
    totals.trialCash += num(r.trial_cash)
    totals.trialRevenue += num(r.trial_revenue)
    totals.ascendCash += num(r.ascend_cash)
    totals.ascendRevenue += num(r.ascend_revenue)
    totals.ascensions += num(r.ascensions_closed)
    totals.noShows += num(r.no_shows)
    totals.reschedules += num(r.reschedules)
    totals.cancels += num(r.cancels)
  }

  // ── Call rows on confirmed, non-excluded EOD reports ──
  const reportById = Object.fromEntries(reports.map(r => [r.id, r]))
  const confirmedIds = reports.filter(r => r.is_confirmed).map(r => r.id)
  const excludedIds = new Set(excluded.map(e => e.closer_call_id))
  let calls = []
  for (let i = 0; i < confirmedIds.length; i += 200) {
    const slice = confirmedIds.slice(i, i + 200)
    const rows = await safe('call rows', () => fetchAll(() => supabase.from('closer_calls')
      .select('id, eod_report_id, call_type, prospect_name, outcome, revenue, cash_collected, offered, offered_finance, notes, ghl_event_id, created_at')
      .in('eod_report_id', slice).order('created_at')))
    calls.push(...rows)
  }
  calls = calls.filter(c => !excludedIds.has(c.id)).map(c => ({
    ...c, closer_id: reportById[c.eod_report_id]?.closer_id, report_date: reportById[c.eod_report_id]?.report_date,
  }))
  // Offers: the per-call `offered` flag is never set by the EOD form, so the
  // only record is the count each closer types on the report header.
  const offersByCloser = {}
  for (const r of reports) if (r.is_confirmed) offersByCloser[r.closer_id] = (offersByCloser[r.closer_id] || 0) + num(r.offers)
  totals.offers = Object.values(offersByCloser).reduce((a, b) => a + b, 0)
  totals.ncRows = calls.filter(c => c.call_type === 'new_call').length

  // ── Per-closer calendar bookings (booking -> appointment -> closer) ──
  const bookingExcludedIds = new Set(bookingExcluded.map(b => b.booking_id))
  // Belt and braces: migration 172 marks test bookings as spam in the view; keep the name guard here too
  const goodBookings = bookings.filter(b => !b.is_dq && !b.is_spam && !bookingExcludedIds.has(b.id) && !/opt digital/i.test(b.contact_name || ''))
  const bookingsByCloser = {}
  const eventIds = goodBookings.map(b => b.ghl_event_id).filter(Boolean)
  for (let i = 0; i < eventIds.length; i += 200) {
    const slice = eventIds.slice(i, i + 200)
    const { data, error } = await supabase.from('ghl_appointments').select('ghl_event_id, closer_id').in('ghl_event_id', slice)
    if (error) { problems.push(`appointments: ${error.message}`); break }
    for (const a of (data || [])) if (a.closer_id) bookingsByCloser[a.closer_id] = (bookingsByCloser[a.closer_id] || 0) + 1
  }

  // ── Confirmed / unconfirmed show marks, company and per closer ──
  const confByCloser = {}
  for (const r of confRows) {
    totals.confShowed += num(r.confirmed_showed); totals.confNoShow += num(r.confirmed_noshow)
    totals.unconfShowed += num(r.unconfirmed_showed); totals.unconfNoShow += num(r.unconfirmed_noshow)
    totals.confCalls += num(r.confirmed_calls); totals.unconfCalls += num(r.unconfirmed_calls)
    const c = confByCloser[r.closer_id] || (confByCloser[r.closer_id] = { confShowed: 0, confNoShow: 0, unconfShowed: 0, unconfNoShow: 0 })
    c.confShowed += num(r.confirmed_showed); c.confNoShow += num(r.confirmed_noshow); c.unconfShowed += num(r.unconfirmed_showed); c.unconfNoShow += num(r.unconfirmed_noshow)
  }

  // ── Per-closer roll-up from the same rows ──
  const byCloser = {}
  for (const c of calls) {
    if (!c.closer_id) continue
    const t = byCloser[c.closer_id] || (byCloser[c.closer_id] = { ...EMPTY_TOTALS, calendarBookings: bookingsByCloser[c.closer_id] || 0 })
    const isNC = c.call_type === 'new_call', isFU = c.call_type === 'follow_up'
    if (isNC) t.ncRows++
    if (isNC && LIVE.has(c.outcome)) t.lives++
    if (isFU && LIVE.has(c.outcome)) t.fuLives++
    if (isNC && c.outcome === 'no_show') t.noShows++
    if (isNC && c.outcome === 'rescheduled') t.reschedules++
    if (isNC && ['canceled', 'cancelled'].includes(c.outcome)) t.cancels++
    if (c.outcome === 'closed') { t.closes++; t.trialCash += num(c.cash_collected); t.trialRevenue += num(c.revenue) }
    if (c.outcome === 'ascended') { t.ascensions++; t.ascendCash += num(c.cash_collected); t.ascendRevenue += num(c.revenue) }
  }
  for (const id of Object.keys(bookingsByCloser)) {
    if (!byCloser[id]) byCloser[id] = { ...EMPTY_TOTALS, calendarBookings: bookingsByCloser[id] }
  }
  for (const [id, n] of Object.entries(offersByCloser)) {
    if (!byCloser[id]) byCloser[id] = { ...EMPTY_TOTALS, calendarBookings: bookingsByCloser[id] || 0 }
    byCloser[id].offers = n
  }
  for (const [id, c] of Object.entries(confByCloser)) {
    if (!byCloser[id]) byCloser[id] = { ...EMPTY_TOTALS, calendarBookings: bookingsByCloser[id] || 0 }
    Object.assign(byCloser[id], c)
  }
  for (const t of Object.values(byCloser)) {
    // Booked = calendar when the appointment carries a closer, else the closer's own new-call rows
    t.qualifiedBookings = t.calendarBookings > 0 ? t.calendarBookings : t.ncRows
  }

  return { totals, byCloser, calls, bookings: goodBookings, window: { startStr, endStr }, mvRows, problems }
}

export function useSalesMetrics(range) {
  const key = typeof range === 'object' ? JSON.stringify(range) : String(range)
  const cached = cache.get(key)
  const fresh = cached && Date.now() - cached.ts < TTL
  const [data, setData] = useState(fresh ? cached.data : null)
  const [loading, setLoading] = useState(!fresh)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    const c = cache.get(key)
    if (c && Date.now() - c.ts < TTL) { setData(c.data); setLoading(false); return }
    setLoading(true); setError(null)
    load(range)
      .then(d => { cache.set(key, { data: d, ts: Date.now() }); if (alive) { setData(d); setError(d.problems.length ? d.problems.join(' · ') : null); setLoading(false) } })
      .catch(err => { console.warn('sales metrics failed:', err); if (alive) { setError(err?.message || 'failed'); setLoading(false) } })
    return () => { alive = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const totals = data?.totals || EMPTY_TOTALS
  return { loading, error, totals, r: rates(totals), byCloser: data?.byCloser || {}, calls: data?.calls || [], bookings: data?.bookings || [], window: data?.window }
}

export function invalidateSalesMetrics() { cache.clear() }
