import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import DataTable from '../components/DataTable'
import { useMarketingData } from '../hooks/useMarketingData'

const fmt = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
const fmtDec = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtPct = (n) => `${n.toFixed(2)}%`

const campaignColumns = [
  { key: 'campaign_name', label: 'Campaign' },
  { key: 'spend', label: 'Spend', align: 'right', render: (v) => fmt(v) },
  { key: 'clicks', label: 'Clicks', align: 'right', render: (v) => (v ?? 0).toLocaleString() },
  { key: 'leads', label: 'Leads', align: 'right', render: (v) => (v ?? 0).toLocaleString() },
  { key: 'cpl', label: 'CPL', align: 'right', render: (v) => fmtDec(v) },
  { key: 'revenue', label: 'Revenue (Hyros)', align: 'right', render: (v) => fmt(v || 0) },
  { key: 'roas', label: 'ROAS', align: 'right', render: (v) => `${(v || 0).toFixed(2)}x` },
]

function DailySpendChart({ daily }) {
  if (!daily.length) return null
  const maxSpend = Math.max(...daily.map(d => d.spend), 1)

  return (
    <div className="bg-bg-card border border-border-default rounded-lg p-4">
      <h2 className="text-sm font-semibold text-text-secondary mb-3">Daily Ad Spend</h2>
      <div className="flex items-end gap-[2px] h-32">
        {daily.map((d) => {
          const pct = (d.spend / maxSpend) * 100
          return (
            <div key={d.date} className="flex-1 flex flex-col items-center justify-end group relative">
              <div
                className="w-full bg-opt-yellow/70 hover:bg-opt-yellow rounded-t transition-colors min-h-[2px]"
                style={{ height: `${pct}%` }}
              />
              <div className="absolute bottom-full mb-1 hidden group-hover:block bg-bg-card border border-border-default rounded px-2 py-1 text-xs text-text-primary whitespace-nowrap shadow-lg z-10">
                <span className="font-medium">{d.date}</span>
                <br />
                {fmt(d.spend)} &middot; {d.leads} leads
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-text-400">{daily[0]?.date}</span>
        <span className="text-[10px] text-text-400">{daily[daily.length - 1]?.date}</span>
      </div>
    </div>
  )
}

export default function MarketingPerformance() {
  const [range, setRange] = useState(30)
  const { data, loading } = useMarketingData(range)
  const { totals, campaigns, daily } = data

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Marketing Performance</h1>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {loading ? (
        <div className="bg-bg-card border border-border-default rounded-lg p-8 text-center text-text-400">
          <p className="text-sm">Loading marketing data...</p>
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <KPICard label="Ad Spend" value={fmt(totals.totalSpend)} subtitle={`${totals.totalImpressions?.toLocaleString() || 0} impressions`} />
            <KPICard label="CPL" value={fmtDec(totals.cpl)} target={250} direction="below" subtitle={`${totals.totalLeads} leads`} />
            <KPICard label="CPC" value={fmtDec(totals.cpc)} subtitle={`${totals.totalClicks?.toLocaleString() || 0} clicks`} />
            <KPICard label="CTR" value={fmtPct(totals.ctr)} />
            <KPICard label="ROAS" value={`${totals.roas.toFixed(2)}x`} target={2.0} direction="above" subtitle={`${fmt(totals.totalRevenue)} revenue`} />
            <KPICard label="CPA" value={fmtDec(totals.cpa)} subtitle={`${totals.totalConversions} conversions`} />
          </div>

          {/* Daily Spend Chart */}
          <div className="mb-6">
            <DailySpendChart daily={daily} />
          </div>

          {/* Campaign Breakdown */}
          <div className="mb-2">
            <h2 className="text-sm font-semibold text-text-secondary mb-3">Campaign Breakdown</h2>
            <DataTable
              columns={campaignColumns}
              data={campaigns}
              emptyMessage="No campaign data for this period"
            />
          </div>
        </>
      )}
    </div>
  )
}
