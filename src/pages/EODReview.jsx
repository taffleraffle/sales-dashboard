import { useState, useEffect } from 'react'
import { Check, Edit3, Loader, ChevronLeft, ChevronRight, MessageSquare, Calendar } from 'lucide-react'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useEODSubmit } from '../hooks/useEOD'
import { supabase } from '../lib/supabase'

const outcomeOptions = [
  { value: 'no_show', label: 'No Show', color: 'text-danger' },
  { value: 'showed', label: 'Showed', color: 'text-opt-yellow' },
  { value: 'not_closed', label: 'Not Closed', color: 'text-text-400' },
  { value: 'closed', label: 'Closed', color: 'text-success' },
]

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

export default function EODReview() {
  const [tab, setTab] = useState('closer')
  const [confirmed, setConfirmed] = useState(false)
  const [selectedMember, setSelectedMember] = useState('')
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0])
  const [calls, setCalls] = useState([])
  const [loadingCalls, setLoadingCalls] = useState(false)
  const [expandedCall, setExpandedCall] = useState(null)
  const [closerNotes, setCloserNotes] = useState('')
  const { members: closers } = useTeamMembers('closer')
  const { members: setters } = useTeamMembers('setter')
  const { submitCloserEOD, submitSetterEOD, submitting } = useEODSubmit()

  const today = new Date().toISOString().split('T')[0]

  const shiftDate = (days) => {
    const d = new Date(selectedDate + 'T12:00:00')
    d.setDate(d.getDate() + days)
    const newDate = d.toISOString().split('T')[0]
    if (newDate <= today) setSelectedDate(newDate)
  }

  // Pull booked calls for selected date + try to match Fathom transcripts
  useEffect(() => {
    if (tab !== 'closer' || !selectedMember) { setCalls([]); return }

    async function loadCalls() {
      setLoadingCalls(true)
      setConfirmed(false)
      setExpandedCall(null)

      // Fetch leads with appointment on the selected date
      const { data } = await supabase
        .from('setter_leads')
        .select('id, lead_name, setter_id, status, appointment_date, date_set, lead_source, revenue_attributed, setter:team_members!setter_leads_setter_id_fkey(name)')
        .eq('closer_id', selectedMember)
        .eq('appointment_date', selectedDate)
        .order('lead_name', { ascending: true })

      // Fetch Fathom transcripts for this closer on the same date
      const { data: transcripts } = await supabase
        .from('closer_transcripts')
        .select('id, prospect_name, summary, meeting_date, duration_seconds')
        .eq('closer_id', selectedMember)
        .eq('meeting_date', selectedDate)

      // Build call rows with Fathom match attempt
      const rows = (data || []).map(lead => {
        // Try to match a transcript by name similarity + date
        const matched = (transcripts || []).find(t =>
          t.meeting_date === lead.appointment_date &&
          t.prospect_name?.toLowerCase().includes(lead.lead_name?.split(' ')[0]?.toLowerCase())
        )

        const outcome = lead.status === 'closed' ? 'closed'
          : lead.status === 'not_closed' ? 'not_closed'
          : ['showed', 'closed', 'not_closed'].includes(lead.status) ? 'showed'
          : lead.status === 'no_show' ? 'no_show'
          : 'no_show'

        return {
          lead_id: lead.id,
          lead_name: lead.lead_name,
          setter_name: lead.setter?.name || '—',
          appointment_date: lead.appointment_date,
          lead_source: lead.lead_source || 'manual',
          call_type: 'NC',
          outcome,
          revenue: parseFloat(lead.revenue_attributed || 0),
          cash_collected: 0,
          existing_status: lead.status,
          notes: matched?.summary || '',
          fathom_summary: matched?.summary || null,
          fathom_duration: matched?.duration_seconds || null,
        }
      })

      setCalls(rows)
      setLoadingCalls(false)
    }

    loadCalls()
  }, [tab, selectedMember, selectedDate])

  const updateCall = (index, field, value) => {
    setCalls(prev => prev.map((c, i) => {
      if (i !== index) return c
      const updated = { ...c, [field]: value }
      // Reset revenue/cash if not closed
      if (field === 'outcome' && value !== 'closed') {
        updated.revenue = 0
        updated.cash_collected = 0
      }
      return updated
    }))
  }

  // Auto-computed summary
  const summary = calls.reduce((acc, c) => {
    const showed = ['showed', 'not_closed', 'closed'].includes(c.outcome)
    return {
      booked: acc.booked + 1,
      showed: acc.showed + (showed ? 1 : 0),
      noShows: acc.noShows + (c.outcome === 'no_show' ? 1 : 0),
      offers: acc.offers + (['not_closed', 'closed'].includes(c.outcome) ? 1 : 0),
      closes: acc.closes + (c.outcome === 'closed' ? 1 : 0),
      revenue: acc.revenue + (c.revenue || 0),
      cash: acc.cash + (c.cash_collected || 0),
      nc: acc.nc + (c.call_type === 'NC' ? 1 : 0),
      fu: acc.fu + (c.call_type === 'FU' ? 1 : 0),
    }
  }, { booked: 0, showed: 0, noShows: 0, offers: 0, closes: 0, revenue: 0, cash: 0, nc: 0, fu: 0 })

  const showRate = summary.booked ? ((summary.showed / summary.booked) * 100).toFixed(0) : 0
  const closeRate = summary.showed ? ((summary.closes / summary.showed) * 100).toFixed(0) : 0

  const handleConfirmCloser = async () => {
    if (!selectedMember) return alert('Select a closer first')

    const eodData = {
      nc_booked: summary.nc,
      fu_booked: summary.fu,
      nc_no_shows: calls.filter(c => c.call_type === 'NC' && c.outcome === 'no_show').length,
      fu_no_shows: calls.filter(c => c.call_type === 'FU' && c.outcome === 'no_show').length,
      live_nc_calls: calls.filter(c => c.call_type === 'NC' && ['showed', 'not_closed', 'closed'].includes(c.outcome)).length,
      live_fu_calls: calls.filter(c => c.call_type === 'FU' && ['showed', 'not_closed', 'closed'].includes(c.outcome)).length,
      offers: summary.offers,
      closes: summary.closes,
      total_revenue: summary.revenue,
      total_cash_collected: summary.cash,
      notes: closerNotes,
    }

    const callRows = calls.map(c => ({
      call_type: c.call_type,
      prospect_name: c.lead_name,
      showed: ['showed', 'not_closed', 'closed'].includes(c.outcome),
      outcome: c.outcome,
      revenue: c.revenue,
      cash_collected: c.cash_collected,
      setter_lead_id: c.lead_id,
      notes: c.notes,
    }))

    const result = await submitCloserEOD(selectedMember, selectedDate, eodData, callRows)

    if (result.success) {
      for (const c of calls) {
        if (c.outcome !== c.existing_status) {
          await supabase
            .from('setter_leads')
            .update({ status: c.outcome, revenue_attributed: c.revenue || 0, updated_at: new Date().toISOString() })
            .eq('id', c.lead_id)
        }
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

  const handleConfirmSetter = async () => {
    if (!selectedMember) return alert('Select a setter first')
    const result = await submitSetterEOD(selectedMember, selectedDate, setterData)
    if (result.success) setConfirmed(true)
    else alert('Failed: ' + result.error)
  }

  const members = tab === 'closer' ? closers : setters
  const selectedName = members.find(m => m.id === selectedMember)?.name || ''

  return (
    <div>
      {/* Header row: title, tabs, selector */}
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <h1 className="text-xl font-bold mr-2">EOD Review</h1>
        <div className="flex gap-1">
          {['closer', 'setter'].map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); setConfirmed(false); setSelectedMember('') }}
              className={`px-3 py-1.5 rounded text-xs ${tab === t ? 'bg-opt-yellow text-bg-primary font-medium' : 'bg-bg-card text-text-secondary border border-border-default'}`}
            >
              {t === 'closer' ? 'Closer' : 'Setter'}
            </button>
          ))}
        </div>
        <select
          value={selectedMember}
          onChange={e => { setSelectedMember(e.target.value); setConfirmed(false) }}
          className="bg-bg-card border border-border-default rounded px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">Select {tab}...</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      {/* Date selector */}
      <div className="flex items-center gap-2 mb-5">
        <Calendar size={14} className="text-text-400" />
        <button
          onClick={() => shiftDate(-1)}
          className="p-1 rounded hover:bg-bg-card-hover text-text-400 hover:text-text-primary"
        >
          <ChevronLeft size={16} />
        </button>
        <input
          type="date"
          value={selectedDate}
          max={today}
          onChange={e => setSelectedDate(e.target.value)}
          className="bg-bg-card border border-border-default rounded px-2 py-1 text-sm text-text-primary"
        />
        <button
          onClick={() => shiftDate(1)}
          disabled={selectedDate >= today}
          className="p-1 rounded hover:bg-bg-card-hover text-text-400 hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
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
      </div>

      {/* Closer EOD */}
      {tab === 'closer' && selectedMember && (
        <>
          {loadingCalls ? (
            <div className="flex items-center justify-center h-32"><Loader className="animate-spin text-opt-yellow" /></div>
          ) : calls.length === 0 ? (
            <div className="bg-bg-card border border-border-default rounded-lg p-8 text-center text-text-400 text-sm">
              No booked calls for {selectedName} on {formatDateLabel(selectedDate).split(' — ').pop() || selectedDate}.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
              {/* Left: call list */}
              <div className="space-y-1">
                <p className="text-[11px] text-text-400 uppercase mb-2">
                  {calls.length} calls &middot; Mark outcomes below
                </p>

                {/* Table-style compact rows */}
                <div className="bg-bg-card border border-border-default rounded-lg overflow-hidden">
                  {/* Header */}
                  <div className="grid grid-cols-[1fr_70px_110px_80px_80px] gap-2 px-3 py-2 text-[10px] text-text-400 uppercase border-b border-border-default">
                    <span>Lead</span>
                    <span>Type</span>
                    <span>Outcome</span>
                    <span className="text-right">Revenue</span>
                    <span className="text-right">Cash</span>
                  </div>

                  {calls.map((call, i) => (
                    <div key={call.lead_id}>
                      <div
                        className={`grid grid-cols-[1fr_70px_110px_80px_80px] gap-2 px-3 py-2 items-center text-sm border-b border-border-default/50 hover:bg-bg-card-hover transition-colors cursor-pointer ${
                          call.outcome === 'closed' ? 'bg-success/5' : call.outcome === 'no_show' ? 'bg-danger/5' : ''
                        }`}
                        onClick={() => setExpandedCall(expandedCall === i ? null : i)}
                      >
                        {/* Lead name + setter */}
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            call.outcome === 'closed' ? 'bg-success' : call.outcome === 'no_show' ? 'bg-danger' : call.outcome === 'showed' ? 'bg-opt-yellow' : 'bg-text-400'
                          }`} />
                          <span className="font-medium truncate">{call.lead_name}</span>
                          <span className="text-[10px] text-text-400 flex-shrink-0">{call.setter_name}</span>
                        </div>

                        {/* NC/FU */}
                        <select
                          value={call.call_type}
                          onChange={e => { e.stopPropagation(); updateCall(i, 'call_type', e.target.value) }}
                          onClick={e => e.stopPropagation()}
                          className="bg-bg-primary border border-border-default rounded px-1.5 py-0.5 text-xs w-full"
                        >
                          <option value="NC">NC</option>
                          <option value="FU">FU</option>
                        </select>

                        {/* Outcome */}
                        <select
                          value={call.outcome}
                          onChange={e => { e.stopPropagation(); updateCall(i, 'outcome', e.target.value) }}
                          onClick={e => e.stopPropagation()}
                          className={`bg-bg-primary border border-border-default rounded px-1.5 py-0.5 text-xs w-full ${
                            outcomeOptions.find(o => o.value === call.outcome)?.color || ''
                          }`}
                        >
                          {outcomeOptions.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>

                        {/* Revenue */}
                        {call.outcome === 'closed' ? (
                          <input
                            type="number"
                            value={call.revenue}
                            onChange={e => { e.stopPropagation(); updateCall(i, 'revenue', parseFloat(e.target.value) || 0) }}
                            onClick={e => e.stopPropagation()}
                            className="bg-bg-primary border border-border-default rounded px-1.5 py-0.5 text-xs text-right w-full text-success"
                            placeholder="0"
                          />
                        ) : (
                          <span className="text-xs text-text-400 text-right">—</span>
                        )}

                        {/* Cash */}
                        {call.outcome === 'closed' ? (
                          <input
                            type="number"
                            value={call.cash_collected}
                            onChange={e => { e.stopPropagation(); updateCall(i, 'cash_collected', parseFloat(e.target.value) || 0) }}
                            onClick={e => e.stopPropagation()}
                            className="bg-bg-primary border border-border-default rounded px-1.5 py-0.5 text-xs text-right w-full"
                            placeholder="0"
                          />
                        ) : (
                          <span className="text-xs text-text-400 text-right">—</span>
                        )}
                      </div>

                      {/* Expanded: notes + Fathom summary */}
                      {expandedCall === i && (
                        <div className="px-3 py-2 bg-bg-primary border-b border-border-default/50 space-y-2">
                          {call.fathom_summary && (
                            <div className="flex items-start gap-2">
                              <MessageSquare size={12} className="text-opt-yellow mt-0.5 flex-shrink-0" />
                              <div>
                                <p className="text-[10px] text-opt-yellow uppercase mb-0.5">
                                  Fathom Summary {call.fathom_duration ? `(${Math.round(call.fathom_duration / 60)} min)` : ''}
                                </p>
                                <p className="text-xs text-text-secondary">{call.fathom_summary}</p>
                              </div>
                            </div>
                          )}
                          <div>
                            <textarea
                              value={call.notes}
                              onChange={e => updateCall(i, 'notes', e.target.value)}
                              placeholder="Add notes for this call..."
                              className="bg-bg-card border border-border-default rounded px-2 py-1 text-xs w-full h-12 resize-none"
                            />
                          </div>
                          <div className="flex gap-3 text-[10px] text-text-400">
                            <span>Appt: {call.appointment_date}</span>
                            <span>Source: {call.lead_source}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
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
                <div className="bg-bg-card border border-border-default rounded-lg p-4 sticky top-20">
                  <h3 className="text-[11px] text-opt-yellow uppercase font-medium mb-3">{selectedName} &middot; {formatDateLabel(selectedDate).split(' — ').pop()}</h3>

                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div className="text-center">
                      <p className="text-2xl font-bold">{summary.booked}</p>
                      <p className="text-[10px] text-text-400">Booked</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold">{summary.showed}</p>
                      <p className="text-[10px] text-text-400">Showed</p>
                    </div>
                  </div>

                  <div className="space-y-2 mb-3">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Show Rate</span>
                      <span className={parseFloat(showRate) >= 70 ? 'text-success' : 'text-danger'}>{showRate}%</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">No Shows</span>
                      <span className="text-danger">{summary.noShows}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Offers</span>
                      <span>{summary.offers}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Closes</span>
                      <span className="text-success font-medium">{summary.closes}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-400">Close Rate</span>
                      <span className={parseFloat(closeRate) >= 25 ? 'text-success' : 'text-text-secondary'}>{closeRate}%</span>
                    </div>
                  </div>

                  {(summary.revenue > 0 || summary.cash > 0) && (
                    <div className="border-t border-border-default pt-3 space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-text-400">Revenue</span>
                        <span className="text-success font-medium">${summary.revenue.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-text-400">Cash</span>
                        <span className="text-opt-yellow font-medium">${summary.cash.toLocaleString()}</span>
                      </div>
                    </div>
                  )}

                  <div className="border-t border-border-default pt-3 mt-3 flex gap-3 text-[10px] text-text-400">
                    <span>NC: {summary.nc}</span>
                    <span>FU: {summary.fu}</span>
                  </div>

                  {/* Confirm button */}
                  <button
                    onClick={handleConfirmCloser}
                    disabled={confirmed || submitting}
                    className={`w-full mt-4 flex items-center justify-center gap-2 px-4 py-2 rounded font-medium text-sm transition-colors ${
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
        </>
      )}

      {tab === 'closer' && !selectedMember && (
        <div className="bg-bg-card border border-border-default rounded-lg p-8 text-center text-text-400 text-sm">
          Select a closer to load their booked calls.
        </div>
      )}

      {/* Setter EOD */}
      {tab === 'setter' && selectedMember && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {[
              ['Leads Worked', 'total_leads'],
              ['Outbound Calls', 'outbound_calls'],
              ['Pickups', 'pickups'],
              ['MCs', 'meaningful_conversations'],
              ['Sets', 'sets'],
              ['Reschedules', 'reschedules'],
            ].map(([label, key]) => (
              <div key={key} className="bg-bg-card border border-border-default rounded-lg p-3">
                <label className="text-[11px] text-text-400 uppercase block mb-1">{label}</label>
                <input
                  type="number"
                  value={setterData[key]}
                  onChange={e => updateSetter(key, parseInt(e.target.value) || 0)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-lg font-bold w-full"
                />
              </div>
            ))}
          </div>
          <div className="bg-bg-card border border-border-default rounded-lg p-4">
            <h3 className="text-sm font-medium mb-3">Self Assessment</h3>
            <div className="grid grid-cols-1 md:grid-cols-[80px_1fr_1fr] gap-3">
              <div>
                <label className="text-xs text-text-400 block mb-1">Rating</label>
                <input
                  type="number" min="1" max="10"
                  value={setterData.self_rating}
                  onChange={e => updateSetter('self_rating', parseInt(e.target.value) || 0)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-sm w-full"
                />
              </div>
              <div>
                <label className="text-xs text-text-400 block mb-1">What went well?</label>
                <textarea
                  value={setterData.what_went_well}
                  onChange={e => updateSetter('what_went_well', e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-xs w-full h-14 resize-none"
                />
              </div>
              <div>
                <label className="text-xs text-text-400 block mb-1">What could improve?</label>
                <textarea
                  value={setterData.what_went_poorly}
                  onChange={e => updateSetter('what_went_poorly', e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-2 py-1 text-xs w-full h-14 resize-none"
                />
              </div>
            </div>
          </div>
          <button
            onClick={handleConfirmSetter}
            disabled={confirmed || submitting}
            className={`flex items-center gap-2 px-6 py-2 rounded font-medium text-sm transition-colors ${
              confirmed
                ? 'bg-success/20 text-success border border-success/30'
                : 'bg-opt-yellow text-bg-primary hover:bg-opt-yellow/90'
            }`}
          >
            {submitting ? <Loader size={14} className="animate-spin" /> : <Check size={14} />}
            {confirmed ? 'Confirmed' : submitting ? 'Saving...' : 'Confirm EOD'}
          </button>
        </div>
      )}

      {tab === 'setter' && !selectedMember && (
        <div className="bg-bg-card border border-border-default rounded-lg p-8 text-center text-text-400 text-sm">
          Select a setter to start their EOD.
        </div>
      )}
    </div>
  )
}
