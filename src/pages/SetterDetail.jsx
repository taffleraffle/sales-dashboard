import { useParams, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import DataTable from '../components/DataTable'
import LeadStatusBadge from '../components/LeadStatusBadge'
import { Loader, ChevronDown } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { sinceDate, rangeToDays } from '../lib/dateUtils'
import { useSetterStats, useSetterEODs } from '../hooks/useSetterData'
import { fetchWavvAggregates, fetchWavvCallsForSTL } from '../services/wavvService'
import { fetchAllPipelineSummaries, computeSpeedToLead } from '../services/ghlPipeline'

export default function SetterDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const [member, setMember] = useState(null)
  const [leads, setLeads] = useState([])
  const stats = useSetterStats(id, days)
  const { reports: myEodReports } = useSetterEODs(id, days)
  const { reports: allReports } = useSetterEODs(null, days)
  const [showEodHistory, setShowEodHistory] = useState(false)
  const [allLeads, setAllLeads] = useState([])
  const [wavvAgg, setWavvAgg] = useState({ totals: { dials: 0, pickups: 0, mcs: 0 }, byUser: {}, uniqueContacts: 0 })
  const [recentCalls, setRecentCalls] = useState([])
  const [stl, setStl] = useState(null)
  const [companyStl, setCompanyStl] = useState(null)
  const [loadingSTL, setLoadingSTL] = useState(true)
  const [pipelineData, setPipelineData] = useState(null)

  // Fetch member info
  useEffect(() => {
    supabase.from('team_members').select('*').eq('id', id).single()
      .then(({ data }) => setMember(data))
  }, [id])

  // Fetch this setter's leads
  useEffect(() => {
    supabase
      .from('setter_leads')
      .select('*, closer:team_members!setter_leads_closer_id_fkey(name)')
      .eq('setter_id', id)
      .gte('date_set', sinceDate(range))
      .order('date_set', { ascending: false })
      .then(({ data }) => setLeads((data || []).map(l => ({ ...l, closer_name: l.closer?.name || '—' }))))
  }, [id, range])

  // Fetch ALL setter leads for company average comparison
  useEffect(() => {
    supabase
      .from('setter_leads')
      .select('id, setter_id, status')
      .gte('date_set', sinceDate(range))
      .then(({ data }) => setAllLeads(data || []))
  }, [range])

  // Fetch WAVV aggregates (fast)
  useEffect(() => {
    fetchWavvAggregates(days).then(setWavvAgg)
  }, [range])

  // Fetch recent calls for this setter (last 50, for the table)
  useEffect(() => {
    if (!member?.wavv_user_id) return
    supabase
      .from('wavv_calls')
      .select('contact_name, phone_number, started_at, call_duration')
      .eq('user_id', member.wavv_user_id)
      .gte('started_at', `${sinceDate(range)}T00:00:00`)
      .order('started_at', { ascending: false })
      .limit(50)
      .then(({ data }) => setRecentCalls(data || []))
  }, [member, range])

  // Fetch GHL pipeline data once (not on range change)
  useEffect(() => {
    fetchAllPipelineSummaries(() => {}).then(setPipelineData)
  }, [])

  // Compute STL when pipeline + member are ready
  useEffect(() => {
    if (!pipelineData || !member) return
    setLoadingSTL(true)
    const allOpps = pipelineData.flatMap(p => p.summary.opportunities || [])
    if (allOpps.length === 0) { setLoadingSTL(false); return }

    fetchWavvCallsForSTL(days).then(calls => {
      if (calls.length > 0) {
        const result = computeSpeedToLead(allOpps, calls)
        setCompanyStl(result)
        const myCalls = calls.filter(c => member.wavv_user_id && c.user_id === member.wavv_user_id)
        setStl(myCalls.length > 0 ? computeSpeedToLead(allOpps, myCalls) : result)
      }
      setLoadingSTL(false)
    })
  }, [pipelineData, member, range])

  // Company-wide averages from all EODs
  const companyActivity = allReports.reduce((acc, r) => ({
    dials: acc.dials + (r.outbound_calls || 0),
    leads: acc.leads + (r.total_leads || 0),
    pickups: acc.pickups + (r.pickups || 0),
    mcs: acc.mcs + (r.meaningful_conversations || 0),
    sets: acc.sets + (r.sets || 0),
  }), { dials: 0, leads: 0, pickups: 0, mcs: 0, sets: 0 })

  const totalCompanySets = allLeads.length
  const companyClosedLeads = allLeads.filter(l => l.status === 'closed')
  const companyShowedLeads = allLeads.filter(l => ['showed', 'closed', 'not_closed'].includes(l.status))
  const companyResolvedLeads = allLeads.filter(l => ['showed', 'closed', 'not_closed', 'no_show'].includes(l.status))
  const companyRates = {
    leadToSet: companyActivity.leads > 0 ? parseFloat(((totalCompanySets / companyActivity.leads) * 100).toFixed(1)) : 0,
    callToSet: companyActivity.dials > 0 ? parseFloat(((totalCompanySets / companyActivity.dials) * 100).toFixed(1)) : 0,
    pickupToSet: companyActivity.pickups > 0 ? parseFloat(((totalCompanySets / companyActivity.pickups) * 100).toFixed(1)) : 0,
    mcToSet: companyActivity.mcs > 0 ? parseFloat(((totalCompanySets / companyActivity.mcs) * 100).toFixed(1)) : 0,
    pickupRate: companyActivity.dials > 0 ? parseFloat(((companyActivity.pickups / companyActivity.dials) * 100).toFixed(1)) : 0,
    closeRate: companyShowedLeads.length > 0 ? parseFloat(((companyClosedLeads.length / companyShowedLeads.length) * 100).toFixed(1)) : 0,
    showRate: companyResolvedLeads.length > 0 ? parseFloat(((companyShowedLeads.length / companyResolvedLeads.length) * 100).toFixed(1)) : 0,
    leadToClose: companyActivity.leads > 0 ? parseFloat(((companyClosedLeads.length / companyActivity.leads) * 100).toFixed(1)) : 0,
  }

  if (!member) {
    return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>
  }

  // WAVV-based stats from pre-aggregated data
  const wavvUser = member.wavv_user_id ? wavvAgg.byUser[member.wavv_user_id] : null
  const hasWavvData = wavvUser && wavvUser.dials > 0

  const effectiveDials = hasWavvData ? wavvUser.dials : stats.outboundCalls
  const effectivePickups = hasWavvData ? wavvUser.pickups : stats.pickups
  const effectiveMcs = hasWavvData ? wavvUser.mcs : stats.mcs
  const effectiveLeads = hasWavvData ? wavvUser.uniqueContacts : stats.totalLeads
  const effectivePickupRate = effectiveDials > 0 ? parseFloat(((effectivePickups / effectiveDials) * 100).toFixed(1)) : 0

  // Sets come from setter_leads, not EOD
  const mySets = leads.length

  const myRates = {
    leadToSet: effectiveLeads > 0 ? parseFloat(((mySets / effectiveLeads) * 100).toFixed(1)) : 0,
    callToSet: effectiveDials > 0 ? parseFloat(((mySets / effectiveDials) * 100).toFixed(1)) : 0,
    pickupToSet: effectivePickups > 0 ? parseFloat(((mySets / effectivePickups) * 100).toFixed(1)) : 0,
    mcToSet: effectiveMcs > 0 ? parseFloat(((mySets / effectiveMcs) * 100).toFixed(1)) : 0,
    pickupRate: effectivePickupRate,
  }

  // Compute show/close rate from leads
  const resolvedLeads = leads.filter(l => ['showed', 'closed', 'not_closed', 'no_show'].includes(l.status))
  const showedLeads = leads.filter(l => ['showed', 'closed', 'not_closed'].includes(l.status))
  const closedLeads = leads.filter(l => l.status === 'closed')
  const showRate = resolvedLeads.length ? parseFloat(((showedLeads.length / resolvedLeads.length) * 100).toFixed(1)) : 0
  const closeRate = showedLeads.length > 0 ? parseFloat(((closedLeads.length / showedLeads.length) * 100).toFixed(1)) : 0
  const leadToCloseRate = effectiveLeads > 0 ? parseFloat(((closedLeads.length / effectiveLeads) * 100).toFixed(1)) : 0
  const revenueAttributed = leads.reduce((sum, l) => sum + parseFloat(l.revenue_attributed || 0), 0)

  const leadColumns = [
    { key: 'lead_name', label: 'Lead' },
    { key: 'closer_name', label: 'Closer' },
    { key: 'date_set', label: 'Date Set' },
    { key: 'appointment_date', label: 'Appt Date' },
    { key: 'status', label: 'Status', render: v => <LeadStatusBadge status={v} /> },
    { key: 'revenue_attributed', label: 'Revenue', align: 'right', render: v => v > 0 ? <span className="text-success">${parseFloat(v).toLocaleString()}</span> : '—' },
  ]

  const fmtDuration = s => {
    if (!s) return '0s'
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
  }

  const tzOpts = { timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-lg sm:text-xl font-bold">{member.name}</h1>
          <p className="text-xs sm:text-sm text-text-400">Setter Performance</p>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* Activity KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
        <KPICard label="Total Dials" value={effectiveDials.toLocaleString()} subtitle={hasWavvData ? 'WAVV' : ''} />
        <KPICard label="Leads Called" value={effectiveLeads} subtitle={hasWavvData ? 'unique contacts' : ''} />
        <KPICard label="Pickups" value={effectivePickups} subtitle={`${effectivePickupRate}% rate`} />
        <KPICard label="MCs" value={effectiveMcs} />
        <KPICard label="Sets" value={mySets} />
        <KPICard label="Revenue" value={`$${revenueAttributed.toLocaleString()}`} />
        <KPICard label="Avg STL" value={stl ? stl.avgDisplay : '—'} subtitle={stl && companyStl ? (() => { const diff = Math.round((stl.avgSecs - companyStl.avgSecs) / 60); return diff < 0 ? `${Math.abs(diff)}m faster than avg` : diff > 0 ? `${diff}m slower than avg` : 'at team avg'; })() : stl ? `${stl.worked} leads` : 'loading...'} />
        <KPICard label="< 5 min" value={stl ? `${stl.pctUnder5m}%` : '—'} subtitle={stl ? `${stl.under5m} of ${stl.worked}` : ''} />
      </div>

      {/* WAVV Enrichment Stats */}
      {hasWavvData && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <KPICard label="Avg Call Duration" value={wavvUser.avgDuration < 60 ? `${wavvUser.avgDuration}s` : `${Math.round(wavvUser.avgDuration / 60)}m ${wavvUser.avgDuration % 60}s`} subtitle="answered calls only" />
          <KPICard label="Calls/Contact" value={`${wavvUser.avgCallsPerContact}x`} subtitle={`${wavvUser.uniqueContacts} contacts`} />
          <KPICard label="Dials/Set" value={mySets > 0 ? (effectiveDials / mySets).toFixed(1) : '—'} />
        </div>
      )}

      {/* Conversion Gauges — with vs company average deltas */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Gauge label="Lead → Set" value={myRates.leadToSet} target={5} max={50} delta={parseFloat((myRates.leadToSet - companyRates.leadToSet).toFixed(1))} avgLabel={companyRates.leadToSet} />
        <Gauge label="Lead → Close" value={leadToCloseRate} target={2} max={20} delta={parseFloat((leadToCloseRate - companyRates.leadToClose).toFixed(1))} avgLabel={companyRates.leadToClose} />
        <Gauge label="Call → Set" value={myRates.callToSet} target={3} max={20} delta={parseFloat((myRates.callToSet - companyRates.callToSet).toFixed(1))} avgLabel={companyRates.callToSet} />
        <Gauge label="Pickup → Set" value={myRates.pickupToSet} target={10} max={50} delta={parseFloat((myRates.pickupToSet - companyRates.pickupToSet).toFixed(1))} avgLabel={companyRates.pickupToSet} />
        <Gauge label="MC → Set" value={myRates.mcToSet} target={30} max={100} delta={parseFloat((myRates.mcToSet - companyRates.mcToSet).toFixed(1))} avgLabel={companyRates.mcToSet} />
        <Gauge label="Pickup Rate" value={myRates.pickupRate} target={30} delta={parseFloat((myRates.pickupRate - companyRates.pickupRate).toFixed(1))} avgLabel={companyRates.pickupRate} />
        <Gauge label="Show Rate" value={showRate} target={70} delta={parseFloat((showRate - companyRates.showRate).toFixed(1))} avgLabel={companyRates.showRate} />
        <Gauge label="Close Rate" value={closeRate} target={25} delta={parseFloat((closeRate - companyRates.closeRate).toFixed(1))} avgLabel={companyRates.closeRate} />
      </div>

      {/* Lead Outcomes Table */}
      {mySets > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-text-secondary mb-3">Recent Sets ({leads.length})</h2>
          <DataTable columns={leadColumns} data={leads} emptyMessage="No sets yet" />
        </div>
      )}

      {/* Recent Leads Contacted — from WAVV calls */}
      {recentCalls.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-text-secondary mb-3">Recent Leads Contacted ({recentCalls.length})</h2>
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-bg-card z-10">
                  <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                    <th className="px-3 py-2 text-left">Contact</th>
                    <th className="px-3 py-2 text-left">Phone</th>
                    <th className="px-3 py-2 text-left">Called At</th>
                    <th className="px-3 py-2 text-right">Duration</th>
                    <th className="px-3 py-2 text-right">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {recentCalls.map((c, i) => {
                    const dur = c.call_duration || 0
                    const type = dur >= 60 ? 'MC' : dur > 0 ? 'Pickup' : 'No Answer'
                    const typeColor = dur >= 60 ? 'text-success' : dur > 0 ? 'text-opt-yellow' : 'text-text-400'
                    return (
                      <tr key={i} className="border-b border-border-default/30 hover:bg-bg-card-hover/50">
                        <td className="px-3 py-1.5 font-medium text-text-primary">{c.contact_name || '—'}</td>
                        <td className="px-3 py-1.5 text-text-400">{c.phone_number || '—'}</td>
                        <td className="px-3 py-1.5 text-text-400">{new Date(c.started_at).toLocaleString('en-US', tzOpts)}</td>
                        <td className="px-3 py-1.5 text-right text-text-primary">{fmtDuration(dur)}</td>
                        <td className={`px-3 py-1.5 text-right font-medium ${typeColor}`}>{type}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* EOD History */}
      {myEodReports.length > 0 && (
        <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
          <button
            onClick={() => setShowEodHistory(!showEodHistory)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-card-hover transition-colors"
          >
            <h2 className="text-sm font-medium">EOD History ({myEodReports.length})</h2>
            <ChevronDown size={14} className={`text-text-400 transition-transform ${showEodHistory ? 'rotate-180' : ''}`} />
          </button>
          {showEodHistory && (
            <div className="border-t border-border-default overflow-x-auto max-h-[400px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-bg-card z-10">
                  <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-right">Dials</th>
                    <th className="px-3 py-2 text-right">Leads</th>
                    <th className="px-3 py-2 text-right">Pickups</th>
                    <th className="px-3 py-2 text-right">MCs</th>
                    <th className="px-3 py-2 text-right">Sets</th>
                    <th className="px-3 py-2 text-right">Resch</th>
                  </tr>
                </thead>
                <tbody>
                  {myEodReports.map(eod => (
                    <tr key={eod.id} className="border-b border-border-default/30 hover:bg-bg-card-hover/50 cursor-pointer" onClick={() => navigate(`/sales/eod?tab=setter&member=${id}&date=${eod.report_date}`)}>
                      <td className="px-3 py-2 font-medium text-opt-yellow hover:underline">{eod.report_date}</td>
                      <td className="px-3 py-2 text-right">{eod.outbound_calls || 0}</td>
                      <td className="px-3 py-2 text-right">{eod.total_leads || 0}</td>
                      <td className="px-3 py-2 text-right">{eod.pickups || 0}</td>
                      <td className="px-3 py-2 text-right">{eod.meaningful_conversations || 0}</td>
                      <td className="px-3 py-2 text-right font-medium">{eod.sets || 0}</td>
                      <td className="px-3 py-2 text-right">{eod.reschedules || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
