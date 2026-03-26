import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Fetch transcripts with filters for the Call Data page.
 */
export function useCallData({ search = '', memberId = '', sinceDate = '', untilDate = '', outcome = '', limit = 50, offset = 0 } = {}) {
  const [transcripts, setTranscripts] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      let query = supabase
        .from('closer_transcripts')
        .select('*, member:team_members!closer_transcripts_closer_id_fkey(id, name, role)', { count: 'exact' })
        .order('meeting_date', { ascending: false })
        .range(offset, offset + limit - 1)

      if (memberId) query = query.eq('closer_id', memberId)
      if (sinceDate) query = query.gte('meeting_date', sinceDate)
      if (untilDate) query = query.lte('meeting_date', untilDate)
      if (outcome) query = query.eq('outcome', outcome)
      if (search) {
        query = query.or(`prospect_name.ilike.%${search}%,summary.ilike.%${search}%`)
      }

      const { data, count, error } = await query
      if (error) console.error('Call data fetch error:', error)
      setTranscripts(data || [])
      setTotal(count || 0)
    } catch (err) {
      console.error('Call data load failed:', err)
    }
    setLoading(false)
  }, [search, memberId, sinceDate, untilDate, outcome, limit, offset])

  useEffect(() => { load() }, [load])

  return { transcripts, total, loading, reload: load }
}

/**
 * Aggregate stats for the Call Data page header.
 * Respects the current date filter so stats update when you change the range.
 */
export function useCallStats(sinceDate = '') {
  const [stats, setStats] = useState({ totalCalls: 0, totalHours: 0, callsThisWeek: 0, memberCount: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const now = new Date()
      const weekAgo = new Date(now)
      weekAgo.setDate(weekAgo.getDate() - 7)
      const weekStr = weekAgo.toISOString().split('T')[0]

      let allQuery = supabase.from('closer_transcripts').select('duration_seconds, closer_id')
      if (sinceDate) allQuery = allQuery.gte('meeting_date', sinceDate)

      const [allRes, weekRes] = await Promise.all([
        allQuery,
        supabase.from('closer_transcripts').select('id').gte('meeting_date', weekStr),
      ])

      const all = allRes.data || []
      const totalSecs = all.reduce((s, r) => s + (r.duration_seconds || 0), 0)
      const uniqueMembers = new Set(all.filter(r => r.closer_id).map(r => r.closer_id))

      setStats({
        totalCalls: all.length,
        totalHours: Math.round(totalSecs / 3600 * 10) / 10,
        callsThisWeek: (weekRes.data || []).length,
        memberCount: uniqueMembers.size,
      })
      setLoading(false)
    }
    load()
  }, [sinceDate])

  return { stats, loading }
}
