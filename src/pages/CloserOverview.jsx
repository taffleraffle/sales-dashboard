import { Link } from 'react-router-dom'
import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import Gauge from '../components/Gauge'

// Placeholder — will be fetched from Supabase
const closers = [
  { id: '1', name: 'Daniel', closeRate: 28, showRate: 72, ascensionRate: 70, pifRate: 25, pifCount: 3, revenue: 14955, deals: 4 },
  { id: '2', name: 'Josh', closeRate: 22, showRate: 65, ascensionRate: 60, pifRate: 20, pifCount: 2, revenue: 9970, deals: 3 },
]

export default function CloserOverview() {
  const [range, setRange] = useState(30)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Closer Performance</h1>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {closers.map(c => (
          <Link
            key={c.id}
            to={`/sales/closers/${c.id}`}
            className="bg-bg-card border border-border-default rounded-lg p-5 hover:bg-bg-card-hover transition-colors block"
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">{c.name}</h3>
              <span className="text-sm text-text-400">{c.deals} closes</span>
            </div>

            <div className="grid grid-cols-4 gap-3 mb-4">
              <Gauge label="Show Rate" value={c.showRate} target={70} />
              <Gauge label="Close Rate" value={c.closeRate} target={25} />
              <Gauge label="Ascension" value={c.ascensionRate} target={70} />
              <Gauge label="PIF Rate" value={c.pifRate} />
            </div>

            <div className="flex gap-6 text-xs">
              <span className="text-text-400">Revenue: <strong className="text-success">${c.revenue.toLocaleString()}</strong></span>
              <span className="text-text-400">PIFs: <strong className="text-opt-yellow">{c.pifCount}</strong></span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
