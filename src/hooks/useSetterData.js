import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { sinceDate } from '../lib/dateUtils'

// Module-level cache keyed by (setterId, days). 3-min TTL mirrors the
// closer EOD cache. Nav between Overview / Setter Overview / EOD dashboards
// now returns cached data instantly and refreshes in the background.
const eodCache = new Map()
const EOD_TTL_MS = 3 * 60 * 1000

function eodKey(setterId, days) {
  return `${setterId || 'all'}:${days}`
}

export function useSetterEODs(setterId, days = 30) {
  const key = eodKey(setterId, days)
  const cached = eodCache.get(key)
  const hasFresh = cached && (Date.now() - cached.ts) < EOD_TTL_MS

  const [reports, setReports] = useState(cached?.reports || [])
  const [loading, setLoading] = useState(!hasFresh)

  useEffect(() => {
    let active = true
    async function go() {
      let query = supabase
        .from('setter_eod_reports')
        .select('*, setter:team_members(name)')
        .gte('report_date', sinceDate(days))
        .order('report_date', { ascending: false })

      if (setterId) query = query.eq('setter_id', setterId)

      const { data, error } = await query
      if (!active) return
      if (error) console.error('Failed to fetch setter EODs:', error)
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
  }, [setterId, days, key, hasFresh])

  return { reports, loading }
}

/** Invalidate the setter-EOD cache — call after a successful EOD submit/edit. */
export function clearSetterEODCache() {
  eodCache.clear()
}

export function useSetterStats(setterId, days = 30) {
  const { reports } = useSetterEODs(setterId, days)

  const totals = reports.reduce(
    (acc, r) => ({
      totalLeads: acc.totalLeads + (r.total_leads || 0),
      outboundCalls: acc.outboundCalls + (r.outbound_calls || 0),
      pickups: acc.pickups + (r.pickups || 0),
      mcs: acc.mcs + (r.meaningful_conversations || 0),
      sets: acc.sets + (r.sets || 0),
      reschedules: acc.reschedules + (r.reschedules || 0),
    }),
    { totalLeads: 0, outboundCalls: 0, pickups: 0, mcs: 0, sets: 0, reschedules: 0 }
  )

  return {
    ...totals,
    leadsToSetPct: totals.totalLeads ? ((totals.sets / totals.totalLeads) * 100).toFixed(1) : 0,
    callsToSetPct: totals.outboundCalls ? ((totals.sets / totals.outboundCalls) * 100).toFixed(1) : 0,
    pickupRate: totals.outboundCalls ? ((totals.pickups / totals.outboundCalls) * 100).toFixed(1) : 0,
    mcsToSetPct: totals.mcs ? ((totals.sets / totals.mcs) * 100).toFixed(1) : 0,
    dialsPerSet: totals.sets ? (totals.outboundCalls / totals.sets).toFixed(1) : 0,
  }
}
