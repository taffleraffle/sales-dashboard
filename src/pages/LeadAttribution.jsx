import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import DataTable from '../components/DataTable'
import LeadStatusBadge from '../components/LeadStatusBadge'
import { supabase } from '../lib/supabase'

const statusOptions = ['set', 'showed', 'no_show', 'rescheduled', 'cancelled', 'closed', 'not_closed']

export default function LeadAttribution() {
  const [range, setRange] = useState(30)
  const [filter, setFilter] = useState('all')

  // Placeholder data — will come from Supabase setter_leads table
  const leads = [
    { id: '1', lead_name: 'Mike Johnson', setter: 'Leandre', closer: 'Daniel', date_set: '2026-03-10', appointment_date: '2026-03-12', status: 'closed', revenue: 997 },
    { id: '2', lead_name: 'Sarah Williams', setter: 'Leandre', closer: 'Daniel', date_set: '2026-03-09', appointment_date: '2026-03-11', status: 'showed', revenue: 0 },
    { id: '3', lead_name: 'Tom Davis', setter: 'Leandre', closer: 'Josh', date_set: '2026-03-08', appointment_date: '2026-03-10', status: 'closed', revenue: 8000 },
    { id: '4', lead_name: 'Lisa Chen', setter: 'Austin', closer: 'Daniel', date_set: '2026-03-07', appointment_date: '2026-03-09', status: 'no_show', revenue: 0 },
    { id: '5', lead_name: 'James Brown', setter: 'Austin', closer: 'Josh', date_set: '2026-03-13', appointment_date: '2026-03-15', status: 'set', revenue: 0 },
    { id: '6', lead_name: 'Anna Smith', setter: 'Valeria', closer: 'Daniel', date_set: '2026-03-06', appointment_date: '2026-03-08', status: 'not_closed', revenue: 0 },
  ]

  const filtered = filter === 'all' ? leads : leads.filter(l => l.status === filter)

  const stats = {
    total: leads.length,
    showed: leads.filter(l => ['showed', 'closed', 'not_closed'].includes(l.status)).length,
    closed: leads.filter(l => l.status === 'closed').length,
    noShow: leads.filter(l => l.status === 'no_show').length,
    revenue: leads.reduce((sum, l) => sum + (l.revenue || 0), 0),
  }

  const showRate = stats.total ? ((stats.showed / stats.total) * 100).toFixed(1) : 0
  const closeRate = stats.showed ? ((stats.closed / stats.showed) * 100).toFixed(1) : 0

  const handleStatusChange = async (leadId, newStatus) => {
    // TODO: Update in Supabase
    console.log('Update lead', leadId, 'to', newStatus)
  }

  const columns = [
    { key: 'lead_name', label: 'Lead' },
    { key: 'setter', label: 'Setter' },
    { key: 'closer', label: 'Closer' },
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
      key: 'revenue',
      label: 'Revenue',
      align: 'right',
      render: v => v > 0 ? <span className="text-success">${v.toLocaleString()}</span> : '—',
    },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Lead Attribution</h1>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <KPICard label="Total Leads" value={stats.total} />
        <KPICard label="Show Rate" value={`${showRate}%`} target={70} direction="above" />
        <KPICard label="Close Rate" value={`${closeRate}%`} target={25} direction="above" />
        <KPICard label="No Shows" value={stats.noShow} />
        <KPICard label="Revenue" value={`$${stats.revenue.toLocaleString()}`} />
      </div>

      {/* Filter */}
      <div className="flex gap-1 mb-4">
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

      <DataTable columns={columns} data={filtered} />
    </div>
  )
}
