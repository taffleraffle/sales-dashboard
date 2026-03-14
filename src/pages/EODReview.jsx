import { useState, useEffect } from 'react'
import { Check, Edit3, RefreshCw, Loader } from 'lucide-react'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useEODSubmit } from '../hooks/useEOD'

export default function EODReview() {
  const [tab, setTab] = useState('closer')
  const [confirmed, setConfirmed] = useState(false)
  const [selectedMember, setSelectedMember] = useState('')
  const { members: closers } = useTeamMembers('closer')
  const { members: setters } = useTeamMembers('setter')
  const { submitCloserEOD, submitSetterEOD, submitting } = useEODSubmit()

  const today = new Date().toISOString().split('T')[0]

  // Editable closer fields
  const [closerData, setCloserData] = useState({
    nc_booked: 0, fu_booked: 0, nc_no_shows: 0, fu_no_shows: 0,
    live_nc_calls: 0, live_fu_calls: 0, offers: 0, closes: 0,
    total_revenue: 0, total_cash_collected: 0, notes: '',
  })

  // Editable setter fields
  const [setterData, setSetterData] = useState({
    total_leads: 0, outbound_calls: 0, pickups: 0,
    meaningful_conversations: 0, sets: 0, reschedules: 0,
    self_rating: 7, what_went_well: '', what_went_poorly: '',
  })

  const updateCloser = (key, val) => setCloserData(d => ({ ...d, [key]: val }))
  const updateSetter = (key, val) => setSetterData(d => ({ ...d, [key]: val }))

  const handleConfirm = async () => {
    if (!selectedMember) return alert('Select a team member first')
    let result
    if (tab === 'closer') {
      result = await submitCloserEOD(selectedMember, today, closerData)
    } else {
      result = await submitSetterEOD(selectedMember, today, setterData)
    }
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
          onChange={e => setSelectedMember(e.target.value)}
          className="bg-bg-card border border-border-default rounded px-3 py-2 text-sm text-text-primary"
        >
          <option value="">Select {tab}...</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>

        <span className="text-sm text-text-400">{today}</span>
      </div>

      <p className="text-xs text-text-400 flex items-center gap-1 mb-4">
        <Edit3 size={12} /> Auto-generated from API data. Review, edit if needed, and confirm.
      </p>

      {tab === 'closer' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
            {numField('NC Booked', 'nc_booked', closerData, updateCloser)}
            {numField('FU Booked', 'fu_booked', closerData, updateCloser)}
            {numField('NC No Shows', 'nc_no_shows', closerData, updateCloser)}
            {numField('FU No Shows', 'fu_no_shows', closerData, updateCloser)}
            {numField('Live NC Calls', 'live_nc_calls', closerData, updateCloser)}
            {numField('Live FU Calls', 'live_fu_calls', closerData, updateCloser)}
            {numField('Offers', 'offers', closerData, updateCloser)}
            {numField('Closes', 'closes', closerData, updateCloser)}
            {numField('Revenue', 'total_revenue', closerData, updateCloser)}
            {numField('Cash Collected', 'total_cash_collected', closerData, updateCloser)}
          </div>
          <div>
            <label className="text-xs text-text-400 block mb-1">Notes</label>
            <textarea
              value={closerData.notes}
              onChange={e => updateCloser('notes', e.target.value)}
              className="bg-bg-primary border border-border-default rounded px-3 py-1.5 text-sm w-full h-16 resize-none"
            />
          </div>
        </div>
      )}

      {tab === 'setter' && (
        <div className="space-y-4">
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

      <div className="mt-6">
        <button
          onClick={handleConfirm}
          disabled={confirmed || submitting || !selectedMember}
          className={`flex items-center gap-2 px-6 py-2.5 rounded font-medium text-sm transition-colors ${
            confirmed
              ? 'bg-success/20 text-success border border-success/30 cursor-default'
              : !selectedMember
              ? 'bg-bg-card text-text-400 border border-border-default cursor-not-allowed'
              : 'bg-opt-yellow text-bg-primary hover:bg-opt-yellow/90'
          }`}
        >
          {submitting ? <Loader size={16} className="animate-spin" /> : <Check size={16} />}
          {confirmed ? 'Confirmed' : submitting ? 'Saving...' : 'Confirm EOD Report'}
        </button>
      </div>
    </div>
  )
}
