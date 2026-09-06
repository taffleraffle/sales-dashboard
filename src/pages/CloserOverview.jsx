import { Link, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import LeaderTable, { Card, Person } from '../components/house/LeaderTable'
import { useBenchmarks } from '../hooks/useBenchmarks'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCloserEODs, useCloserCallBreakdown } from '../hooks/useCloserData'
import { supabase } from '../lib/supabase'
import { Plus } from 'lucide-react'
import { rangeToDays } from '../lib/dateUtils'

export default function CloserOverview() {
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const { members: closers, loading: loadingMembers } = useTeamMembers('closer')
  const { reports, loading: loadingReports } = useCloserEODs(null, days)
  const { breakdown } = useCloserCallBreakdown(null, days)
  const { bm } = useBenchmarks()

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
          <Link to="/sales/eod/submit?tab=closer" className="editorial-btn-primary">
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
        <Gauge label="Show Rate" value={companyShowRate} target={bm('show_rate_new', 70)} />
        <Gauge label="Resched Rate" value={companyRescheduleRate} target={10} max={100} />
        <Gauge label="Offer Rate" value={companyOfferRate} target={bm('offer_rate', 80)} />
        <Gauge label="Close Rate" value={companyCloseRate} target={bm('close_rate', 25)} />
        <Gauge label="Offer → Close" value={companyOfferCloseRate} target={30} max={100} />
        <Gauge label="Calls per close" value={callsPerClose} target={4} max={20} suffix="" />
        <Gauge label="Cash Collect %" value={cashCollectionRate} target={50} />
      </div>

      {/* One table per closer: replaces the card grid + comparison rows that
          showed the same closerStats twice (DUPLICATE-METRICS doc, item 5). */}
      <Card title="Closers" count={closerStats.length}>
        <LeaderTable
          rows={[...closerStats].sort((a, b) => (b.cash + 0) - (a.cash + 0))}
          onRowClick={(r) => navigate(`/sales/closers/${r.id}`)}
          empty="No closers found. Add people on the Team page."
          footer={{ name: 'Team', booked: totalBooked, liveNC: companyProspects.live, offers: companyTotals.offers, closes: closesDeduped, showRate: companyShowRate, closeRate: companyCloseRate, offerRate: companyOfferRate, revenue: companyTotals.revenue, cash: companyTotals.cash }}
          columns={[
            { key: 'name', label: 'Closer', render: (r, f) => f ? <span style={{ fontWeight: 700 }}>Team</span> : <Person name={r.name} rank={r._rank} sub={r.confN > 0 ? `${r.confShowRate ?? '—'}% confirmed show (${r.confN})` : undefined} /> },
            { key: 'booked', label: 'Booked', align: 'right' },
            { key: 'liveNC', label: 'Net new', align: 'right' },
            { key: 'offers', label: 'Offers', align: 'right' },
            { key: 'closes', label: 'Closes', align: 'right', strong: true },
            { key: 'showRate', label: 'Show', align: 'right', render: r => `${r.showRate}%`, tone: r => toneOf(r.showRate, bm('show_rate_new', 70)) },
            { key: 'closeRate', label: 'Close', align: 'right', render: r => `${r.closeRate}%`, tone: r => toneOf(r.closeRate, bm('close_rate', 25)) },
            { key: 'offerRate', label: 'Offer', align: 'right', render: r => `${r.offerRate}%`, tone: r => toneOf(r.offerRate, bm('offer_rate', 80)) },
            { key: 'revenue', label: 'Revenue', align: 'right', render: r => `$${Math.round(r.revenue).toLocaleString()}` },
            { key: 'cash', label: 'Cash', align: 'right', strong: true, render: r => `$${Math.round(r.cash).toLocaleString()}` },
          ]}
        />
      </Card>

      </div> {/* end max-w-[1600px] mx-auto */}
    </div>
  )
}

function toneOf(value, target) {
  const v = parseFloat(value)
  if (!Number.isFinite(v)) return null
  return v >= target ? 'good' : v >= target * 0.8 ? 'warn' : 'bad'
}
