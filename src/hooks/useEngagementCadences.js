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
    setCadences(data || [])
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
