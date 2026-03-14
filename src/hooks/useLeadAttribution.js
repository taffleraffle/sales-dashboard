import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function useLeadAttribution(days = 30) {
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchLeads = useCallback(async () => {
    setLoading(true)
    const since = new Date()
    since.setDate(since.getDate() - days)

    const { data, error } = await supabase
      .from('setter_leads')
      .select('*, setter:team_members!setter_leads_setter_id_fkey(name), closer:team_members!setter_leads_closer_id_fkey(name)')
      .gte('date_set', since.toISOString().split('T')[0])
      .order('date_set', { ascending: false })

    if (error) console.error('Failed to fetch leads:', error)
    setLeads((data || []).map(l => ({
      ...l,
      setter_name: l.setter?.name || '—',
      closer_name: l.closer?.name || '—',
    })))
    setLoading(false)
  }, [days])

  useEffect(() => { fetchLeads() }, [fetchLeads])

  const updateStatus = async (leadId, newStatus) => {
    const { error } = await supabase
      .from('setter_leads')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', leadId)

    if (error) {
      console.error('Failed to update lead status:', error)
      return false
    }
    // Refresh
    await fetchLeads()
    return true
  }

  const updateRevenue = async (leadId, revenue) => {
    const { error } = await supabase
      .from('setter_leads')
      .update({ revenue_attributed: revenue, updated_at: new Date().toISOString() })
      .eq('id', leadId)

    if (error) {
      console.error('Failed to update revenue:', error)
      return false
    }
    await fetchLeads()
    return true
  }

  return { leads, loading, updateStatus, updateRevenue, refresh: fetchLeads }
}
