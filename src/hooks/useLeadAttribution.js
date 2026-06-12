import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import {sinceDate, dateRangeBoundsET } from '../lib/dateUtils'

export function useLeadAttribution(range = 30) {
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const rangeKey = typeof range === 'object' ? JSON.stringify(range) : range

  const fetchLeads = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('setter_leads')
      // NB: do not add bare column names alongside * — a non-existent column
      // (the old ", contacted") 400s the whole query via PostgREST and this
      // page silently rendered zero leads.
      .select('*, setter:team_members!setter_leads_setter_id_fkey(name), closer:team_members!setter_leads_closer_id_fkey(name)')
      .gte('date_set', dateRangeBoundsET(range).startStr)
      .lte('date_set', dateRangeBoundsET(range).endStr)
      .order('date_set', { ascending: false })

    if (error) console.error('Failed to fetch leads:', error)
    setLeads((data || []).map(l => ({
      ...l,
      setter_name: l.setter?.name || '—',
      closer_name: l.closer?.name || '—',
    })))
    setLoading(false)
  }, [rangeKey])

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
