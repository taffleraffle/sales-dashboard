import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useTeamMembers(role = null) {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      let query = supabase.from('team_members').select('*').eq('is_active', true)
      if (role) query = query.eq('role', role)
      const { data, error } = await query.order('name')
      if (error) console.error('Failed to fetch team members:', error)
      setMembers(data || [])
      setLoading(false)
    }
    fetch()
  }, [role])

  return { members, loading }
}
