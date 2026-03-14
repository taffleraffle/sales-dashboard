import { useParams } from 'react-router-dom'
import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import DataTable from '../components/DataTable'
import { MessageSquare, TrendingUp, AlertTriangle } from 'lucide-react'

export default function CloserDetail() {
  const { id } = useParams()
  const [range, setRange] = useState(30)

  // Placeholder — will come from Supabase + Fathom API
  const closer = {
    name: 'Daniel',
    closeRate: 28,
    showRate: 72,
    offerRate: 85,
    ascensionRate: 70,
    pifRate: 25,
    pifCount: 3,
    totalCloses: 12,
    revenue: 14955,
    avgDeal: 1246,
  }

  const objections = [
    { category: 'Price / Budget', count: 8, winRate: 37.5, example: '"That\'s a lot of money for something I haven\'t seen results from yet"' },
    { category: 'Need to think about it', count: 6, winRate: 50, example: '"I need to discuss this with my business partner first"' },
    { category: 'Already have someone', count: 4, winRate: 25, example: '"We\'re already working with an SEO company"' },
    { category: 'Timing', count: 3, winRate: 66.7, example: '"Business is slow right now, maybe in a few months"' },
  ]

  const transcripts = [
    { id: '1', prospect: 'Mike Johnson', date: '2026-03-13', duration: '32 min', outcome: 'closed', revenue: 997, summary: 'Restoration company in Phoenix. Concerned about price but closed after ROI breakdown.' },
    { id: '2', prospect: 'Sarah Williams', date: '2026-03-12', duration: '28 min', outcome: 'not_closed', revenue: 0, summary: 'Plumber in Dallas. Wanted to think about it. Follow-up scheduled.' },
    { id: '3', prospect: 'Tom Davis', date: '2026-03-11', duration: '45 min', outcome: 'closed', revenue: 8000, summary: 'Remodeling contractor. PIF deal. Very engaged, asked great questions.' },
  ]

  const objectionColumns = [
    { key: 'category', label: 'Objection' },
    { key: 'count', label: 'Times', align: 'right' },
    { key: 'winRate', label: 'Win Rate', align: 'right', render: v => <span className={v >= 50 ? 'text-success' : 'text-danger'}>{v}%</span> },
    { key: 'example', label: 'Example', render: v => <span className="text-text-400 text-xs italic">{v}</span> },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">{closer.name}</h1>
          <p className="text-sm text-text-400">Closer Performance</p>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* Gauges */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Gauge label="Show Rate" value={closer.showRate} target={70} />
        <Gauge label="Close Rate" value={closer.closeRate} target={25} />
        <Gauge label="Offer Rate" value={closer.offerRate} target={80} />
        <Gauge label="Ascension" value={closer.ascensionRate} target={70} />
        <Gauge label="PIF Rate" value={closer.pifRate} />
      </div>

      {/* Revenue KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KPICard label="Total Closes" value={closer.totalCloses} />
        <KPICard label="Revenue" value={`$${closer.revenue.toLocaleString()}`} />
        <KPICard label="Avg Deal" value={`$${closer.avgDeal}`} />
        <KPICard label="PIFs" value={closer.pifCount} subtitle={`${closer.pifRate}% of closes`} />
      </div>

      {/* Objection Analysis */}
      <div className="bg-bg-card border border-border-default rounded-lg p-5 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle size={16} className="text-warning" />
          <h2 className="text-sm font-medium">Most Common Objections</h2>
          <span className="text-xs text-text-400 ml-auto">Analyzed from Fathom transcripts via Claude</span>
        </div>
        <DataTable columns={objectionColumns} data={objections} />
      </div>

      {/* Fathom Transcripts */}
      <div className="bg-bg-card border border-border-default rounded-lg p-5">
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare size={16} className="text-opt-yellow" />
          <h2 className="text-sm font-medium">Recent Call Transcripts</h2>
          <span className="text-xs text-text-400 ml-auto">Auto-pulled from Fathom</span>
        </div>
        <div className="space-y-3">
          {transcripts.map(t => (
            <div key={t.id} className="border border-border-default rounded-lg p-4 hover:bg-bg-card-hover transition-colors">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="font-medium">{t.prospect}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    t.outcome === 'closed' ? 'bg-success/15 text-success' : 'bg-text-400/15 text-text-400'
                  }`}>
                    {t.outcome === 'closed' ? 'Closed' : 'Not Closed'}
                  </span>
                  {t.revenue > 0 && <span className="text-xs text-success">${t.revenue.toLocaleString()}</span>}
                </div>
                <div className="text-xs text-text-400 flex items-center gap-3">
                  <span>{t.duration}</span>
                  <span>{t.date}</span>
                </div>
              </div>
              <p className="text-sm text-text-secondary">{t.summary}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
