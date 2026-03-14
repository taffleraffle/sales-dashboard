import { useState } from 'react'
import { Check, Edit3, RefreshCw } from 'lucide-react'

export default function EODReview() {
  const [tab, setTab] = useState('closer')
  const [confirmed, setConfirmed] = useState(false)

  // Auto-generated closer EOD (from GHL calendar + Fathom)
  const closerEOD = {
    date: '2026-03-14',
    ncBooked: 4,
    fuBooked: 2,
    ncNoShows: 1,
    fuNoShows: 0,
    liveNCCalls: 3,
    liveFUCalls: 2,
    offers: 4,
    closes: 2,
    revenue: 1994,
    calls: [
      { prospect: 'Mike Johnson', type: 'NC', showed: true, outcome: 'closed', revenue: 997 },
      { prospect: 'Sarah Williams', type: 'NC', showed: true, outcome: 'not_closed', revenue: 0 },
      { prospect: 'Tom Davis', type: 'FU', showed: true, outcome: 'closed', revenue: 997 },
      { prospect: 'Lisa Chen', type: 'NC', showed: false, outcome: 'no_show', revenue: 0 },
      { prospect: 'James Brown', type: 'FU', showed: true, outcome: 'not_closed', revenue: 0 },
    ],
  }

  // Auto-generated setter EOD (from Wavv tags diff)
  const setterEOD = {
    date: '2026-03-14',
    totalLeads: 42,
    outboundCalls: 156,
    pickups: 23,
    meaningfulConversations: 12,
    sets: 3,
    reschedules: 1,
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">EOD Review</h1>
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-bg-card border border-border-default text-text-secondary hover:text-text-primary">
          <RefreshCw size={14} />
          Refresh from APIs
        </button>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-1 mb-6">
        <button
          onClick={() => { setTab('closer'); setConfirmed(false) }}
          className={`px-4 py-2 rounded text-sm ${tab === 'closer' ? 'bg-opt-yellow text-bg-primary font-medium' : 'bg-bg-card text-text-secondary border border-border-default'}`}
        >
          Closer EOD
        </button>
        <button
          onClick={() => { setTab('setter'); setConfirmed(false) }}
          className={`px-4 py-2 rounded text-sm ${tab === 'setter' ? 'bg-opt-yellow text-bg-primary font-medium' : 'bg-bg-card text-text-secondary border border-border-default'}`}
        >
          Setter EOD
        </button>
      </div>

      {tab === 'closer' && (
        <div className="space-y-4">
          <p className="text-xs text-text-400 flex items-center gap-1">
            <Edit3 size={12} /> Auto-generated from GHL calendar events. Review and confirm.
          </p>

          {/* Summary metrics */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {[
              { label: 'NC Booked', value: closerEOD.ncBooked },
              { label: 'FU Booked', value: closerEOD.fuBooked },
              { label: 'No Shows', value: closerEOD.ncNoShows + closerEOD.fuNoShows },
              { label: 'Live Calls', value: closerEOD.liveNCCalls + closerEOD.liveFUCalls },
              { label: 'Closes', value: closerEOD.closes },
              { label: 'Revenue', value: `$${closerEOD.revenue.toLocaleString()}` },
            ].map(m => (
              <div key={m.label} className="bg-bg-card border border-border-default rounded-lg p-3">
                <p className="text-[11px] text-text-400 uppercase">{m.label}</p>
                <p className="text-lg font-bold">{m.value}</p>
              </div>
            ))}
          </div>

          {/* Individual calls */}
          <div className="bg-bg-card border border-border-default rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border-default">
              <h3 className="text-sm font-medium">Call Log</h3>
            </div>
            {closerEOD.calls.map((call, i) => (
              <div key={i} className={`px-4 py-3 flex items-center justify-between ${i % 2 === 0 ? 'bg-bg-primary' : ''} border-b border-border-default last:border-0`}>
                <div className="flex items-center gap-3">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-bg-card border border-border-default">{call.type}</span>
                  <span>{call.prospect}</span>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className={call.showed ? 'text-success' : 'text-danger'}>
                    {call.showed ? 'Showed' : 'No Show'}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    call.outcome === 'closed' ? 'bg-success/15 text-success' : 'bg-text-400/15 text-text-400'
                  }`}>{call.outcome.replace('_', ' ')}</span>
                  {call.revenue > 0 && <span className="text-success">${call.revenue}</span>}
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={() => setConfirmed(true)}
            disabled={confirmed}
            className={`flex items-center gap-2 px-6 py-2.5 rounded font-medium text-sm transition-colors ${
              confirmed
                ? 'bg-success/20 text-success border border-success/30 cursor-default'
                : 'bg-opt-yellow text-bg-primary hover:bg-opt-yellow/90'
            }`}
          >
            <Check size={16} />
            {confirmed ? 'Confirmed' : 'Confirm EOD Report'}
          </button>
        </div>
      )}

      {tab === 'setter' && (
        <div className="space-y-4">
          <p className="text-xs text-text-400 flex items-center gap-1">
            <Edit3 size={12} /> Auto-generated from Wavv dial tags. Review and confirm.
          </p>

          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {[
              { label: 'Leads Worked', value: setterEOD.totalLeads },
              { label: 'Outbound Calls', value: setterEOD.outboundCalls },
              { label: 'Pickups', value: setterEOD.pickups },
              { label: 'MCs', value: setterEOD.meaningfulConversations },
              { label: 'Sets', value: setterEOD.sets },
              { label: 'Reschedules', value: setterEOD.reschedules },
            ].map(m => (
              <div key={m.label} className="bg-bg-card border border-border-default rounded-lg p-3">
                <p className="text-[11px] text-text-400 uppercase">{m.label}</p>
                <p className="text-lg font-bold">{m.value}</p>
              </div>
            ))}
          </div>

          {/* Self-assessment (manual input) */}
          <div className="bg-bg-card border border-border-default rounded-lg p-5">
            <h3 className="text-sm font-medium mb-3">Self Assessment</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-text-400 block mb-1">Rating (1-10)</label>
                <input type="number" min="1" max="10" className="bg-bg-primary border border-border-default rounded px-3 py-1.5 text-sm w-20" />
              </div>
              <div>
                <label className="text-xs text-text-400 block mb-1">What went well?</label>
                <textarea className="bg-bg-primary border border-border-default rounded px-3 py-1.5 text-sm w-full h-16 resize-none" />
              </div>
              <div>
                <label className="text-xs text-text-400 block mb-1">What could improve?</label>
                <textarea className="bg-bg-primary border border-border-default rounded px-3 py-1.5 text-sm w-full h-16 resize-none" />
              </div>
            </div>
          </div>

          <button
            onClick={() => setConfirmed(true)}
            disabled={confirmed}
            className={`flex items-center gap-2 px-6 py-2.5 rounded font-medium text-sm transition-colors ${
              confirmed
                ? 'bg-success/20 text-success border border-success/30 cursor-default'
                : 'bg-opt-yellow text-bg-primary hover:bg-opt-yellow/90'
            }`}
          >
            <Check size={16} />
            {confirmed ? 'Confirmed' : 'Confirm EOD Report'}
          </button>
        </div>
      )}
    </div>
  )
}
