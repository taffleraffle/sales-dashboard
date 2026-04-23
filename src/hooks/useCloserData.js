import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { sinceDate } from '../lib/dateUtils'

// Module-level cache keyed by (closerId, days). 3-min TTL — closer_eod_reports
// updates throughout the day as closers submit, so we keep it fresher than
// team_members (5min). Mirrors useTeamMembers: return cached instantly,
// kick a background refresh.
const eodCache = new Map()
const EOD_TTL_MS = 3 * 60 * 1000

function eodKey(closerId, days) {
  return `${closerId || 'all'}:${days}`
}

export function useCloserEODs(closerId, days = 30) {
  const key = eodKey(closerId, days)
  const cached = eodCache.get(key)
  const hasFresh = cached && (Date.now() - cached.ts) < EOD_TTL_MS

  const [reports, setReports] = useState(cached?.reports || [])
  const [loading, setLoading] = useState(!hasFresh)

  useEffect(() => {
    let active = true
    async function go() {
      let query = supabase
        .from('closer_eod_reports')
        .select('*, closer:team_members(name)')
        .gte('report_date', sinceDate(days))
        .order('report_date', { ascending: false })

      if (closerId) query = query.eq('closer_id', closerId)

      const { data, error } = await query
      if (!active) return
      if (error) console.error('Failed to fetch closer EODs:', error)
      const next = data || []
      eodCache.set(key, { reports: next, ts: Date.now() })
      setReports(next)
      setLoading(false)
    }

    if (hasFresh) {
      setLoading(false)
      go().catch(() => {})
    } else {
      setLoading(true)
      go()
    }
    return () => { active = false }
  }, [closerId, days, key, hasFresh])

  return { reports, loading }
}

/** Invalidate the closer-EOD cache — call after a successful EOD submit/edit. */
export function clearCloserEODCache() {
  eodCache.clear()
}

/**
 * Populate the module-level EOD cache from Layout's pre-warm effect so the
 * first page to mount (SalesOverview / CloserOverview / EODDashboard / etc.)
 * gets instant data from `useCloserEODs` instead of waiting on Supabase.
 *
 * Safe to call repeatedly — short-circuits if a fresh entry already exists.
 */
export async function prewarmCloserEODs(closerId = null, days = 30) {
  const key = eodKey(closerId, days)
  const cached = eodCache.get(key)
  if (cached && (Date.now() - cached.ts) < EOD_TTL_MS) return
  let query = supabase
    .from('closer_eod_reports')
    .select('*, closer:team_members(name)')
    .gte('report_date', sinceDate(days))
    .order('report_date', { ascending: false })
  if (closerId) query = query.eq('closer_id', closerId)
  const { data, error } = await query
  if (error) return
  eodCache.set(key, { reports: data || [], ts: Date.now() })
}

/**
 * Aggregate close breakdown by call type from closer_calls rows.
 * Returns per-closer splits: new_call closes vs follow_up closes.
 * Used for the "close rate = closes on new calls / live new calls" formula,
 * and "net close rate = all closes / live new calls".
 */
export function useCloserCallBreakdown(closerId, days = 30) {
  const [breakdown, setBreakdown] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      setLoading(true)
      // Fetch reports in range, then their calls
      let reportQ = supabase
        .from('closer_eod_reports')
        .select('id, closer_id')
        .gte('report_date', sinceDate(days))
      if (closerId) reportQ = reportQ.eq('closer_id', closerId)
      const { data: reports } = await reportQ

      const reportIds = (reports || []).map(r => r.id)
      const reportToCloser = {}
      for (const r of (reports || [])) reportToCloser[r.id] = r.closer_id

      if (reportIds.length === 0) {
        setBreakdown({})
        setLoading(false)
        return
      }

      const { data: calls } = await supabase
        .from('closer_calls')
        .select('eod_report_id, call_type, outcome')
        .in('eod_report_id', reportIds)

      // Aggregate per closer
      // IMPORTANT: 'ascended' outcome means an existing client was upgraded —
      // it should count as LIVE (they showed) but NOT as a new close (no double-counting).
      // Pure ascension-type calls (call_type = 'ascension') are upgrades to existing
      // clients and should NOT count toward the new-call close rate at all.
      const byCloser = {}
      for (const c of (calls || [])) {
        const cid = reportToCloser[c.eod_report_id]
        if (!cid) continue
        if (!byCloser[cid]) byCloser[cid] = { ncCloses: 0, fuCloses: 0, ncLive: 0, fuLive: 0, allCloses: 0 }
        const b = byCloser[cid]
        const isNew = c.call_type === 'new_call'
        const isFu = c.call_type === 'follow_up'
        // Live = they showed up (closed, not_closed, or ascended existing client)
        const isLive = ['closed', 'not_closed', 'ascended'].includes(c.outcome)
        // Close = fresh close only (ascensions are upgrades, not new closes)
        const isClose = c.outcome === 'closed'
        if (isNew && isClose) b.ncCloses++
        if (isFu && isClose) b.fuCloses++
        if (isNew && isLive) b.ncLive++
        if (isFu && isLive) b.fuLive++
        if (isClose) b.allCloses++
      }

      setBreakdown(byCloser)
      setLoading(false)
    }
    fetch()
  }, [closerId, days])

  return { breakdown, loading }
}

export function useCloserTranscripts(closerId) {
  const [transcripts, setTranscripts] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      let query = supabase
        .from('closer_transcripts')
        .select('*')
        .order('meeting_date', { ascending: false })
        .limit(20)

      if (closerId) query = query.eq('closer_id', closerId)

      const { data, error } = await query
      if (error) console.error('Failed to fetch transcripts:', error)
      setTranscripts(data || [])
      setLoading(false)
    }
    fetch()
  }, [closerId])

  return { transcripts, loading }
}

export function useObjectionAnalysis(closerId, days = 30) {
  const [objections, setObjections] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      setLoading(true)
      let query = supabase
        .from('objection_analysis')
        .select('*')
        .gte('period_start', sinceDate(days))
        .order('occurrence_count', { ascending: false })

      if (closerId) query = query.eq('closer_id', closerId)

      const { data, error } = await query
      if (error) console.error('Failed to fetch objections:', error)
      setObjections(data || [])
      setLoading(false)
    }
    fetch()
  }, [closerId, days])

  return { objections, loading }
}

export function useCloserStats(closerId, days = 30) {
  const { reports } = useCloserEODs(closerId, days)

  const totals = reports.reduce(
    (acc, r) => ({
      ncBooked: acc.ncBooked + (r.nc_booked || 0),
      fuBooked: acc.fuBooked + (r.fu_booked || 0),
      noShows: acc.noShows + (r.nc_no_shows || 0) + (r.fu_no_shows || 0),
      liveCalls: acc.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
      liveNC: acc.liveNC + (r.live_nc_calls || 0),
      offers: acc.offers + (r.offers || 0),
      closes: acc.closes + (r.closes || 0),
      revenue: acc.revenue + parseFloat(r.total_revenue || 0),
      cash: acc.cash + parseFloat(r.total_cash_collected || 0),
      ascensions: acc.ascensions + (r.deposits || 0),
      ascendCash: acc.ascendCash + parseFloat(r.ascend_cash || 0),
      ascendRevenue: acc.ascendRevenue + parseFloat(r.ascend_revenue || 0),
      reschedules: acc.reschedules + (r.reschedules || 0),
    }),
    { ncBooked: 0, fuBooked: 0, noShows: 0, liveCalls: 0, liveNC: 0, offers: 0, closes: 0, revenue: 0, cash: 0, ascensions: 0, ascendCash: 0, ascendRevenue: 0, reschedules: 0 }
  )

  const totalBooked = totals.ncBooked + totals.fuBooked
  return {
    ...totals,
    totalBooked,
    // Show rate: new-call only (live_nc / nc_booked). Follow-ups excluded —
    // they aren't qualified strategy-call bookings.
    showRate: totals.ncBooked ? ((totals.liveNC / totals.ncBooked) * 100).toFixed(1) : 0,
    offerRate: totals.liveCalls ? ((totals.offers / totals.liveCalls) * 100).toFixed(1) : 0,
    closeRate: totals.liveCalls ? ((totals.closes / totals.liveCalls) * 100).toFixed(1) : 0,
    rescheduleRate: totalBooked ? ((totals.reschedules / totalBooked) * 100).toFixed(1) : 0,
  }
}
