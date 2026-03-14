import { useState } from 'react'
import KPICard from '../components/KPICard'
import DateRangeSelector from '../components/DateRangeSelector'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'

const funnelSteps = [
  { label: 'Leads', key: 'leads' },
  { label: 'Bookings', key: 'bookings' },
  { label: 'Shows', key: 'shows' },
  { label: 'Offers', key: 'offers' },
  { label: 'Closes', key: 'closes' },
  { label: 'Ascensions', key: 'ascensions' },
]

export default function SalesOverview() {
  const [range, setRange] = useState(30)

  // Placeholder data — will be wired to Supabase + APIs
  const kpis = {
    adSpend: 10621,
    cpl: 34.49,
    cpc: 2.15,
    roas: 1.69,
    cpa: 885,
    showRate: 67.1,
    closeRate: 25.5,
    ascensionRate: 66.7,
    pifCount: 3,
    pifRate: 25,
    activeTrials: 4,
  }

  const funnel = {
    leads: 308,
    bookings: 70,
    shows: 47,
    offers: 38,
    closes: 12,
    ascensions: 8,
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Sales Overview</h1>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
        <KPICard label="Ad Spend" value={`$${kpis.adSpend.toLocaleString()}`} />
        <KPICard label="CPL" value={`$${kpis.cpl}`} target={250} direction="below" />
        <KPICard label="ROAS" value={`${kpis.roas}x`} target={2.0} direction="above" />
        <KPICard label="Show Rate" value={`${kpis.showRate}%`} target={70} direction="above" />
        <KPICard label="Close Rate" value={`${kpis.closeRate}%`} target={25} direction="above" />
        <KPICard label="Ascension Rate" value={`${kpis.ascensionRate}%`} target={70} direction="above" />
      </div>

      {/* Funnel Visualization */}
      <div className="bg-bg-card border border-border-default rounded-lg p-5 mb-6">
        <h2 className="text-sm font-medium text-text-secondary mb-4">Full Funnel</h2>
        <div className="flex items-center justify-between gap-2 overflow-x-auto">
          {funnelSteps.map((step, i) => {
            const count = funnel[step.key]
            const prev = i > 0 ? funnel[funnelSteps[i - 1].key] : null
            const convPct = prev ? ((count / prev) * 100).toFixed(1) : null
            return (
              <div key={step.key} className="flex items-center gap-2">
                {i > 0 && (
                  <div className="flex flex-col items-center text-text-400">
                    <ArrowRight size={14} />
                    <span className="text-[10px]">{convPct}%</span>
                  </div>
                )}
                <div className="text-center min-w-[80px]">
                  <p className="text-2xl font-bold text-text-primary">{count}</p>
                  <p className="text-[11px] text-text-400 uppercase">{step.label}</p>
                </div>
              </div>
            )
          })}
        </div>
        <div className="mt-3 pt-3 border-t border-border-default flex gap-6 text-xs text-text-400">
          <span>Leads per close: <strong className="text-text-primary">{Math.round(funnel.leads / funnel.closes)}</strong></span>
          <span>Shows per close: <strong className="text-text-primary">{(funnel.shows / funnel.closes).toFixed(1)}</strong></span>
          <span>CPA: <strong className="text-text-primary">${kpis.cpa}</strong></span>
        </div>
      </div>

      {/* Auto vs Manual Comparison */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-bg-card border border-border-default rounded-lg p-5">
          <h3 className="text-sm font-medium text-opt-yellow mb-3">Auto-Booked</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[11px] text-text-400 uppercase">Show Rate</p>
              <p className="text-lg font-bold">75.0%</p>
            </div>
            <div>
              <p className="text-[11px] text-text-400 uppercase">Close Rate</p>
              <p className="text-lg font-bold">30.8%</p>
            </div>
            <div>
              <p className="text-[11px] text-text-400 uppercase">CPA</p>
              <p className="text-lg font-bold">$720</p>
            </div>
          </div>
        </div>
        <div className="bg-bg-card border border-border-default rounded-lg p-5">
          <h3 className="text-sm font-medium text-text-secondary mb-3">Manual Sets</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[11px] text-text-400 uppercase">Show Rate</p>
              <p className="text-lg font-bold">62.5%</p>
            </div>
            <div>
              <p className="text-[11px] text-text-400 uppercase">Close Rate</p>
              <p className="text-lg font-bold">20.0%</p>
            </div>
            <div>
              <p className="text-[11px] text-text-400 uppercase">CPA</p>
              <p className="text-lg font-bold">$1,050</p>
            </div>
          </div>
        </div>
      </div>

      {/* Team Quick View */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-bg-card border border-border-default rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-secondary">Closers</h3>
            <Link to="/sales/closers" className="text-xs text-opt-yellow hover:underline">View all</Link>
          </div>
          <div className="space-y-2 text-sm text-text-400">
            <p>Connect API data to populate closer cards</p>
          </div>
        </div>
        <div className="bg-bg-card border border-border-default rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-secondary">Setters</h3>
            <Link to="/sales/setters" className="text-xs text-opt-yellow hover:underline">View all</Link>
          </div>
          <div className="space-y-2 text-sm text-text-400">
            <p>Connect API data to populate setter cards</p>
          </div>
        </div>
      </div>
    </div>
  )
}
