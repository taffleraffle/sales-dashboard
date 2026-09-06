import { Link, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import LeaderTable, { Card, Person } from '../components/house/LeaderTable'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useBenchmarks } from '../hooks/useBenchmarks'
import { useSalesMetrics, rates, EMPTY_TOTALS } from '../hooks/useSalesMetrics'
import { Plus } from 'lucide-react'

/*
  Closers. Every number here comes from useSalesMetrics: company tiles from
  the marketing matview (same as the Marketing page and the Overview), the
  per-closer table from the confirmed call rows grouped by closer. No EOD
  header fields, no separate close-rate method.
*/

const money = (n) => `$${Math.round(n || 0).toLocaleString()}`

export default function CloserOverview() {
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const { members: closers, loading: loadingMembers } = useTeamMembers('closer')
  const { bm } = useBenchmarks()
  const m = useSalesMetrics(range)
  const T = m.totals
  const R = m.r

  if (loadingMembers || m.loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="flex items-center justify-between gap-3 mb-6"><div className="h-8 w-48 tile" /><div className="h-9 w-36 tile" /></div>
        <div className="kpi-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="tile h-24" />)}</div>
        <div className="kpi-grid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="tile h-32" />)}</div>
        <div className="tile h-64" />
      </div>
    )
  }

  const rows = closers.map(c => {
    const t = m.byCloser[c.id] || { ...EMPTY_TOTALS }
    const r = rates(t)
    return { id: c.id, name: c.name, booked: t.qualifiedBookings, live: t.lives, offers: t.offers, closes: t.closes,
      showRate: r.showRate, closeRate: r.closeRate, offerRate: r.offerRate, revenue: r.revenue, cash: r.cash }
  }).sort((a, b) => b.cash - a.cash)

  const toneOf = (v, target, dir = 'above') => {
    if (!Number.isFinite(v) || target == null) return null
    if (dir === 'above') return v >= target ? 'good' : v >= target * 0.8 ? 'warn' : 'bad'
    return v <= target ? 'good' : v <= target * 1.2 ? 'warn' : 'bad'
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Closers</span>
          <h1 className="h2 mt-2">The <em>closer</em> floor.</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/sales/eod/submit?tab=closer" className="editorial-btn-primary"><Plus size={14} /> New EOD</Link>
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      <div>
        {m.error && <div className="callout" style={{ marginBottom: 18 }}><b>Could not load the numbers.</b> {m.error}</div>}

        <div className="kpi-grid mb-6">
          <KPICard label="Booked" value={T.qualifiedBookings} subtitle="qualified calls on the calendar" />
          <KPICard label="Live" value={T.lives} subtitle={`${T.fuLives} follow-up lives separately`} />
          <KPICard label="No shows" value={T.noShows} subtitle={`${T.reschedules} rescheduled · ${T.cancels} cancelled`} />
          <KPICard label="Offers" value={T.offers} />
          <KPICard label="Closes" value={T.closes} subtitle={T.ascensions > 0 ? `${T.ascensions} ascensions separately` : undefined} />
          <KPICard label="Revenue" value={money(R.revenue)} subtitle="trial + ascension" />
          <KPICard label="Cash collected" value={money(R.cash)} subtitle={R.revenue > 0 ? `${R.cashCollectRate}% of revenue` : undefined} />
          <KPICard label="Avg deal" value={R.avgDeal != null ? money(R.avgDeal) : '—'} subtitle="trial revenue per close" />
        </div>

        <div className="kpi-grid mb-6">
          <Gauge label="Show rate" value={R.showRate} target={bm('show_rate_new', 50)} hint="Live new calls over qualified calls booked" />
          <Gauge label="Close rate" value={R.closeRate} target={bm('close_rate', 30)} hint="Closes over live new calls" />
          <Gauge label="Offer rate" value={R.offerRate} target={bm('offer_rate', 80)} />
          <Gauge label="Offer to close" value={R.offerCloseRate} target={30} />
          <Gauge label="Reschedule rate" value={R.rescheduleRate} target={10} max={50} direction="below" />
          <Gauge label="No-show rate" value={R.noShowRate} target={20} max={50} direction="below" />
          <Gauge label="Cash collected" value={R.cashCollectRate} target={50} />
        </div>

        <Card title="Closers" count={rows.length}>
          <LeaderTable
            rows={rows}
            onRowClick={(r) => navigate(`/sales/closers/${r.id}`)}
            empty="No closers found. Add people on the Team page."
            footer={{ name: 'Team', booked: T.qualifiedBookings, live: T.lives, offers: T.offers, closes: T.closes, showRate: R.showRate, closeRate: R.closeRate, offerRate: R.offerRate, revenue: R.revenue, cash: R.cash }}
            columns={[
              { key: 'name', label: 'Closer', render: (r, f) => f ? <span style={{ fontWeight: 700 }}>Team</span> : <Person name={r.name} rank={r._rank} /> },
              { key: 'booked', label: 'Booked', align: 'right' },
              { key: 'live', label: 'Live', align: 'right' },
              { key: 'offers', label: 'Offers', align: 'right' },
              { key: 'closes', label: 'Closes', align: 'right', strong: true },
              { key: 'showRate', label: 'Show', align: 'right', render: r => `${r.showRate}%`, tone: r => toneOf(r.showRate, bm('show_rate_new', 50)) },
              { key: 'closeRate', label: 'Close', align: 'right', render: r => `${r.closeRate}%`, tone: r => toneOf(r.closeRate, bm('close_rate', 30)) },
              { key: 'offerRate', label: 'Offer', align: 'right', render: r => `${r.offerRate}%`, tone: r => toneOf(r.offerRate, bm('offer_rate', 80)) },
              { key: 'revenue', label: 'Revenue', align: 'right', render: r => money(r.revenue) },
              { key: 'cash', label: 'Cash', align: 'right', strong: true, render: r => money(r.cash) },
            ]}
          />
        </Card>
        <p style={{ fontSize: 12.5, color: 'var(--ink-4)', margin: '12px 4px 0' }}>
          Company tiles and the Team row read the marketing view (calendar bookings, confirmed call rows). Per-closer rows are the same call rows grouped by who filed them; a booking with no closer on the appointment is counted against the closer&apos;s own new-call rows instead.
        </p>
      </div>
    </div>
  )
}
