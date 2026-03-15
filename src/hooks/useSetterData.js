import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { sinceDate } from '../lib/dateUtils'

export function useSetterEODs(setterId, days = 30) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      let query = supabase
        .from('setter_eod_reports')
        .select('*, setter:team_members(name)')
        .gte('report_date', sinceDate(days))
        .order('report_date', { ascending: false })

      if (setterId) query = query.eq('setter_id', setterId)

      const { data, error } = await query
      if (error) console.error('Failed to fetch setter EODs:', error)
      setReports(data || [])
      setLoading(false)
    }
    fetch()
  }, [setterId, days])

  return { reports, loading }
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
