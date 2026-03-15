import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { sinceDate } from '../lib/dateUtils'

export function useCloserEODs(closerId, days = 30) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      let query = supabase
        .from('closer_eod_reports')
        .select('*, closer:team_members(name)')
        .gte('report_date', sinceDate(days))
        .order('report_date', { ascending: false })

      if (closerId) query = query.eq('closer_id', closerId)

      const { data, error } = await query
      if (error) console.error('Failed to fetch closer EODs:', error)
      setReports(data || [])
      setLoading(false)
    }
    fetch()
  }, [closerId, days])

  return { reports, loading }
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
      offers: acc.offers + (r.offers || 0),
      closes: acc.closes + (r.closes || 0),
      revenue: acc.revenue + parseFloat(r.total_revenue || 0),
      cash: acc.cash + parseFloat(r.total_cash_collected || 0),
      ascensions: acc.ascensions + (r.deposits || 0),
      ascendCash: acc.ascendCash + parseFloat(r.ascend_cash || 0),
      ascendRevenue: acc.ascendRevenue + parseFloat(r.ascend_revenue || 0),
      reschedules: acc.reschedules + (r.reschedules || 0),
    }),
    { ncBooked: 0, fuBooked: 0, noShows: 0, liveCalls: 0, offers: 0, closes: 0, revenue: 0, cash: 0, ascensions: 0, ascendCash: 0, ascendRevenue: 0, reschedules: 0 }
  )

  const totalBooked = totals.ncBooked + totals.fuBooked
  return {
    ...totals,
    totalBooked,
    showRate: totalBooked ? ((totals.liveCalls / totalBooked) * 100).toFixed(1) : 0,
    offerRate: totals.liveCalls ? ((totals.offers / totals.liveCalls) * 100).toFixed(1) : 0,
    closeRate: totals.liveCalls ? ((totals.closes / totals.liveCalls) * 100).toFixed(1) : 0,
    rescheduleRate: totalBooked ? ((totals.reschedules / totalBooked) * 100).toFixed(1) : 0,
  }
}
