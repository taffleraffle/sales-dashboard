import { Link, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCloserEODs, useCloserCallBreakdown } from '../hooks/useCloserData'
import { supabase } from '../lib/supabase'
import { Loader, Plus } from 'lucide-react'
import { rangeToDays } from '../lib/dateUtils'

export default function CloserOverview() {
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const { members: closers, loading: loadingMembers } = useTeamMembers('closer')
  const { reports, loading: loadingReports } = useCloserEODs(null, days)
  const { breakdown } = useCloserCallBreakdown(null, days)

  // Per-closer confirmed-vs-unconfirmed show rate (migration 161). Confirmation
  // is the manual mark (booking_call_status); attendance is the call outcome.
  const [confByCloser, setConfByCloser] = useState({})
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const since = new Date(); since.setDate(since.getDate() - (typeof days === 'number' ? days : 31))
      const from = since.toISOString().slice(0, 10)
      const { data, error } = await supabase
        .from('lib_call_confirmation_by_closer')
        .select('closer_id, confirmed_calls, confirmed_showed, confirmed_noshow, unconfirmed_calls, unconfirmed_showed, unconfirmed_noshow')
        .gte('report_date', from)
      if (cancelled) return
      if (error) { console.warn('closer confirmation load failed:', error.message); return }
      const by = {}
      for (const r of (data || [])) {
        const b = by[r.closer_id] || (by[r.closer_id] = { cShow: 0, cNo: 0, cCalls: 0, uShow: 0, uNo: 0, uCalls: 0 })
        b.cShow += +r.confirmed_showed || 0; b.cNo += +r.confirmed_noshow || 0; b.cCalls += +r.confirmed_calls || 0
        b.uShow += +r.unconfirmed_showed || 0; b.uNo += +r.unconfirmed_noshow || 0; b.uCalls += +r.unconfirmed_calls || 0
      }
      setConfByCloser(by)
    })()
    return () => { cancelled = true }
  }, [days])

  // Wait for BOTH members and reports before rendering so KPI cards don't flash
  // empty values (0s) while reports are still loading in the background.
  if (loadingMembers || loadingReports) {
    return (
      <div className="max-w-[1600px] mx-auto space-y-4 animate-pulse">
        <div className="flex items-center justify-between gap-3 mb-6">
          <div className="h-8 w-48 tile" />
          <div className="h-9 w-36 tile" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 sm:gap-3">
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

  // Company close rate — prospect-level. Sums unique-prospect counts
  // across closers. See useCloserCallBreakdown for the rationale and
  // scripts/close-rate-audit.mjs for the audit.
  const companyProspects = Object.values(breakdown).reduce((a, b) => ({
    live:   a.live   + (b.liveProspects   || 0),
    closed: a.closed + (b.closedProspects || 0),
  }), { live: 0, closed: 0 })
  const companyCloseRate = companyProspects.live > 0
    ? parseFloat(((companyProspects.closed / companyProspects.live) * 100).toFixed(1))
    : 0
  const companyOfferRate = companyTotals.liveCalls > 0 ? parseFloat(((companyTotals.offers / companyTotals.liveCalls) * 100).toFixed(1)) : 0
  // Offer-close, avg-deal, calls-per-close use the prospect-deduped close
  // count so the rate denominator agrees with the Closes tile shown above
  // (the Close Rate gauge has always used prospect-level — now everything
  // downstream uses it too).
  const closesDeduped = companyProspects.closed || 0
  const companyOfferCloseRate = companyTotals.offers > 0 ? parseFloat(((closesDeduped / companyTotals.offers) * 100).toFixed(1)) : 0
  const companyRescheduleRate = totalBooked > 0 ? parseFloat(((companyTotals.reschedules / totalBooked) * 100).toFixed(1)) : 0
  const avgDealSize = closesDeduped > 0 ? parseFloat((companyTotals.revenue / closesDeduped).toFixed(0)) : 0
  const callsPerClose = closesDeduped > 0 ? parseFloat((companyTotals.liveCalls / closesDeduped).toFixed(1)) : 0
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
    const b = breakdown[closer.id] || { liveProspects: 0, closedProspects: 0 }
    const cf = confByCloser[closer.id] || { cShow: 0, cNo: 0, cCalls: 0, uShow: 0, uNo: 0, uCalls: 0 }
    const showPct = (s, n) => (s + n) > 0 ? parseFloat(((s / (s + n)) * 100).toFixed(0)) : null
    return {
      ...closer,
      ...totals,
      booked,
      // Confirmed vs unconfirmed show rate (migration 161).
      confShowRate: showPct(cf.cShow, cf.cNo), confN: cf.cCalls,
      unconfShowRate: showPct(cf.uShow, cf.uNo), unconfN: cf.uCalls,
      // Override the EOD-typed totals.closes and totals.liveNC with the
      // prospect-deduped counts so the per-closer card's headline figures
      // and its Close Rate gauge come from the same source (per-call truth).
      // Keep the EOD aggregate accessible under *_eod for any caller that
      // still wants the self-report number.
      closes: b.closedProspects || 0,
      closes_eod: totals.closes,
      liveNC: b.liveProspects || 0,
      liveNC_eod: totals.liveNC,
      // Show rate: new-call only (see companyShowRate note).
      showRate: totals.ncBooked ? parseFloat(((totals.liveNC / totals.ncBooked) * 100).toFixed(1)) : 0,
      // Close rate = unique closed prospects / unique live prospects.
      closeRate: b.liveProspects > 0 ? parseFloat(((b.closedProspects / b.liveProspects) * 100).toFixed(1)) : 0,
      offerRate: totals.liveCalls ? parseFloat(((totals.offers / totals.liveCalls) * 100).toFixed(1)) : 0,
      cashCollRate: totals.revenue > 0 ? parseFloat(((totals.cash / totals.revenue) * 100).toFixed(1)) : 0,
      reschedules: myReports.reduce((s, r) => s + (r.reschedules || 0), 0),
      rescheduleRate: booked ? parseFloat(((myReports.reduce((s, r) => s + (r.reschedules || 0), 0) / booked) * 100).toFixed(1)) : 0,
    }
  })

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Closers</span>
          <h1 className="h2 mt-2">The <em>closer</em> floor.</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/sales/eod/submit?tab=closer" className="flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-sm bg-opt-yellow text-text-primary text-xs font-semibold hover:brightness-110 transition-all">
            <Plus size={14} />
            New EOD
          </Link>
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto">

      {/* Company-Level KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 sm:gap-3 mb-6">
        <KPICard label="Booked" value={totalBooked} subtitle={`${companyTotals.ncBooked} NC / ${companyTotals.fuBooked} FU`} />
        {/* Net New + Closes use the prospect-deduped per-call truth (same
            source as the Close Rate gauge below), with the EOD self-report
            in the subtitle for reconciliation. Without this, the Closes
            tile and the Close Rate gauge silently disagreed on the
            numerator/denominator. */}
        <KPICard label="Net New" value={companyProspects.live} subtitle={`${companyTotals.liveNC} EOD-reported · ${companyTotals.liveFU} FU separately`} />
        <KPICard label="No Shows" value={totalNoShows} />
        <KPICard label="Offers" value={companyTotals.offers} />
        <KPICard label="Closes" value={closesDeduped} subtitle={closesDeduped !== companyTotals.closes ? `${companyTotals.closes} EOD-reported` : null} />
        <KPICard label="Revenue" value={`$${companyTotals.revenue.toLocaleString()}`} />
        <KPICard label="Cash Collected" value={`$${companyTotals.cash.toLocaleString()}`} />
        <KPICard label="Avg Deal" value={`$${avgDealSize.toLocaleString()}`} />
      </div>

      {/* Company Conversion Gauges — 7 items (Net Close removed; close rate
          is now prospect-level, so a separate "net" version is meaningless) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4 gap-2 sm:gap-3 mb-6">
        <Gauge label="Show Rate" value={companyShowRate} target={70} />
        <Gauge label="Resched Rate" value={companyRescheduleRate} target={10} max={100} />
        <Gauge label="Offer Rate" value={companyOfferRate} target={80} />
        <Gauge label="Close Rate" value={companyCloseRate} target={25} />
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
                <span className="text-text-400">Net New: <strong className="text-text-primary">{c.liveNC}</strong></span>
                <span className="text-text-400">Offers: <strong className="text-text-primary">{c.offers}</strong></span>
                <span className="text-text-400">Cash: <strong className="text-text-primary">${c.cash.toLocaleString()}</strong></span>
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
            <div className="bg-opt-yellow/[0.06] border border-opt-yellow/30 rounded-sm px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
              <div className="flex items-center gap-3 min-w-0 sm:min-w-[180px]">
                <div className="w-9 h-9 rounded-full bg-opt-yellow/25 border border-opt-yellow/50 flex items-center justify-center">
                  <span className="text-[11px] font-bold text-text-primary">∑</span>
                </div>
                <span className="text-sm font-semibold text-text-primary">Team Total</span>
              </div>
              <div className="flex items-baseline gap-4 sm:gap-6">
                <StatBlock label="Closes" value={closesDeduped} />
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
    : ok ? 'bg-opt-yellow/15 text-text-primary border-opt-yellow/30'
    : 'bg-danger/15 text-danger border-danger/30'
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium ${color}`}>
      <span className="text-text-400 font-normal">{label}</span>
      <span>{value}</span>
    </span>
  )
}

function StatBlock({ label, value, accent }) {
  const color = accent === 'success' ? 'text-success' : accent === 'opt-yellow' ? 'text-text-primary' : 'text-text-primary'
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
        <div className="w-9 h-9 rounded-full bg-opt-yellow/15 border border-opt-yellow/30 flex items-center justify-center shrink-0 text-[11px] font-bold text-text-primary">
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
        {/* Confirmed vs unconfirmed show rate — only when the closer has marked
            calls in the window (migration 161). */}
        {c.confN > 0 && (
          <Pill label={`Conf Show (${c.confN})`} value={c.confShowRate == null ? '—' : `${c.confShowRate}%`} good={c.confShowRate >= 70} ok={c.confShowRate >= 50} />
        )}
        {c.unconfN > 0 && (
          <Pill label={`Unconf Show (${c.unconfN})`} value={c.unconfShowRate == null ? '—' : `${c.unconfShowRate}%`} good={c.unconfShowRate >= 70} ok={c.unconfShowRate >= 50} />
        )}
      </div>
    </div>
  )
}
