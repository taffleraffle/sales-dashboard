import { Link, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCloserEODs, useCloserCallBreakdown } from '../hooks/useCloserData'
import { Loader, Plus } from 'lucide-react'
import { rangeToDays } from '../lib/dateUtils'

export default function CloserOverview() {
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const { members: closers, loading: loadingMembers } = useTeamMembers('closer')
  const { reports, loading: loadingReports } = useCloserEODs(null, days)
  const { breakdown } = useCloserCallBreakdown(null, days)

  // Wait for BOTH members and reports before rendering so KPI cards don't flash
  // empty values (0s) while reports are still loading in the background.
  if (loadingMembers || loadingReports) {
    return (
      <div className="max-w-[1600px] mx-auto space-y-4 animate-pulse">
        <div className="flex items-center justify-between gap-3 mb-6">
          <div className="h-8 w-48 tile" />
          <div className="h-9 w-36 tile" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 sm:gap-3">
          {Array.from({ length: 8 }, (_, i) => <div key={i} className="tile h-24" />)}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2 sm:gap-3">
          {Array.from({ length: 8 }, (_, i) => <div key={i} className="tile h-20" />)}
        </div>
        <div className="tile h-64" />
      </div>
    )
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
  // Show rate: new-call only. Follow-ups aren't qualified bookings and shouldn't
  // affect the headline show rate. Denominator is nc_booked; numerator is
  // live_nc_calls. Live calls / total booked as before would skew on teams
  // that run heavy follow-up schedules.
  const companyShowRate = companyTotals.ncBooked > 0 ? parseFloat(((companyTotals.liveNC / companyTotals.ncBooked) * 100).toFixed(1)) : 0

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
      liveNC: acc.liveNC + (r.live_nc_calls || 0),
      offers: acc.offers + (r.offers || 0),
      closes: acc.closes + (r.closes || 0),
      revenue: acc.revenue + parseFloat(r.total_revenue || 0),
      cash: acc.cash + parseFloat(r.total_cash_collected || 0),
    }), { ncBooked: 0, fuBooked: 0, noShows: 0, liveCalls: 0, liveNC: 0, offers: 0, closes: 0, revenue: 0, cash: 0 })

    const booked = totals.ncBooked + totals.fuBooked
    const b = breakdown[closer.id] || { ncCloses: 0, fuCloses: 0, ncLive: 0 }
    return {
      ...closer,
      ...totals,
      booked,
      // Show rate: new-call only (see companyShowRate note).
      showRate: totals.ncBooked ? parseFloat(((totals.liveNC / totals.ncBooked) * 100).toFixed(1)) : 0,
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
          <Link to="/sales/eod/submit?tab=closer" className="flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-xl bg-opt-yellow text-bg-primary text-xs font-semibold hover:brightness-110 transition-all">
            <Plus size={14} />
            New EOD
          </Link>
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto">

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

      {/* Company Conversion Gauges — 8 items in cleanly-divisible breakpoints */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4 gap-2 sm:gap-3 mb-6">
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
        <div className="tile tile-feedback p-8 text-center text-text-400">
          No closers found. Add team members in Supabase.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {closerStats.map(c => (
            <Link
              key={c.id}
              to={`/sales/closers/${c.id}`}
              className="tile tile-feedback p-3 sm:p-6 hover:bg-bg-card-hover transition-all block"
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

      {/* Closer Comparison — leaderboard cards (replaces blocky 13-col table) */}
      {closerStats.length > 0 && (
        <>
          <h2 className="text-sm font-medium text-text-secondary mb-4">Closer Comparison</h2>
          <div className="space-y-2 mb-6">
            {closerStats.map(c => (
              <CloserLeaderboardRow
                key={c.id}
                closer={c}
                onClick={() => navigate(`/sales/closers/${c.id}`)}
              />
            ))}
            {/* Team total — summary row styled as a yellow-tinted card so it
                reads as an aggregate, not a clickable team-member row. */}
            <div className="bg-opt-yellow/[0.06] border border-opt-yellow/30 rounded-2xl px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
              <div className="flex items-center gap-3 min-w-0 sm:min-w-[180px]">
                <div className="w-9 h-9 rounded-full bg-opt-yellow/25 border border-opt-yellow/50 flex items-center justify-center">
                  <span className="text-[11px] font-bold text-opt-yellow">∑</span>
                </div>
                <span className="text-sm font-semibold text-opt-yellow">Team Total</span>
              </div>
              <div className="flex items-baseline gap-4 sm:gap-6">
                <StatBlock label="Closes" value={companyTotals.closes} />
                <StatBlock label="Revenue" value={`$${companyTotals.revenue.toLocaleString()}`} accent="success" />
                <StatBlock label="Cash" value={`$${companyTotals.cash.toLocaleString()}`} accent="opt-yellow" />
              </div>
              <div className="flex flex-wrap gap-2 sm:ml-auto">
                <Pill label="Show" value={`${companyShowRate}%`} good={parseFloat(companyShowRate) >= 70} ok={parseFloat(companyShowRate) >= 50} />
                <Pill label="Close" value={`${companyCloseRate}%`} good={parseFloat(companyCloseRate) >= 25} ok={parseFloat(companyCloseRate) >= 15} />
                <Pill label="Offer" value={`${companyOfferRate}%`} good={parseFloat(companyOfferRate) >= 80} ok={parseFloat(companyOfferRate) >= 60} />
              </div>
            </div>
          </div>
        </>
      )}

      </div> {/* end max-w-[1600px] mx-auto */}
    </div>
  )
}

function initialsOf(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function Pill({ label, value, good, ok }) {
  const color = good ? 'bg-success/15 text-success border-success/30'
    : ok ? 'bg-opt-yellow/15 text-opt-yellow border-opt-yellow/30'
    : 'bg-danger/15 text-danger border-danger/30'
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium ${color}`}>
      <span className="text-text-400 font-normal">{label}</span>
      <span>{value}</span>
    </span>
  )
}

function StatBlock({ label, value, accent }) {
  const color = accent === 'success' ? 'text-success' : accent === 'opt-yellow' ? 'text-opt-yellow' : 'text-text-primary'
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-text-400">{label}</span>
      <span className={`text-base sm:text-lg font-bold leading-tight ${color} tabular-nums`}>{value}</span>
    </div>
  )
}

function CloserLeaderboardRow({ closer, onClick }) {
  const c = closer
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className="tile tile-hover px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5"
    >
      {/* Name block */}
      <div className="flex items-center gap-3 min-w-0 sm:min-w-[180px]">
        <div className="w-9 h-9 rounded-full bg-opt-yellow/15 border border-opt-yellow/30 flex items-center justify-center shrink-0 text-[11px] font-bold text-opt-yellow">
          {initialsOf(c.name)}
        </div>
        <span className="text-sm font-semibold text-text-primary truncate">{c.name}</span>
      </div>

      {/* Primary stats */}
      <div className="flex items-baseline gap-4 sm:gap-6">
        <StatBlock label="Closes" value={c.closes} />
        <StatBlock label="Revenue" value={`$${c.revenue.toLocaleString()}`} accent="success" />
        <StatBlock label="Cash" value={`$${c.cash.toLocaleString()}`} accent="opt-yellow" />
      </div>

      {/* Rate pills */}
      <div className="flex flex-wrap gap-2 sm:ml-auto">
        <Pill label="Show" value={`${c.showRate}%`} good={c.showRate >= 70} ok={c.showRate >= 50} />
        <Pill label="Close" value={`${c.closeRate}%`} good={c.closeRate >= 25} ok={c.closeRate >= 15} />
        <Pill label="Offer" value={`${c.offerRate}%`} good={c.offerRate >= 80} ok={c.offerRate >= 60} />
      </div>
    </div>
  )
}
