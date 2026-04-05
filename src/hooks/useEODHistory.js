import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useEODHistory(from, to) {
  const [closerEODs, setCloserEODs] = useState([])
  const [setterEODs, setSetterEODs] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [{ data: cEODs }, { data: sEODs }] = await Promise.all([
        supabase
          .from('closer_eod_reports')
          .select('*, closer:team_members(name)')
          .gte('report_date', from)
          .lte('report_date', to)
          .order('report_date', { ascending: false }),
        supabase
          .from('setter_eod_reports')
          .select('*, setter:team_members(name)')
          .gte('report_date', from)
          .lte('report_date', to)
          .order('report_date', { ascending: false }),
      ])
      setCloserEODs(cEODs || [])
      setSetterEODs(sEODs || [])
      setLoading(false)
    }
    load()
  }, [from, to])

  return { closerEODs, setterEODs, loading }
}
