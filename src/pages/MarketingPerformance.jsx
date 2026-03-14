import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'

export default function MarketingPerformance() {
  const [range, setRange] = useState(30)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Marketing Performance</h1>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KPICard label="Ad Spend" value="$10,621" />
        <KPICard label="CPL" value="$34.49" target={250} direction="below" />
        <KPICard label="CPC" value="$2.15" />
        <KPICard label="ROAS" value="1.69x" target={2.0} direction="above" />
      </div>

      <div className="bg-bg-card border border-border-default rounded-lg p-8 text-center text-text-400">
        <p className="text-sm">Will's chunk — Meta Ads API + Hyros integration will populate charts here</p>
        <p className="text-xs mt-2">Campaign breakdown, spend vs revenue trends, CPL trends, ROAS over time</p>
      </div>
    </div>
  )
}
