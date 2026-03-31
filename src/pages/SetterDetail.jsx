import { useParams, useNavigate } from 'react-router-dom'
import React, { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import DataTable from '../components/DataTable'
import LeadStatusBadge from '../components/LeadStatusBadge'
import { Loader, ChevronDown, Edit3, Clock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { sinceDate, rangeToDays } from '../lib/dateUtils'
import { useSetterStats, useSetterEODs } from '../hooks/useSetterData'
import { fetchWavvAggregates, fetchWavvCallsForSTL } from '../services/wavvService'
import { fetchAllPipelineSummaries, computeSpeedToLead, buildSetterSchedules } from '../services/ghlPipeline'
import { computeShowRate } from '../utils/metricCalculations'

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
  const [expandedCall, setExpandedCall] = useState(null)
  const [editingKpis, setEditingKpis] = useState(false)
  const [kpiTargets, setKpiTargets] = useState(() => {
    try { return JSON.parse(localStorage.getItem('setter_kpi_targets')) || { leads_day: 70, sets_day: 3, stl_pct: 80 } }
    catch { return { leads_day: 70, sets_day: 3, stl_pct: 80 } }
  })
  const [callsFrom, setCallsFrom] = useState(() => sinceDate(range))
  const [callsTo, setCallsTo] = useState(() => new Date().toISOString().split('T')[0])
  const [stl, setStl] = useState(null)
  const [companyStl, setCompanyStl] = useState(null)
  const [loadingSTL, setLoadingSTL] = useState(true)
  const [pipelineData, setPipelineData] = useState(null)
  const [stlDays, setStlDays] = useState(() => {
    try { return parseInt(localStorage.getItem('stl_days')) || 4 } catch { return 4 }
  })
  const [stlStartHour, setStlStartHour] = useState(null)
  const [stlEndHour, setStlEndHour] = useState(null)
  const [savingStlHours, setSavingStlHours] = useState(false)

  // Fetch member info
  useEffect(() => {
    supabase.from('team_members').select('*').eq('id', id).single()
      .then(({ data }) => {
        setMember(data)
        if (data) {
          setStlStartHour(data.stl_start_hour ?? '')
          setStlEndHour(data.stl_end_hour ?? '')
        }
      })
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

  // Fetch recent calls for this setter using date range
  useEffect(() => {
    if (!member?.wavv_user_id) return
    let query = supabase
      .from('wavv_calls')
      .select('contact_name, phone_number, started_at, call_duration')
      .eq('user_id', member.wavv_user_id)
      .gte('started_at', `${callsFrom}T00:00:00`)
    if (callsTo) query = query.lte('started_at', `${callsTo}T23:59:59`)
    query
      .order('started_at', { ascending: false })
      .limit(200)
      .then(({ data }) => setRecentCalls(data || []))
  }, [member, callsFrom, callsTo])

  // Sync date range when page range selector changes
  useEffect(() => { setCallsFrom(sinceDate(range)) }, [range])

  // Fetch GHL pipeline data once (not on range change)
  useEffect(() => {
    fetchAllPipelineSummaries(() => {}).then(setPipelineData)
  }, [])

  // Compute STL when pipeline + member + config are ready
  useEffect(() => {
    if (!pipelineData || !member) return
    setLoadingSTL(true)
    const allOpps = pipelineData.flatMap(p => p.summary.opportunities || [])
    // Filter opportunities to the configured STL window
    const stlCutoff = new Date(Date.now() - stlDays * 86400000).getTime()
    const stlOpps = allOpps.filter(o => o.createdAt && new Date(o.createdAt).getTime() >= stlCutoff)
    if (stlOpps.length === 0) { setLoadingSTL(false); return }

    // Build schedule map using current hour values (from state, which tracks DB + edits)
    const hasSchedule = stlStartHour !== '' && stlEndHour !== '' && stlStartHour != null && stlEndHour != null
    const schedules = hasSchedule && member.wavv_user_id
      ? { [member.wavv_user_id]: { startHour: parseInt(stlStartHour), endHour: parseInt(stlEndHour) } }
      : {}

    fetchWavvCallsForSTL(stlDays).then(calls => {
      if (calls.length > 0) {
        const result = computeSpeedToLead(stlOpps, calls, [], schedules)
        setCompanyStl(result)
        const myCalls = calls.filter(c => member.wavv_user_id && c.user_id === member.wavv_user_id)
        // Filter opportunities to this setter's working hours for their individual STL
        const mySchedule = schedules[member.wavv_user_id]
        const STL_TZ = 'America/Indiana/Indianapolis'
        const getHourInTz = ts => parseInt(new Date(ts).toLocaleString('en-US', { timeZone: STL_TZ, hour: 'numeric', hour12: false }))
        const myOpps = mySchedule
          ? stlOpps.filter(o => {
              const hour = getHourInTz(o.createdAt)
              return hour >= mySchedule.startHour && hour < mySchedule.endHour
            })
          : stlOpps
        setStl(myCalls.length > 0 ? computeSpeedToLead(myOpps, myCalls, [], schedules) : result)
      }
      setLoadingSTL(false)
    })
  }, [pipelineData, member, stlDays, stlStartHour, stlEndHour])

  // Company-wide averages from all EODs
  const companyActivity = allReports.reduce((acc, r) => ({
    dials: acc.dials + (r.outbound_calls || 0),
    leads: acc.leads + (r.total_leads || 0),
    pickups: acc.pickups + (r.pickups || 0),
    mcs: acc.mcs + (r.meaningful_conversations || 0),
    sets: acc.sets + (r.sets || 0),
  }), { dials: 0, leads: 0, pickups: 0, mcs: 0, sets: 0 })

  const totalCompanySets = Math.max(allLeads.length, companyActivity.sets)
  const companyClosedLeads = allLeads.filter(l => l.status === 'closed')
  const companyShowedLeads = allLeads.filter(l => ['showed', 'closed', 'not_closed'].includes(l.status))
  const { showRate: companyShowRateVal } = computeShowRate(allLeads)
  const companyRates = {
    leadToSet: companyActivity.leads > 0 ? parseFloat(((totalCompanySets / companyActivity.leads) * 100).toFixed(1)) : 0,
    callToSet: companyActivity.dials > 0 ? parseFloat(((totalCompanySets / companyActivity.dials) * 100).toFixed(1)) : 0,
    pickupToSet: companyActivity.pickups > 0 ? parseFloat(((totalCompanySets / companyActivity.pickups) * 100).toFixed(1)) : 0,
    mcToSet: companyActivity.mcs > 0 ? parseFloat(((totalCompanySets / companyActivity.mcs) * 100).toFixed(1)) : 0,
    pickupRate: companyActivity.dials > 0 ? parseFloat(((companyActivity.pickups / companyActivity.dials) * 100).toFixed(1)) : 0,
    closeRate: companyShowedLeads.length > 0 ? parseFloat(((companyClosedLeads.length / companyShowedLeads.length) * 100).toFixed(1)) : 0,
    showRate: companyShowRateVal,
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

  // Sets: use EOD totals if higher than setter_leads count (historical data)
  const eodSets = myEodReports.reduce((s, r) => s + (r.sets || 0), 0)
  const mySets = Math.max(leads.length, eodSets)

  const myRates = {
    leadToSet: effectiveLeads > 0 ? parseFloat(((mySets / effectiveLeads) * 100).toFixed(1)) : 0,
    callToSet: effectiveDials > 0 ? parseFloat(((mySets / effectiveDials) * 100).toFixed(1)) : 0,
    pickupToSet: effectivePickups > 0 ? parseFloat(((mySets / effectivePickups) * 100).toFixed(1)) : 0,
    mcToSet: effectiveMcs > 0 ? parseFloat(((mySets / effectiveMcs) * 100).toFixed(1)) : 0,
    pickupRate: effectivePickupRate,
  }

  // Compute show/close rate from leads
  const { showRate } = computeShowRate(leads)
  const showedLeads = leads.filter(l => ['showed', 'closed', 'not_closed'].includes(l.status))
  const closedLeads = leads.filter(l => l.status === 'closed')
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

      {/* KPI Targets — daily progress */}
      {(() => {
        const eodDays = myEodReports.length || 1
        const dailySets = mySets / eodDays
        const dailyLeads = effectiveLeads / eodDays
        const stlPct = stl ? stl.pctUnder5m : 0
        const kpis = [
          { key: 'leads_day', label: 'Leads/Day', value: dailyLeads, target: kpiTargets.leads_day, format: 'n', desc: `${Math.round(dailyLeads)} avg over ${eodDays} days` },
          { key: 'sets_day', label: 'Sets/Day', value: dailySets, target: kpiTargets.sets_day, format: 'n', desc: `${dailySets.toFixed(1)} avg over ${eodDays} days` },
          { key: 'stl_pct', label: 'STL < 5min', value: stlPct, target: kpiTargets.stl_pct, format: '%', desc: stl ? `${stl.under5m} of ${stl.worked} leads (last ${stlDays}d)` : 'loading...' },
        ]

        const fmtHour = h => {
          if (h === '' || h == null) return '—'
          const n = parseInt(h)
          if (n === 0) return '12am'
          if (n < 12) return `${n}am`
          if (n === 12) return '12pm'
          return `${n - 12}pm`
        }

        const saveStlHours = async (start, end) => {
          if (!member) return
          setSavingStlHours(true)
          const updates = { stl_start_hour: start !== '' ? parseInt(start) : null, stl_end_hour: end !== '' ? parseInt(end) : null }
          await supabase.from('team_members').update(updates).eq('id', member.id)
          setMember(prev => ({ ...prev, ...updates }))
          setSavingStlHours(false)
        }

        return (
          <div className="bg-bg-card border border-border-default rounded-2xl p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] text-opt-yellow uppercase font-medium">Daily KPI Targets</h3>
              <button
                onClick={() => setEditingKpis(!editingKpis)}
                className="text-[10px] text-text-400 hover:text-opt-yellow transition-colors flex items-center gap-1"
              >
                <Edit3 size={10} />
                {editingKpis ? 'Done' : 'Edit Targets'}
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {kpis.map(k => {
                const pct = k.target > 0 ? Math.min((k.value / k.target) * 100, 100) : 0
                const isHit = k.value >= k.target
                const isClose = pct >= 70
                const color = isHit ? 'bg-success' : isClose ? 'bg-opt-yellow' : 'bg-danger'
                const textColor = isHit ? 'text-success' : isClose ? 'text-opt-yellow' : 'text-danger'
                return (
                  <div key={k.key}>
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="text-[10px] text-text-400 uppercase">{k.label}</span>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-sm font-bold ${textColor}`}>
                          {k.format === '%' ? `${Math.round(k.value)}%` : k.value.toFixed(1)}
                        </span>
                        <span className="text-[10px] text-text-400">/</span>
                        {editingKpis ? (
                          <input
                            type="number"
                            value={kpiTargets[k.key]}
                            onChange={e => {
                              const val = parseFloat(e.target.value) || 0
                              setKpiTargets(prev => ({ ...prev, [k.key]: val }))
                              localStorage.setItem('setter_kpi_targets', JSON.stringify({ ...kpiTargets, [k.key]: val }))
                            }}
                            className="w-12 bg-bg-primary border border-opt-yellow/30 rounded px-1 py-0.5 text-[11px] text-text-primary text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        ) : (
                          <span className="text-[10px] text-text-400">{k.target}{k.format === '%' ? '%' : ''}</span>
                        )}
                      </div>
                    </div>
                    <div className="h-2 bg-bg-primary rounded-full overflow-hidden mb-1">
                      <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-[9px] text-text-400">{k.desc}{isHit ? ' — Target hit' : pct > 0 ? ` — ${(100 - pct).toFixed(0)}% behind` : ''}</p>
                  </div>
                )
              })}
            </div>

            {/* STL Configuration — always visible */}
            <div className="mt-4 pt-3 border-t border-border-default/50">
              <div className="flex items-center gap-1.5 mb-2">
                <Clock size={11} className="text-opt-yellow" />
                <span className="text-[11px] text-opt-yellow uppercase font-medium">Speed to Lead Config</span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] text-text-400 block mb-1">Start Hour</label>
                  <select
                    value={stlStartHour ?? ''}
                    onChange={e => {
                      const val = e.target.value
                      setStlStartHour(val === '' ? '' : parseInt(val))
                      saveStlHours(val, stlEndHour)
                    }}
                    className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
                  >
                    <option value="">Off</option>
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{i === 0 ? '12am' : i < 12 ? `${i}am` : i === 12 ? '12pm' : `${i-12}pm`}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-text-400 block mb-1">End Hour</label>
                  <select
                    value={stlEndHour ?? ''}
                    onChange={e => {
                      const val = e.target.value
                      setStlEndHour(val === '' ? '' : parseInt(val))
                      saveStlHours(stlStartHour, val)
                    }}
                    className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
                  >
                    <option value="">Off</option>
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{i === 0 ? '12am' : i < 12 ? `${i}am` : i === 12 ? '12pm' : `${i-12}pm`}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-text-400 block mb-1">STL Window</label>
                  <select
                    value={stlDays}
                    onChange={e => {
                      const val = parseInt(e.target.value)
                      setStlDays(val)
                      localStorage.setItem('stl_days', val)
                    }}
                    className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
                  >
                    <option value={1}>Last 1 day</option>
                    <option value={2}>Last 2 days</option>
                    <option value={3}>Last 3 days</option>
                    <option value={4}>Last 4 days</option>
                    <option value={7}>Last 7 days</option>
                    <option value={14}>Last 14 days</option>
                    <option value={30}>Last 30 days</option>
                  </select>
                </div>
              </div>
              {savingStlHours && <p className="text-[9px] text-opt-yellow mt-1">Saving...</p>}
            </div>
          </div>
        )
      })()}

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

      {/* Recent Leads Contacted — from WAVV calls, grouped by contact */}
      {recentCalls.length > 0 && (() => {
        // Build phone → pipeline/stage lookup from GHL data
        const normPhone = p => p ? p.replace(/\D/g, '').slice(-10) : null
        const phoneToPipeline = {}
        if (pipelineData) {
          for (const p of pipelineData) {
            const stageMap = {}
            if (p.stages) p.stages.forEach(s => { stageMap[s.id] = s.name?.replace(/[🔵🟡🟢🔴🟣🟠]/g, '').trim() })
            for (const opp of (p.summary?.opportunities || [])) {
              const ph = normPhone(opp.contact?.phone)
              if (ph) phoneToPipeline[ph] = { pipeline: p.name, stage: stageMap[opp.pipelineStageId] || 'Unknown' }
            }
          }
        }

        // Group calls by phone number (or contact name if no phone)
        const grouped = []
        const seen = new Map()
        for (const c of recentCalls) {
          const key = c.phone_number || c.contact_name || `anon-${Math.random()}`
          if (seen.has(key)) {
            seen.get(key).calls.push(c)
          } else {
            const group = { key, name: c.contact_name || '—', phone: c.phone_number || '—', calls: [c] }
            seen.set(key, group)
            grouped.push(group)
          }
        }
        return (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-text-secondary">Recent Leads Contacted ({grouped.length} contacts, {recentCalls.length} calls)</h2>
              <div className="flex items-center gap-1.5 text-[10px] text-text-400">
                <span>From</span>
                <input type="date" value={callsFrom} onChange={e => setCallsFrom(e.target.value)}
                  className="bg-bg-primary border border-border-default rounded-lg px-2 py-1 text-xs text-text-primary" />
                <span>to</span>
                <input type="date" value={callsTo} onChange={e => setCallsTo(e.target.value)}
                  className="bg-bg-primary border border-border-default rounded-lg px-2 py-1 text-xs text-text-primary" />
              </div>
            </div>
            <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-bg-card z-10">
                    <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                      <th className="px-3 py-2 text-left w-6"></th>
                      <th className="px-3 py-2 text-left">Contact</th>
                      <th className="px-3 py-2 text-left">Phone</th>
                      <th className="px-3 py-2 text-left">Current Stage</th>
                      <th className="px-3 py-2 text-left">Last Called</th>
                      <th className="px-3 py-2 text-right">Best Call</th>
                      <th className="px-3 py-2 text-right">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped.map(g => {
                      const bestCall = g.calls.reduce((best, c) => (c.call_duration || 0) > (best.call_duration || 0) ? c : best, g.calls[0])
                      const bestDur = bestCall.call_duration || 0
                      const bestType = bestDur >= 60 ? 'MC' : bestDur > 45 ? 'Pickup' : 'No Answer'
                      const bestColor = bestDur >= 60 ? 'text-success' : bestDur > 45 ? 'text-opt-yellow' : 'text-text-400'
                      const lastCall = g.calls[0] // already sorted desc
                      const isExpanded = expandedCall === g.key
                      const hasMultiple = g.calls.length > 1
                      const pipeInfo = phoneToPipeline[normPhone(g.phone)]
                      const stageColor = pipeInfo?.stage ? (
                        /new lead|triage/i.test(pipeInfo.stage) ? 'text-blue-400'
                        : /contact|booked/i.test(pipeInfo.stage) ? 'text-opt-yellow'
                        : /set call|strategy/i.test(pipeInfo.stage) ? 'text-success'
                        : /no show|lost|dead/i.test(pipeInfo.stage) ? 'text-danger'
                        : /nurture|follow/i.test(pipeInfo.stage) ? 'text-purple-400'
                        : 'text-text-400'
                      ) : 'text-text-400'
                      return (
                        <React.Fragment key={g.key}>
                          <tr
                            className={`border-b border-border-default/30 hover:bg-bg-card-hover/50 ${hasMultiple ? 'cursor-pointer' : ''}`}
                            onClick={() => hasMultiple && setExpandedCall(isExpanded ? null : g.key)}
                          >
                            <td className="px-3 py-1.5 text-text-400">
                              {hasMultiple && <ChevronDown size={10} className={`transition-transform ${isExpanded ? '' : '-rotate-90'}`} />}
                            </td>
                            <td className="px-3 py-1.5 font-medium text-text-primary">
                              {g.name}
                              {hasMultiple && <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-text-400/15 text-text-400">x{g.calls.length}</span>}
                            </td>
                            <td className="px-3 py-1.5 text-text-400">{g.phone}</td>
                            <td className="px-3 py-1.5">
                              {pipeInfo ? (
                                <div className="flex flex-col">
                                  <span className="text-[10px] text-text-400 truncate max-w-[140px]">{pipeInfo.pipeline}</span>
                                  <span className={`text-[10px] font-medium ${stageColor}`}>{pipeInfo.stage}</span>
                                </div>
                              ) : <span className="text-text-400">—</span>}
                            </td>
                            <td className="px-3 py-1.5 text-text-400">{new Date(lastCall.started_at).toLocaleString('en-US', tzOpts)}</td>
                            <td className="px-3 py-1.5 text-right text-text-primary">{fmtDuration(bestDur)}</td>
                            <td className={`px-3 py-1.5 text-right font-medium ${bestColor}`}>{bestType}</td>
                          </tr>
                          {isExpanded && g.calls.map((c, ci) => {
                            const dur = c.call_duration || 0
                            const type = dur >= 60 ? 'MC' : dur > 45 ? 'Pickup' : 'No Answer'
                            const typeColor = dur >= 60 ? 'text-success' : dur > 45 ? 'text-opt-yellow' : 'text-text-400'
                            return (
                              <tr key={ci} className="bg-bg-primary/50 border-b border-border-default/20">
                                <td className="px-3 py-1"></td>
                                <td className="px-3 py-1 text-text-400 text-[10px] pl-8">Call {ci + 1}</td>
                                <td className="px-3 py-1"></td>
                                <td className="px-3 py-1"></td>
                                <td className="px-3 py-1 text-text-400">{new Date(c.started_at).toLocaleString('en-US', tzOpts)}</td>
                                <td className="px-3 py-1 text-right text-text-primary">{fmtDuration(dur)}</td>
                                <td className={`px-3 py-1 text-right font-medium ${typeColor}`}>{type}</td>
                              </tr>
                            )
                          })}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )
      })()}

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
