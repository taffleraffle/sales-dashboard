import { useParams } from 'react-router-dom'
import { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import DataTable from '../components/DataTable'
import LeadStatusBadge from '../components/LeadStatusBadge'
import { Loader } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useSetterStats } from '../hooks/useSetterData'

export default function SetterDetail() {
  const { id } = useParams()
  const [range, setRange] = useState(30)
  const [member, setMember] = useState(null)
  const [leads, setLeads] = useState([])
  const stats = useSetterStats(id, range)

  useEffect(() => {
    supabase.from('team_members').select('*').eq('id', id).single()
      .then(({ data }) => setMember(data))
  }, [id])

  useEffect(() => {
    const since = new Date()
    since.setDate(since.getDate() - range)
    supabase
      .from('setter_leads')
      .select('*, closer:team_members!setter_leads_closer_id_fkey(name)')
      .eq('setter_id', id)
      .gte('date_set', since.toISOString().split('T')[0])
      .order('date_set', { ascending: false })
      .then(({ data }) => setLeads((data || []).map(l => ({ ...l, closer_name: l.closer?.name || '—' }))))
  }, [id, range])

  if (!member) {
    return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>
  }

  // Compute show rate from leads
  const resolvedLeads = leads.filter(l => ['showed', 'closed', 'not_closed', 'no_show'].includes(l.status))
  const showedLeads = leads.filter(l => ['showed', 'closed', 'not_closed'].includes(l.status))
  const showRate = resolvedLeads.length ? parseFloat(((showedLeads.length / resolvedLeads.length) * 100).toFixed(1)) : 0
  const revenueAttributed = leads.reduce((sum, l) => sum + parseFloat(l.revenue_attributed || 0), 0)

  const leadColumns = [
    { key: 'lead_name', label: 'Lead' },
    { key: 'closer_name', label: 'Closer' },
    { key: 'date_set', label: 'Date Set' },
    { key: 'appointment_date', label: 'Appt Date' },
    { key: 'status', label: 'Status', render: v => <LeadStatusBadge status={v} /> },
    { key: 'revenue_attributed', label: 'Revenue', align: 'right', render: v => v > 0 ? <span className="text-success">${parseFloat(v).toLocaleString()}</span> : '—' },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">{member.name}</h1>
          <p className="text-sm text-text-400">Setter Performance</p>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* Activity KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <KPICard label="Total Dials" value={stats.outboundCalls.toLocaleString()} />
        <KPICard label="Leads Called" value={stats.totalLeads} />
        <KPICard label="Pickups" value={stats.pickups} subtitle={`${stats.pickupRate}% rate`} />
        <KPICard label="MCs" value={stats.mcs} />
        <KPICard label="Sets" value={stats.sets} />
        <KPICard label="Revenue" value={`$${revenueAttributed.toLocaleString()}`} />
      </div>

      {/* Conversion Gauges */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Gauge label="Leads → Set" value={parseFloat(stats.leadsToSetPct)} target={5} max={50} />
        <Gauge label="MCs → Set" value={parseFloat(stats.mcsToSetPct)} target={40} max={100} />
        <Gauge label="Show Rate" value={showRate} target={70} />
        <Gauge label="Dials/Set" value={parseFloat(stats.dialsPerSet)} target={30} max={100} />
      </div>

      {/* Lead Outcomes Table */}
      <div>
        <h2 className="text-sm font-medium text-text-secondary mb-3">Lead Outcomes ({leads.length})</h2>
        <DataTable columns={leadColumns} data={leads} emptyMessage="No leads attributed yet" />
      </div>
    </div>
  )
}
