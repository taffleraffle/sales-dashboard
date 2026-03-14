import { useParams } from 'react-router-dom'
import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import DataTable from '../components/DataTable'
import LeadStatusBadge from '../components/LeadStatusBadge'

export default function SetterDetail() {
  const { id } = useParams()
  const [range, setRange] = useState(30)

  // Placeholder — will come from GHL/Wavv + Supabase
  const setter = {
    name: 'Leandre',
    dials: 1200,
    leadsCalled: 155,
    mcs: 48,
    sets: 38,
    pickups: 82,
    autoBookings: 15,
    manualSets: 23,
    showRate: 71,
    closeRateOnSets: 31.6,
    revenueAttributed: 11964,
  }

  const leads = [
    { id: '1', name: 'Mike Johnson', status: 'closed', closer: 'Daniel', dateSet: '2026-03-10', appointmentDate: '2026-03-12', revenue: 997 },
    { id: '2', name: 'Sarah Williams', status: 'showed', closer: 'Daniel', dateSet: '2026-03-09', appointmentDate: '2026-03-11', revenue: 0 },
    { id: '3', name: 'Tom Davis', status: 'closed', closer: 'Josh', dateSet: '2026-03-08', appointmentDate: '2026-03-10', revenue: 8000 },
    { id: '4', name: 'Lisa Chen', status: 'no_show', closer: 'Daniel', dateSet: '2026-03-07', appointmentDate: '2026-03-09', revenue: 0 },
    { id: '5', name: 'James Brown', status: 'set', closer: 'Josh', dateSet: '2026-03-13', appointmentDate: '2026-03-15', revenue: 0 },
  ]

  const leadColumns = [
    { key: 'name', label: 'Lead' },
    { key: 'closer', label: 'Closer' },
    { key: 'dateSet', label: 'Date Set' },
    { key: 'appointmentDate', label: 'Appt Date' },
    { key: 'status', label: 'Status', render: v => <LeadStatusBadge status={v} /> },
    { key: 'revenue', label: 'Revenue', align: 'right', render: v => v > 0 ? <span className="text-success">${v.toLocaleString()}</span> : '—' },
  ]

  const dialsToSet = setter.dials / setter.sets
  const pickupRate = ((setter.pickups / setter.dials) * 100).toFixed(1)
  const mcsToSet = ((setter.sets / setter.mcs) * 100).toFixed(1)
  const leadsToSet = ((setter.sets / setter.leadsCalled) * 100).toFixed(1)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">{setter.name}</h1>
          <p className="text-sm text-text-400">Setter Performance</p>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* Activity KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
        <KPICard label="Total Dials" value={setter.dials.toLocaleString()} />
        <KPICard label="Leads Called" value={setter.leadsCalled} />
        <KPICard label="Pickups" value={setter.pickups} subtitle={`${pickupRate}% rate`} />
        <KPICard label="MCs" value={setter.mcs} />
        <KPICard label="Sets" value={setter.sets} />
        <KPICard label="Revenue Attributed" value={`$${setter.revenueAttributed.toLocaleString()}`} />
      </div>

      {/* Conversion Gauges */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Gauge label="Leads → Set" value={parseFloat(leadsToSet)} target={5} max={50} />
        <Gauge label="MCs → Set" value={parseFloat(mcsToSet)} target={40} max={100} />
        <Gauge label="Show Rate" value={setter.showRate} target={70} />
        <Gauge label="Close Rate (on sets)" value={setter.closeRateOnSets} target={25} />
      </div>

      {/* Auto vs Manual */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-bg-card border border-border-default rounded-lg p-4">
          <p className="text-[11px] uppercase text-text-400 mb-1">Auto-Bookings</p>
          <p className="text-2xl font-bold text-opt-yellow">{setter.autoBookings}</p>
          <p className="text-xs text-text-400">{((setter.autoBookings / setter.sets) * 100).toFixed(0)}% of sets</p>
        </div>
        <div className="bg-bg-card border border-border-default rounded-lg p-4">
          <p className="text-[11px] uppercase text-text-400 mb-1">Manual Sets</p>
          <p className="text-2xl font-bold">{setter.manualSets}</p>
          <p className="text-xs text-text-400">{((setter.manualSets / setter.sets) * 100).toFixed(0)}% of sets</p>
        </div>
      </div>

      {/* Dials/Set metric */}
      <div className="bg-bg-card border border-border-default rounded-lg p-4 mb-6">
        <p className="text-[11px] uppercase text-text-400 mb-1">Dials per Set</p>
        <p className="text-2xl font-bold">{dialsToSet.toFixed(1)}</p>
        <p className="text-xs text-text-400">Target: &lt; 30</p>
      </div>

      {/* Lead Outcomes Table */}
      <div>
        <h2 className="text-sm font-medium text-text-secondary mb-3">Lead Outcomes</h2>
        <DataTable columns={leadColumns} data={leads} />
      </div>
    </div>
  )
}
