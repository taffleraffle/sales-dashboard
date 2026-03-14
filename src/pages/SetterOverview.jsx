import { Link } from 'react-router-dom'
import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import DataTable from '../components/DataTable'

export default function SetterOverview() {
  const [range, setRange] = useState(30)

  // Company-level metrics (from GHL pipeline / Wavv tags)
  const companyMetrics = {
    totalDials: 2450,
    totalLeadsCalled: 308,
    meaningfulConvos: 89,
    sets: 70,
    autoBookings: 30,
    manualSets: 40,
    conversionRate: 22.7,
    dialsPerSet: 35,
  }

  // Per-setter breakdown
  const setters = [
    { id: '1', name: 'Leandre', dials: 1200, leadsCalled: 155, mcs: 48, sets: 38, showRate: 71, autoBookings: 15, manualSets: 23, convRate: 24.5 },
    { id: '2', name: 'Austin', dials: 850, leadsCalled: 102, mcs: 29, sets: 22, showRate: 63, autoBookings: 10, manualSets: 12, convRate: 21.6 },
    { id: '3', name: 'Valeria', dials: 400, leadsCalled: 51, mcs: 12, sets: 10, showRate: 70, autoBookings: 5, manualSets: 5, convRate: 19.6 },
  ]

  const columns = [
    { key: 'name', label: 'Setter', render: (v, row) => <Link to={`/sales/setters/${row.id}`} className="text-opt-yellow hover:underline">{v}</Link> },
    { key: 'dials', label: 'Dials', align: 'right' },
    { key: 'leadsCalled', label: 'Leads', align: 'right' },
    { key: 'mcs', label: 'MCs', align: 'right' },
    { key: 'sets', label: 'Sets', align: 'right' },
    { key: 'convRate', label: 'Conv %', align: 'right', render: v => `${v}%` },
    { key: 'showRate', label: 'Show Rate', align: 'right', render: v => <span className={v >= 70 ? 'text-success' : v >= 56 ? 'text-warning' : 'text-danger'}>{v}%</span> },
    { key: 'autoBookings', label: 'Auto', align: 'right' },
    { key: 'manualSets', label: 'Manual', align: 'right' },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Setter Performance</h1>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* Company-Level KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
        <KPICard label="Total Dials" value={companyMetrics.totalDials.toLocaleString()} />
        <KPICard label="Leads Called" value={companyMetrics.totalLeadsCalled} />
        <KPICard label="MCs" value={companyMetrics.meaningfulConvos} />
        <KPICard label="Sets" value={companyMetrics.sets} />
        <KPICard label="Conv Rate" value={`${companyMetrics.conversionRate}%`} target={40} direction="above" subtitle="Leads → Set" />
        <KPICard label="Dials/Set" value={companyMetrics.dialsPerSet} target={30} direction="below" />
        <KPICard label="Auto-Booked" value={companyMetrics.autoBookings} />
        <KPICard label="Manual Sets" value={companyMetrics.manualSets} />
      </div>

      {/* Per-Setter Table */}
      <div className="mb-6">
        <h2 className="text-sm font-medium text-text-secondary mb-3">Individual Performance</h2>
        <DataTable columns={columns} data={setters} />
      </div>
    </div>
  )
}
