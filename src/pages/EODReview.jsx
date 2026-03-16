import { useState, useEffect, useRef } from 'react'
import { Check, Edit3, Loader, ChevronLeft, ChevronRight, MessageSquare, Calendar, RefreshCw, Plus, Search, X, Zap, Lock } from 'lucide-react'
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

// Format a Date object as YYYY-MM-DD in local timezone (avoids UTC shift from toISOString)
const toLocalDateStr = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const formatDateLabel = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00')
  const today = new Date()
  today.setHours(12, 0, 0, 0)
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
      const [leadsRes, ghlRes] = await Promise.all([
        supabase
          .from('setter_leads')
          .select('id, lead_name, appointment_date, lead_source')
          .ilike('lead_name', `%${search}%`)
          .order('appointment_date', { ascending: false })
          .limit(6),
        supabase
          .from('ghl_appointments')
          .select('id, ghl_event_id, contact_name, appointment_date, contact_email, contact_phone')
          .ilike('contact_name', `%${search}%`)
          .order('appointment_date', { ascending: false })
          .limit(6),
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
      const seen = new Set(leads.map(l => l.lead_name?.toLowerCase()))
      const combined = [...leads, ...ghl.filter(g => !seen.has(g.lead_name?.toLowerCase()))]

      // If no local results, try GHL contacts API
      if (combined.length === 0) {
        const ghlKey = import.meta.env.VITE_GHL_API_KEY
        const ghlLoc = import.meta.env.VITE_GHL_LOCATION_ID
        if (ghlKey && ghlLoc) {
          try {
            const params = new URLSearchParams({ locationId: ghlLoc, query: search, limit: '8' })
            const res = await fetch(`https://services.leadconnectorhq.com/contacts/?${params}`, {
              headers: { 'Authorization': `Bearer ${ghlKey}`, 'Version': '2021-07-28' },
            })
            if (res.ok) {
              const json = await res.json()
              ;(json.contacts || []).forEach(c => combined.push({
                id: c.id,
                lead_name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || 'Unknown',
                appointment_date: null,
                lead_source: 'ghl',
                contact_email: c.email || '',
                contact_phone: c.phone || '',
                _source: 'ghl_live',
              }))
            }
          } catch {}
        }
      }

      combined.sort((a, b) => (b.appointment_date || '').localeCompare(a.appointment_date || ''))
      setResults(combined.slice(0, 8))
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
                  {lead._source === 'ghl_live' ? 'GHL' : lead._source === 'ghl' ? 'GHL' : 'Lead'}
                </span>
              </div>
              <span className="text-[10px] text-text-400">
                {lead.appointment_date || 'No date'}{lead.lead_source ? ` · ${lead.lead_source}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Setter Dashboard with pipeline stats + EOD form
function SetterDashboard({ setterId, selectedDate, selectedName, formatDateLabel, setterData, updateSetter, handleConfirmSetter, confirmed, submitting, setLeadsForSets, setRescheduleLeadsForParent }) {
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
  }, [setterId, selectedDate])

  // Auto-apply WAVV data to setter fields (always pre-fill, setter can override)
  useEffect(() => {
    if (!wavvStats || wavvApplied) return
    updateSetter('outbound_calls', wavvStats.dials)
    updateSetter('pickups', wavvStats.pickups)
    updateSetter('meaningful_conversations', wavvStats.mcs)
    setWavvApplied(true)
  }, [wavvStats, wavvApplied])

  // Sync set leads count with sets field
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
      {confirmed && (
        <div className="bg-success/10 border border-success/30 rounded-2xl p-4 flex items-center gap-3">
          <Check size={20} className="text-success flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-success">EOD Submitted Successfully</p>
            <p className="text-xs text-text-400 mt-0.5">
              {selectedName} &middot; {formatDateLabel(selectedDate).split(' — ').pop()} &mdash;
              {setterData.outbound_calls} dials, {setterData.pickups} pickups, {setterData.meaningful_conversations} MCs, {setterData.sets} sets
              {setterData.reschedules > 0 && `, ${setterData.reschedules} reschedules`}
              {setterData.self_rating && ` &middot; Rating: ${setterData.self_rating}/10`}
            </p>
          </div>
        </div>
      )}

      {/* Pipeline KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
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
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
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
      </div>
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
    return params.get('date') || toLocalDateStr(new Date())
  })
  const [calls, setCalls] = useState([])
  const [loadingCalls, setLoadingCalls] = useState(false)
  const [expandedCall, setExpandedCall] = useState(null)
  const [closerNotes, setCloserNotes] = useState('')
  const { members: closers } = useTeamMembers('closer')
  const { members: setters } = useTeamMembers('setter')
  const { submitCloserEOD, submitSetterEOD, submitting } = useEODSubmit()

  const today = toLocalDateStr(new Date())

  const shiftDate = (days) => {
    const d = new Date(selectedDate + 'T12:00:00')
    d.setDate(d.getDate() + days)
    const newDate = toLocalDateStr(d)
    if (newDate <= today) setSelectedDate(newDate)
  }

  const [calendarSource, setCalendarSource] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [showLeadPicker, setShowLeadPicker] = useState(false)
  const [closerHistory, setCloserHistory] = useState([])
  const [showCloserHistory, setShowCloserHistory] = useState(true)
  const [allEodHistory, setAllEodHistory] = useState([])
  const [loadingAllHistory, setLoadingAllHistory] = useState(false)
  const [historyFrom, setHistoryFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7)
    return toLocalDateStr(d)
  })
  const [historyTo, setHistoryTo] = useState(() => toLocalDateStr(new Date()))

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

  const handleRefreshGHL = async () => {
    if (!selectedMember || syncing) return
    setSyncing(true)
    try {
      await syncGHLAppointments(selectedDate, selectedDate)
      // Re-fetch after sync
      const { source, events } = await fetchCloserCalendar(selectedMember, selectedDate)
      setCalendarSource(source)
      const rows = events.map((evt) => {
        // Format time in ET (GHL location timezone)
        const startTime = evt.start_time ? (() => {
          try {
            const d = new Date(evt.start_time)
            if (isNaN(d.getTime())) return null
            return d.toLocaleTimeString('en-US', {
              hour: 'numeric', minute: '2-digit',
              timeZone: 'America/Indiana/Indianapolis',
            })
          } catch { return null }
        })() : null
        return {
          lead_id: evt.lead_id || null,
          ghl_event_id: evt.ghl_event_id || null,
          lead_name: evt.contact_name,
          setter_name: evt.setter_name || '—',
          appointment_date: selectedDate,
          start_time: startTime,
          calendar_name: evt.calendar_name || '',
          lead_source: evt.lead_source || (source === 'ghl' ? 'ghl' : 'manual'),
          call_type: 'new_call',
          outcome: evt.existing_status || 'no_show',
          revenue: evt.revenue_attributed || 0,
          cash_collected: 0,
          existing_status: evt.existing_status || evt.status || null,
          notes: evt.notes || '',
          fathom_summary: null,
          fathom_duration: null,
          contact_email: evt.contact_email || '',
          contact_phone: evt.contact_phone || '',
          ascended: false,
          offered_finance: false,
        }
      })
      setCalls(rows)
    } catch (err) {
      console.error('GHL sync failed:', err)
    }
    setSyncing(false)
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
                            setConfirmed(false)
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
        {tab === 'closer' && selectedMember && (
          <button
            onClick={handleRefreshGHL}
            disabled={syncing}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] text-text-400 hover:text-opt-yellow border border-border-default hover:border-opt-yellow/30 ml-auto disabled:opacity-50"
            title="Sync appointments from GHL"
          >
            <RefreshCw size={10} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing GHL...' : 'Sync GHL'}
          </button>
        )}
      </div>

      {/* Closer EOD */}
      {tab === 'closer' && selectedMember && (
        <>
          {/* Confirmed state — clean summary with Edit button */}
          {confirmed && (
            <div className="bg-bg-card border border-success/30 rounded-2xl p-6 mb-4">
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
                {isAdmin && (
                  <button
                    onClick={() => setConfirmed(false)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-400 hover:text-opt-yellow border border-border-default hover:border-opt-yellow/30 transition-colors"
                  >
                    <Edit3 size={12} />
                    Edit
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="text-center p-3 bg-bg-primary rounded-2xl">
                  <p className="text-xl font-bold">{summary.booked}</p>
                  <p className="text-[10px] text-text-400 uppercase">Booked</p>
                </div>
                <div className="text-center p-3 bg-bg-primary rounded-2xl">
                  <p className="text-xl font-bold">{summary.showed}</p>
                  <p className="text-[10px] text-text-400 uppercase">Live Calls</p>
                </div>
                <div className="text-center p-3 bg-bg-primary rounded-2xl">
                  <p className="text-xl font-bold text-success">{summary.closes}</p>
                  <p className="text-[10px] text-text-400 uppercase">Closes</p>
                </div>
                <div className="text-center p-3 bg-bg-primary rounded-2xl">
                  <p className="text-xl font-bold text-opt-yellow">${summary.cash.toLocaleString()}</p>
                  <p className="text-[10px] text-text-400 uppercase">Cash</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-border-default text-xs text-text-400">
                {summary.offers > 0 && <span>Offers: <strong className="text-text-primary">{summary.offers}</strong></span>}
                {summary.revenue > 0 && <span>Trial Revenue: <strong className="text-success">${summary.revenue.toLocaleString()}</strong></span>}
                {summary.ascendCash > 0 && <span>Ascend Cash: <strong className="text-cyan-400">${summary.ascendCash.toLocaleString()}</strong></span>}
                {summary.contractValue > 0 && <span>Ascend Revenue: <strong className="text-cyan-400">${summary.contractValue.toLocaleString()}</strong></span>}
                {summary.ascensions > 0 && <span>Ascended: <strong className="text-cyan-400">{summary.ascensions}/{summary.ascensionCalls}</strong></span>}
                {summary.rescheduled > 0 && <span>Rescheduled: <strong className="text-blue-400">{summary.rescheduled}</strong></span>}
                {summary.noShows > 0 && <span>No Shows: <strong className="text-danger">{summary.noShows}</strong></span>}
                <span>Show Rate: <strong className={parseFloat(showRate) >= 70 ? 'text-success' : 'text-danger'}>{showRate}%</strong></span>
                <span>Offer Rate: <strong className={parseFloat(offerRate) >= 80 ? 'text-success' : 'text-text-secondary'}>{offerRate}%</strong></span>
                <span>Close Rate: <strong className={parseFloat(closeRate) >= 25 ? 'text-success' : 'text-text-secondary'}>{closeRate}%</strong></span>
              </div>
            </div>
          )}

          {confirmed ? null : loadingCalls ? (
            <div className="flex items-center justify-center h-32"><Loader className="animate-spin text-opt-yellow" /></div>
          ) : calls.length === 0 ? (
            <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center text-text-400 text-sm">
              <p>No booked calls for {selectedName} on {formatDateLabel(selectedDate).split(' — ').pop() || selectedDate}.</p>
              <button
                onClick={() => setShowLeadPicker(true)}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-opt-yellow border border-opt-yellow/30 hover:bg-opt-yellow/10 transition-colors"
              >
                <Plus size={12} />
                Add Call Manually
              </button>
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

                {/* Add Call button */}
                <button
                  onClick={() => setShowLeadPicker(true)}
                  className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-400 hover:text-opt-yellow border border-dashed border-border-default hover:border-opt-yellow/30 transition-colors"
                >
                  <Plus size={12} />
                  Add Call
                </button>

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
          submitting={submitting}
          setLeadsForSets={setSetterSetLeads}
          setRescheduleLeadsForParent={setSetterRescheduleLeads}
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
                        onClick={() => { setSelectedMember(eod.setter_id); setConfirmed(false) }}
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
                        onClick={() => { setSelectedMember(eod.setter_id); setSelectedDate(eod.report_date); setConfirmed(false) }}
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
    </div>
  )
}
