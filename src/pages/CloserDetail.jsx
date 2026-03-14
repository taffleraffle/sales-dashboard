import { useParams } from 'react-router-dom'
import { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import DataTable from '../components/DataTable'
import { MessageSquare, AlertTriangle, Loader } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useCloserStats, useCloserTranscripts, useObjectionAnalysis } from '../hooks/useCloserData'

export default function CloserDetail() {
  const { id } = useParams()
  const [range, setRange] = useState(30)
  const [member, setMember] = useState(null)
  const stats = useCloserStats(id, range)
  const { transcripts, loading: loadingTranscripts } = useCloserTranscripts(id)
  const { objections, loading: loadingObjections } = useObjectionAnalysis(id)

  useEffect(() => {
    supabase.from('team_members').select('*').eq('id', id).single()
      .then(({ data }) => setMember(data))
  }, [id])

  if (!member) {
    return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>
  }

  const objectionColumns = [
    { key: 'objection_category', label: 'Objection' },
    { key: 'occurrence_count', label: 'Times', align: 'right' },
    { key: 'win_rate', label: 'Win Rate', align: 'right', render: v => v != null ? <span className={v >= 50 ? 'text-success' : 'text-danger'}>{v}%</span> : '—' },
    { key: 'example_quotes', label: 'Example', render: v => {
      const quotes = Array.isArray(v) ? v : []
      return quotes[0] ? <span className="text-text-400 text-xs italic">"{quotes[0]}"</span> : '—'
    }},
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">{member.name}</h1>
          <p className="text-sm text-text-400">Closer Performance</p>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* Gauges */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
        <Gauge label="Show Rate" value={parseFloat(stats.showRate)} target={70} />
        <Gauge label="Close Rate" value={parseFloat(stats.closeRate)} target={25} />
        <Gauge label="Offer Rate" value={parseFloat(stats.offerRate)} target={80} />
      </div>

      {/* Revenue KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KPICard label="Total Closes" value={stats.closes} />
        <KPICard label="Revenue" value={`$${stats.revenue.toLocaleString()}`} />
        <KPICard label="Cash Collected" value={`$${stats.cash.toLocaleString()}`} />
        <KPICard label="Live Calls" value={stats.liveCalls} />
      </div>

      {/* Objection Analysis */}
      <div className="bg-bg-card border border-border-default rounded-lg p-5 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle size={16} className="text-warning" />
          <h2 className="text-sm font-medium">Most Common Objections</h2>
          <span className="text-xs text-text-400 ml-auto">Analyzed from Fathom transcripts via Claude</span>
        </div>
        {loadingObjections ? (
          <p className="text-text-400 text-sm py-4 text-center">Loading...</p>
        ) : objections.length > 0 ? (
          <DataTable columns={objectionColumns} data={objections} />
        ) : (
          <p className="text-text-400 text-sm py-4 text-center">No objection data yet. Transcripts will be analyzed automatically.</p>
        )}
      </div>

      {/* Fathom Transcripts */}
      <div className="bg-bg-card border border-border-default rounded-lg p-5">
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare size={16} className="text-opt-yellow" />
          <h2 className="text-sm font-medium">Call Transcripts</h2>
          <span className="text-xs text-text-400 ml-auto">Auto-pulled from Fathom</span>
        </div>
        {loadingTranscripts ? (
          <p className="text-text-400 text-sm py-4 text-center">Loading transcripts...</p>
        ) : transcripts.length > 0 ? (
          <div className="space-y-3">
            {transcripts.map(t => (
              <div key={t.id} className="border border-border-default rounded-lg p-4 hover:bg-bg-card-hover transition-colors">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{t.prospect_name || 'Unknown'}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      t.outcome === 'closed' ? 'bg-success/15 text-success' : 'bg-text-400/15 text-text-400'
                    }`}>
                      {t.outcome || 'pending'}
                    </span>
                    {t.revenue > 0 && <span className="text-xs text-success">${parseFloat(t.revenue).toLocaleString()}</span>}
                  </div>
                  <div className="text-xs text-text-400 flex items-center gap-3">
                    {t.duration_seconds && <span>{Math.round(t.duration_seconds / 60)} min</span>}
                    <span>{t.meeting_date}</span>
                  </div>
                </div>
                <p className="text-sm text-text-secondary">{t.summary || 'No summary available'}</p>
                {t.transcript_url && (
                  <a href={t.transcript_url} target="_blank" rel="noopener noreferrer" className="text-xs text-opt-yellow hover:underline mt-1 inline-block">
                    View recording
                  </a>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-text-400 text-sm py-4 text-center">No transcripts yet. Fathom meetings will appear here automatically.</p>
        )}
      </div>
    </div>
  )
}
