import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function useEngagementCadences() {
  const [cadences, setCadences] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    const { data, error } = await supabase
      .from('engagement_cadences')
      .select('*')
      .order('created_at')
    if (error) console.error('engagement_cadences:', error)
    // Fixed order: speed_to_lead first, then call_confirmation, then re_engage
    const order = { speed_to_lead: 0, call_confirmation: 1, re_engage: 2 }
    const sorted = (data || []).sort((a, b) => (order[a.name] ?? 9) - (order[b.name] ?? 9))
    setCadences(sorted)
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  const update = async (cadenceId, updates) => {
    const { error } = await supabase
      .from('engagement_cadences')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', cadenceId)
    if (!error) await fetch()
    return !error
  }

  return { cadences, loading, update, refresh: fetch }
}
