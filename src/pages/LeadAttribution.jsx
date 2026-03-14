import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import DataTable from '../components/DataTable'
import { useLeadAttribution } from '../hooks/useLeadAttribution'
import { Loader } from 'lucide-react'

const statusOptions = ['set', 'showed', 'no_show', 'rescheduled', 'cancelled', 'closed', 'not_closed']

export default function LeadAttribution() {
  const [range, setRange] = useState(30)
  const [filter, setFilter] = useState('all')
  const { leads, loading, updateStatus } = useLeadAttribution(range)

  const filtered = filter === 'all' ? leads : leads.filter(l => l.status === filter)

  const showed = leads.filter(l => ['showed', 'closed', 'not_closed'].includes(l.status)).length
  const closed = leads.filter(l => l.status === 'closed').length
  const noShow = leads.filter(l => l.status === 'no_show').length
  const revenue = leads.reduce((sum, l) => sum + parseFloat(l.revenue_attributed || 0), 0)
  const resolved = showed + noShow
  const showRate = resolved ? ((showed / resolved) * 100).toFixed(1) : 0
  const closeRate = showed ? ((closed / showed) * 100).toFixed(1) : 0

  const handleStatusChange = async (leadId, newStatus) => {
    await updateStatus(leadId, newStatus)
  }

  const columns = [
    { key: 'lead_name', label: 'Lead' },
    { key: 'setter_name', label: 'Setter' },
    { key: 'closer_name', label: 'Closer' },
    { key: 'date_set', label: 'Date Set' },
    { key: 'appointment_date', label: 'Appt Date' },
    {
      key: 'status',
      label: 'Status',
      render: (v, row) => (
        <select
          value={v}
          onChange={e => handleStatusChange(row.id, e.target.value)}
          className="bg-bg-primary border border-border-default rounded px-2 py-1 text-xs text-text-primary"
        >
          {statusOptions.map(s => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'revenue_attributed',
      label: 'Revenue',
      align: 'right',
      render: v => v > 0 ? <span className="text-success">${parseFloat(v).toLocaleString()}</span> : '—',
    },
  ]

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Lead Attribution</h1>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <KPICard label="Total Leads" value={leads.length} />
        <KPICard label="Show Rate" value={`${showRate}%`} target={70} direction="above" />
        <KPICard label="Close Rate" value={`${closeRate}%`} target={25} direction="above" />
        <KPICard label="No Shows" value={noShow} />
        <KPICard label="Revenue" value={`$${revenue.toLocaleString()}`} />
      </div>

      <div className="flex gap-1 mb-4 flex-wrap">
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1 rounded text-xs ${filter === 'all' ? 'bg-opt-yellow text-bg-primary' : 'bg-bg-card text-text-secondary border border-border-default'}`}
        >
          All ({leads.length})
        </button>
        {statusOptions.map(s => {
          const count = leads.filter(l => l.status === s).length
          if (!count) return null
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1 rounded text-xs ${filter === s ? 'bg-opt-yellow text-bg-primary' : 'bg-bg-card text-text-secondary border border-border-default'}`}
            >
              {s.replace('_', ' ')} ({count})
            </button>
          )
        })}
      </div>

      <DataTable columns={columns} data={filtered} emptyMessage="No leads yet" />
    </div>
  )
}
