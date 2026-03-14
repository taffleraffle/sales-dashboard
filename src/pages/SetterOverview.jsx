import { Link } from 'react-router-dom'
import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import DataTable from '../components/DataTable'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useSetterEODs } from '../hooks/useSetterData'
import { usePipelineAnalytics } from '../hooks/usePipelineAnalytics'
import { Loader } from 'lucide-react'

export default function SetterOverview() {
  const [range, setRange] = useState(30)
  const { members: setters, loading: loadingMembers } = useTeamMembers('setter')
  const { reports, loading: loadingReports } = useSetterEODs(null, range)
  const { data: pipeline, loading: loadingPipeline } = usePipelineAnalytics(range)

  if (loadingMembers) {
    return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>
  }

  // Company-level from pipeline analytics (if available) or EOD aggregation
  const dialer = pipeline?.dialer || {}
  const companyFromEOD = reports.reduce((acc, r) => ({
    totalLeads: acc.totalLeads + (r.total_leads || 0),
    outboundCalls: acc.outboundCalls + (r.outbound_calls || 0),
    pickups: acc.pickups + (r.pickups || 0),
    mcs: acc.mcs + (r.meaningful_conversations || 0),
    sets: acc.sets + (r.sets || 0),
  }), { totalLeads: 0, outboundCalls: 0, pickups: 0, mcs: 0, sets: 0 })

  // Use pipeline data if available, EOD as fallback
  const company = {
    totalDials: dialer.totalDials || companyFromEOD.outboundCalls,
    totalLeadsCalled: dialer.totalLeadsDialed || companyFromEOD.totalLeads,
    mcs: dialer.totalMCs || companyFromEOD.mcs,
    sets: companyFromEOD.sets || dialer.totalSets || 0,
    pickupRate: dialer.pickupRate || (companyFromEOD.outboundCalls ? ((companyFromEOD.pickups / companyFromEOD.outboundCalls) * 100).toFixed(1) : 0),
    dialsPerSet: dialer.callToSet || (companyFromEOD.sets ? (companyFromEOD.outboundCalls / companyFromEOD.sets).toFixed(1) : 0),
  }
  company.convRate = company.totalLeadsCalled ? ((company.sets / company.totalLeadsCalled) * 100).toFixed(1) : 0

  // Per-setter breakdown from EODs
  const setterRows = setters.map(setter => {
    const myReports = reports.filter(r => r.setter_id === setter.id)
    const t = myReports.reduce((acc, r) => ({
      dials: acc.dials + (r.outbound_calls || 0),
      leads: acc.leads + (r.total_leads || 0),
      mcs: acc.mcs + (r.meaningful_conversations || 0),
      sets: acc.sets + (r.sets || 0),
      pickups: acc.pickups + (r.pickups || 0),
    }), { dials: 0, leads: 0, mcs: 0, sets: 0, pickups: 0 })

    return {
      id: setter.id,
      name: setter.name,
      dials: t.dials,
      leadsCalled: t.leads,
      mcs: t.mcs,
      sets: t.sets,
      convRate: t.leads ? parseFloat(((t.sets / t.leads) * 100).toFixed(1)) : 0,
      pickupRate: t.dials ? parseFloat(((t.pickups / t.dials) * 100).toFixed(1)) : 0,
    }
  })

  const columns = [
    { key: 'name', label: 'Setter', render: (v, row) => <Link to={`/sales/setters/${row.id}`} className="text-opt-yellow hover:underline">{v}</Link> },
    { key: 'dials', label: 'Dials', align: 'right' },
    { key: 'leadsCalled', label: 'Leads', align: 'right' },
    { key: 'mcs', label: 'MCs', align: 'right' },
    { key: 'sets', label: 'Sets', align: 'right' },
    { key: 'convRate', label: 'Conv %', align: 'right', render: v => `${v}%` },
    { key: 'pickupRate', label: 'Pickup %', align: 'right', render: v => `${v}%` },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Setter Performance</h1>
        <div className="flex items-center gap-3">
          {loadingPipeline && <span className="text-xs text-text-400">Loading pipeline...</span>}
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* Company-Level KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <KPICard label="Total Dials" value={company.totalDials.toLocaleString()} />
        <KPICard label="Leads Called" value={company.totalLeadsCalled.toLocaleString()} />
        <KPICard label="MCs" value={company.mcs} />
        <KPICard label="Sets" value={company.sets} />
        <KPICard label="Conv Rate" value={`${company.convRate}%`} subtitle="Leads → Set" />
        <KPICard label="Dials/Set" value={company.dialsPerSet} target={30} direction="below" />
      </div>

      {/* Per-Setter Table */}
      <div>
        <h2 className="text-sm font-medium text-text-secondary mb-3">Individual Performance</h2>
        <DataTable columns={columns} data={setterRows} emptyMessage="No setter EOD data yet" />
      </div>
    </div>
  )
}
