import { useState } from 'react'
import KPICard from '../components/KPICard'
import DateRangeSelector from '../components/DateRangeSelector'
import { ArrowRight, Loader } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCloserEODs } from '../hooks/useCloserData'
import { useSetterEODs } from '../hooks/useSetterData'
import { usePipelineAnalytics } from '../hooks/usePipelineAnalytics'

const funnelSteps = [
  { label: 'Leads', key: 'leads' },
  { label: 'Bookings', key: 'bookings' },
  { label: 'Shows', key: 'shows' },
  { label: 'Offers', key: 'offers' },
  { label: 'Closes', key: 'closes' },
]

export default function SalesOverview() {
  const [range, setRange] = useState(30)
  const { data: pipeline, loading: loadingPipeline, error: pipelineError } = usePipelineAnalytics(range)
  const { members: closers } = useTeamMembers('closer')
  const { members: setters } = useTeamMembers('setter')
  const { reports: closerReports } = useCloserEODs(null, range)
  const { reports: setterReports } = useSetterEODs(null, range)

  // Aggregate closer EOD data
  const closerTotals = closerReports.reduce((acc, r) => ({
    booked: acc.booked + (r.nc_booked || 0) + (r.fu_booked || 0),
    liveCalls: acc.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
    offers: acc.offers + (r.offers || 0),
    closes: acc.closes + (r.closes || 0),
    revenue: acc.revenue + parseFloat(r.total_revenue || 0),
    cash: acc.cash + parseFloat(r.total_cash_collected || 0),
  }), { booked: 0, liveCalls: 0, offers: 0, closes: 0, revenue: 0, cash: 0 })

  // Aggregate setter EOD data
  const setterTotals = setterReports.reduce((acc, r) => ({
    dials: acc.dials + (r.outbound_calls || 0),
    leads: acc.leads + (r.total_leads || 0),
    mcs: acc.mcs + (r.meaningful_conversations || 0),
    sets: acc.sets + (r.sets || 0),
  }), { dials: 0, leads: 0, mcs: 0, sets: 0 })

  // Use GHL pipeline for funnel if available, otherwise fall back to EOD
  const pFunnel = pipeline?.funnel
  const sourceOutcomes = pipeline?.sourceOutcomes

  const funnel = {
    leads: pFunnel?.newLeads || setterTotals.leads || 0,
    bookings: pFunnel?.setCallsTotal || closerTotals.booked || 0,
    shows: pFunnel?.setCallsTotal ? Math.round(pFunnel.setCallsTotal * (pFunnel.showRate || 0) / 100) : closerTotals.liveCalls,
    offers: closerTotals.offers,
    closes: pFunnel?.closedCount || closerTotals.closes || 0,
  }

  const showRate = funnel.bookings ? ((funnel.shows / funnel.bookings) * 100).toFixed(1) : 0
  const closeRate = funnel.shows ? ((funnel.closes / funnel.shows) * 100).toFixed(1) : 0
  const offerRate = funnel.shows ? ((funnel.offers / funnel.shows) * 100).toFixed(1) : 0

  // Auto vs Manual from pipeline source outcomes
  const autoData = sourceOutcomes?.auto || {}
  const manualData = sourceOutcomes?.manual || {}

  // Per-closer quick view
  const closerCards = closers.map(c => {
    const myReports = closerReports.filter(r => r.closer_id === c.id)
    const t = myReports.reduce((acc, r) => ({
      liveCalls: acc.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
      closes: acc.closes + (r.closes || 0),
      revenue: acc.revenue + parseFloat(r.total_revenue || 0),
    }), { liveCalls: 0, closes: 0, revenue: 0 })
    return { id: c.id, name: c.name, ...t }
  })

  // Per-setter quick view
  const setterCards = setters.map(s => {
    const myReports = setterReports.filter(r => r.setter_id === s.id)
    const t = myReports.reduce((acc, r) => ({
      dials: acc.dials + (r.outbound_calls || 0),
      sets: acc.sets + (r.sets || 0),
    }), { dials: 0, sets: 0 })
    return { id: s.id, name: s.name, ...t }
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Sales Overview</h1>
        <div className="flex items-center gap-3">
          {loadingPipeline && <span className="text-xs text-text-400">Loading pipeline...</span>}
          {pipelineError && <span className="text-xs text-danger">Pipeline error</span>}
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <KPICard label="Total Revenue" value={`$${closerTotals.revenue.toLocaleString()}`} />
        <KPICard label="Cash Collected" value={`$${closerTotals.cash.toLocaleString()}`} />
        <KPICard label="Total Closes" value={closerTotals.closes} />
        <KPICard label="Show Rate" value={`${showRate}%`} target={70} direction="above" />
        <KPICard label="Close Rate" value={`${closeRate}%`} target={25} direction="above" />
        <KPICard label="Offer Rate" value={`${offerRate}%`} target={80} direction="above" />
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
        {funnel.closes > 0 && (
          <div className="mt-3 pt-3 border-t border-border-default flex gap-6 text-xs text-text-400">
            <span>Leads per close: <strong className="text-text-primary">{Math.round(funnel.leads / funnel.closes)}</strong></span>
            <span>Shows per close: <strong className="text-text-primary">{(funnel.shows / funnel.closes).toFixed(1)}</strong></span>
          </div>
        )}
      </div>

      {/* Auto vs Manual Comparison */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-bg-card border border-border-default rounded-lg p-5">
          <h3 className="text-sm font-medium text-opt-yellow mb-3">Auto-Booked</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[11px] text-text-400 uppercase">Bookings</p>
              <p className="text-lg font-bold">{autoData.total || pFunnel?.autoBooked || 0}</p>
            </div>
            <div>
              <p className="text-[11px] text-text-400 uppercase">Show Rate</p>
              <p className="text-lg font-bold">{autoData.show_rate || pFunnel?.showRateAuto || 0}%</p>
            </div>
            <div>
              <p className="text-[11px] text-text-400 uppercase">Close Rate</p>
              <p className="text-lg font-bold">{autoData.close_rate || pFunnel?.closeRateAuto || 0}%</p>
            </div>
          </div>
        </div>
        <div className="bg-bg-card border border-border-default rounded-lg p-5">
          <h3 className="text-sm font-medium text-text-secondary mb-3">Manual Sets</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[11px] text-text-400 uppercase">Bookings</p>
              <p className="text-lg font-bold">{manualData.total || pFunnel?.manualSet || 0}</p>
            </div>
            <div>
              <p className="text-[11px] text-text-400 uppercase">Show Rate</p>
              <p className="text-lg font-bold">{manualData.show_rate || pFunnel?.showRateManual || 0}%</p>
            </div>
            <div>
              <p className="text-[11px] text-text-400 uppercase">Close Rate</p>
              <p className="text-lg font-bold">{manualData.close_rate || pFunnel?.closeRateManual || 0}%</p>
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
          {closerCards.length > 0 ? (
            <div className="space-y-2">
              {closerCards.map(c => (
                <Link key={c.id} to={`/sales/closers/${c.id}`} className="flex items-center justify-between py-1.5 hover:bg-bg-card-hover rounded px-2 -mx-2 transition-colors">
                  <span className="text-sm font-medium">{c.name}</span>
                  <div className="flex gap-4 text-xs text-text-400">
                    <span>{c.closes} closes</span>
                    <span className="text-success">${c.revenue.toLocaleString()}</span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-400">No closer data yet</p>
          )}
        </div>
        <div className="bg-bg-card border border-border-default rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-secondary">Setters</h3>
            <Link to="/sales/setters" className="text-xs text-opt-yellow hover:underline">View all</Link>
          </div>
          {setterCards.length > 0 ? (
            <div className="space-y-2">
              {setterCards.map(s => (
                <Link key={s.id} to={`/sales/setters/${s.id}`} className="flex items-center justify-between py-1.5 hover:bg-bg-card-hover rounded px-2 -mx-2 transition-colors">
                  <span className="text-sm font-medium">{s.name}</span>
                  <div className="flex gap-4 text-xs text-text-400">
                    <span>{s.sets} sets</span>
                    <span>{s.dials} dials</span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-400">No setter data yet</p>
          )}
        </div>
      </div>
    </div>
  )
}
