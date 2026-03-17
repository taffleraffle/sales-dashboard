import { useState, useEffect, useRef } from 'react'
import { Check, Edit3, Loader, ChevronLeft, ChevronRight, ChevronDown, MessageSquare, Calendar, RefreshCw, Plus, Search, X, Zap, Lock } from 'lucide-react'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useEODSubmit } from '../hooks/useEOD'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchCloserCalendar, syncGHLAppointments } from '../services/ghlCalendar'

const closingOutcomes = [
  { value: 'no_show', label: 'No Show', color: 'text-danger' },
  { value: 'rescheduled', label: 'Rescheduled', color: 'text-blue-400' },
  { value: 'not_closed', label: 'Not Closed', color: 'text-text-400' },
  { value: 'closed', label: 'Closed', color: 'text-success' },
]

const ascensionOutcomes = [
  { value: 'not_ascended', label: "Didn't Ascend", color: 'text-text-400' },
  { value: 'ascended', label: 'Ascended', color: 'text-success' },
]

function getOutcomeOptions(callType) {
  if (callType === 'ascension') return ascensionOutcomes
  return closingOutcomes
}

import { todayET } from '../lib/dateUtils'

// Format a Date object as YYYY-MM-DD in local timezone (avoids UTC shift from toISOString)
const toLocalDateStr = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const formatDateLabel = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00')
  const today = new Date(todayET() + 'T12:00:00')
  const diff = Math.round((today - d) / 86400000)
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' })
  const month = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (diff === 0) return `Today — ${weekday}, ${month}`
  if (diff === 1) return `Yesterday — ${weekday}, ${month}`
  return `${weekday}, ${month}`
}

// Lead picker dropdown for manual entry
function LeadPicker({ onSelect, onClose }) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    if (search.length < 2) { setResults([]); return }
    const timer = setTimeout(async () => {
      setLoading(true)
      const ghlKey = import.meta.env.VITE_GHL_API_KEY
      const ghlLoc = import.meta.env.VITE_GHL_LOCATION_ID

      // Search all three sources in parallel
      const [leadsRes, ghlRes, ghlContactsRes] = await Promise.all([
        supabase
          .from('setter_leads')
          .select('id, lead_name, appointment_date, lead_source, setter:team_members!setter_leads_setter_id_fkey(name)')
          .ilike('lead_name', `%${search}%`)
          .order('appointment_date', { ascending: false })
          .limit(15),
        supabase
          .from('ghl_appointments')
          .select('id, ghl_event_id, contact_name, appointment_date, contact_email, contact_phone, calendar_name')
          .ilike('contact_name', `%${search}%`)
          .order('appointment_date', { ascending: false })
          .limit(15),
        // Always search GHL contacts API for live pipeline leads
        (ghlKey && ghlLoc) ? fetch(
          `https://services.leadconnectorhq.com/contacts/?${new URLSearchParams({ locationId: ghlLoc, query: search, limit: '20' })}`,
          { headers: { 'Authorization': `Bearer ${ghlKey}`, 'Version': '2021-07-28' } }
        ).then(r => r.ok ? r.json() : { contacts: [] }).catch(() => ({ contacts: [] }))
        : Promise.resolve({ contacts: [] }),
      ])

      const leads = (leadsRes.data || []).map(l => ({ ...l, _source: 'lead' }))
      const ghl = (ghlRes.data || []).map(g => ({
        id: g.id,
        lead_name: g.contact_name,
        appointment_date: g.appointment_date,
        lead_source: g.calendar_name || 'ghl',
        setter: null,
        ghl_event_id: g.ghl_event_id,
        contact_email: g.contact_email,
        contact_phone: g.contact_phone,
        _source: 'ghl',
      }))
      const ghlLive = (ghlContactsRes.contacts || []).map(c => ({
        id: c.id,
        lead_name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || 'Unknown',
        appointment_date: null,
        lead_source: 'ghl',
        setter: null,
        contact_email: c.email || '',
        contact_phone: c.phone || '',
        _source: 'ghl_live',
      }))

      // Deduplicate: setter_leads > ghl_appointments > ghl_live contacts
      const seen = new Set()
      const combined = []
      for (const list of [leads, ghl, ghlLive]) {
        for (const item of list) {
          const key = item.lead_name?.toLowerCase().trim()
          if (key && !seen.has(key)) {
            seen.add(key)
            combined.push(item)
          }
        }
      }

      combined.sort((a, b) => (b.appointment_date || '').localeCompare(a.appointment_date || ''))
      setResults(combined.slice(0, 20))
      setLoading(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-2xl w-96 max-h-[400px] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default">
          <Search size={14} className="text-text-400" />
          <input
            ref={inputRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search leads by name..."
            className="bg-transparent text-sm flex-1 outline-none text-text-primary"
          />
          <button onClick={onClose} className="text-text-400 hover:text-text-primary"><X size={14} /></button>
        </div>
        <div className="overflow-y-auto max-h-[340px]">
          {loading && <div className="p-4 text-center text-text-400 text-xs"><Loader size={14} className="animate-spin inline" /></div>}
          {!loading && search.length >= 2 && results.length === 0 && (
            <div className="p-4 text-center text-text-400 text-xs">No leads found</div>
          )}
          {results.map(lead => (
            <button
              key={lead.id}
              onClick={() => onSelect(lead)}
              className="w-full text-left px-3 py-2 hover:bg-bg-card-hover border-b border-border-default/30 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{lead.lead_name}</span>
                <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${
                  lead._source === 'ghl' || lead._source === 'ghl_live' ? 'bg-success/15 text-success' : 'bg-blue-500/15 text-blue-400'
                }`}>
                  {lead._source === 'ghl_live' ? 'GHL Contact' : lead._source === 'ghl' ? 'GHL' : 'Lead'}
                </span>
              </div>
              <span className="text-[10px] text-text-400">
                {lead.appointment_date || 'No appt date'}{lead.setter?.name ? ` · Set by ${lead.setter.name}` : ''}{lead.contact_email ? ` · ${lead.contact_email}` : ''}{lead.contact_phone ? ` · ${lead.contact_phone}` : ''}
              </span>
            </button>
          ))}
          {search.length < 2 && <div className="p-4 text-center text-text-400 text-xs">Type at least 2 characters to search</div>}
        </div>
      </div>
    </div>
  )
}

// Retroactive deal updater — search past calls and update outcome/revenue
function DealUpdater({ closerId, onClose, onSaved }) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(null)
  const [outcome, setOutcome] = useState('closed')
  const [revenue, setRevenue] = useState(0)
  const [cashCollected, setCashCollected] = useState(0)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Search past calls for this closer
  useEffect(() => {
    if (search.length < 2) { setResults([]); return }
    const timer = setTimeout(async () => {
      setLoading(true)
      // Search closer_calls + setter_leads + ghl_appointments for this closer
      const [callsRes, leadsRes, ghlRes] = await Promise.all([
        supabase
          .from('closer_calls')
          .select('id, prospect_name, outcome, revenue, cash_collected, call_type, notes, ghl_event_id, setter_lead_id, created_at, eod_report_id, eod:closer_eod_reports!closer_calls_eod_report_id_fkey(report_date, closer_id)')
          .eq('eod.closer_id', closerId)
          .ilike('prospect_name', `%${search}%`)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('setter_leads')
          .select('id, lead_name, date_set, appointment_date, status, revenue_attributed, lead_source, setter:team_members!setter_leads_setter_id_fkey(name)')
          .eq('closer_id', closerId)
          .ilike('lead_name', `%${search}%`)
          .order('appointment_date', { ascending: false })
          .limit(15),
        supabase
          .from('ghl_appointments')
          .select('id, ghl_event_id, contact_name, appointment_date, contact_email, contact_phone, outcome, revenue')
          .eq('closer_id', closerId)
          .ilike('contact_name', `%${search}%`)
          .order('appointment_date', { ascending: false })
          .limit(15),
      ])

      const combined = []
      const seen = new Set()

      // Closer calls (past EOD submissions)
      for (const c of (callsRes.data || [])) {
        if (!c.eod) continue
        const key = `call-${c.id}`
        if (seen.has(key)) continue
        seen.add(key)
        combined.push({
          type: 'closer_call',
          id: c.id,
          name: c.prospect_name,
          date: c.eod.report_date,
          outcome: c.outcome,
          revenue: c.revenue || 0,
          cash_collected: c.cash_collected || 0,
          call_type: c.call_type,
          notes: c.notes || '',
          ghl_event_id: c.ghl_event_id,
          setter_lead_id: c.setter_lead_id,
          eod_report_id: c.eod_report_id,
          _label: c.outcome === 'closed' ? 'Closed' : c.outcome === 'not_closed' ? 'Not Closed' : c.outcome === 'no_show' ? 'No Show' : c.outcome === 'rescheduled' ? 'Rescheduled' : c.outcome,
        })
      }

      // Setter leads assigned to this closer (may not have a closer_call yet)
      for (const l of (leadsRes.data || [])) {
        const nameKey = l.lead_name?.toLowerCase().trim()
        if (combined.some(c => c.name?.toLowerCase().trim() === nameKey && c.date === l.appointment_date)) continue
        combined.push({
          type: 'setter_lead',
          id: l.id,
          name: l.lead_name,
          date: l.appointment_date || l.date_set,
          outcome: l.status,
          revenue: l.revenue_attributed || 0,
          cash_collected: 0,
          setter_name: l.setter?.name || null,
          lead_source: l.lead_source,
          _label: l.status === 'closed' ? 'Closed' : l.status === 'not_closed' ? 'Not Closed' : l.status === 'no_show' ? 'No Show' : l.status || 'Set',
        })
      }

      // GHL appointments (may not have been submitted in an EOD yet)
      for (const g of (ghlRes.data || [])) {
        const nameKey = g.contact_name?.toLowerCase().trim()
        if (combined.some(c => c.name?.toLowerCase().trim() === nameKey && c.date === g.appointment_date)) continue
        combined.push({
          type: 'ghl_appointment',
          id: g.id,
          name: g.contact_name,
          date: g.appointment_date,
          outcome: g.outcome || 'unknown',
          revenue: g.revenue || 0,
          cash_collected: 0,
          ghl_event_id: g.ghl_event_id,
          _label: g.outcome || 'No outcome',
        })
      }

      combined.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      setResults(combined)
      setLoading(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [search, closerId])

  const handleSelect = (item) => {
    setSelected(item)
    setOutcome(item.outcome === 'closed' ? 'closed' : 'closed')
    setRevenue(item.revenue || 0)
    setCashCollected(item.cash_collected || 0)
    setNotes(item.notes || '')
  }

  const handleSave = async () => {
    if (!selected) return
    setSaving(true)

    try {
      const originalDate = selected.date

      // 1. Update the closer_call record if it exists
      if (selected.type === 'closer_call') {
        await supabase
          .from('closer_calls')
          .update({
            outcome,
            revenue: parseFloat(revenue) || 0,
            cash_collected: parseFloat(cashCollected) || 0,
            notes,
          })
          .eq('id', selected.id)

        // Update the parent closer_eod_report aggregates
        if (selected.eod_report_id) {
          const { data: reportCalls } = await supabase
            .from('closer_calls')
            .select('call_type, outcome, revenue, cash_collected, offered_finance')
            .eq('eod_report_id', selected.eod_report_id)

          if (reportCalls) {
            const agg = reportCalls.reduce((a, c) => {
              const isAsc = c.call_type === 'ascension'
              const isLive = isAsc ? true : ['not_closed', 'closed'].includes(c.outcome)
              return {
                nc_booked: a.nc_booked + (c.call_type === 'new_call' ? 1 : 0),
                fu_booked: a.fu_booked + (c.call_type === 'follow_up' ? 1 : 0),
                nc_no_shows: a.nc_no_shows + (c.call_type === 'new_call' && c.outcome === 'no_show' ? 1 : 0),
                fu_no_shows: a.fu_no_shows + (c.call_type === 'follow_up' && c.outcome === 'no_show' ? 1 : 0),
                live_nc_calls: a.live_nc_calls + (c.call_type === 'new_call' && ['not_closed', 'closed'].includes(c.outcome) ? 1 : 0),
                live_fu_calls: a.live_fu_calls + (c.call_type === 'follow_up' && ['not_closed', 'closed'].includes(c.outcome) ? 1 : 0),
                reschedules: a.reschedules + (c.outcome === 'rescheduled' ? 1 : 0),
                offers: a.offers + (c.offered ? 1 : 0),
                closes: a.closes + (c.outcome === 'closed' ? 1 : 0),
                deposits: a.deposits + (c.outcome === 'ascended' ? 1 : 0),
                total_revenue: a.total_revenue + (isAsc ? 0 : parseFloat(c.revenue || 0)),
                total_cash_collected: a.total_cash_collected + (isAsc ? 0 : parseFloat(c.cash_collected || 0)),
                ascend_cash: a.ascend_cash + (isAsc ? parseFloat(c.cash_collected || 0) : 0),
                ascend_revenue: a.ascend_revenue + (isAsc ? parseFloat(c.revenue || 0) : 0),
              }
            }, { nc_booked: 0, fu_booked: 0, nc_no_shows: 0, fu_no_shows: 0, live_nc_calls: 0, live_fu_calls: 0, reschedules: 0, offers: 0, closes: 0, deposits: 0, total_revenue: 0, total_cash_collected: 0, ascend_cash: 0, ascend_revenue: 0 })

            await supabase
              .from('closer_eod_reports')
              .update({ ...agg, updated_at: new Date().toISOString() })
              .eq('id', selected.eod_report_id)
          }
        }
      }

      // 2. Update setter_lead if linked
      const setterLeadId = selected.setter_lead_id || (selected.type === 'setter_lead' ? selected.id : null)
      if (setterLeadId) {
        await supabase
          .from('setter_leads')
          .update({
            status: outcome,
            revenue_attributed: parseFloat(revenue) || 0,
            updated_at: new Date().toISOString(),
          })
          .eq('id', setterLeadId)
      }

      // 3. Update ghl_appointment if linked
      const ghlEventId = selected.ghl_event_id || (selected.type === 'ghl_appointment' ? selected.ghl_event_id : null)
      if (ghlEventId) {
        await supabase
          .from('ghl_appointments')
          .update({
            outcome,
            revenue: parseFloat(revenue) || 0,
            updated_at: new Date().toISOString(),
          })
          .eq('ghl_event_id', ghlEventId)
      }

      // 4. Re-sync marketing_tracker for the original date
      if (originalDate) {
        try {
          const [{ data: allEODs }] = await Promise.all([
            supabase.from('closer_eod_reports').select('*').eq('report_date', originalDate),
          ])
          const reportIds = allEODs?.map(r => r.id) || []
          const { data: allCalls } = reportIds.length
            ? await supabase.from('closer_calls').select('call_type, revenue, cash_collected, outcome, offered_finance').in('eod_report_id', reportIds)
            : { data: [] }

          if (allEODs?.length) {
            const agg = allEODs.reduce((a, r) => ({
              offers: a.offers + (r.offers || 0),
              closes: a.closes + (r.closes || 0),
              trial_cash: a.trial_cash + parseFloat(r.total_cash_collected || 0),
              trial_revenue: a.trial_revenue + parseFloat(r.total_revenue || 0),
              ascensions: a.ascensions + (r.deposits || 0),
              live_calls: a.live_calls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
              booked: a.booked + (r.nc_booked || 0) + (r.fu_booked || 0),
              reschedules: a.reschedules + (r.reschedules || 0),
            }), { offers: 0, closes: 0, trial_cash: 0, trial_revenue: 0, ascensions: 0, live_calls: 0, booked: 0, reschedules: 0 })

            const callAgg = (allCalls || []).reduce((a, c) => ({
              ascCash: a.ascCash + (c.call_type === 'ascension' ? parseFloat(c.cash_collected || 0) : 0),
              ascRevenue: a.ascRevenue + (c.call_type === 'ascension' ? parseFloat(c.revenue || 0) : 0),
              financeOffers: a.financeOffers + (c.call_type === 'ascension' && c.offered_finance ? 1 : 0),
              financeAccepted: a.financeAccepted + (c.call_type === 'ascension' && c.offered_finance && ['closed', 'ascended'].includes(c.outcome) ? 1 : 0),
            }), { ascCash: 0, ascRevenue: 0, financeOffers: 0, financeAccepted: 0 })

            const { data: existingRows } = await supabase
              .from('marketing_tracker')
              .select('*')
              .eq('date', originalDate)
              .limit(1)

            await supabase.from('marketing_tracker').upsert({
              ...(existingRows?.[0] || {}),
              date: originalDate,
              offers: agg.offers,
              closes: agg.closes,
              trial_cash: agg.trial_cash,
              trial_revenue: agg.trial_revenue,
              ascensions: agg.ascensions,
              ascend_cash: callAgg.ascCash,
              ascend_revenue: callAgg.ascRevenue,
              finance_offers: callAgg.financeOffers,
              finance_accepted: callAgg.financeAccepted,
              live_calls: agg.live_calls,
              calls_on_calendar: agg.booked,
              reschedules: agg.reschedules,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'date' })
          }
        } catch (syncErr) {
          console.error('Marketing tracker re-sync failed:', syncErr)
        }
      }

      setSaved(true)
      if (onSaved) onSaved()
    } catch (err) {
      console.error('Deal update failed:', err)
      alert('Failed to update deal: ' + err.message)
    }
    setSaving(false)
  }

  const outcomeColor = (o) => o === 'closed' ? 'text-success' : o === 'not_closed' ? 'text-text-400' : o === 'no_show' ? 'text-danger' : o === 'rescheduled' ? 'text-blue-400' : 'text-text-400'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-2xl w-[480px] max-h-[90vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <div className="flex items-center gap-2">
            <Edit3 size={14} className="text-opt-yellow" />
            <span className="text-sm font-semibold">Update Deal</span>
          </div>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary"><X size={14} /></button>
        </div>

        {saved ? (
          <div className="p-8 text-center">
            <div className="text-3xl mb-2">&#10003;</div>
            <p className="text-sm font-medium text-success mb-1">Deal updated successfully</p>
            <p className="text-xs text-text-400">Stats have been retroactively updated for {selected?.date}</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 rounded-xl bg-opt-yellow text-bg-primary text-sm font-semibold hover:brightness-110 transition-all">Done</button>
          </div>
        ) : !selected ? (
          <>
            {/* Search */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-default">
              <Search size={14} className="text-text-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search past calls by lead name..."
                className="bg-transparent text-sm flex-1 outline-none text-text-primary"
              />
              {loading && <Loader size={14} className="animate-spin text-text-400" />}
            </div>

            {/* Results */}
            <div className="overflow-y-auto max-h-[60vh]">
              {search.length < 2 && (
                <div className="p-6 text-center text-text-400 text-xs">Search for a lead name to find past calls to update</div>
              )}
              {!loading && search.length >= 2 && results.length === 0 && (
                <div className="p-6 text-center text-text-400 text-xs">No past calls found for this lead</div>
              )}
              {results.map((item, i) => (
                <button
                  key={`${item.type}-${item.id}-${i}`}
                  onClick={() => handleSelect(item)}
                  className="w-full text-left px-4 py-3 hover:bg-bg-card-hover border-b border-border-default/30 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{item.name}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                        item.outcome === 'closed' ? 'bg-success/15 text-success' :
                        item.outcome === 'not_closed' ? 'bg-text-400/10 text-text-400' :
                        item.outcome === 'no_show' ? 'bg-danger/15 text-danger' :
                        item.outcome === 'rescheduled' ? 'bg-blue-500/15 text-blue-400' :
                        'bg-text-400/10 text-text-400'
                      }`}>{item._label}</span>
                    </div>
                    <span className="text-[10px] text-text-400">{item.date || 'No date'}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-text-400">
                      {item.type === 'closer_call' ? 'EOD Call' : item.type === 'setter_lead' ? 'Setter Lead' : 'GHL Appt'}
                      {item.setter_name ? ` · Set by ${item.setter_name}` : ''}
                      {item.revenue ? ` · $${parseFloat(item.revenue).toLocaleString()}` : ''}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="p-4 space-y-4">
            {/* Selected deal header */}
            <div className="bg-bg-primary rounded-xl p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold">{selected.name}</span>
                <button onClick={() => setSelected(null)} className="text-[10px] text-text-400 hover:text-opt-yellow">Change</button>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-text-400">
                <span>Original date: {selected.date}</span>
                <span>·</span>
                <span className={outcomeColor(selected.outcome)}>Was: {selected._label}</span>
                {selected.revenue > 0 && <><span>·</span><span>${parseFloat(selected.revenue).toLocaleString()}</span></>}
              </div>
            </div>

            {/* New outcome */}
            <div>
              <label className="text-[10px] text-text-400 uppercase font-medium mb-1.5 block">New Outcome</label>
              <div className="flex gap-1.5">
                {closingOutcomes.map(o => (
                  <button
                    key={o.value}
                    onClick={() => setOutcome(o.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      outcome === o.value
                        ? o.value === 'closed' ? 'bg-success/20 text-success ring-1 ring-success/40'
                        : o.value === 'not_closed' ? 'bg-text-400/15 text-text-primary ring-1 ring-text-400/30'
                        : o.value === 'rescheduled' ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-400/40'
                        : 'bg-danger/20 text-danger ring-1 ring-danger/40'
                        : 'bg-bg-primary text-text-400 hover:text-text-primary'
                    }`}
                  >{o.label}</button>
                ))}
              </div>
            </div>

            {/* Revenue + Cash */}
            {['closed', 'ascended'].includes(outcome) && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-text-400 uppercase font-medium mb-1.5 block">Cash Collected ($)</label>
                  <input
                    type="number"
                    value={cashCollected}
                    onChange={e => setCashCollected(e.target.value)}
                    className="w-full bg-bg-primary border border-border-default rounded-lg px-3 py-2 text-sm"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-text-400 uppercase font-medium mb-1.5 block">Revenue / Contract ($)</label>
                  <input
                    type="number"
                    value={revenue}
                    onChange={e => setRevenue(e.target.value)}
                    className="w-full bg-bg-primary border border-border-default rounded-lg px-3 py-2 text-sm"
                    placeholder="0"
                  />
                </div>
              </div>
            )}

            {/* Notes */}
            <div>
              <label className="text-[10px] text-text-400 uppercase font-medium mb-1.5 block">Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Follow-up details, how the deal closed..."
                className="w-full bg-bg-primary border border-border-default rounded-lg px-3 py-2 text-sm h-20 resize-y"
              />
            </div>

            {/* Save */}
            <div className="flex items-center justify-between pt-2 border-t border-border-default">
              <p className="text-[10px] text-text-400">This will update stats for <strong>{selected.date}</strong></p>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-opt-yellow text-bg-primary font-semibold text-sm hover:brightness-110 transition-all disabled:opacity-50"
              >
                {saving ? <Loader size={14} className="animate-spin" /> : <Check size={14} />}
                {saving ? 'Updating...' : 'Update Deal'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Inline lead search for setter set assignments
function SetterLeadSearch({ index, onSelect, selectedLead, label = 'Set' }) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    if (search.length < 2) { setResults([]); return }
    const timer = setTimeout(async () => {
      setLoading(true)
      const ghlKey = import.meta.env.VITE_GHL_API_KEY
      const ghlLoc = import.meta.env.VITE_GHL_LOCATION_ID

      // Search all three sources in parallel (same as closer LeadPicker)
      const [leadsRes, ghlRes, ghlContactsRes] = await Promise.all([
        supabase
          .from('setter_leads')
          .select('id, lead_name, appointment_date, lead_source')
          .ilike('lead_name', `%${search}%`)
          .order('appointment_date', { ascending: false })
          .limit(10),
        supabase
          .from('ghl_appointments')
          .select('id, ghl_event_id, contact_name, appointment_date, contact_email, contact_phone')
          .ilike('contact_name', `%${search}%`)
          .order('appointment_date', { ascending: false })
          .limit(10),
        // Always search GHL contacts API for live pipeline leads
        (ghlKey && ghlLoc) ? fetch(
          `https://services.leadconnectorhq.com/contacts/?${new URLSearchParams({ locationId: ghlLoc, query: search, limit: '15' })}`,
          { headers: { 'Authorization': `Bearer ${ghlKey}`, 'Version': '2021-07-28' } }
        ).then(r => r.ok ? r.json() : { contacts: [] }).catch(() => ({ contacts: [] }))
        : Promise.resolve({ contacts: [] }),
      ])
      const leads = (leadsRes.data || []).map(l => ({ ...l, _source: 'lead' }))
      const ghl = (ghlRes.data || []).map(g => ({
        id: g.id,
        lead_name: g.contact_name,
        appointment_date: g.appointment_date,
        lead_source: 'ghl',
        ghl_event_id: g.ghl_event_id,
        contact_email: g.contact_email,
        contact_phone: g.contact_phone,
        _source: 'ghl',
      }))
      const ghlLive = (ghlContactsRes.contacts || []).map(c => ({
        id: c.id,
        lead_name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || 'Unknown',
        appointment_date: null,
        lead_source: 'ghl',
        contact_email: c.email || '',
        contact_phone: c.phone || '',
        _source: 'ghl_live',
      }))

      // Deduplicate: setter_leads > ghl_appointments > ghl_live contacts
      const seen = new Set()
      const combined = []
      for (const list of [leads, ghl, ghlLive]) {
        for (const item of list) {
          const key = item.lead_name?.toLowerCase().trim()
          if (key && !seen.has(key)) {
            seen.add(key)
            combined.push(item)
          }
        }
      }

      combined.sort((a, b) => (b.appointment_date || '').localeCompare(a.appointment_date || ''))
      setResults(combined.slice(0, 10))
      setLoading(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  if (selectedLead) {
    return (
      <div className="flex items-center gap-2 bg-bg-card border border-border-default rounded-2xl px-3 py-2 flex-wrap">
        <span className="text-xs text-text-400">{label} {index + 1}:</span>
        <span className="text-sm font-medium">{selectedLead.lead_name}</span>
        <div className="flex items-center gap-1">
          <Calendar size={10} className="text-text-400" />
          <input
            type="date"
            value={selectedLead.appointment_date || ''}
            onChange={e => onSelect({ ...selectedLead, appointment_date: e.target.value })}
            className="bg-bg-primary border border-border-default rounded px-1.5 py-0.5 text-[11px] text-text-primary w-[130px]"
            placeholder="Booked for..."
          />
        </div>
        <span className={`text-[9px] px-1 py-0.5 rounded ${
          selectedLead._source === 'ghl' || selectedLead._source === 'ghl_live' ? 'bg-success/15 text-success' : 'bg-blue-500/15 text-blue-400'
        }`}>
          {selectedLead._source === 'ghl_live' ? 'GHL' : selectedLead._source === 'ghl' ? 'GHL' : 'Lead'}
        </span>
        <button onClick={() => onSelect(null)} className="text-text-400 hover:text-danger ml-auto"><X size={12} /></button>
      </div>
    )
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2 bg-bg-card border border-opt-yellow/30 rounded-2xl px-3 py-2">
        <span className="text-xs text-opt-yellow">{label} {index + 1}:</span>
        <Search size={12} className="text-text-400" />
        <input
          ref={inputRef}
          value={search}
          onChange={e => { setSearch(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder="Search lead name..."
          className="bg-transparent text-sm flex-1 outline-none text-text-primary"
        />
        {loading && <Loader size={12} className="animate-spin text-text-400" />}
      </div>
      {open && search.length >= 2 && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-bg-card border border-border-default rounded-2xl shadow-lg max-h-[200px] overflow-y-auto">
          {results.length === 0 && !loading && (
            <div className="p-3 text-center text-text-400 text-xs">No leads found</div>
          )}
          {results.map(lead => (
            <button
              key={lead.id}
              onClick={() => { onSelect(lead); setSearch(''); setOpen(false) }}
              className="w-full text-left px-3 py-2 hover:bg-bg-card-hover border-b border-border-default/30 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{lead.lead_name}</span>
                <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${
                  lead._source === 'ghl' || lead._source === 'ghl_live' ? 'bg-success/15 text-success' : 'bg-blue-500/15 text-blue-400'
                }`}>
                  {lead._source === 'ghl_live' ? 'GHL Contact' : lead._source === 'ghl' ? 'GHL' : 'Lead'}
                </span>
              </div>
              <span className="text-[10px] text-text-400">
                {lead.appointment_date || 'No appt date'}{lead.lead_source ? ` · ${lead.lead_source}` : ''}{lead.contact_email ? ` · ${lead.contact_email}` : ''}{lead.contact_phone ? ` · ${lead.contact_phone}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Setter Dashboard with pipeline stats + EOD form
function SetterDashboard({ setterId, selectedDate, selectedName, formatDateLabel, setterData, updateSetter, handleConfirmSetter, confirmed, setConfirmed, savedSetterLeads = [], initialSetLeads = [], initialRescheduleLeads = [], submitting, setLeadsForSets, setRescheduleLeadsForParent, refreshKey = 0 }) {
  const [pipeline, setPipeline] = useState({ set: 0, booked: 0, showed: 0, closed: 0, noShow: 0, cancelled: 0, revenue: 0, total: 0 })
  const [weeklyStats, setWeeklyStats] = useState({ sets: 0, shows: 0, closes: 0, revenue: 0, showRate: 0, closeRate: 0 })
  const [loading, setLoading] = useState(true)
  const [wavvStats, setWavvStats] = useState(null)
  const [wavvApplied, setWavvApplied] = useState(false)
  const [setLeads, setSetLeads] = useState([]) // leads selected for each set
  const [rescheduleLeads, setRescheduleLeads] = useState([]) // leads for each reschedule
  const [showHistory, setShowHistory] = useState(true)
  const [eodHistory, setEodHistory] = useState([])

  // Auto-fetch WAVV dials for this setter on the selected date
  useEffect(() => {
    async function loadWavv() {
      const { data: member } = await supabase
        .from('team_members')
        .select('wavv_user_id')
        .eq('id', setterId)
        .single()

      if (!member?.wavv_user_id) { setWavvStats(null); return }

      const dayStart = `${selectedDate}T00:00:00`
      const dayEnd = `${selectedDate}T23:59:59`
      const { data: calls } = await supabase
        .from('wavv_calls')
        .select('call_duration')
        .eq('user_id', member.wavv_user_id)
        .gte('started_at', dayStart)
        .lte('started_at', dayEnd)

      if (!calls?.length) { setWavvStats(null); return }

      let dials = 0, pickups = 0, mcs = 0
      for (const c of calls) {
        dials++
        if ((c.call_duration || 0) > 15) pickups++
        if ((c.call_duration || 0) >= 60) mcs++
      }
      setWavvStats({ dials, pickups, mcs })
    }
    setWavvApplied(false)
    setWavvStats(null)
    if (setterId) loadWavv()
  }, [setterId, selectedDate, refreshKey])

  // Auto-apply WAVV data to setter fields (always pre-fill, setter can override)
  useEffect(() => {
    if (!wavvStats || wavvApplied) return
    updateSetter('outbound_calls', wavvStats.dials)
    updateSetter('pickups', wavvStats.pickups)
    updateSetter('meaningful_conversations', wavvStats.mcs)
    setWavvApplied(true)
  }, [wavvStats, wavvApplied])

  // Pre-fill leads from saved data when loading a confirmed EOD
  const [leadsInitialized, setLeadsInitialized] = useState(false)
  useEffect(() => {
    if (initialSetLeads.length > 0 && !leadsInitialized) {
      setSetLeads(initialSetLeads)
      setLeadsInitialized(true)
    }
    if (initialRescheduleLeads.length > 0 && !leadsInitialized) {
      setRescheduleLeads(initialRescheduleLeads)
    }
  }, [initialSetLeads, initialRescheduleLeads])

  // Reset initialization flag when member/date changes
  useEffect(() => { setLeadsInitialized(false) }, [setterId, selectedDate])

  // Sync set leads count with sets field (only pad/trim, don't overwrite saved leads)
  useEffect(() => {
    const count = setterData.sets || 0
    setSetLeads(prev => {
      if (prev.length === count) return prev
      if (prev.length < count) return [...prev, ...Array(count - prev.length).fill(null)]
      return prev.slice(0, count)
    })
  }, [setterData.sets])

  // Sync reschedule leads count with reschedules field
  useEffect(() => {
    const count = setterData.reschedules || 0
    setRescheduleLeads(prev => {
      if (prev.length === count) return prev
      if (prev.length < count) return [...prev, ...Array(count - prev.length).fill(null)]
      return prev.slice(0, count)
    })
  }, [setterData.reschedules])

  // Pass leads up to parent for submission
  useEffect(() => {
    if (setLeadsForSets) setLeadsForSets(setLeads)
  }, [setLeads])

  useEffect(() => {
    if (setRescheduleLeadsForParent) setRescheduleLeadsForParent(rescheduleLeads)
  }, [rescheduleLeads])

  // Load EOD history
  useEffect(() => {
    async function loadHistory() {
      const { data } = await supabase
        .from('setter_eod_reports')
        .select('*')
        .eq('setter_id', setterId)
        .eq('is_confirmed', true)
        .order('report_date', { ascending: false })
        .limit(14)
      setEodHistory(data || [])
    }
    if (setterId) loadHistory()
  }, [setterId, confirmed])

  useEffect(() => {
    async function loadSetterData() {
      setLoading(true)
      const since = new Date()
      since.setDate(since.getDate() - 30)
      const sinceStr = toLocalDateStr(since)

      const [leadsRes, weekRes] = await Promise.all([
        supabase
          .from('setter_leads')
          .select('id, lead_name, lead_source, date_set, appointment_date, status, revenue_attributed, closer:team_members!setter_leads_closer_id_fkey(name)')
          .eq('setter_id', setterId)
          .gte('date_set', sinceStr)
          .order('appointment_date', { ascending: false }),
        supabase
          .from('setter_eod_reports')
          .select('*')
          .eq('setter_id', setterId)
          .gte('report_date', (() => {
            const d = new Date()
            d.setDate(d.getDate() - d.getDay())
            return toLocalDateStr(d)
          })())
          .order('report_date', { ascending: false }),
      ])

      const allLeads = leadsRes.data || []

      const statusCounts = allLeads.reduce((acc, l) => {
        const s = l.status || 'set'
        acc[s] = (acc[s] || 0) + 1
        return acc
      }, {})
      const totalRevenue = allLeads.reduce((s, l) => s + parseFloat(l.revenue_attributed || 0), 0)
      setPipeline({
        total: allLeads.length,
        set: statusCounts.set || 0,
        booked: (statusCounts.set || 0) + (statusCounts.booked || 0),
        showed: (statusCounts.showed || 0) + (statusCounts.not_closed || 0) + (statusCounts.closed || 0),
        closed: statusCounts.closed || 0,
        noShow: statusCounts.no_show || 0,
        cancelled: statusCounts.cancelled || 0,
        revenue: totalRevenue,
      })

      const weekReports = weekRes.data || []
      const wSets = weekReports.reduce((s, r) => s + (r.sets || 0), 0)
      const sundayStr = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return toLocalDateStr(d) })()
      const wShows = allLeads.filter(l => l.appointment_date >= sundayStr && ['showed', 'not_closed', 'closed'].includes(l.status)).length
      const wCloses = allLeads.filter(l => l.appointment_date >= sundayStr && l.status === 'closed').length
      const wRevenue = allLeads.filter(l => l.appointment_date >= sundayStr && l.status === 'closed').reduce((s, l) => s + parseFloat(l.revenue_attributed || 0), 0)

      setWeeklyStats({
        sets: wSets, shows: wShows, closes: wCloses, revenue: wRevenue,
        showRate: wSets > 0 ? ((wShows / wSets) * 100).toFixed(0) : 0,
        closeRate: wShows > 0 ? ((wCloses / wShows) * 100).toFixed(0) : 0,
        dials: weekReports.reduce((s, r) => s + (r.outbound_calls || 0), 0),
        pickups: weekReports.reduce((s, r) => s + (r.pickups || 0), 0),
        mcs: weekReports.reduce((s, r) => s + (r.meaningful_conversations || 0), 0),
      })

      setLoading(false)
    }
    if (setterId) loadSetterData()
  }, [setterId, selectedDate])

  if (loading) return <div className="flex items-center justify-center h-32"><Loader className="animate-spin text-opt-yellow" /></div>

  const updateSetLead = (index, lead) => {
    setSetLeads(prev => prev.map((l, i) => i === index ? lead : l))
  }
  const updateRescheduleLead = (index, lead) => {
    setRescheduleLeads(prev => prev.map((l, i) => i === index ? lead : l))
  }

  const allLeadsAssigned = (setterData.sets > 0 ? setLeads.every(Boolean) : true) &&
    (setterData.reschedules > 0 ? rescheduleLeads.every(Boolean) : true)

  return (
    <div className="space-y-4">
      {/* Confirmation banner */}
      {confirmed && (<>
        <div className="bg-bg-card border border-success/30 rounded-2xl p-6 mb-2">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-success/15 flex items-center justify-center">
                <Check size={20} className="text-success" />
              </div>
              <div>
                <p className="text-sm font-medium text-success">EOD Submitted</p>
                <p className="text-xs text-text-400">{selectedName} &middot; {formatDateLabel(selectedDate).split(' — ').pop()}</p>
              </div>
            </div>
            <button
              onClick={() => setConfirmed(false)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-400 hover:text-opt-yellow border border-border-default hover:border-opt-yellow/30 transition-colors"
            >
              <Edit3 size={12} />
              Edit
            </button>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {[
              ['Leads', setterData.total_leads],
              ['Dials', setterData.outbound_calls],
              ['Pickups', setterData.pickups],
              ['MCs', setterData.meaningful_conversations],
              ['Sets', setterData.sets, 'text-success'],
              ['Reschedules', setterData.reschedules],
            ].map(([label, val, color]) => (
              <div key={label} className="text-center p-3 bg-bg-primary rounded-2xl">
                <p className={`text-xl font-bold ${color || ''}`}>{val || 0}</p>
                <p className="text-[10px] text-text-400 uppercase">{label}</p>
              </div>
            ))}
          </div>
          {(setterData.what_went_well || setterData.what_went_poorly) && (
            <div className="flex gap-4 mt-3 pt-3 border-t border-border-default text-xs">
              {setterData.what_went_well && <div className="flex-1"><span className="text-text-400">Went well: </span><span className="text-text-secondary">{setterData.what_went_well}</span></div>}
              {setterData.what_went_poorly && <div className="flex-1"><span className="text-text-400">Could improve: </span><span className="text-text-secondary">{setterData.what_went_poorly}</span></div>}
            </div>
          )}
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border-default text-xs text-text-400">
            <span>Rating: <strong className="text-text-primary">{setterData.self_rating}/10</strong></span>
          </div>
        </div>

        {/* Leads set + rescheduled — read-only detail */}
        {savedSetterLeads.length > 0 && (
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-border-default">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
                Leads ({savedSetterLeads.length})
              </p>
            </div>
            <div className="divide-y divide-border-default/30">
              {savedSetterLeads.map(lead => {
                const statusBadge = lead.status === 'set' ? { label: 'Set', cls: 'bg-success/15 text-success' }
                  : lead.status === 'rescheduled' ? { label: 'Rescheduled', cls: 'bg-blue-500/15 text-blue-400' }
                  : lead.status === 'showed' || lead.status === 'not_closed' ? { label: 'Showed', cls: 'bg-opt-yellow/15 text-opt-yellow' }
                  : lead.status === 'closed' ? { label: 'Closed', cls: 'bg-success/15 text-success' }
                  : lead.status === 'no_show' ? { label: 'No Show', cls: 'bg-danger/15 text-danger' }
                  : lead.status === 'cancelled' ? { label: 'Cancelled', cls: 'bg-text-400/15 text-text-400' }
                  : { label: lead.status || '—', cls: 'bg-text-400/15 text-text-400' }
                return (
                  <div key={lead.id} className="px-5 py-3 flex items-center gap-3">
                    <span className="font-medium text-sm min-w-[140px]">{lead.lead_name}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${statusBadge.cls}`}>{statusBadge.label}</span>
                    {lead.lead_source && lead.lead_source !== 'manual' && (
                      <span className="text-[10px] text-text-400 bg-bg-primary px-1.5 py-0.5 rounded">{lead.lead_source === 'ghl' ? 'GHL' : lead.lead_source}</span>
                    )}
                    {lead.appointment_date && (
                      <span className="text-[10px] text-text-400 ml-auto">Appt: {lead.appointment_date}</span>
                    )}
                    {lead.closer?.name && (
                      <span className="text-[10px] text-text-400">→ {lead.closer.name}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </>)}

      {/* Pipeline KPIs — always show */}
      {!confirmed && <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        {[
          ['Sets (30d)', pipeline.total, ''],
          ['Pending', pipeline.set, 'text-opt-yellow'],
          ['Showed', pipeline.showed, 'text-success'],
          ['No Shows', pipeline.noShow, 'text-danger'],
          ['Closed', pipeline.closed, 'text-success'],
          ['Revenue', `$${pipeline.revenue.toLocaleString()}`, 'text-success'],
          ['Show %', pipeline.total > 0 ? `${((pipeline.showed / pipeline.total) * 100).toFixed(0)}%` : '—', ''],
          ['Close %', pipeline.showed > 0 ? `${((pipeline.closed / pipeline.showed) * 100).toFixed(0)}%` : '—', ''],
        ].map(([label, val, color]) => (
          <div key={label} className="bg-bg-card border border-border-default rounded-2xl p-2.5 text-center">
            <p className={`text-lg font-bold ${color}`}>{val}</p>
            <p className="text-[10px] text-text-400 uppercase">{label}</p>
          </div>
        ))}
      </div>}

      {!confirmed && <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
        {/* Left: EOD form */}
        <div className="space-y-4">
          {/* Activity inputs */}
          <div className="bg-bg-card border border-border-default rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] text-opt-yellow uppercase font-medium">
                {selectedName} &middot; {formatDateLabel(selectedDate).split(' — ').pop()} &middot; Activity
              </h3>
              {wavvStats && (
                <span className="flex items-center gap-1 text-[10px] text-text-400">
                  <Zap size={10} className="text-opt-yellow" />
                  WAVV: {wavvStats.dials} dials auto-filled
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              {[
                ['Leads Worked', 'total_leads'],
                ['Dials', 'outbound_calls'],
                ['Pickups', 'pickups'],
                ['MCs', 'meaningful_conversations'],
                ['Sets', 'sets'],
                ['Reschedules', 'reschedules'],
              ].map(([label, key]) => (
                <div key={key}>
                  <label className="text-[10px] text-text-400 uppercase block mb-1">{label}</label>
                  <input
                    type="number"
                    value={setterData[key] || ''}
                    onChange={e => updateSetter(key, parseInt(e.target.value) || 0)}
                    className={`bg-bg-primary border rounded px-2 py-1.5 text-lg font-bold w-full text-center ${
                      wavvStats && ['outbound_calls', 'pickups', 'meaningful_conversations'].includes(key)
                        ? 'border-opt-yellow/30'
                        : 'border-border-default'
                    }`}
                    placeholder="0"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Lead assignment for each set */}
          {setterData.sets > 0 && (
            <div className="bg-bg-card border border-border-default rounded-2xl p-4">
              <h3 className="text-[11px] text-opt-yellow uppercase font-medium mb-3">
                Assign Leads to Sets ({setLeads.filter(Boolean).length}/{setterData.sets})
              </h3>
              <p className="text-[10px] text-text-400 mb-3">Search and select the lead for each set appointment.</p>
              <div className="space-y-2">
                {setLeads.map((lead, i) => (
                  <SetterLeadSearch
                    key={`set-${i}`}
                    index={i}
                    selectedLead={lead}
                    onSelect={l => updateSetLead(i, l)}
                  />
                ))}
              </div>
              {setLeads.some(l => !l) && (
                <p className="text-[10px] text-warning mt-2">Please assign a lead to each set before confirming.</p>
              )}
            </div>
          )}

          {/* Lead assignment for each reschedule */}
          {setterData.reschedules > 0 && (
            <div className="bg-bg-card border border-border-default rounded-2xl p-4">
              <h3 className="text-[11px] text-text-400 uppercase font-medium mb-3">
                Reschedule Prospects ({rescheduleLeads.filter(Boolean).length}/{setterData.reschedules})
              </h3>
              <p className="text-[10px] text-text-400 mb-3">Search and select the prospect who rescheduled.</p>
              <div className="space-y-2">
                {rescheduleLeads.map((lead, i) => (
                  <SetterLeadSearch
                    key={`resched-${i}`}
                    index={i}
                    selectedLead={lead}
                    onSelect={l => updateRescheduleLead(i, l)}
                    label="Resched"
                  />
                ))}
              </div>
              {rescheduleLeads.some(l => !l) && (
                <p className="text-[10px] text-warning mt-2">Please assign a prospect to each reschedule before confirming.</p>
              )}
            </div>
          )}

          {/* Self assessment */}
          <div className="bg-bg-card border border-border-default rounded-2xl p-4">
            <h3 className="text-[11px] text-text-400 uppercase font-medium mb-3">Self Assessment</h3>
            <div className="grid grid-cols-1 md:grid-cols-[80px_1fr_1fr] gap-3">
              <div>
                <label className="text-[10px] text-text-400 block mb-1">Rating</label>
                <input
                  type="number" min="1" max="10"
                  value={setterData.self_rating || ''}
                  onChange={e => updateSetter('self_rating', parseInt(e.target.value) || 0)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-sm w-full text-center"
                  placeholder="7"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-400 block mb-1">What went well?</label>
                <textarea
                  value={setterData.what_went_well}
                  onChange={e => updateSetter('what_went_well', e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-xs w-full h-14 resize-none"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-400 block mb-1">What could improve?</label>
                <textarea
                  value={setterData.what_went_poorly}
                  onChange={e => updateSetter('what_went_poorly', e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-xs w-full h-14 resize-none"
                />
              </div>
            </div>
          </div>

          {/* Confirm */}
          {!confirmed && (
            <button
              onClick={handleConfirmSetter}
              disabled={submitting || !allLeadsAssigned}
              className="flex items-center gap-2 px-6 py-2 rounded font-medium text-sm bg-opt-yellow text-bg-primary hover:bg-opt-yellow/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? <Loader size={14} className="animate-spin" /> : <Check size={14} />}
              {submitting ? 'Saving...' : 'Confirm EOD'}
            </button>
          )}

          {/* EOD History */}
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-card-hover transition-colors"
            >
              <h3 className="text-[11px] text-text-400 uppercase font-medium">EOD History ({eodHistory.length})</h3>
              <ChevronRight size={14} className={`text-text-400 transition-transform ${showHistory ? 'rotate-90' : ''}`} />
            </button>
            {showHistory && (
              <div className="border-t border-border-default">
                {eodHistory.length === 0 ? (
                  <p className="p-4 text-center text-text-400 text-xs">No EOD history yet</p>
                ) : (
                  <div className="max-h-[400px] overflow-y-auto">
                    {eodHistory.map(eod => {
                      const dateLabel = formatDateLabel(eod.report_date)
                      return (
                        <div key={eod.id} className="px-4 py-3 border-b border-border-default/30 hover:bg-bg-card-hover transition-colors">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-medium">{dateLabel}</span>
                            <span className="text-[10px] text-text-400">Rating: {eod.self_rating || '—'}/10</span>
                          </div>
                          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
                            {[
                              ['Leads', eod.total_leads],
                              ['Dials', eod.outbound_calls],
                              ['Pickups', eod.pickups],
                              ['MCs', eod.meaningful_conversations],
                              ['Sets', eod.sets],
                              ['Resched', eod.reschedules],
                            ].map(([lbl, val]) => (
                              <div key={lbl}>
                                <p className="text-sm font-bold">{val || 0}</p>
                                <p className="text-[9px] text-text-400">{lbl}</p>
                              </div>
                            ))}
                          </div>
                          {(eod.what_went_well || eod.what_went_poorly) && (
                            <div className="mt-2 space-y-1">
                              {eod.what_went_well && (
                                <p className="text-[10px] text-text-secondary"><span className="text-success">+</span> {eod.what_went_well}</p>
                              )}
                              {eod.what_went_poorly && (
                                <p className="text-[10px] text-text-secondary"><span className="text-danger">-</span> {eod.what_went_poorly}</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: weekly summary sidebar */}
        <div>
          <div className="bg-bg-card border border-border-default rounded-2xl p-4 sticky top-20">
            <h3 className="text-[11px] text-opt-yellow uppercase font-medium mb-3">This Week</h3>

            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="text-center">
                <p className="text-xl font-bold">{weeklyStats.dials}</p>
                <p className="text-[10px] text-text-400">Dials</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-bold">{weeklyStats.pickups}</p>
                <p className="text-[10px] text-text-400">Pickups</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-bold">{weeklyStats.mcs}</p>
                <p className="text-[10px] text-text-400">MCs</p>
              </div>
            </div>

            <div className="space-y-2 mb-3">
              <div className="flex justify-between text-xs">
                <span className="text-text-400">Sets</span>
                <span className="font-medium">{weeklyStats.sets}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-text-400">Shows</span>
                <span>{weeklyStats.shows}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-text-400">Show Rate</span>
                <span className={parseInt(weeklyStats.showRate) >= 70 ? 'text-success' : 'text-danger'}>{weeklyStats.showRate}%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-text-400">Closes</span>
                <span className="text-success font-medium">{weeklyStats.closes}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-text-400">Close Rate</span>
                <span className={parseInt(weeklyStats.closeRate) >= 25 ? 'text-success' : 'text-text-secondary'}>{weeklyStats.closeRate}%</span>
              </div>
            </div>

            {weeklyStats.revenue > 0 && (
              <div className="border-t border-border-default pt-3">
                <div className="flex justify-between text-xs">
                  <span className="text-text-400">Revenue (attributed)</span>
                  <span className="text-success font-medium">${weeklyStats.revenue.toLocaleString()}</span>
                </div>
              </div>
            )}

            {/* Conversion funnel */}
            <div className="border-t border-border-default pt-3 mt-3">
              <p className="text-[10px] text-text-400 uppercase mb-2">30-Day Funnel</p>
              {[
                ['Sets', pipeline.total, 'bg-text-400'],
                ['Showed', pipeline.showed, 'bg-opt-yellow'],
                ['Closed', pipeline.closed, 'bg-success'],
              ].map(([label, count, color]) => (
                <div key={label} className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] text-text-400 w-12">{label}</span>
                  <div className="flex-1 bg-bg-primary rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${color}`}
                      style={{ width: `${pipeline.total > 0 ? (count / pipeline.total) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-medium w-6 text-right">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>}
    </div>
  )
}

export default function EODReview() {
  const { profile, canFileEOD, getEODMemberId, isAdmin } = useAuth()

  const [tab, setTab] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const urlTab = params.get('tab')
    if (urlTab) return urlTab === 'setter' ? 'setter' : 'closer'
    // Default to user's own role
    if (profile?.role === 'setter') return 'setter'
    return 'closer'
  })
  const [confirmed, setConfirmed] = useState(false)
  const [selectedMember, setSelectedMember] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const urlMember = params.get('member')
    if (urlMember) return urlMember
    // Auto-select the logged-in user's team member
    if (!isAdmin && profile?.teamMemberId) return profile.teamMemberId
    return ''
  })
  const [selectedDate, setSelectedDate] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('date') || todayET()
  })
  const [calls, setCalls] = useState([])
  const [loadingCalls, setLoadingCalls] = useState(false)
  const [expandedCall, setExpandedCall] = useState(null)
  const [closerNotes, setCloserNotes] = useState('')
  const { members: closers } = useTeamMembers('closer')
  const { members: setters } = useTeamMembers('setter')
  const { submitCloserEOD, submitSetterEOD, submitting } = useEODSubmit()

  const today = todayET()

  const shiftDate = (days) => {
    const d = new Date(selectedDate + 'T12:00:00')
    d.setDate(d.getDate() + days)
    const newDate = toLocalDateStr(d)
    if (newDate <= today) setSelectedDate(newDate)
  }

  const [calendarSource, setCalendarSource] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [showLeadPicker, setShowLeadPicker] = useState(false)
  const [showDealUpdater, setShowDealUpdater] = useState(false)
  const [setterRefreshKey, setSetterRefreshKey] = useState(0)
  const [closerHistory, setCloserHistory] = useState([])
  const [showCloserHistory, setShowCloserHistory] = useState(true)
  const [allEodHistory, setAllEodHistory] = useState([])
  const [loadingAllHistory, setLoadingAllHistory] = useState(false)
  const [historyFrom, setHistoryFrom] = useState(() => {
    const d = new Date(todayET() + 'T12:00:00'); d.setDate(d.getDate() - 7)
    return toLocalDateStr(d)
  })
  const [historyTo, setHistoryTo] = useState(() => todayET())

  const addManualCall = (lead) => {
    setShowLeadPicker(false)
    setCalls(prev => [...prev, {
      lead_id: lead ? lead.id : null,
      ghl_event_id: null,
      lead_name: lead ? lead.lead_name : 'Manual Entry',
      setter_name: lead?.setter?.name || '—',
      appointment_date: selectedDate,
      start_time: null,
      calendar_name: '',
      lead_source: lead?.lead_source || 'manual',
      call_type: 'new_call',
      outcome: 'no_show',
      revenue: 0,
      cash_collected: 0,
      ascended: false,
      offered_finance: false,
      existing_status: null,
      notes: '',
      fathom_summary: null,
      fathom_duration: null,
      contact_email: '',
      contact_phone: '',
      is_manual: true,
    }])
  }

  const handleRefreshCloser = async () => {
    if (!selectedMember || syncing) return
    setSyncing(true)
    try {
      // 1. Sync GHL appointments from API + trigger Fathom transcript sync
      await Promise.all([
        syncGHLAppointments(selectedDate, selectedDate),
        // Trigger Fathom sync edge function to pull latest transcripts
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sync-fathom`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: '{}',
        }).catch(() => {}), // Don't block if sync fails
      ])

      // 2. Re-fetch all three sources: calendar, setter_leads, Fathom transcripts
      const [calendarResult, leadsRes, transcriptsRes] = await Promise.all([
        fetchCloserCalendar(selectedMember, selectedDate),
        supabase
          .from('setter_leads')
          .select('id, lead_name, setter:team_members!setter_leads_setter_id_fkey(name), lead_source, status, revenue_attributed, date_set')
          .eq('closer_id', selectedMember)
          .eq('appointment_date', selectedDate),
        supabase
          .from('closer_transcripts')
          .select('id, prospect_name, summary, meeting_date, duration_seconds')
          .eq('closer_id', selectedMember)
          .eq('meeting_date', selectedDate)
          .then(res => res, () => ({ data: [] })),
      ])

      const { source, events } = calendarResult
      const setterLeads = leadsRes.data || []
      const transcripts = transcriptsRes.data || []
      setCalendarSource(source)

      // Helper: format GHL time string to readable time in ET
      const formatTime = (timeStr) => {
        if (!timeStr) return null
        try {
          const d = new Date(timeStr)
          if (isNaN(d.getTime())) return null
          return d.toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit',
            timeZone: 'America/Indiana/Indianapolis',
          })
        } catch { return null }
      }

      // Helper: match transcript by first name
      const findTranscript = (name) => {
        const first = name?.split(' ')[0]?.toLowerCase()
        if (!first || first.length < 2) return null
        return transcripts.find(t => t.prospect_name?.toLowerCase().includes(first)) || null
      }

      const truncateSummary = (text) => {
        if (!text) return ''
        const cleaned = text.replace(/[{}]/g, '').replace(/#{1,6}\s*/g, '').replace(/\*\*/g, '').trim()
        const sentences = cleaned.split(/(?<=[.!?])\s+/).slice(0, 5)
        return sentences.join(' ')
      }

      // 3. Build rows from calendar events, matching setter_leads + transcripts
      const matchedLeadIds = new Set()
      const calendarRows = events.map(evt => {
        const firstName = evt.contact_name?.split(' ')[0]?.toLowerCase()
        const matchedLead = setterLeads.find(l =>
          l.lead_name?.toLowerCase().includes(firstName) ||
          (firstName?.length > 2 && l.lead_name?.toLowerCase().split(' ')[0] === firstName)
        )
        if (matchedLead) matchedLeadIds.add(matchedLead.id)

        const transcript = findTranscript(evt.contact_name)
        const outcome = evt.existing_status === 'closed' ? 'closed'
          : evt.existing_status === 'not_closed' ? 'not_closed'
          : ['showed', 'closed', 'not_closed'].includes(evt.existing_status) ? 'showed'
          : evt.existing_status === 'no_show' ? 'no_show'
          : null

        return {
          lead_id: matchedLead?.id || evt.lead_id || null,
          ghl_event_id: evt.ghl_event_id || null,
          lead_name: evt.contact_name,
          setter_name: matchedLead?.setter?.name || evt.setter_name || '—',
          appointment_date: selectedDate,
          start_time: formatTime(evt.start_time),
          calendar_name: evt.calendar_name || '',
          lead_source: matchedLead?.lead_source || evt.lead_source || (source === 'ghl' ? 'ghl' : 'manual'),
          call_type: 'new_call',
          outcome: outcome || (matchedLead?.status && matchedLead.status !== 'booked' ? matchedLead.status : 'no_show'),
          revenue: matchedLead?.revenue_attributed || evt.revenue_attributed || 0,
          cash_collected: 0,
          existing_status: evt.existing_status || evt.status || null,
          notes: truncateSummary(transcript?.summary) || evt.notes || '',
          fathom_summary: transcript?.summary || null,
          fathom_duration: transcript?.duration_seconds || null,
          contact_email: evt.contact_email || '',
          contact_phone: evt.contact_phone || '',
          ascended: false,
          offered_finance: false,
          _rowSource: 'calendar',
        }
      })

      // 4. Add unmatched setter_leads
      const leadOnlyRows = setterLeads
        .filter(l => !matchedLeadIds.has(l.id))
        .map(lead => {
          const transcript = findTranscript(lead.lead_name)
          return {
            lead_id: lead.id,
            ghl_event_id: null,
            lead_name: lead.lead_name,
            setter_name: lead.setter?.name || '—',
            appointment_date: selectedDate,
            start_time: null,
            calendar_name: '',
            lead_source: lead.lead_source || 'manual',
            call_type: 'new_call',
            outcome: lead.status && lead.status !== 'booked' && lead.status !== 'set' ? lead.status : 'no_show',
            revenue: parseFloat(lead.revenue_attributed || 0),
            cash_collected: 0,
            existing_status: lead.status || null,
            notes: truncateSummary(transcript?.summary) || '',
            fathom_summary: transcript?.summary || null,
            fathom_duration: transcript?.duration_seconds || null,
            contact_email: '',
            contact_phone: '',
            ascended: false,
            offered_finance: false,
            _rowSource: 'lead',
          }
        })

      setCalls([...calendarRows, ...leadOnlyRows])
    } catch (err) {
      console.error('Refresh failed:', err)
    }
    setSyncing(false)
  }

  const handleRefreshSetter = async () => {
    if (!selectedMember || syncing) return
    setSyncing(true)
    // Bump refresh key to trigger WAVV re-fetch inside SetterDashboard
    setSetterRefreshKey(k => k + 1)
    // Small delay to let the useEffect fire, then clear syncing
    setTimeout(() => setSyncing(false), 1500)
  }

  // Load all-team EOD history when no member is selected
  useEffect(() => {
    if (selectedMember) { setAllEodHistory([]); return }
    async function loadAll() {
      setLoadingAllHistory(true)
      const table = tab === 'closer' ? 'closer_eod_reports' : 'setter_eod_reports'
      const fk = tab === 'closer' ? 'closer:team_members(name)' : 'setter:team_members(name)'
      const { data } = await supabase
        .from(table)
        .select(`*, ${fk}`)
        .eq('is_confirmed', true)
        .gte('report_date', historyFrom)
        .lte('report_date', historyTo)
        .order('report_date', { ascending: false })
      setAllEodHistory(data || [])
      setLoadingAllHistory(false)
    }
    loadAll()
  }, [tab, selectedMember, selectedDate, historyFrom, historyTo])

  // Load closer EOD history
  useEffect(() => {
    if (tab !== 'closer' || !selectedMember) { setCloserHistory([]); return }
    async function loadHistory() {
      const { data } = await supabase
        .from('closer_eod_reports')
        .select('*')
        .eq('closer_id', selectedMember)
        .eq('is_confirmed', true)
        .order('report_date', { ascending: false })
        .limit(14)
      setCloserHistory(data || [])
    }
    loadHistory()
  }, [tab, selectedMember, confirmed])

  // Pull BOTH GHL calendar events AND setter_leads, merge them, match Fathom transcripts
  useEffect(() => {
    if (tab !== 'closer' || !selectedMember) { setCalls([]); setCalendarSource(null); return }

    async function loadCalls() {
      setLoadingCalls(true)
      setExpandedCall(null)

      // Check if an EOD already exists for this member+date
      const { data: existingEOD } = await supabase
        .from('closer_eod_reports')
        .select('id, is_confirmed')
        .eq('closer_id', selectedMember)
        .eq('report_date', selectedDate)
        .limit(1)

      if (existingEOD?.[0]?.is_confirmed) {
        setConfirmed(true)
        // Load saved closer_calls for read-only view
        const { data: savedCalls } = await supabase
          .from('closer_calls')
          .select('*')
          .eq('eod_report_id', existingEOD[0].id)
          .order('id', { ascending: true })
        if (savedCalls?.length) {
          // Also load the EOD notes
          const { data: eodData } = await supabase
            .from('closer_eod_reports')
            .select('notes')
            .eq('id', existingEOD[0].id)
            .single()
          setCloserNotes(eodData?.notes || '')
          setCalls(savedCalls.map(c => ({
            lead_id: c.lead_id || null,
            ghl_event_id: c.ghl_event_id || null,
            lead_name: c.prospect_name || 'Unknown',
            setter_name: c.setter_name || '—',
            appointment_date: selectedDate,
            start_time: c.start_time || null,
            calendar_name: c.calendar_name || '',
            lead_source: c.lead_source || '',
            call_type: c.call_type || 'new_call',
            outcome: c.outcome || 'no_show',
            revenue: parseFloat(c.revenue || 0),
            cash_collected: parseFloat(c.cash_collected || 0),
            offered: ['closed', 'not_closed'].includes(c.outcome),
            ascended: c.outcome === 'ascended',
            offered_finance: c.offered_finance || false,
            notes: c.notes || '',
            fathom_summary: c.fathom_summary || null,
            fathom_duration: c.fathom_duration || null,
            contact_email: c.contact_email || '',
            contact_phone: c.contact_phone || '',
          })))
          setLoadingCalls(false)
          return  // Skip live calendar fetch — we have saved data
        }
      } else {
        setConfirmed(false)
      }

      try {
      // Fetch all three data sources in parallel
      const [calendarResult, leadsRes, transcriptsRes] = await Promise.all([
        fetchCloserCalendar(selectedMember, selectedDate),
        supabase
          .from('setter_leads')
          .select('id, lead_name, setter:team_members!setter_leads_setter_id_fkey(name), lead_source, status, revenue_attributed, date_set')
          .eq('closer_id', selectedMember)
          .eq('appointment_date', selectedDate),
        supabase
          .from('closer_transcripts')
          .select('id, prospect_name, summary, meeting_date, duration_seconds')
          .eq('closer_id', selectedMember)
          .eq('meeting_date', selectedDate)
          .then(res => res, () => ({ data: [] })),
      ])

      const { source, events } = calendarResult
      const setterLeads = leadsRes.data || []
      const transcripts = transcriptsRes.data || []
      setCalendarSource(source)

      // Helper: format GHL time string to readable time in ET (GHL location timezone)
      const formatTime = (timeStr) => {
        if (!timeStr) return null
        try {
          const d = new Date(timeStr)
          if (isNaN(d.getTime())) return null
          return d.toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit',
            timeZone: 'America/Indiana/Indianapolis',
          })
        } catch { return null }
      }

      // Helper: match transcript by first name
      const findTranscript = (name) => {
        const first = name?.split(' ')[0]?.toLowerCase()
        if (!first || first.length < 2) return null
        return transcripts.find(t => t.prospect_name?.toLowerCase().includes(first)) || null
      }

      // Clean and truncate summary to max 5 sentences
      const truncateSummary = (text) => {
        if (!text) return ''
        const cleaned = text.replace(/[{}]/g, '').replace(/#{1,6}\s*/g, '').replace(/\*\*/g, '').trim()
        const sentences = cleaned.split(/(?<=[.!?])\s+/).slice(0, 5)
        return sentences.join(' ')
      }

      // Build rows from GHL calendar events, marking matched setter_leads
      const matchedLeadIds = new Set()
      const calendarRows = events.map(evt => {
        const firstName = evt.contact_name?.split(' ')[0]?.toLowerCase()
        const matchedLead = setterLeads.find(l =>
          l.lead_name?.toLowerCase().includes(firstName) ||
          (firstName?.length > 2 && l.lead_name?.toLowerCase().split(' ')[0] === firstName)
        )
        if (matchedLead) matchedLeadIds.add(matchedLead.id)

        const transcript = findTranscript(evt.contact_name)

        const outcome = evt.existing_status === 'closed' ? 'closed'
          : evt.existing_status === 'not_closed' ? 'not_closed'
          : ['showed', 'closed', 'not_closed'].includes(evt.existing_status) ? 'showed'
          : evt.existing_status === 'no_show' ? 'no_show'
          : null

        return {
          lead_id: matchedLead?.id || evt.lead_id || null,
          ghl_event_id: evt.ghl_event_id || null,
          lead_name: evt.contact_name,
          setter_name: matchedLead?.setter?.name || evt.setter_name || '—',
          appointment_date: selectedDate,
          start_time: formatTime(evt.start_time),
          calendar_name: evt.calendar_name || '',
          lead_source: matchedLead?.lead_source || evt.lead_source || (source === 'ghl' ? 'ghl' : 'manual'),
          call_type: 'new_call',
          outcome: outcome || (matchedLead?.status && matchedLead.status !== 'booked' ? matchedLead.status : 'no_show'),
          revenue: matchedLead?.revenue_attributed || evt.revenue_attributed || 0,
          cash_collected: 0,
          existing_status: evt.existing_status || evt.status || null,
          notes: truncateSummary(transcript?.summary) || evt.notes || '',
          fathom_summary: transcript?.summary || null,
          fathom_duration: transcript?.duration_seconds || null,
          contact_email: evt.contact_email || '',
          contact_phone: evt.contact_phone || '',
          ascended: false,
          offered_finance: false,
          _rowSource: 'calendar',
        }
      })

      // Add setter_leads that weren't matched to any GHL calendar entry
      const leadOnlyRows = setterLeads
        .filter(l => !matchedLeadIds.has(l.id))
        .map(lead => {
          const transcript = findTranscript(lead.lead_name)
          return {
            lead_id: lead.id,
            ghl_event_id: null,
            lead_name: lead.lead_name,
            setter_name: lead.setter?.name || '—',
            appointment_date: selectedDate,
            start_time: null,
            calendar_name: '',
            lead_source: lead.lead_source || 'manual',
            call_type: 'new_call',
            outcome: lead.status && lead.status !== 'booked' && lead.status !== 'set' ? lead.status : 'no_show',
            revenue: parseFloat(lead.revenue_attributed || 0),
            cash_collected: 0,
            existing_status: lead.status || null,
            notes: truncateSummary(transcript?.summary) || '',
            fathom_summary: transcript?.summary || null,
            fathom_duration: transcript?.duration_seconds || null,
            contact_email: '',
            contact_phone: '',
            ascended: false,
            offered_finance: false,
            _rowSource: 'lead',
          }
        })

      // Merge: calendar entries first (sorted by time), then unmatched leads
      const allRows = [...calendarRows, ...leadOnlyRows]
      setCalls(allRows)
      } catch (err) {
        console.error('Failed to load calls:', err)
      }
      setLoadingCalls(false)
    }

    loadCalls()
  }, [tab, selectedMember, selectedDate])

  const updateCall = (index, field, value) => {
    setCalls(prev => prev.map((c, i) => {
      if (i !== index) return c
      const updated = { ...c, [field]: value }
      // Reset revenue/cash if not a won outcome
      if (field === 'outcome' && !['closed', 'ascended'].includes(value)) {
        updated.revenue = 0
        updated.cash_collected = 0
      }
      return updated
    }))
  }

  // Auto-computed summary — ascensions excluded from show rate (they always show)
  const summary = calls.reduce((acc, c) => {
    const isAsc = c.call_type === 'ascension'
    const isLive = isAsc ? true : ['not_closed', 'closed'].includes(c.outcome)
    return {
      booked: acc.booked + (isAsc ? 0 : 1),
      showed: acc.showed + (isAsc ? 0 : (isLive ? 1 : 0)),
      noShows: acc.noShows + (c.outcome === 'no_show' ? 1 : 0),
      rescheduled: acc.rescheduled + (c.outcome === 'rescheduled' ? 1 : 0),
      offers: acc.offers + (c.offered ? 1 : 0),
      closes: acc.closes + (c.outcome === 'closed' ? 1 : 0),
      ascensions: acc.ascensions + (c.outcome === 'ascended' ? 1 : 0),
      ascensionCalls: acc.ascensionCalls + (isAsc ? 1 : 0),
      revenue: acc.revenue + (isAsc ? 0 : (c.revenue || 0)),
      cash: acc.cash + (isAsc ? 0 : (c.cash_collected || 0)),
      contractValue: acc.contractValue + (isAsc ? (c.revenue || 0) : 0),
      ascendCash: acc.ascendCash + (isAsc ? (c.cash_collected || 0) : 0),
      newCall: acc.newCall + (c.call_type === 'new_call' ? 1 : 0),
      followUp: acc.followUp + (c.call_type === 'follow_up' ? 1 : 0),
      financeOffered: acc.financeOffered + (isAsc && c.offered_finance ? 1 : 0),
      financeAccepted: acc.financeAccepted + (isAsc && c.offered_finance && (c.outcome === 'closed' || c.outcome === 'ascended') ? 1 : 0),
    }
  }, { booked: 0, showed: 0, noShows: 0, rescheduled: 0, offers: 0, closes: 0, ascensions: 0, ascensionCalls: 0, revenue: 0, cash: 0, contractValue: 0, ascendCash: 0, newCall: 0, followUp: 0, financeOffered: 0, financeAccepted: 0 })

  const showRate = summary.booked ? ((summary.showed / summary.booked) * 100).toFixed(0) : 0
  const closeRate = summary.showed ? ((summary.closes / summary.showed) * 100).toFixed(0) : 0
  const offerRate = summary.showed ? ((summary.offers / summary.showed) * 100).toFixed(0) : 0
  const rescheduleRate = summary.booked ? ((summary.rescheduled / summary.booked) * 100).toFixed(0) : 0

  const handleConfirmCloser = async () => {
    if (!selectedMember) return alert('Select a closer first')

    const eodData = {
      nc_booked: summary.newCall,
      fu_booked: summary.followUp,
      nc_no_shows: calls.filter(c => c.call_type === 'new_call' && c.outcome === 'no_show').length,
      fu_no_shows: calls.filter(c => ['follow_up'].includes(c.call_type) && c.outcome === 'no_show').length,
      live_nc_calls: calls.filter(c => c.call_type === 'new_call' && ['not_closed', 'closed'].includes(c.outcome)).length,
      live_fu_calls: calls.filter(c => c.call_type === 'follow_up' && ['not_closed', 'closed'].includes(c.outcome)).length,
      reschedules: summary.rescheduled,
      offers: summary.offers,
      closes: summary.closes,
      deposits: summary.ascensions,
      total_revenue: summary.revenue,
      total_cash_collected: summary.cash,
      ascend_cash: summary.ascendCash,
      ascend_revenue: summary.contractValue,
      notes: closerNotes,
    }

    const callRows = calls.map(c => ({
      call_type: c.call_type,
      prospect_name: c.lead_name,
      showed: c.call_type === 'ascension' ? true : ['not_closed', 'closed'].includes(c.outcome),
      outcome: c.outcome,
      revenue: c.revenue,
      cash_collected: c.cash_collected,
      offered_finance: c.offered_finance || false,
      setter_lead_id: c.lead_id || null,
      ghl_event_id: c.ghl_event_id || null,
      notes: c.notes,
    }))

    const result = await submitCloserEOD(selectedMember, selectedDate, eodData, callRows)

    if (result.success) {
      // Update setter_leads status for calls that have a lead_id
      for (const c of calls) {
        if (c.lead_id && c.outcome !== c.existing_status) {
          await supabase
            .from('setter_leads')
            .update({ status: c.outcome, revenue_attributed: c.revenue || 0, updated_at: new Date().toISOString() })
            .eq('id', c.lead_id)
        }
      }

      // Auto-sync aggregated closer EOD data to marketing_tracker for this date
      try {
        const [{ data: allEODs }, { data: allCalls }] = await Promise.all([
          supabase.from('closer_eod_reports').select('*').eq('report_date', selectedDate),
          supabase.from('closer_calls').select('call_type, revenue, cash_collected, outcome')
            .in('eod_report_id', (await supabase.from('closer_eod_reports').select('id').eq('report_date', selectedDate)).data?.map(r => r.id) || []),
        ])
        if (allEODs?.length) {
          const agg = allEODs.reduce((a, r) => ({
            offers: a.offers + (r.offers || 0),
            closes: a.closes + (r.closes || 0),
            trial_cash: a.trial_cash + parseFloat(r.total_cash_collected || 0),
            trial_revenue: a.trial_revenue + parseFloat(r.total_revenue || 0),
            ascensions: a.ascensions + (r.deposits || 0),
            live_calls: a.live_calls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
            booked: a.booked + (r.nc_booked || 0) + (r.fu_booked || 0),
            reschedules: a.reschedules + (r.reschedules || 0),
          }), { offers: 0, closes: 0, trial_cash: 0, trial_revenue: 0, ascensions: 0, live_calls: 0, booked: 0, reschedules: 0 })
          // Split ascension + finance data from calls
          const callAgg = (allCalls || []).reduce((a, c) => ({
            ascCash: a.ascCash + (c.call_type === 'ascension' ? parseFloat(c.cash_collected || 0) : 0),
            ascRevenue: a.ascRevenue + (c.call_type === 'ascension' ? parseFloat(c.revenue || 0) : 0),
            financeOffers: a.financeOffers + (c.call_type === 'ascension' && c.offered_finance ? 1 : 0),
            financeAccepted: a.financeAccepted + (c.call_type === 'ascension' && c.offered_finance && (c.outcome === 'closed' || c.outcome === 'ascended') ? 1 : 0),
          }), { ascCash: 0, ascRevenue: 0, financeOffers: 0, financeAccepted: 0 })
          // Fetch existing row to merge (preserve adspend, leads, etc.)
          const { data: existingRows } = await supabase
            .from('marketing_tracker')
            .select('*')
            .eq('date', selectedDate)
            .limit(1)
          const existing = existingRows?.[0] || {}
          await supabase.from('marketing_tracker').upsert({
            ...existing,
            date: selectedDate,
            offers: agg.offers,
            closes: agg.closes,
            trial_cash: agg.trial_cash,
            trial_revenue: agg.trial_revenue,
            ascensions: agg.ascensions,
            ascend_cash: callAgg.ascCash,
            ascend_revenue: callAgg.ascRevenue,
            finance_offers: callAgg.financeOffers,
            finance_accepted: callAgg.financeAccepted,
            live_calls: agg.live_calls,
            calls_on_calendar: agg.booked,
            reschedules: agg.reschedules,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'date' })
        }
      } catch (syncErr) {
        console.error('Marketing tracker sync failed:', syncErr)
      }

      setConfirmed(true)
    } else {
      alert('Failed: ' + result.error)
    }
  }

  // Setter state
  const [setterData, setSetterData] = useState({
    total_leads: 0, outbound_calls: 0, pickups: 0,
    meaningful_conversations: 0, sets: 0, reschedules: 0,
    self_rating: 7, what_went_well: '', what_went_poorly: '',
  })
  const updateSetter = (key, val) => setSetterData(d => ({ ...d, [key]: val }))
  const [setterSetLeads, setSetterSetLeads] = useState([])
  const [setterRescheduleLeads, setSetterRescheduleLeads] = useState([])

  // Saved leads for read-only view
  const [savedSetterLeads, setSavedSetterLeads] = useState([])

  // Load existing setter EOD data + assigned leads when viewing a past date
  useEffect(() => {
    if (tab !== 'setter' || !selectedMember) return
    async function loadExistingSetterEOD() {
      const { data } = await supabase
        .from('setter_eod_reports')
        .select('*')
        .eq('setter_id', selectedMember)
        .eq('report_date', selectedDate)
        .limit(1)
      if (data?.[0]) {
        const eod = data[0]
        setSetterData({
          total_leads: eod.total_leads || 0,
          outbound_calls: eod.outbound_calls || 0,
          pickups: eod.pickups || 0,
          meaningful_conversations: eod.meaningful_conversations || 0,
          sets: eod.sets || 0,
          reschedules: eod.reschedules || 0,
          self_rating: eod.self_rating || 7,
          what_went_well: eod.what_went_well || '',
          what_went_poorly: eod.what_went_poorly || '',
        })
        if (eod.is_confirmed) setConfirmed(true)

        // Load assigned leads for this EOD (read-only view + pre-fill edit form)
        const { data: leads } = await supabase
          .from('setter_leads')
          .select('id, lead_name, lead_source, date_set, appointment_date, status, closer:team_members!setter_leads_closer_id_fkey(name)')
          .eq('setter_id', selectedMember)
          .eq('date_set', selectedDate)
          .order('id')
        setSavedSetterLeads(leads || [])
        // Pre-fill the edit form's lead assignments
        const setLeadsList = (leads || []).filter(l => l.status === 'set' || l.status === 'booked' || l.status === 'showed' || l.status === 'closed' || l.status === 'not_closed' || l.status === 'no_show')
        const reschLeadsList = (leads || []).filter(l => l.status === 'rescheduled')
        setSetterSetLeads(setLeadsList.map(l => ({ id: l.id, lead_name: l.lead_name, lead_source: l.lead_source, appointment_date: l.appointment_date, _source: 'lead' })))
        setSetterRescheduleLeads(reschLeadsList.map(l => ({ id: l.id, lead_name: l.lead_name, lead_source: l.lead_source, _source: 'lead' })))
      } else {
        setSetterData({
          total_leads: 0, outbound_calls: 0, pickups: 0,
          meaningful_conversations: 0, sets: 0, reschedules: 0,
          self_rating: 7, what_went_well: '', what_went_poorly: '',
        })
        setSavedSetterLeads([])
        setConfirmed(false)
      }
    }
    loadExistingSetterEOD()
  }, [tab, selectedMember, selectedDate])

  const handleConfirmSetter = async () => {
    if (!selectedMember) return alert('Select a setter first')
    const result = await submitSetterEOD(selectedMember, selectedDate, setterData)
    if (result.success) {
      // Create setter_leads records for each assigned set lead
      for (const lead of setterSetLeads) {
        if (!lead) continue
        const { data: existing } = await supabase
          .from('setter_leads')
          .select('id')
          .eq('setter_id', selectedMember)
          .eq('lead_name', lead.lead_name)
          .eq('date_set', selectedDate)
          .limit(1)
        if (existing?.length) continue

        await supabase.from('setter_leads').insert({
          setter_id: selectedMember,
          lead_name: lead.lead_name,
          lead_source: lead.lead_source || 'manual',
          date_set: selectedDate,
          appointment_date: lead.appointment_date || null,
          status: 'set',
          eod_report_id: result.report?.id || null,
        })
      }
      // Update reschedule leads to 'rescheduled' status
      for (const lead of setterRescheduleLeads) {
        if (!lead) continue
        if (lead._source === 'lead' && lead.id) {
          // Update existing setter_lead status
          await supabase.from('setter_leads')
            .update({ status: 'rescheduled', updated_at: new Date().toISOString() })
            .eq('id', lead.id)
        } else {
          // Create new record if from GHL
          const { data: existing } = await supabase
            .from('setter_leads')
            .select('id')
            .eq('setter_id', selectedMember)
            .eq('lead_name', lead.lead_name)
            .eq('date_set', selectedDate)
            .limit(1)
          if (!existing?.length) {
            await supabase.from('setter_leads').insert({
              setter_id: selectedMember,
              lead_name: lead.lead_name,
              lead_source: lead.lead_source || 'manual',
              date_set: selectedDate,
              appointment_date: lead.appointment_date || null,
              status: 'rescheduled',
              eod_report_id: result.report?.id || null,
            })
          }
        }
      }
      setConfirmed(true)
    } else {
      alert('Failed: ' + result.error)
    }
  }

  const members = tab === 'closer' ? closers : setters
  const selectedName = members.find(m => m.id === selectedMember)?.name || ''
  const [eodStarted, setEodStarted] = useState(() => {
    // Auto-start if navigated with a tab param or non-admin with locked member
    const params = new URLSearchParams(window.location.search)
    return !!params.get('tab') || (!isAdmin && !!profile?.teamMemberId)
  })

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">End of Day</h1>
          <p className="text-xs sm:text-sm text-text-400 mt-0.5 sm:mt-1">{eodStarted ? 'File your daily report' : 'Review and submit EOD reports'}</p>
        </div>
        {!eodStarted && (
          <button
            onClick={() => setEodStarted(true)}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-opt-yellow text-bg-primary font-semibold text-sm hover:brightness-110 transition-all shadow-[0_0_20px_rgba(212,245,12,0.1)]"
          >
            <Plus size={16} />
            New EOD
          </button>
        )}
      </div>

      {/* ── Landing view: no EOD started yet ── */}
      {!eodStarted ? (
        <div className="space-y-6">
          {/* Quick action cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { t: 'closer', label: 'Closer EOD', desc: 'Log calls, outcomes, revenue and cash collected', icon: '📊' },
              { t: 'setter', label: 'Setter EOD', desc: 'Log dials, pickups, MCs, sets and reschedules', icon: '📞' },
            ].map(card => {
              const allowed = canFileEOD(card.t)
              return (
                <button
                  key={card.t}
                  onClick={() => { if (allowed) { setTab(card.t); setEodStarted(true) } }}
                  disabled={!allowed}
                  className={`bg-bg-card border rounded-2xl p-6 text-left transition-all ${
                    allowed ? 'border-border-default hover:border-opt-yellow/40 hover:bg-bg-card-hover cursor-pointer' : 'border-border-default opacity-50 cursor-not-allowed'
                  }`}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-2xl">{card.icon}</span>
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{card.label}</p>
                      <p className="text-xs text-text-400">{card.desc}</p>
                    </div>
                    {!allowed && <Lock size={14} className="text-text-400 ml-auto" />}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Recent EOD history (all team) */}
          {allEodHistory.length > 0 && (
            <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-border-default">
                <h2 className="text-sm font-semibold text-text-primary">Recent EODs</h2>
              </div>
              <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-bg-card">
                    <tr className="text-[10px] text-text-400 uppercase border-b border-border-default">
                      <th className="py-2 px-4 text-left">Date</th>
                      <th className="py-2 px-4 text-left">Name</th>
                      <th className="py-2 px-4 text-left">Type</th>
                      <th className="py-2 px-4 text-right">{tab === 'closer' ? 'Closes' : 'Sets'}</th>
                      <th className="py-2 px-4 text-right">{tab === 'closer' ? 'Cash' : 'Dials'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allEodHistory.slice(0, 20).map(eod => {
                      const name = eod.closer?.name || eod.setter?.name || '—'
                      return (
                        <tr key={eod.id} className="border-b border-border-default/30 hover:bg-bg-card-hover cursor-pointer transition-colors"
                          onClick={() => {
                            setSelectedMember(eod.closer_id || eod.setter_id)
                            setSelectedDate(eod.report_date)
                            setEodStarted(true)
                            // Respect confirmed status — show read-only if already submitted
                            setConfirmed(!!eod.is_confirmed)
                          }}
                        >
                          <td className="py-2 px-4 text-text-secondary">{formatDateLabel(eod.report_date)}</td>
                          <td className="py-2 px-4 font-medium">{name}</td>
                          <td className="py-2 px-4"><span className="text-[10px] px-1.5 py-0.5 rounded bg-opt-yellow-subtle text-opt-yellow">{tab}</span></td>
                          <td className="py-2 px-4 text-right font-semibold">{tab === 'closer' ? (eod.closes || 0) : (eod.sets || 0)}</td>
                          <td className="py-2 px-4 text-right text-success font-medium">{tab === 'closer' ? `$${parseFloat(eod.total_cash_collected || 0).toLocaleString()}` : (eod.outbound_calls || 0)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
      <>
      {/* ── Active EOD: member/date selection + form ── */}
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <button
          onClick={() => { setEodStarted(false); setSelectedMember(isAdmin ? '' : (profile?.teamMemberId || '')) }}
          className="text-xs text-text-400 hover:text-text-primary transition-colors mr-1"
        >
          ← Back
        </button>
        <div className="flex gap-1">
          {['closer', 'setter'].map(t => {
            const allowed = canFileEOD(t)
            return (
              <button
                key={t}
                onClick={() => {
                  if (!allowed) return
                  setTab(t)
                  setConfirmed(false)
                  setSelectedMember(isAdmin ? '' : (profile?.teamMemberId || ''))
                }}
                disabled={!allowed}
                className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 transition-all ${
                  tab === t ? 'bg-opt-yellow text-bg-primary font-semibold'
                    : allowed ? 'bg-bg-card text-text-secondary border border-border-default hover:bg-bg-card-hover'
                    : 'bg-bg-card text-text-400/50 border border-border-default cursor-not-allowed'
                }`}
              >
                {!allowed && <Lock size={10} />}
                {t === 'closer' ? 'Closer' : 'Setter'}
              </button>
            )
          })}
        </div>
        <select
          value={selectedMember}
          onChange={e => { setSelectedMember(e.target.value); setConfirmed(false) }}
          disabled={!isAdmin && !!profile?.teamMemberId}
          className="bg-bg-card border border-border-default rounded-xl px-3 py-1.5 text-sm text-text-primary disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <option value="">Select {tab}...</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        {!isAdmin && profile?.teamMemberId && (
          <span className="text-[10px] text-text-400 flex items-center gap-1"><Lock size={10} /> Locked to your account</span>
        )}
      </div>

      {/* Date selector */}
      <div className="flex items-center gap-2 mb-5">
        <Calendar size={14} className="text-text-400" />
        <button
          onClick={() => shiftDate(-1)}
          className="p-1 rounded-lg hover:bg-bg-card-hover text-text-400 hover:text-text-primary"
        >
          <ChevronLeft size={16} />
        </button>
        <input
          type="date"
          value={selectedDate}
          max={today}
          onChange={e => setSelectedDate(e.target.value)}
          className="bg-bg-card border border-border-default rounded-xl px-3 py-1.5 text-sm text-text-primary"
        />
        <button
          onClick={() => shiftDate(1)}
          disabled={selectedDate >= today}
          className="p-1 rounded-lg hover:bg-bg-card-hover text-text-400 hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronRight size={16} />
        </button>
        <span className="text-xs text-text-400">{formatDateLabel(selectedDate)}</span>
        {selectedDate !== today && (
          <button
            onClick={() => setSelectedDate(today)}
            className="text-[10px] text-opt-yellow hover:underline ml-1"
          >
            Jump to today
          </button>
        )}
        {selectedMember && (
          <button
            onClick={tab === 'closer' ? handleRefreshCloser : handleRefreshSetter}
            disabled={syncing}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] text-text-400 hover:text-opt-yellow border border-border-default hover:border-opt-yellow/30 ml-auto disabled:opacity-50"
            title={tab === 'closer' ? 'Refresh calendar, Fathom transcripts & leads' : 'Refresh WAVV dials & stats'}
          >
            <RefreshCw size={10} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Refreshing...' : 'Refresh'}
          </button>
        )}
      </div>

      {/* Closer EOD */}
      {tab === 'closer' && selectedMember && (
        <>
          {/* Confirmed state — read-only summary + call details with Edit button */}
          {confirmed && (
            <div className="space-y-4 mb-4">
              <div className="bg-bg-card border border-success/30 rounded-2xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-success/15 flex items-center justify-center">
                      <Check size={20} className="text-success" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-success">EOD Submitted</p>
                      <p className="text-xs text-text-400">{selectedName} &middot; {formatDateLabel(selectedDate).split(' — ').pop()}</p>
                    </div>
                  </div>
                  {(isAdmin || (profile?.teamMemberId === selectedMember)) && (
                    <button
                      onClick={() => setConfirmed(false)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-400 hover:text-opt-yellow border border-border-default hover:border-opt-yellow/30 transition-colors"
                    >
                      <Edit3 size={12} />
                      Edit
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
                  <div className="text-center p-3 bg-bg-primary rounded-2xl">
                    <p className="text-xl font-bold">{summary.booked}</p>
                    <p className="text-[10px] text-text-400 uppercase">Booked</p>
                  </div>
                  <div className="text-center p-3 bg-bg-primary rounded-2xl">
                    <p className="text-xl font-bold">{summary.showed}</p>
                    <p className="text-[10px] text-text-400 uppercase">Live Calls</p>
                  </div>
                  <div className="text-center p-3 bg-bg-primary rounded-2xl">
                    <p className="text-xl font-bold text-danger">{summary.noShows}</p>
                    <p className="text-[10px] text-text-400 uppercase">No Shows</p>
                  </div>
                  <div className="text-center p-3 bg-bg-primary rounded-2xl">
                    <p className="text-xl font-bold text-blue-400">{summary.rescheduled}</p>
                    <p className="text-[10px] text-text-400 uppercase">Rescheduled</p>
                  </div>
                  <div className="text-center p-3 bg-bg-primary rounded-2xl">
                    <p className="text-xl font-bold">{summary.offers}</p>
                    <p className="text-[10px] text-text-400 uppercase">Offers</p>
                  </div>
                  <div className="text-center p-3 bg-bg-primary rounded-2xl">
                    <p className="text-xl font-bold text-success">{summary.closes}</p>
                    <p className="text-[10px] text-text-400 uppercase">Closes</p>
                  </div>
                  <div className="text-center p-3 bg-bg-primary rounded-2xl">
                    <p className="text-xl font-bold text-opt-yellow">${summary.cash.toLocaleString()}</p>
                    <p className="text-[10px] text-text-400 uppercase">Cash</p>
                  </div>
                  <div className="text-center p-3 bg-bg-primary rounded-2xl">
                    <p className="text-xl font-bold text-success">${summary.revenue.toLocaleString()}</p>
                    <p className="text-[10px] text-text-400 uppercase">Revenue</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-border-default text-xs text-text-400">
                  {summary.ascendCash > 0 && <span>Ascend Cash: <strong className="text-cyan-400">${summary.ascendCash.toLocaleString()}</strong></span>}
                  {summary.contractValue > 0 && <span>Ascend Revenue: <strong className="text-cyan-400">${summary.contractValue.toLocaleString()}</strong></span>}
                  {summary.ascensions > 0 && <span>Ascended: <strong className="text-cyan-400">{summary.ascensions}/{summary.ascensionCalls}</strong></span>}
                  <span>Show Rate: <strong className={parseFloat(showRate) >= 70 ? 'text-success' : 'text-danger'}>{showRate}%</strong></span>
                  <span>Offer Rate: <strong className={parseFloat(offerRate) >= 80 ? 'text-success' : 'text-text-secondary'}>{offerRate}%</strong></span>
                  <span>Close Rate: <strong className={parseFloat(closeRate) >= 25 ? 'text-success' : 'text-text-secondary'}>{closeRate}%</strong></span>
                </div>
              </div>

              {/* Read-only call details — expandable */}
              {calls.length > 0 && (
                <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-border-default">
                    <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider">{calls.length} Calls</p>
                  </div>
                  <div className="divide-y divide-border-default/30">
                    {calls.map((call, i) => {
                      const key = call.ghl_event_id || call.lead_id || `ro-${i}`
                      const isAsc = call.call_type === 'ascension'
                      const outcomeBadge = call.outcome === 'closed' ? { label: 'Closed', cls: 'bg-success/15 text-success' }
                        : call.outcome === 'ascended' ? { label: 'Ascended', cls: 'bg-cyan-500/15 text-cyan-400' }
                        : call.outcome === 'no_show' ? { label: 'No Show', cls: 'bg-danger/15 text-danger' }
                        : call.outcome === 'rescheduled' ? { label: 'Rescheduled', cls: 'bg-blue-500/15 text-blue-400' }
                        : call.outcome === 'not_closed' ? { label: 'Not Closed', cls: 'bg-text-400/15 text-text-400' }
                        : call.outcome === 'not_ascended' ? { label: "Didn't Ascend", cls: 'bg-text-400/15 text-text-400' }
                        : { label: call.outcome || '—', cls: 'bg-text-400/15 text-text-400' }
                      const typeBadge = isAsc ? { label: 'ASC', cls: 'text-cyan-400' }
                        : call.call_type === 'follow_up' ? { label: 'FU', cls: 'text-purple-400' }
                        : { label: 'NC', cls: 'text-opt-yellow' }
                      const isExpanded = expandedCall === key
                      const hasDetail = call.notes || call.fathom_summary || call.contact_email || call.contact_phone

                      return (
                        <div key={key}>
                          <div
                            className="px-5 py-3 flex items-center gap-3 cursor-pointer hover:bg-bg-card-hover/50 transition-colors"
                            onClick={() => setExpandedCall(isExpanded ? null : key)}
                          >
                            <ChevronDown size={12} className={`text-text-400 transition-transform flex-shrink-0 ${isExpanded ? '' : '-rotate-90'}`} />
                            <span className={`text-[10px] font-semibold ${typeBadge.cls} w-6`}>{typeBadge.label}</span>
                            <span className="font-medium text-sm min-w-[120px]">{call.lead_name}</span>
                            {call.start_time && <span className="text-xs text-text-400 font-mono">{call.start_time}</span>}
                            {call.setter_name && call.setter_name !== '—' && (
                              <span className="text-[10px] text-text-400 bg-bg-primary px-1.5 py-0.5 rounded">{call.setter_name}</span>
                            )}
                            <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${outcomeBadge.cls}`}>{outcomeBadge.label}</span>
                            <div className="ml-auto flex items-center gap-3 text-xs">
                              {call.cash_collected > 0 && <span className="text-opt-yellow font-medium">${parseFloat(call.cash_collected).toLocaleString()} cash</span>}
                              {call.revenue > 0 && <span className="text-success">${parseFloat(call.revenue).toLocaleString()} rev</span>}
                              {call.fathom_summary && <MessageSquare size={10} className="text-text-400" />}
                            </div>
                          </div>
                          {isExpanded && (
                            <div className="px-5 pb-3 pl-12 space-y-2">
                              {/* Contact info */}
                              {(call.contact_email || call.contact_phone) && (
                                <div className="flex gap-4 text-xs text-text-400">
                                  {call.contact_email && <span>Email: <strong className="text-text-secondary">{call.contact_email}</strong></span>}
                                  {call.contact_phone && <span>Phone: <strong className="text-text-secondary">{call.contact_phone}</strong></span>}
                                </div>
                              )}
                              {/* Financials */}
                              {(call.revenue > 0 || call.cash_collected > 0) && (
                                <div className="flex gap-4 text-xs">
                                  <span className="text-text-400">Revenue: <strong className="text-success">${parseFloat(call.revenue || 0).toLocaleString()}</strong></span>
                                  <span className="text-text-400">Cash: <strong className="text-opt-yellow">${parseFloat(call.cash_collected || 0).toLocaleString()}</strong></span>
                                </div>
                              )}
                              {/* Fathom summary */}
                              {call.fathom_summary && (
                                <div className="bg-bg-primary rounded-xl p-3">
                                  <p className="text-[10px] text-text-400 uppercase mb-1 flex items-center gap-1">
                                    <MessageSquare size={10} /> Fathom Summary
                                    {call.fathom_duration && <span className="ml-1">({Math.round(call.fathom_duration / 60)}m)</span>}
                                  </p>
                                  <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">{call.fathom_summary}</p>
                                </div>
                              )}
                              {/* Notes */}
                              {call.notes && !call.fathom_summary && (
                                <div className="text-xs text-text-400">
                                  <span className="uppercase text-[10px]">Notes: </span>
                                  <span className="text-text-secondary">{call.notes}</span>
                                </div>
                              )}
                              {!hasDetail && (
                                <p className="text-[10px] text-text-400 italic">No additional details recorded</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Notes */}
              {closerNotes && (
                <div className="bg-bg-card border border-border-default rounded-2xl p-4">
                  <p className="text-[10px] text-text-400 uppercase mb-1">Notes</p>
                  <p className="text-sm text-text-secondary">{closerNotes}</p>
                </div>
              )}
            </div>
          )}

          {confirmed ? null : loadingCalls ? (
            <div className="flex items-center justify-center h-32"><Loader className="animate-spin text-opt-yellow" /></div>
          ) : calls.length === 0 ? (
            <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center text-text-400 text-sm">
              <p>No booked calls for {selectedName} on {formatDateLabel(selectedDate).split(' — ').pop() || selectedDate}.</p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <button
                  onClick={() => setShowLeadPicker(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-opt-yellow border border-opt-yellow/30 hover:bg-opt-yellow/10 transition-colors"
                >
                  <Plus size={12} />
                  Add Call Manually
                </button>
                <button
                  onClick={() => setShowDealUpdater(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-success border border-success/30 hover:bg-success/10 transition-colors"
                >
                  <Edit3 size={12} />
                  Update Deal
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
              {/* Left: call list */}
              <div className="space-y-1">
                <p className="text-[11px] text-text-400 uppercase mb-2">
                  {calls.length} calls &middot; Mark outcomes below
                  {(() => {
                    const hasCalendar = calls.some(c => c._rowSource === 'calendar')
                    const hasLeads = calls.some(c => c._rowSource === 'lead')
                    return (
                      <>
                        {hasCalendar && (
                          <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-medium bg-success/15 text-success">
                            GHL Calendar
                          </span>
                        )}
                        {hasLeads && (
                          <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-blue-500/15 text-blue-400">
                            + Leads
                          </span>
                        )}
                      </>
                    )
                  })()}
                </p>

                {/* Call cards */}
                <div className="space-y-2">
                  {calls.map((call, i) => {
                    const outcomes = getOutcomeOptions(call.call_type)
                    const isAscension = call.call_type === 'ascension'
                    const isClosedOrAscended = call.outcome === 'closed' || call.outcome === 'ascended'
                    const isNoShow = call.outcome === 'no_show'
                    const isRescheduled = call.outcome === 'rescheduled'
                    const showInputs = isClosedOrAscended
                    const typeBadge = isAscension ? { label: 'ASC', cls: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' }
                      : call.call_type === 'follow_up' ? { label: 'FU', cls: 'bg-purple-500/15 text-purple-400 border-purple-500/30' }
                      : { label: 'NC', cls: 'bg-opt-yellow/15 text-opt-yellow border-opt-yellow/30' }

                    return (
                    <div key={call.ghl_event_id || call.lead_id || `manual-${i}`}
                      className={`bg-bg-card border rounded-2xl overflow-hidden transition-colors ${
                        isClosedOrAscended ? 'border-success/30' : isNoShow ? 'border-danger/30' : isRescheduled ? 'border-blue-400/30' : 'border-border-default'
                      }`}
                    >
                      {/* Card header */}
                      <div className="px-4 py-3">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${typeBadge.cls}`}>{typeBadge.label}</span>
                            <span className="font-medium text-sm truncate">{call.lead_name}</span>
                            {call.start_time && <span className="text-xs text-text-400 font-mono flex-shrink-0">{call.start_time}</span>}
                            {call.setter_name && call.setter_name !== '—' && (
                              <span className="text-[10px] text-text-400 flex-shrink-0 bg-bg-primary px-1.5 py-0.5 rounded">{call.setter_name}</span>
                            )}
                            {call.is_manual && <span className="text-[10px] text-opt-yellow flex-shrink-0">manual</span>}
                          </div>
                          <select value={call.call_type}
                            onChange={e => {
                              const newType = e.target.value
                              updateCall(i, 'call_type', newType)
                              if (newType === 'ascension') updateCall(i, 'outcome', 'not_ascended')
                              else if (['ascended', 'not_ascended'].includes(call.outcome)) updateCall(i, 'outcome', 'no_show')
                            }}
                            className="bg-bg-primary border border-border-default rounded px-2 py-1 text-[11px] ml-2 flex-shrink-0">
                            <option value="new_call">Closing</option>
                            <option value="ascension">Ascension</option>
                            <option value="follow_up">Follow Up</option>
                          </select>
                        </div>

                        {/* Outcome pills */}
                        <div className="flex items-center gap-1.5 mb-3">
                          {outcomes.map(o => (
                            <button key={o.value}
                              onClick={() => {
                                updateCall(i, 'outcome', o.value)
                                if (o.value === 'closed') updateCall(i, 'offered', true)
                              }}
                              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                                call.outcome === o.value
                                  ? o.value === 'closed' || o.value === 'ascended' ? 'bg-success text-white'
                                    : o.value === 'no_show' ? 'bg-danger text-white'
                                    : o.value === 'rescheduled' ? 'bg-blue-500 text-white'
                                    : o.value === 'not_ascended' ? 'bg-text-400/80 text-white'
                                    : 'bg-text-400/60 text-white'
                                  : 'bg-bg-primary text-text-400 hover:text-text-primary hover:bg-bg-primary/80 border border-border-default'
                              }`}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>

                        {/* Offered toggle — show for live closing calls */}
                        {!isAscension && ['not_closed', 'closed'].includes(call.outcome) && (
                          <div className="flex items-center gap-2 mb-3">
                            <span className="text-[10px] text-text-400 uppercase">Offered?</span>
                            <button
                              onClick={() => updateCall(i, 'offered', true)}
                              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                                call.offered ? 'bg-opt-yellow text-bg-primary' : 'bg-bg-primary text-text-400 border border-border-default hover:text-text-primary'
                              }`}
                            >Yes</button>
                            <button
                              onClick={() => updateCall(i, 'offered', false)}
                              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                                call.offered === false ? 'bg-text-400/60 text-white' : 'bg-bg-primary text-text-400 border border-border-default hover:text-text-primary'
                              }`}
                            >No</button>
                          </div>
                        )}

                        {/* Money inputs — only show when closed/ascended */}
                        {showInputs && (
                          <div className="flex items-center gap-3 mb-3">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-text-400 uppercase">Cash</span>
                              <div className="relative">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-text-400">$</span>
                                <input type="number" value={call.cash_collected || ''} placeholder="0"
                                  onChange={e => updateCall(i, 'cash_collected', parseFloat(e.target.value) || 0)}
                                  className="bg-bg-primary border border-border-default rounded pl-5 pr-2 py-1.5 text-sm text-right w-28 text-opt-yellow" />
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-text-400 uppercase">{isAscension ? 'Contract' : 'Revenue'}</span>
                              <div className="relative">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-text-400">$</span>
                                <input type="number" value={call.revenue || ''} placeholder="0"
                                  onChange={e => updateCall(i, 'revenue', parseFloat(e.target.value) || 0)}
                                  className="bg-bg-primary border border-border-default rounded pl-5 pr-2 py-1.5 text-sm text-right w-28 text-success" />
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Offered Finance — ascension calls only */}
                        {isAscension && ['not_ascended', 'ascended'].includes(call.outcome) && (
                          <div className="flex items-center gap-2 mb-3">
                            <span className="text-[10px] text-text-400 uppercase">Offered Finance?</span>
                            <button
                              onClick={() => updateCall(i, 'offered_finance', true)}
                              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                                call.offered_finance ? 'bg-purple-500 text-white' : 'bg-bg-primary text-text-400 border border-border-default hover:text-text-primary'
                              }`}
                            >Yes</button>
                            <button
                              onClick={() => updateCall(i, 'offered_finance', false)}
                              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                                call.offered_finance === false ? 'bg-text-400/60 text-white' : 'bg-bg-primary text-text-400 border border-border-default hover:text-text-primary'
                              }`}
                            >No</button>
                          </div>
                        )}

                        {/* Notes toggle */}
                        <button
                          onClick={() => setExpandedCall(expandedCall === i ? null : i)}
                          className="flex items-center gap-1.5 text-[11px] text-text-400 hover:text-text-secondary transition-colors"
                        >
                          <MessageSquare size={12} />
                          {call.notes ? 'Edit Notes' : 'Add Notes'}
                          {call.fathom_duration ? ` (${Math.round(call.fathom_duration / 60)} min)` : ''}
                        </button>
                      </div>

                      {/* Notes panel */}
                      {expandedCall === i && (
                        <div className="px-4 pb-4">
                          <textarea
                            value={call.notes}
                            onChange={e => updateCall(i, 'notes', e.target.value)}
                            placeholder="Call summary, objections, next steps..."
                            className="bg-bg-primary border border-border-default rounded px-3 py-2.5 text-sm w-full h-36 resize-y leading-relaxed"
                          />
                        </div>
                      )}
                    </div>
                  )})}
                </div>

                {/* Add Call + Update Deal buttons */}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => setShowLeadPicker(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-400 hover:text-opt-yellow border border-dashed border-border-default hover:border-opt-yellow/30 transition-colors"
                  >
                    <Plus size={12} />
                    Add Call
                  </button>
                  <button
                    onClick={() => setShowDealUpdater(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-400 hover:text-success border border-dashed border-border-default hover:border-success/30 transition-colors"
                  >
                    <Edit3 size={12} />
                    Update Deal
                  </button>
                </div>

                {/* EOD notes */}
                <div className="mt-3">
                  <textarea
                    value={closerNotes}
                    onChange={e => setCloserNotes(e.target.value)}
                    placeholder="Overall notes for today..."
                    className="bg-bg-card border border-border-default rounded px-3 py-2 text-xs w-full h-14 resize-none"
                  />
                </div>
              </div>

              {/* Right: summary sidebar */}
              <div className="space-y-3">
                <div className="bg-bg-card border border-border-default rounded-2xl p-5 sticky top-20">
                  <h3 className="text-xs text-opt-yellow uppercase font-medium mb-4">{selectedName} &middot; {formatDateLabel(selectedDate).split(' — ').pop()}</h3>

                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div className="text-center">
                      <p className="text-2xl font-bold">{summary.booked}</p>
                      <p className="text-[10px] text-text-400">Booked</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold">{summary.showed}</p>
                      <p className="text-[10px] text-text-400">Live</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-danger">{summary.noShows}</p>
                      <p className="text-[10px] text-text-400">No Shows</p>
                    </div>
                  </div>

                  <div className="space-y-2 mb-3">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Show Rate</span>
                      <span className={parseFloat(showRate) >= 70 ? 'text-success' : 'text-danger'}>{showRate}%</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Offer Rate</span>
                      <span className={parseFloat(offerRate) >= 80 ? 'text-success' : 'text-text-secondary'}>{offerRate}%</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Close Rate</span>
                      <span className={parseFloat(closeRate) >= 25 ? 'text-success' : 'text-text-secondary'}>{closeRate}%</span>
                    </div>
                    {summary.rescheduled > 0 && (
                      <div className="flex justify-between text-xs">
                        <span className="text-text-400">Reschedule Rate</span>
                        <span className="text-blue-400">{rescheduleRate}%</span>
                      </div>
                    )}
                  </div>

                  <div className="border-t border-border-default pt-3 space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Offers</span>
                      <span className="text-text-primary font-medium">{summary.offers}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Closes</span>
                      <span className="text-success font-medium">{summary.closes}</span>
                    </div>
                    {summary.ascensionCalls > 0 && (
                      <div className="flex justify-between text-xs">
                        <span className="text-text-400">Ascended</span>
                        <span className="text-cyan-400 font-medium">{summary.ascensions}/{summary.ascensionCalls}</span>
                      </div>
                    )}
                    {summary.rescheduled > 0 && (
                      <div className="flex justify-between text-xs">
                        <span className="text-text-400">Rescheduled</span>
                        <span className="text-blue-400">{summary.rescheduled}</span>
                      </div>
                    )}
                  </div>

                  <div className="border-t border-border-default pt-3 mt-3 space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Trial Cash</span>
                      <span className="text-opt-yellow font-medium">${summary.cash.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Trial Revenue</span>
                      <span className="text-success font-medium">${summary.revenue.toLocaleString()}</span>
                    </div>
                    {summary.ascendCash > 0 && (
                      <div className="flex justify-between text-xs">
                        <span className="text-text-400">Ascend Cash</span>
                        <span className="text-cyan-400 font-medium">${summary.ascendCash.toLocaleString()}</span>
                      </div>
                    )}
                    {summary.contractValue > 0 && (
                      <div className="flex justify-between text-xs">
                        <span className="text-text-400">Ascend Revenue</span>
                        <span className="text-cyan-400 font-medium">${summary.contractValue.toLocaleString()}</span>
                      </div>
                    )}
                    {summary.financeOffered > 0 && (
                      <div className="flex justify-between text-xs">
                        <span className="text-text-400">On Finance</span>
                        <span>{summary.financeOffered}</span>
                      </div>
                    )}
                  </div>

                  <div className="border-t border-border-default pt-3 mt-3 flex flex-wrap gap-2 text-[10px] text-text-400">
                    <span className="px-1.5 py-0.5 rounded bg-bg-primary">Closing: {summary.newCall}</span>
                    {summary.ascensionCalls > 0 && <span className="px-1.5 py-0.5 rounded bg-bg-primary">Ascension: {summary.ascensionCalls}</span>}
                    {summary.followUp > 0 && <span className="px-1.5 py-0.5 rounded bg-bg-primary">Follow Up: {summary.followUp}</span>}
                  </div>

                  <button
                    onClick={handleConfirmCloser}
                    disabled={confirmed || submitting}
                    className={`w-full mt-4 flex items-center justify-center gap-2 px-4 py-2.5 rounded font-medium text-sm transition-colors ${
                      confirmed
                        ? 'bg-success/20 text-success border border-success/30'
                        : 'bg-opt-yellow text-bg-primary hover:bg-opt-yellow/90'
                    }`}
                  >
                    {submitting ? <Loader size={14} className="animate-spin" /> : <Check size={14} />}
                    {confirmed ? 'Confirmed' : submitting ? 'Saving...' : 'Confirm EOD'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Closer EOD History — below the form */}
          {closerHistory.length > 0 && (
            <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mt-6">
              <button
                onClick={() => setShowCloserHistory(!showCloserHistory)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-card-hover transition-colors"
              >
                <h3 className="text-[11px] text-text-400 uppercase font-medium">EOD History ({closerHistory.length})</h3>
                <ChevronRight size={14} className={`text-text-400 transition-transform ${showCloserHistory ? 'rotate-90' : ''}`} />
              </button>
              {showCloserHistory && (
                <div className="border-t border-border-default overflow-x-auto max-h-[400px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-bg-card z-10">
                      <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                        <th className="px-3 py-2.5 text-left">Date</th>
                        <th className="px-3 py-2.5 text-right">Booked</th>
                        <th className="px-3 py-2.5 text-right">Live</th>
                        <th className="px-3 py-2.5 text-right">No Shows</th>
                        <th className="px-3 py-2.5 text-right">Closes</th>
                        <th className="px-3 py-2.5 text-right">Asc</th>
                        <th className="px-3 py-2.5 text-right">Close %</th>
                        <th className="px-3 py-2.5 text-right">Show %</th>
                        <th className="px-3 py-2.5 text-right">Cash</th>
                        <th className="px-3 py-2.5 text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closerHistory.map(eod => {
                        const booked = (eod.nc_booked || 0) + (eod.fu_booked || 0)
                        const live = (eod.live_nc_calls || 0) + (eod.live_fu_calls || 0)
                        const noShows = (eod.nc_no_shows || 0) + (eod.fu_no_shows || 0)
                        const showPct = booked > 0 ? ((live / booked) * 100).toFixed(0) : '—'
                        const closePct = live > 0 ? (((eod.closes || 0) / live) * 100).toFixed(0) : '—'
                        const rev = parseFloat(eod.total_revenue || 0)
                        const cash = parseFloat(eod.total_cash_collected || 0)
                        return (
                          <tr key={eod.id} className={`border-b border-border-default/30 hover:bg-bg-card-hover/50 cursor-pointer ${(eod.closes || 0) > 0 ? 'bg-success/5' : ''}`}
                            onClick={() => { setSelectedDate(eod.report_date); setConfirmed(false) }}
                          >
                            <td className="px-3 py-2.5 font-medium">{formatDateLabel(eod.report_date)}</td>
                            <td className="px-3 py-2.5 text-right">{booked}</td>
                            <td className="px-3 py-2.5 text-right">{live}</td>
                            <td className="px-3 py-2.5 text-right text-danger">{noShows}</td>
                            <td className="px-3 py-2.5 text-right font-medium">{eod.closes || 0}</td>
                            <td className="px-3 py-2.5 text-right text-cyan-400">{eod.deposits || 0}</td>
                            <td className={`px-3 py-2.5 text-right ${closePct !== '—' && parseFloat(closePct) >= 30 ? 'text-success' : closePct !== '—' && parseFloat(closePct) >= 15 ? 'text-opt-yellow' : 'text-danger'}`}>{closePct !== '—' ? `${closePct}%` : '—'}</td>
                            <td className={`px-3 py-2.5 text-right ${showPct !== '—' && parseFloat(showPct) >= 70 ? 'text-success' : showPct !== '—' && parseFloat(showPct) >= 50 ? 'text-opt-yellow' : 'text-danger'}`}>{showPct !== '—' ? `${showPct}%` : '—'}</td>
                            <td className="px-3 py-2.5 text-right text-opt-yellow">{cash > 0 ? `$${cash.toLocaleString()}` : '—'}</td>
                            <td className="px-3 py-2.5 text-right text-success">{rev > 0 ? `$${rev.toLocaleString()}` : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

        </>
      )}

      {tab === 'closer' && !selectedMember && (
        <>
          {/* Pending members */}
          {(() => {
            const todayEods = allEodHistory.filter(e => e.report_date === selectedDate)
            const submittedIds = new Set(todayEods.map(e => e.closer_id))
            const pending = closers.filter(c => !submittedIds.has(c.id))
            return (
              <>
                {pending.length > 0 && (
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <span className="text-[10px] text-text-400 uppercase">Pending:</span>
                    {pending.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { setSelectedMember(p.id); setConfirmed(false) }}
                        className="px-2.5 py-1 rounded text-xs bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20 transition-colors"
                      >
                        {p.name}
                      </button>
                    ))}
                    {pending.length === 0 && <span className="text-xs text-success">All submitted!</span>}
                  </div>
                )}
                {closers.length > 0 && pending.length === 0 && (
                  <div className="bg-success/10 border border-success/30 rounded-2xl p-3 mb-3 flex items-center gap-2">
                    <Check size={16} className="text-success" />
                    <span className="text-xs text-success font-medium">All closers have submitted EODs for {formatDateLabel(selectedDate).split(' — ').pop()}</span>
                  </div>
                )}
              </>
            )
          })()}

          {/* Today's submissions */}
          {loadingAllHistory ? (
            <div className="flex items-center justify-center h-32"><Loader className="animate-spin text-opt-yellow" /></div>
          ) : (
            <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
                <h3 className="text-[11px] text-text-400 uppercase font-medium">
                  Closer EODs — {formatDateLabel(selectedDate).split(' — ').pop() || selectedDate}
                  {allEodHistory.filter(e => e.report_date === selectedDate).length > 0 && (
                    <span className="ml-2 text-text-primary">{allEodHistory.filter(e => e.report_date === selectedDate).length} submitted</span>
                  )}
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                      <th className="px-3 py-2 text-left">Closer</th>
                      <th className="px-3 py-2 text-right">Booked</th>
                      <th className="px-3 py-2 text-right">Live</th>
                      <th className="px-3 py-2 text-right">No Shows</th>
                      <th className="px-3 py-2 text-right">Closes</th>
                      <th className="px-3 py-2 text-right">Asc</th>
                      <th className="px-3 py-2 text-right">Show %</th>
                      <th className="px-3 py-2 text-right">Cash</th>
                      <th className="px-3 py-2 text-right">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allEodHistory.filter(e => e.report_date === selectedDate).length === 0 ? (
                      <tr><td colSpan={9} className="px-3 py-6 text-center text-text-400">No EODs submitted for this date yet</td></tr>
                    ) : allEodHistory.filter(e => e.report_date === selectedDate).map(eod => {
                      const booked = (eod.nc_booked || 0) + (eod.fu_booked || 0)
                      const live = (eod.live_nc_calls || 0) + (eod.live_fu_calls || 0)
                      const noShows = (eod.nc_no_shows || 0) + (eod.fu_no_shows || 0)
                      const showPct = booked > 0 ? ((live / booked) * 100).toFixed(0) : '—'
                      const rev = parseFloat(eod.total_revenue || 0)
                      const cash = parseFloat(eod.total_cash_collected || 0)
                      return (
                        <tr key={eod.id} className={`border-b border-border-default/30 hover:bg-bg-card-hover/50 cursor-pointer ${(eod.closes || 0) > 0 ? 'bg-success/5' : ''}`}
                          onClick={() => { setSelectedMember(eod.closer_id); setConfirmed(false) }}
                        >
                          <td className="px-3 py-2 font-medium text-opt-yellow">{eod.closer?.name || '—'}</td>
                          <td className="px-3 py-2 text-right">{booked}</td>
                          <td className="px-3 py-2 text-right">{live}</td>
                          <td className="px-3 py-2 text-right text-danger">{noShows}</td>
                          <td className="px-3 py-2 text-right font-medium">{eod.closes || 0}</td>
                          <td className="px-3 py-2 text-right text-cyan-400">{eod.deposits || 0}</td>
                          <td className={`px-3 py-2 text-right ${showPct !== '—' && parseFloat(showPct) >= 70 ? 'text-success' : showPct !== '—' && parseFloat(showPct) >= 50 ? 'text-opt-yellow' : 'text-danger'}`}>{showPct !== '—' ? `${showPct}%` : '—'}</td>
                          <td className="px-3 py-2 text-right text-opt-yellow">{cash > 0 ? `$${cash.toLocaleString()}` : '—'}</td>
                          <td className="px-3 py-2 text-right text-success">{rev > 0 ? `$${rev.toLocaleString()}` : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Older history with date range */}
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mt-4">
            <div className="px-4 py-3 border-b border-border-default flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-[11px] text-text-400 uppercase font-medium">Previous EODs</h3>
              <div className="flex items-center gap-2">
                <input type="date" value={historyFrom} onChange={e => setHistoryFrom(e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-[11px] text-text-primary" />
                <span className="text-[10px] text-text-400">to</span>
                <input type="date" value={historyTo} onChange={e => setHistoryTo(e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-[11px] text-text-primary" />
              </div>
            </div>
            {allEodHistory.filter(e => e.report_date !== selectedDate).length === 0 ? (
              <p className="px-4 py-6 text-center text-text-400 text-xs">No EODs in this date range</p>
            ) : (
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-bg-card z-10">
                    <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                      <th className="px-3 py-2.5 text-left">Date</th>
                      <th className="px-3 py-2.5 text-left">Closer</th>
                      <th className="px-3 py-2.5 text-right">Booked</th>
                      <th className="px-3 py-2.5 text-right">Live</th>
                      <th className="px-3 py-2.5 text-right">No Shows</th>
                      <th className="px-3 py-2.5 text-right">Closes</th>
                      <th className="px-3 py-2.5 text-right">Asc</th>
                      <th className="px-3 py-2.5 text-right">Show %</th>
                      <th className="px-3 py-2.5 text-right">Cash</th>
                      <th className="px-3 py-2.5 text-right">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allEodHistory.filter(e => e.report_date !== selectedDate).map(eod => {
                      const booked = (eod.nc_booked || 0) + (eod.fu_booked || 0)
                      const live = (eod.live_nc_calls || 0) + (eod.live_fu_calls || 0)
                      const noShows = (eod.nc_no_shows || 0) + (eod.fu_no_shows || 0)
                      const showPct = booked > 0 ? ((live / booked) * 100).toFixed(0) : '—'
                      const rev = parseFloat(eod.total_revenue || 0)
                      const cash = parseFloat(eod.total_cash_collected || 0)
                      return (
                        <tr key={eod.id} className={`border-b border-border-default/30 hover:bg-bg-card-hover/50 cursor-pointer ${(eod.closes || 0) > 0 ? 'bg-success/5' : ''}`}
                          onClick={() => { setSelectedMember(eod.closer_id); setSelectedDate(eod.report_date); setConfirmed(false) }}
                        >
                          <td className="px-3 py-2.5 text-text-400">{formatDateLabel(eod.report_date)}</td>
                          <td className="px-3 py-2.5 text-opt-yellow font-medium">{eod.closer?.name || '—'}</td>
                          <td className="px-3 py-2.5 text-right">{booked}</td>
                          <td className="px-3 py-2.5 text-right">{live}</td>
                          <td className="px-3 py-2.5 text-right text-danger">{noShows}</td>
                          <td className="px-3 py-2.5 text-right font-medium">{eod.closes || 0}</td>
                          <td className="px-3 py-2.5 text-right text-cyan-400">{eod.deposits || 0}</td>
                          <td className={`px-3 py-2.5 text-right ${showPct !== '—' && parseFloat(showPct) >= 70 ? 'text-success' : showPct !== '—' && parseFloat(showPct) >= 50 ? 'text-opt-yellow' : 'text-danger'}`}>{showPct !== '—' ? `${showPct}%` : '—'}</td>
                          <td className="px-3 py-2.5 text-right text-opt-yellow">{cash > 0 ? `$${cash.toLocaleString()}` : '—'}</td>
                          <td className="px-3 py-2.5 text-right text-success">{rev > 0 ? `$${rev.toLocaleString()}` : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Setter EOD */}
      {tab === 'setter' && selectedMember && (
        <SetterDashboard
          setterId={selectedMember}
          selectedDate={selectedDate}
          selectedName={selectedName}
          formatDateLabel={formatDateLabel}
          setterData={setterData}
          updateSetter={updateSetter}
          handleConfirmSetter={handleConfirmSetter}
          confirmed={confirmed}
          setConfirmed={setConfirmed}
          savedSetterLeads={savedSetterLeads}
          initialSetLeads={setterSetLeads}
          initialRescheduleLeads={setterRescheduleLeads}
          submitting={submitting}
          setLeadsForSets={setSetterSetLeads}
          setRescheduleLeadsForParent={setSetterRescheduleLeads}
          refreshKey={setterRefreshKey}
        />
      )}

      {tab === 'setter' && !selectedMember && (
        <>
          {/* Pending setters */}
          {(() => {
            const todayEods = allEodHistory.filter(e => e.report_date === selectedDate)
            const submittedIds = new Set(todayEods.map(e => e.setter_id))
            const pending = setters.filter(s => !submittedIds.has(s.id))
            return (
              <>
                {pending.length > 0 && (
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <span className="text-[10px] text-text-400 uppercase">Pending:</span>
                    {pending.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { setSelectedMember(p.id); setConfirmed(false) }}
                        className="px-2.5 py-1 rounded text-xs bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20 transition-colors"
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
                {setters.length > 0 && pending.length === 0 && (
                  <div className="bg-success/10 border border-success/30 rounded-2xl p-3 mb-3 flex items-center gap-2">
                    <Check size={16} className="text-success" />
                    <span className="text-xs text-success font-medium">All setters have submitted EODs for {formatDateLabel(selectedDate).split(' — ').pop()}</span>
                  </div>
                )}
              </>
            )
          })()}

          {/* Today's submissions */}
          {loadingAllHistory ? (
            <div className="flex items-center justify-center h-32"><Loader className="animate-spin text-opt-yellow" /></div>
          ) : (
            <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border-default">
                <h3 className="text-[11px] text-text-400 uppercase font-medium">
                  Setter EODs — {formatDateLabel(selectedDate).split(' — ').pop() || selectedDate}
                  {allEodHistory.filter(e => e.report_date === selectedDate).length > 0 && (
                    <span className="ml-2 text-text-primary">{allEodHistory.filter(e => e.report_date === selectedDate).length} submitted</span>
                  )}
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                      <th className="px-3 py-2 text-left">Setter</th>
                      <th className="px-3 py-2 text-right">Leads</th>
                      <th className="px-3 py-2 text-right">Dials</th>
                      <th className="px-3 py-2 text-right">Pickups</th>
                      <th className="px-3 py-2 text-right">MCs</th>
                      <th className="px-3 py-2 text-right">Sets</th>
                      <th className="px-3 py-2 text-right">Resched</th>
                      <th className="px-3 py-2 text-right">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allEodHistory.filter(e => e.report_date === selectedDate).length === 0 ? (
                      <tr><td colSpan={8} className="px-3 py-6 text-center text-text-400">No EODs submitted for this date yet</td></tr>
                    ) : allEodHistory.filter(e => e.report_date === selectedDate).map(eod => (
                      <tr key={eod.id} className={`border-b border-border-default/30 hover:bg-bg-card-hover/50 cursor-pointer ${(eod.sets || 0) > 0 ? 'bg-success/5' : ''}`}
                        onClick={() => { setSelectedMember(eod.setter_id); setConfirmed(!!eod.is_confirmed) }}
                      >
                        <td className="px-3 py-2 font-medium text-opt-yellow">{eod.setter?.name || '—'}</td>
                        <td className="px-3 py-2 text-right">{eod.total_leads || 0}</td>
                        <td className="px-3 py-2 text-right">{eod.outbound_calls || 0}</td>
                        <td className="px-3 py-2 text-right">{eod.pickups || 0}</td>
                        <td className="px-3 py-2 text-right">{eod.meaningful_conversations || 0}</td>
                        <td className="px-3 py-2 text-right font-medium">{eod.sets || 0}</td>
                        <td className="px-3 py-2 text-right">{eod.reschedules || 0}</td>
                        <td className="px-3 py-2 text-right text-text-400">{eod.self_rating || '—'}/10</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Older history with date range */}
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mt-4">
            <div className="px-4 py-3 border-b border-border-default flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-[11px] text-text-400 uppercase font-medium">Previous EODs</h3>
              <div className="flex items-center gap-2">
                <input type="date" value={historyFrom} onChange={e => setHistoryFrom(e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-[11px] text-text-primary" />
                <span className="text-[10px] text-text-400">to</span>
                <input type="date" value={historyTo} onChange={e => setHistoryTo(e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-[11px] text-text-primary" />
              </div>
            </div>
            {allEodHistory.filter(e => e.report_date !== selectedDate).length === 0 ? (
              <p className="px-4 py-6 text-center text-text-400 text-xs">No EODs in this date range</p>
            ) : (
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-bg-card z-10">
                    <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                      <th className="px-3 py-2.5 text-left">Date</th>
                      <th className="px-3 py-2.5 text-left">Setter</th>
                      <th className="px-3 py-2.5 text-right">Leads</th>
                      <th className="px-3 py-2.5 text-right">Dials</th>
                      <th className="px-3 py-2.5 text-right">Pickups</th>
                      <th className="px-3 py-2.5 text-right">MCs</th>
                      <th className="px-3 py-2.5 text-right">Sets</th>
                      <th className="px-3 py-2.5 text-right">Resched</th>
                      <th className="px-3 py-2.5 text-right">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allEodHistory.filter(e => e.report_date !== selectedDate).map(eod => (
                      <tr key={eod.id} className={`border-b border-border-default/30 hover:bg-bg-card-hover/50 cursor-pointer ${(eod.sets || 0) > 0 ? 'bg-success/5' : ''}`}
                        onClick={() => { setSelectedMember(eod.setter_id); setSelectedDate(eod.report_date); setConfirmed(!!eod.is_confirmed) }}
                      >
                        <td className="px-3 py-2.5 text-text-400">{formatDateLabel(eod.report_date)}</td>
                        <td className="px-3 py-2.5 text-opt-yellow font-medium">{eod.setter?.name || '—'}</td>
                        <td className="px-3 py-2.5 text-right">{eod.total_leads || 0}</td>
                        <td className="px-3 py-2.5 text-right">{eod.outbound_calls || 0}</td>
                        <td className="px-3 py-2.5 text-right">{eod.pickups || 0}</td>
                        <td className="px-3 py-2.5 text-right">{eod.meaningful_conversations || 0}</td>
                        <td className="px-3 py-2.5 text-right font-medium">{eod.sets || 0}</td>
                        <td className="px-3 py-2.5 text-right">{eod.reschedules || 0}</td>
                        <td className="px-3 py-2.5 text-right text-text-400">{eod.self_rating || '—'}/10</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Lead picker modal */}
      </>
      )}

      {showLeadPicker && (
        <LeadPicker
          onSelect={addManualCall}
          onClose={() => setShowLeadPicker(false)}
        />
      )}

      {showDealUpdater && (
        <DealUpdater
          closerId={selectedMember}
          onClose={() => setShowDealUpdater(false)}
          onSaved={() => {
            // Refresh calls for current date view
            setLoadingCalls(true)
            setTimeout(() => setLoadingCalls(false), 100)
          }}
        />
      )}
    </div>
  )
}
