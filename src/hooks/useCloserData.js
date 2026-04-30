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
 * Per-closer call breakdown from closer_calls rows.
 *
 * Close rate is computed at the PROSPECT level, not the call level: count
 * each unique prospect_name once regardless of how many follow-ups they had.
 * "10 calls + 10 follow-ups, 5 closed" should read 50%, not 25% — multiple
 * follow-ups on the same prospect collapse to 1 in both numerator and
 * denominator. Closing on a follow-up still counts as a close.
 *
 * Returned per-closer fields:
 *   - liveProspects:   unique prospect_name with at least one NC/FU call
 *                      where outcome ∈ {closed, not_closed} (denominator)
 *   - closedProspects: unique prospect_name with at least one NC/FU call
 *                      where outcome = closed                (numerator)
 *   - ncBooked / fuBooked-style call-row counters are kept for any caller
 *     that still wants the old per-row splits, but consumers should prefer
 *     liveProspects / closedProspects for close-rate math.
 *
 * Ascension-type calls (call_type = 'ascension') are existing-client
 * upgrades, not new closes, and are excluded from both sides — same as
 * before.
 */
export function useCloserCallBreakdown(closerId, days = 30) {
  const [breakdown, setBreakdown] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      setLoading(true)
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
        .select('eod_report_id, call_type, outcome, prospect_name')
        .in('eod_report_id', reportIds)

      const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ')

      // Build Sets of prospect names per closer. Sets handle the dedup —
      // adding the same name twice is a no-op, so multiple FUs on one
      // prospect collapse naturally.
      const sets = {}  // closerId -> { live: Set, closed: Set }
      const counts = {} // closerId -> call-row counters (kept for any legacy reader)
      for (const c of (calls || [])) {
        const cid = reportToCloser[c.eod_report_id]
        if (!cid) continue
        if (!sets[cid]) sets[cid] = { live: new Set(), closed: new Set() }
        if (!counts[cid]) counts[cid] = { ncCloses: 0, fuCloses: 0, ncLive: 0, fuLive: 0, allCloses: 0 }
        const isNew = c.call_type === 'new_call'
        const isFu  = c.call_type === 'follow_up'
        const isCloseEligible = isNew || isFu
        // For close-rate, "live" excludes ascensions. Ascended-client calls
        // are upgrades, not closing opportunities, so they don't contribute
        // to either numerator or denominator.
        const isLiveForClose = isCloseEligible && ['closed', 'not_closed'].includes(c.outcome)
        const isClose = isCloseEligible && c.outcome === 'closed'
        const name = norm(c.prospect_name)
        if (name && isLiveForClose) sets[cid].live.add(name)
        if (name && isClose)        sets[cid].closed.add(name)

        // Legacy call-row counters (unused by the close-rate UI, kept so
        // any other reader doesn't break)
        const k = counts[cid]
        const isLiveLegacy = ['closed', 'not_closed', 'ascended'].includes(c.outcome)
        if (isNew && c.outcome === 'closed') k.ncCloses++
        if (isFu  && c.outcome === 'closed') k.fuCloses++
        if (isNew && isLiveLegacy) k.ncLive++
        if (isFu  && isLiveLegacy) k.fuLive++
        if (c.outcome === 'closed') k.allCloses++
      }

      const byCloser = {}
      for (const cid of Object.keys(sets)) {
        byCloser[cid] = {
          ...counts[cid],
          liveProspects: sets[cid].live.size,
          closedProspects: sets[cid].closed.size,
        }
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
    // closeRate here is an APPROXIMATION from EOD-level aggregates (numerator =
    // all closes, denominator = live NC only). Prefer useCloserCallBreakdown's
    // ncCloses / ncLive when you need the strictly-NC close rate (CloserOverview
    // and CloserDetail use that instead). Kept for back-compat with any caller
    // reading stats.closeRate; do not use this for performance dashboards.
    closeRate: totals.liveNC ? ((totals.closes / totals.liveNC) * 100).toFixed(1) : 0,
    rescheduleRate: totalBooked ? ((totals.reschedules / totalBooked) * 100).toFixed(1) : 0,
  }
}
