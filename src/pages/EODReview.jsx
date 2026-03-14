import { useState, useEffect } from 'react'
import { Check, Edit3, Loader, Phone, PhoneOff } from 'lucide-react'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useEODSubmit } from '../hooks/useEOD'
import { supabase } from '../lib/supabase'

export default function EODReview() {
  const [tab, setTab] = useState('closer')
  const [confirmed, setConfirmed] = useState(false)
  const [selectedMember, setSelectedMember] = useState('')
  const [calls, setCalls] = useState([])
  const [loadingCalls, setLoadingCalls] = useState(false)
  const { members: closers } = useTeamMembers('closer')
  const { members: setters } = useTeamMembers('setter')
  const { submitCloserEOD, submitSetterEOD, submitting } = useEODSubmit()

  const today = new Date().toISOString().split('T')[0]

  // Pull booked calls for selected closer from setter_leads
  useEffect(() => {
    if (tab !== 'closer' || !selectedMember) {
      setCalls([])
      return
    }

    async function loadCalls() {
      setLoadingCalls(true)
      setConfirmed(false)

      // Get calls booked for today (or recent 7 days with appointment_date)
      const since = new Date()
      since.setDate(since.getDate() - 7)
      const sinceStr = since.toISOString().split('T')[0]

      const { data, error } = await supabase
        .from('setter_leads')
        .select('id, lead_name, setter_id, status, appointment_date, date_set, lead_source, revenue_attributed, setter:team_members!setter_leads_setter_id_fkey(name)')
        .eq('closer_id', selectedMember)
        .gte('appointment_date', sinceStr)
        .lte('appointment_date', today)
        .order('appointment_date', { ascending: false })

      if (error) console.error('Failed to load calls:', error)

      // Build editable call rows with defaults from existing status
      const rows = (data || []).map(lead => ({
        lead_id: lead.id,
        lead_name: lead.lead_name,
        setter_name: lead.setter?.name || '—',
        appointment_date: lead.appointment_date,
        lead_source: lead.lead_source || '—',
        call_type: lead.lead_source === 'auto' ? 'NC' : 'NC', // default, editable
        showed: ['showed', 'closed', 'not_closed'].includes(lead.status),
        offered: lead.status === 'closed' || lead.status === 'not_closed',
        closed: lead.status === 'closed',
        revenue: parseFloat(lead.revenue_attributed || 0),
        cash_collected: 0,
        existing_status: lead.status,
        notes: '',
      }))

      setCalls(rows)
      setLoadingCalls(false)
    }

    loadCalls()
  }, [tab, selectedMember, today])

  const updateCall = (index, field, value) => {
    setCalls(prev => prev.map((c, i) => {
      if (i !== index) return c
      const updated = { ...c, [field]: value }
      // Auto-cascade: if not showed, can't offer/close
      if (field === 'showed' && !value) {
        updated.offered = false
        updated.closed = false
        updated.revenue = 0
        updated.cash_collected = 0
      }
      if (field === 'offered' && !value) {
        updated.closed = false
        updated.revenue = 0
        updated.cash_collected = 0
      }
      if (field === 'closed' && !value) {
        updated.revenue = 0
        updated.cash_collected = 0
      }
      return updated
    }))
  }

  // Auto-computed summary from calls
  const summary = calls.reduce((acc, c) => ({
    nc_booked: acc.nc_booked + (c.call_type === 'NC' ? 1 : 0),
    fu_booked: acc.fu_booked + (c.call_type === 'FU' ? 1 : 0),
    nc_no_shows: acc.nc_no_shows + (c.call_type === 'NC' && !c.showed ? 1 : 0),
    fu_no_shows: acc.fu_no_shows + (c.call_type === 'FU' && !c.showed ? 1 : 0),
    live_nc_calls: acc.live_nc_calls + (c.call_type === 'NC' && c.showed ? 1 : 0),
    live_fu_calls: acc.live_fu_calls + (c.call_type === 'FU' && c.showed ? 1 : 0),
    offers: acc.offers + (c.offered ? 1 : 0),
    closes: acc.closes + (c.closed ? 1 : 0),
    total_revenue: acc.total_revenue + (c.revenue || 0),
    total_cash_collected: acc.total_cash_collected + (c.cash_collected || 0),
  }), { nc_booked: 0, fu_booked: 0, nc_no_shows: 0, fu_no_shows: 0, live_nc_calls: 0, live_fu_calls: 0, offers: 0, closes: 0, total_revenue: 0, total_cash_collected: 0 })

  const [closerNotes, setCloserNotes] = useState('')

  const handleConfirmCloser = async () => {
    if (!selectedMember) return alert('Select a closer first')

    // Build closer_calls for the hook
    const callRows = calls.map(c => ({
      call_type: c.call_type,
      prospect_name: c.lead_name,
      showed: c.showed,
      outcome: c.closed ? 'closed' : c.offered ? 'not_closed' : c.showed ? 'showed' : 'no_show',
      revenue: c.revenue,
      cash_collected: c.cash_collected,
      setter_lead_id: c.lead_id,
      notes: c.notes,
    }))

    const result = await submitCloserEOD(selectedMember, today, { ...summary, notes: closerNotes }, callRows)

    if (result.success) {
      // Also update setter_leads statuses
      for (const c of calls) {
        const newStatus = c.closed ? 'closed' : c.offered ? 'not_closed' : c.showed ? 'showed' : 'no_show'
        if (newStatus !== c.existing_status) {
          await supabase
            .from('setter_leads')
            .update({
              status: newStatus,
              revenue_attributed: c.revenue || 0,
              updated_at: new Date().toISOString(),
            })
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
    const result = await submitSetterEOD(selectedMember, today, setterData)
    if (result.success) setConfirmed(true)
    else alert('Failed: ' + result.error)
  }

  const members = tab === 'closer' ? closers : setters

  const numField = (label, key, data, update) => (
    <div className="bg-bg-card border border-border-default rounded-lg p-3">
      <label className="text-[11px] text-text-400 uppercase block mb-1">{label}</label>
      <input
        type="number"
        value={data[key]}
        onChange={e => update(key, parseInt(e.target.value) || 0)}
        className="bg-bg-primary border border-border-default rounded px-2 py-1 text-lg font-bold w-full"
      />
    </div>
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">EOD Review</h1>
      </div>

      {/* Tab + Member selector */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <div className="flex gap-1">
          <button
            onClick={() => { setTab('closer'); setConfirmed(false); setSelectedMember('') }}
            className={`px-4 py-2 rounded text-sm ${tab === 'closer' ? 'bg-opt-yellow text-bg-primary font-medium' : 'bg-bg-card text-text-secondary border border-border-default'}`}
          >
            Closer EOD
          </button>
          <button
            onClick={() => { setTab('setter'); setConfirmed(false); setSelectedMember('') }}
            className={`px-4 py-2 rounded text-sm ${tab === 'setter' ? 'bg-opt-yellow text-bg-primary font-medium' : 'bg-bg-card text-text-secondary border border-border-default'}`}
          >
            Setter EOD
          </button>
        </div>

        <select
          value={selectedMember}
          onChange={e => { setSelectedMember(e.target.value); setConfirmed(false) }}
          className="bg-bg-card border border-border-default rounded px-3 py-2 text-sm text-text-primary"
        >
          <option value="">Select {tab}...</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>

        <span className="text-sm text-text-400">{today}</span>
      </div>

      {/* Closer EOD — call-by-call review */}
      {tab === 'closer' && selectedMember && (
        <div className="space-y-4">
          <p className="text-xs text-text-400 flex items-center gap-1">
            <Edit3 size={12} /> Calls booked in the last 7 days. Mark each call's outcome, then confirm.
          </p>

          {loadingCalls ? (
            <div className="flex items-center justify-center h-32">
              <Loader className="animate-spin text-opt-yellow" />
            </div>
          ) : calls.length === 0 ? (
            <div className="bg-bg-card border border-border-default rounded-lg p-8 text-center text-text-400 text-sm">
              No booked calls found for this closer in the last 7 days.
            </div>
          ) : (
            <>
              {/* Individual call cards */}
              <div className="space-y-3">
                {calls.map((call, i) => (
                  <div key={call.lead_id} className="bg-bg-card border border-border-default rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        {call.showed ? (
                          <Phone size={16} className="text-success" />
                        ) : (
                          <PhoneOff size={16} className="text-danger" />
                        )}
                        <div>
                          <span className="font-medium text-sm">{call.lead_name}</span>
                          <span className="text-xs text-text-400 ml-2">via {call.setter_name}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-400">
                        <span>{call.appointment_date}</span>
                        <select
                          value={call.call_type}
                          onChange={e => updateCall(i, 'call_type', e.target.value)}
                          className="bg-bg-primary border border-border-default rounded px-2 py-0.5 text-xs"
                        >
                          <option value="NC">NC</option>
                          <option value="FU">FU</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 flex-wrap">
                      {/* Showed toggle */}
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={call.showed}
                          onChange={e => updateCall(i, 'showed', e.target.checked)}
                          className="accent-opt-yellow"
                        />
                        <span className={`text-xs ${call.showed ? 'text-success' : 'text-danger'}`}>
                          {call.showed ? 'Showed' : 'No Show'}
                        </span>
                      </label>

                      {/* Offered toggle */}
                      {call.showed && (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={call.offered}
                            onChange={e => updateCall(i, 'offered', e.target.checked)}
                            className="accent-opt-yellow"
                          />
                          <span className="text-xs text-text-secondary">Offered</span>
                        </label>
                      )}

                      {/* Closed toggle */}
                      {call.offered && (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={call.closed}
                            onChange={e => updateCall(i, 'closed', e.target.checked)}
                            className="accent-opt-yellow"
                          />
                          <span className={`text-xs ${call.closed ? 'text-success font-medium' : 'text-text-secondary'}`}>
                            Closed
                          </span>
                        </label>
                      )}

                      {/* Revenue + Cash if closed */}
                      {call.closed && (
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-text-400">$</span>
                            <input
                              type="number"
                              value={call.revenue}
                              onChange={e => updateCall(i, 'revenue', parseFloat(e.target.value) || 0)}
                              placeholder="Revenue"
                              className="bg-bg-primary border border-border-default rounded px-2 py-0.5 text-xs w-24"
                            />
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-text-400">Cash</span>
                            <input
                              type="number"
                              value={call.cash_collected}
                              onChange={e => updateCall(i, 'cash_collected', parseFloat(e.target.value) || 0)}
                              placeholder="Cash"
                              className="bg-bg-primary border border-border-default rounded px-2 py-0.5 text-xs w-24"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Auto-calculated summary */}
              <div className="bg-bg-card border border-opt-yellow/20 rounded-lg p-4">
                <h3 className="text-xs text-opt-yellow uppercase font-medium mb-3">Summary (auto-calculated)</h3>
                <div className="grid grid-cols-3 md:grid-cols-5 gap-3 text-center">
                  <div>
                    <p className="text-lg font-bold">{summary.nc_booked + summary.fu_booked}</p>
                    <p className="text-[10px] text-text-400 uppercase">Booked</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold">{summary.live_nc_calls + summary.live_fu_calls}</p>
                    <p className="text-[10px] text-text-400 uppercase">Showed</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-danger">{summary.nc_no_shows + summary.fu_no_shows}</p>
                    <p className="text-[10px] text-text-400 uppercase">No Shows</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold">{summary.offers}</p>
                    <p className="text-[10px] text-text-400 uppercase">Offers</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-success">{summary.closes}</p>
                    <p className="text-[10px] text-text-400 uppercase">Closes</p>
                  </div>
                </div>
                {summary.total_revenue > 0 && (
                  <div className="flex gap-6 mt-3 pt-3 border-t border-border-default text-xs text-text-400">
                    <span>Revenue: <strong className="text-success">${summary.total_revenue.toLocaleString()}</strong></span>
                    <span>Cash: <strong className="text-opt-yellow">${summary.total_cash_collected.toLocaleString()}</strong></span>
                  </div>
                )}
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs text-text-400 block mb-1">Notes</label>
                <textarea
                  value={closerNotes}
                  onChange={e => setCloserNotes(e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-3 py-1.5 text-sm w-full h-16 resize-none"
                  placeholder="Any notes for today..."
                />
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'closer' && !selectedMember && (
        <div className="bg-bg-card border border-border-default rounded-lg p-8 text-center text-text-400 text-sm">
          Select a closer to load their booked calls.
        </div>
      )}

      {/* Setter EOD — manual entry */}
      {tab === 'setter' && selectedMember && (
        <div className="space-y-4">
          <p className="text-xs text-text-400 flex items-center gap-1">
            <Edit3 size={12} /> Enter today's activity numbers, then confirm.
          </p>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {numField('Leads Worked', 'total_leads', setterData, updateSetter)}
            {numField('Outbound Calls', 'outbound_calls', setterData, updateSetter)}
            {numField('Pickups', 'pickups', setterData, updateSetter)}
            {numField('MCs', 'meaningful_conversations', setterData, updateSetter)}
            {numField('Sets', 'sets', setterData, updateSetter)}
            {numField('Reschedules', 'reschedules', setterData, updateSetter)}
          </div>
          <div className="bg-bg-card border border-border-default rounded-lg p-5">
            <h3 className="text-sm font-medium mb-3">Self Assessment</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-text-400 block mb-1">Rating (1-10)</label>
                <input
                  type="number" min="1" max="10"
                  value={setterData.self_rating}
                  onChange={e => updateSetter('self_rating', parseInt(e.target.value) || 0)}
                  className="bg-bg-primary border border-border-default rounded px-3 py-1.5 text-sm w-20"
                />
              </div>
              <div>
                <label className="text-xs text-text-400 block mb-1">What went well?</label>
                <textarea
                  value={setterData.what_went_well}
                  onChange={e => updateSetter('what_went_well', e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-3 py-1.5 text-sm w-full h-16 resize-none"
                />
              </div>
              <div>
                <label className="text-xs text-text-400 block mb-1">What could improve?</label>
                <textarea
                  value={setterData.what_went_poorly}
                  onChange={e => updateSetter('what_went_poorly', e.target.value)}
                  className="bg-bg-primary border border-border-default rounded px-3 py-1.5 text-sm w-full h-16 resize-none"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'setter' && !selectedMember && (
        <div className="bg-bg-card border border-border-default rounded-lg p-8 text-center text-text-400 text-sm">
          Select a setter to start their EOD.
        </div>
      )}

      {/* Confirm button */}
      {selectedMember && (
        <div className="mt-6">
          <button
            onClick={tab === 'closer' ? handleConfirmCloser : handleConfirmSetter}
            disabled={confirmed || submitting || !selectedMember || (tab === 'closer' && calls.length === 0)}
            className={`flex items-center gap-2 px-6 py-2.5 rounded font-medium text-sm transition-colors ${
              confirmed
                ? 'bg-success/20 text-success border border-success/30 cursor-default'
                : !selectedMember || (tab === 'closer' && calls.length === 0)
                ? 'bg-bg-card text-text-400 border border-border-default cursor-not-allowed'
                : 'bg-opt-yellow text-bg-primary hover:bg-opt-yellow/90'
            }`}
          >
            {submitting ? <Loader size={16} className="animate-spin" /> : <Check size={16} />}
            {confirmed ? 'Confirmed' : submitting ? 'Saving...' : 'Confirm EOD Report'}
          </button>
        </div>
      )}
    </div>
  )
}
