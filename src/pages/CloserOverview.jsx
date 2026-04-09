import { Link } from 'react-router-dom'
import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCloserEODs, useCloserCallBreakdown } from '../hooks/useCloserData'
import { Loader, Plus } from 'lucide-react'
import { rangeToDays } from '../lib/dateUtils'

export default function CloserOverview() {
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const { members: closers, loading: loadingMembers } = useTeamMembers('closer')
  const { reports, loading: loadingReports } = useCloserEODs(null, days)
  const { breakdown } = useCloserCallBreakdown(null, days)

  if (loadingMembers) {
    return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>
  }

  // Company-wide totals from all closer EODs
  const companyTotals = reports.reduce((acc, r) => ({
    ncBooked: acc.ncBooked + (r.nc_booked || 0),
    fuBooked: acc.fuBooked + (r.fu_booked || 0),
    ncNoShows: acc.ncNoShows + (r.nc_no_shows || 0),
    fuNoShows: acc.fuNoShows + (r.fu_no_shows || 0),
    liveCalls: acc.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
    liveNC: acc.liveNC + (r.live_nc_calls || 0),
    liveFU: acc.liveFU + (r.live_fu_calls || 0),
    reschedules: acc.reschedules + (r.reschedules || 0),
    offers: acc.offers + (r.offers || 0),
    closes: acc.closes + (r.closes || 0),
    deposits: acc.deposits + (r.deposits || 0),
    revenue: acc.revenue + parseFloat(r.total_revenue || 0),
    cash: acc.cash + parseFloat(r.total_cash_collected || 0),
  }), { ncBooked: 0, fuBooked: 0, ncNoShows: 0, fuNoShows: 0, liveCalls: 0, liveNC: 0, liveFU: 0, reschedules: 0, offers: 0, closes: 0, deposits: 0, revenue: 0, cash: 0 })

  const totalBooked = companyTotals.ncBooked + companyTotals.fuBooked
  const totalNoShows = companyTotals.ncNoShows + companyTotals.fuNoShows
  const companyShowRate = totalBooked > 0 ? parseFloat(((companyTotals.liveCalls / totalBooked) * 100).toFixed(1)) : 0

  // Company close-rate breakdown from call-level data
  const companyBreak = Object.values(breakdown).reduce((a, b) => ({
    ncCloses: a.ncCloses + b.ncCloses,
    fuCloses: a.fuCloses + b.fuCloses,
    ncLive: a.ncLive + b.ncLive,
    fuLive: a.fuLive + b.fuLive,
    allCloses: a.allCloses + b.allCloses,
  }), { ncCloses: 0, fuCloses: 0, ncLive: 0, fuLive: 0, allCloses: 0 })

  // Close rate = closes on NEW calls only / live new calls
  const companyCloseRate = companyBreak.ncLive > 0
    ? parseFloat(((companyBreak.ncCloses / companyBreak.ncLive) * 100).toFixed(1))
    : 0
  // Net close rate = ALL closes (new + follow-up) / live new calls
  const companyNetCloseRate = companyBreak.ncLive > 0
    ? parseFloat((((companyBreak.ncCloses + companyBreak.fuCloses) / companyBreak.ncLive) * 100).toFixed(1))
    : 0
  const companyOfferRate = companyTotals.liveCalls > 0 ? parseFloat(((companyTotals.offers / companyTotals.liveCalls) * 100).toFixed(1)) : 0
  const companyOfferCloseRate = companyTotals.offers > 0 ? parseFloat(((companyTotals.closes / companyTotals.offers) * 100).toFixed(1)) : 0
  const companyRescheduleRate = totalBooked > 0 ? parseFloat(((companyTotals.reschedules / totalBooked) * 100).toFixed(1)) : 0
  const avgDealSize = companyTotals.closes > 0 ? parseFloat((companyTotals.revenue / companyTotals.closes).toFixed(0)) : 0
  const callsPerClose = companyTotals.closes > 0 ? parseFloat((companyTotals.liveCalls / companyTotals.closes).toFixed(1)) : 0
  const cashCollectionRate = companyTotals.revenue > 0 ? parseFloat(((companyTotals.cash / companyTotals.revenue) * 100).toFixed(1)) : 0

  // Aggregate stats per closer
  const closerStats = closers.map(closer => {
    const myReports = reports.filter(r => r.closer_id === closer.id)
    const totals = myReports.reduce((acc, r) => ({
      ncBooked: acc.ncBooked + (r.nc_booked || 0),
      fuBooked: acc.fuBooked + (r.fu_booked || 0),
      noShows: acc.noShows + (r.nc_no_shows || 0) + (r.fu_no_shows || 0),
      liveCalls: acc.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
      offers: acc.offers + (r.offers || 0),
      closes: acc.closes + (r.closes || 0),
      revenue: acc.revenue + parseFloat(r.total_revenue || 0),
      cash: acc.cash + parseFloat(r.total_cash_collected || 0),
    }), { ncBooked: 0, fuBooked: 0, noShows: 0, liveCalls: 0, offers: 0, closes: 0, revenue: 0, cash: 0 })

    const booked = totals.ncBooked + totals.fuBooked
    const b = breakdown[closer.id] || { ncCloses: 0, fuCloses: 0, ncLive: 0 }
    return {
      ...closer,
      ...totals,
      booked,
      showRate: booked ? parseFloat(((totals.liveCalls / booked) * 100).toFixed(1)) : 0,
      // Close rate = new call closes / live new calls (excludes follow-ups from denominator)
      closeRate: b.ncLive > 0 ? parseFloat(((b.ncCloses / b.ncLive) * 100).toFixed(1)) : 0,
      // Net close rate = all closes (new + FU) / live new calls
      netCloseRate: b.ncLive > 0 ? parseFloat((((b.ncCloses + b.fuCloses) / b.ncLive) * 100).toFixed(1)) : 0,
      offerRate: totals.liveCalls ? parseFloat(((totals.offers / totals.liveCalls) * 100).toFixed(1)) : 0,
      cashCollRate: totals.revenue > 0 ? parseFloat(((totals.cash / totals.revenue) * 100).toFixed(1)) : 0,
      reschedules: myReports.reduce((s, r) => s + (r.reschedules || 0), 0),
      rescheduleRate: booked ? parseFloat(((myReports.reduce((s, r) => s + (r.reschedules || 0), 0) / booked) * 100).toFixed(1)) : 0,
    }
  })

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Closer Performance</h1>
        <div className="flex items-center gap-3">
          <Link to="/sales/eod?tab=closer" className="flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-xl bg-opt-yellow text-bg-primary text-xs font-semibold hover:brightness-110 transition-all">
            <Plus size={14} />
            New EOD
          </Link>
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* Company-Level KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 sm:gap-3 mb-6">
        <KPICard label="Booked" value={totalBooked} subtitle={`${companyTotals.ncBooked} NC / ${companyTotals.fuBooked} FU`} />
        <KPICard label="Live Calls" value={companyTotals.liveCalls} subtitle={`${companyTotals.liveNC} NC / ${companyTotals.liveFU} FU`} />
        <KPICard label="No Shows" value={totalNoShows} />
        <KPICard label="Offers" value={companyTotals.offers} />
        <KPICard label="Closes" value={companyTotals.closes} />
        <KPICard label="Revenue" value={`$${companyTotals.revenue.toLocaleString()}`} />
        <KPICard label="Cash Collected" value={`$${companyTotals.cash.toLocaleString()}`} />
        <KPICard label="Avg Deal" value={`$${avgDealSize.toLocaleString()}`} />
      </div>

      {/* Company Conversion Gauges */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2 sm:gap-3 mb-6">
        <Gauge label="Show Rate" value={companyShowRate} target={70} />
        <Gauge label="Resched Rate" value={companyRescheduleRate} target={10} max={100} />
        <Gauge label="Offer Rate" value={companyOfferRate} target={80} />
        <Gauge label="Close Rate" value={companyCloseRate} target={25} />
        <Gauge label="Net Close" value={companyNetCloseRate} target={30} />
        <Gauge label="Offer → Close" value={companyOfferCloseRate} target={30} max={100} />
        <Gauge label="Calls/Close" value={callsPerClose} target={4} max={20} />
        <Gauge label="Cash Collect %" value={cashCollectionRate} target={50} />
      </div>

      {/* Per-Closer Cards */}
      <h2 className="text-sm font-medium text-text-secondary mb-3">Individual Performance</h2>
      {closerStats.length === 0 ? (
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center text-text-400">
          No closers found. Add team members in Supabase.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {closerStats.map(c => (
            <Link
              key={c.id}
              to={`/sales/closers/${c.id}`}
              className="bg-bg-card border border-border-default rounded-2xl p-3 sm:p-6 hover:bg-bg-card-hover transition-all block"
            >
              <div className="flex items-center justify-between mb-3 sm:mb-4">
                <h3 className="text-base sm:text-lg font-bold">{c.name}</h3>
                <div className="flex gap-2 sm:gap-3 text-[10px] sm:text-xs text-text-400">
                  <span>{c.closes} closes</span>
                  <span className="text-success">${c.revenue.toLocaleString()}</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-3 sm:mb-4">
                <Gauge label="Show Rate" value={c.showRate} target={70} />
                <Gauge label="Close Rate" value={c.closeRate} target={25} />
                <Gauge label="Offer Rate" value={c.offerRate} target={80} />
              </div>

              <div className="flex flex-wrap gap-4 text-xs">
                <span className="text-text-400">Booked: <strong className="text-text-primary">{c.booked}</strong></span>
                <span className="text-text-400">Live Calls: <strong className="text-text-primary">{c.liveCalls}</strong></span>
                <span className="text-text-400">Offers: <strong className="text-text-primary">{c.offers}</strong></span>
                <span className="text-text-400">Cash: <strong className="text-opt-yellow">${c.cash.toLocaleString()}</strong></span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Closer Comparison Table */}
      {closerStats.length > 0 && (
        <>
          <h2 className="text-sm font-medium text-text-secondary mb-3">Closer Comparison</h2>
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                    <th className="px-3 py-2 text-left">Closer</th>
                    <th className="px-3 py-2 text-right">Booked</th>
                    <th className="px-3 py-2 text-right">Live Calls</th>
                    <th className="px-3 py-2 text-right">No Shows</th>
                    <th className="px-3 py-2 text-right">Offers</th>
                    <th className="px-3 py-2 text-right">Closes</th>
                    <th className="px-3 py-2 text-right">Show %</th>
                    <th className="px-3 py-2 text-right">Close %</th>
                    <th className="px-3 py-2 text-right">Offer %</th>
                    <th className="px-3 py-2 text-right">Resched</th>
                    <th className="px-3 py-2 text-right">Revenue</th>
                    <th className="px-3 py-2 text-right">Cash</th>
                    <th className="px-3 py-2 text-right">Collect %</th>
                  </tr>
                </thead>
                <tbody>
                  {closerStats.map(c => {
                    const rateColor = (v, good, ok) => v >= good ? 'text-success' : v >= ok ? 'text-opt-yellow' : 'text-danger'
                    return (
                      <tr key={c.id} className="border-b border-border-default/30 hover:bg-bg-card-hover/50">
                        <td className="px-3 py-2 font-medium">
                          <Link to={`/sales/closers/${c.id}`} className="text-opt-yellow hover:underline">{c.name}</Link>
                        </td>
                        <td className="px-3 py-2 text-right text-text-400">{c.booked}</td>
                        <td className="px-3 py-2 text-right text-text-400">{c.liveCalls}</td>
                        <td className="px-3 py-2 text-right text-danger">{c.noShows}</td>
                        <td className="px-3 py-2 text-right text-text-400">{c.offers}</td>
                        <td className="px-3 py-2 text-right font-medium text-text-primary">{c.closes}</td>
                        <td className={`px-3 py-2 text-right font-medium ${rateColor(c.showRate, 70, 50)}`}>{c.showRate}%</td>
                        <td className={`px-3 py-2 text-right font-medium ${rateColor(c.closeRate, 25, 15)}`}>{c.closeRate}%</td>
                        <td className={`px-3 py-2 text-right font-medium ${rateColor(c.offerRate, 80, 60)}`}>{c.offerRate}%</td>
                        <td className="px-3 py-2 text-right text-text-400">{c.reschedules}</td>
                        <td className="px-3 py-2 text-right text-success font-medium">${c.revenue.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-opt-yellow font-medium">${c.cash.toLocaleString()}</td>
                        <td className={`px-3 py-2 text-right font-medium ${c.cashCollRate >= 50 ? 'text-success' : c.cashCollRate >= 30 ? 'text-opt-yellow' : 'text-danger'}`}>{c.cashCollRate}%</td>
                      </tr>
                    )
                  })}
                  <tr className="border-t border-border-default bg-bg-card-hover/30 font-medium">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2 text-right">{totalBooked}</td>
                    <td className="px-3 py-2 text-right">{companyTotals.liveCalls}</td>
                    <td className="px-3 py-2 text-right">{totalNoShows}</td>
                    <td className="px-3 py-2 text-right">{companyTotals.offers}</td>
                    <td className="px-3 py-2 text-right">{companyTotals.closes}</td>
                    <td className="px-3 py-2 text-right">{companyShowRate}%</td>
                    <td className="px-3 py-2 text-right">{companyCloseRate}%</td>
                    <td className="px-3 py-2 text-right">{companyOfferRate}%</td>
                    <td className="px-3 py-2 text-right">{companyTotals.reschedules}</td>
                    <td className="px-3 py-2 text-right text-success">${companyTotals.revenue.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-opt-yellow">${companyTotals.cash.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">{cashCollectionRate}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
