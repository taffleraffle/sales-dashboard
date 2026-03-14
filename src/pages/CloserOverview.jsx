import { Link } from 'react-router-dom'
import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import Gauge from '../components/Gauge'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCloserEODs } from '../hooks/useCloserData'
import { Loader } from 'lucide-react'

export default function CloserOverview() {
  const [range, setRange] = useState(30)
  const { members: closers, loading: loadingMembers } = useTeamMembers('closer')
  const { reports, loading: loadingReports } = useCloserEODs(null, range)

  if (loadingMembers) {
    return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>
  }

  // Aggregate stats per closer
  const closerStats = closers.map(closer => {
    const myReports = reports.filter(r => r.closer_id === closer.id)
    const totals = myReports.reduce((acc, r) => ({
      booked: acc.booked + (r.nc_booked || 0) + (r.fu_booked || 0),
      liveCalls: acc.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
      offers: acc.offers + (r.offers || 0),
      closes: acc.closes + (r.closes || 0),
      revenue: acc.revenue + parseFloat(r.total_revenue || 0),
      cash: acc.cash + parseFloat(r.total_cash_collected || 0),
    }), { booked: 0, liveCalls: 0, offers: 0, closes: 0, revenue: 0, cash: 0 })

    return {
      ...closer,
      ...totals,
      showRate: totals.booked ? parseFloat(((totals.liveCalls / totals.booked) * 100).toFixed(1)) : 0,
      closeRate: totals.liveCalls ? parseFloat(((totals.closes / totals.liveCalls) * 100).toFixed(1)) : 0,
      offerRate: totals.liveCalls ? parseFloat(((totals.offers / totals.liveCalls) * 100).toFixed(1)) : 0,
    }
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Closer Performance</h1>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {closerStats.length === 0 ? (
        <div className="bg-bg-card border border-border-default rounded-lg p-8 text-center text-text-400">
          No closers found. Add team members in Supabase.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {closerStats.map(c => (
            <Link
              key={c.id}
              to={`/sales/closers/${c.id}`}
              className="bg-bg-card border border-border-default rounded-lg p-5 hover:bg-bg-card-hover transition-colors block"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold">{c.name}</h3>
                <span className="text-sm text-text-400">{c.closes} closes</span>
              </div>

              <div className="grid grid-cols-3 gap-3 mb-4">
                <Gauge label="Show Rate" value={c.showRate} target={70} />
                <Gauge label="Close Rate" value={c.closeRate} target={25} />
                <Gauge label="Offer Rate" value={c.offerRate} target={80} />
              </div>

              <div className="flex gap-6 text-xs">
                <span className="text-text-400">Revenue: <strong className="text-success">${c.revenue.toLocaleString()}</strong></span>
                <span className="text-text-400">Cash: <strong className="text-opt-yellow">${c.cash.toLocaleString()}</strong></span>
                <span className="text-text-400">Live Calls: <strong className="text-text-primary">{c.liveCalls}</strong></span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
