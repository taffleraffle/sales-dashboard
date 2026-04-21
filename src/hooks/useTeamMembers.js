import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

// Module-level cache: team members rarely change, so every navigation between
// Sales / Closers / Setters / EOD / Commissions pages doesn't need to refetch.
// First page load: fetches and caches per-role. Subsequent loads: return cached
// list instantly + kick a background refresh to stay fresh.
const cache = new Map() // key: role || '__all' → { members, ts }
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 min — long enough to feel instant across a session

async function fetchMembers(role) {
  let query = supabase.from('team_members').select('*').eq('is_active', true)
  if (role) query = query.eq('role', role)
  const { data, error } = await query.order('name')
  if (error) console.error('Failed to fetch team members:', error)
  return data || []
}

export function useTeamMembers(role = null) {
  const key = role || '__all'
  const cached = cache.get(key)
  const hasFreshCache = cached && (Date.now() - cached.ts) < CACHE_TTL_MS

  const [members, setMembers] = useState(cached?.members || [])
  const [loading, setLoading] = useState(!hasFreshCache)

  useEffect(() => {
    let active = true
    async function go() {
      const data = await fetchMembers(role)
      if (!active) return
      cache.set(key, { members: data, ts: Date.now() })
      setMembers(data)
      setLoading(false)
    }
    // If we have fresh cached data, surface it instantly but still refresh
    // in the background for next render. Otherwise we're loading fresh.
    if (hasFreshCache) {
      setLoading(false)
      go().catch(() => {})
    } else {
      setLoading(true)
      go()
    }
    return () => { active = false }
  }, [role, key, hasFreshCache])

  return { members, loading }
}
