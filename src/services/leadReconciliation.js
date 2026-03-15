import { supabase } from '../lib/supabase'

/**
 * Fetch all leads that need reconciliation — combines:
 * 1. setter_leads with status 'set' or 'booked' where appointment_date has passed
 * 2. GHL appointments without an outcome where appointment_date has passed
 *
 * Also returns recently reconciled leads for context.
 */
export async function fetchUnreconciledLeads(days = 30) {
  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceStr = since.toISOString().split('T')[0]
  const todayStr = new Date().toISOString().split('T')[0]

  // Get all team members for name lookups
  const { data: members } = await supabase.from('team_members').select('id, name, role')
  const memberMap = {}
  for (const m of (members || [])) memberMap[m.id] = m.name

  // 1. Setter leads that are unresolved (appointment date passed, no outcome yet)
  const { data: staleLeads } = await supabase
    .from('setter_leads')
    .select('id, setter_id, closer_id, lead_name, lead_source, date_set, appointment_date, status, revenue_attributed, notes')
    .in('status', ['set', 'booked'])
    .lte('appointment_date', todayStr)
    .gte('appointment_date', sinceStr)
    .order('appointment_date', { ascending: false })

  // 2. GHL appointments without outcome
  const { data: unresolvedAppts } = await supabase
    .from('ghl_appointments')
    .select('ghl_event_id, closer_id, contact_name, contact_phone, contact_email, appointment_date, start_time, calendar_name, appointment_status, outcome, ghl_contact_id')
    .gte('appointment_date', sinceStr)
    .lte('appointment_date', todayStr)
    .neq('appointment_status', 'cancelled')
    .is('outcome', null)
    .order('appointment_date', { ascending: false })

  // 3. Recently reconciled leads (for the resolved count)
  const { count: resolvedCount } = await supabase
    .from('setter_leads')
    .select('id', { count: 'exact', head: true })
    .in('status', ['showed', 'not_closed', 'closed', 'no_show', 'cancelled'])
    .gte('appointment_date', sinceStr)

  const { count: resolvedApptsCount } = await supabase
    .from('ghl_appointments')
    .select('ghl_event_id', { count: 'exact', head: true })
    .gte('appointment_date', sinceStr)
    .lte('appointment_date', todayStr)
    .neq('appointment_status', 'cancelled')
    .not('outcome', 'is', null)

  // Build unreconciled list — merge setter_leads + unmatched GHL appointments
  const unreconciled = []

  // Add setter_leads first (these are the primary attribution records)
  const usedNames = new Set()
  for (const lead of (staleLeads || [])) {
    const daysSince = Math.floor((Date.now() - new Date(lead.appointment_date).getTime()) / 86400000)
    usedNames.add(lead.lead_name?.toLowerCase().trim())
    unreconciled.push({
      id: lead.id,
      type: 'setter_lead',
      name: lead.lead_name,
      setter: memberMap[lead.setter_id] || '—',
      closer: memberMap[lead.closer_id] || 'Unassigned',
      closer_id: lead.closer_id,
      source: lead.lead_source || '—',
      date_set: lead.date_set,
      appointment_date: lead.appointment_date,
      days_overdue: daysSince,
      urgency: daysSince >= 3 ? 'critical' : daysSince >= 1 ? 'warning' : 'info',
      current_status: lead.status,
      revenue: lead.revenue_attributed,
      notes: lead.notes,
    })
  }

  // Add GHL appointments that don't already appear as setter_leads
  for (const appt of (unresolvedAppts || [])) {
    const nameKey = appt.contact_name?.toLowerCase().trim()
    if (nameKey && usedNames.has(nameKey)) continue // already covered by setter_lead
    const daysSince = Math.floor((Date.now() - new Date(appt.appointment_date).getTime()) / 86400000)
    unreconciled.push({
      id: appt.ghl_event_id,
      type: 'ghl_appointment',
      name: appt.contact_name,
      setter: '—',
      closer: memberMap[appt.closer_id] || 'Unassigned',
      closer_id: appt.closer_id,
      source: appt.calendar_name || '—',
      date_set: null,
      appointment_date: appt.appointment_date,
      days_overdue: daysSince,
      urgency: daysSince >= 3 ? 'critical' : daysSince >= 1 ? 'warning' : 'info',
      current_status: 'no outcome',
      revenue: 0,
      notes: '',
      phone: appt.contact_phone,
      email: appt.contact_email,
    })
  }

  unreconciled.sort((a, b) => b.days_overdue - a.days_overdue)

  const totalPast = unreconciled.length + (resolvedCount || 0) + (resolvedApptsCount || 0)

  return {
    unreconciled,
    reconciled_count: (resolvedCount || 0) + (resolvedApptsCount || 0),
    total: totalPast,
    reconciliation_rate: totalPast > 0
      ? parseFloat((((resolvedCount || 0) + (resolvedApptsCount || 0)) / totalPast * 100).toFixed(1))
      : 100,
  }
}

/**
 * Reconcile a lead — update its outcome, call type, cash collected, and revenue.
 */
export async function reconcileLead(lead, data) {
  const { outcome, call_type, cash_collected, revenue, notes } = data

  if (lead.type === 'setter_lead') {
    const { error } = await supabase
      .from('setter_leads')
      .update({
        status: outcome,
        revenue_attributed: revenue || 0,
        notes: [lead.notes, notes].filter(Boolean).join(' | '),
        updated_at: new Date().toISOString(),
      })
      .eq('id', lead.id)
    if (error) throw error
  }

  if (lead.type === 'ghl_appointment') {
    const { error } = await supabase
      .from('ghl_appointments')
      .update({
        outcome,
        revenue: revenue || 0,
        cash_collected: cash_collected || 0,
        notes: notes || '',
        updated_at: new Date().toISOString(),
      })
      .eq('ghl_event_id', lead.id)
    if (error) throw error
  }

  return { success: true }
}
