import { Link } from 'react-router-dom'
import { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import DataTable from '../components/DataTable'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useSetterEODs } from '../hooks/useSetterData'
import { supabase } from '../lib/supabase'
import { sinceDate, rangeToDays } from '../lib/dateUtils'
import { fetchAllPipelineSummaries, computeSpeedToLead } from '../services/ghlPipeline'
import { fetchWavvAggregates, fetchWavvCallsForSTL } from '../services/wavvService'
import { Loader, ChevronDown, Plus, ChevronUp } from 'lucide-react'

export default function SetterOverview() {
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const { members: setters, loading: loadingMembers } = useTeamMembers('setter')
  const { members: closers } = useTeamMembers('closer')
  const { reports, loading: loadingReports } = useSetterEODs(null, days)
  const [allLeads, setAllLeads] = useState([])
  const [loadingLeads, setLoadingLeads] = useState(true)
  const [pipelineData, setPipelineData] = useState([])
  const [loadingPipeline, setLoadingPipeline] = useState(true)
  const [pipelineProgress, setPipelineProgress] = useState('')
  const [wavvAgg, setWavvAgg] = useState({ totals: { dials: 0, pickups: 0, mcs: 0 }, byUser: {}, uniqueContacts: 0 })
  const [wavvLoaded, setWavvLoaded] = useState(false)
  const [stlOpen, setStlOpen] = useState(false)
  const [stlCalls, setStlCalls] = useState(null)
  const [autoBookings, setAutoBookings] = useState([])
  const [allAppointments, setAllAppointments] = useState([])
  const [showAllLeads, setShowAllLeads] = useState(false)

  // Fetch appointments from GHL calendars
  useEffect(() => {
    async function fetchAppointments() {
      const INTRO_CALENDARS = [
        '5omixNmtgmGMWQfEL0fs', 'C5NRRAjwsy43nOyU6izQ',
        'GpYh75LaFEJgpHYkZfN9', 'okWMyvLhnJ7sbuvSIzok', 'MvYStrHFsRTpunwTXIqT',
      ]
      const { data } = await supabase
        .from('ghl_appointments')
        .select('ghl_event_id, closer_id, ghl_user_id, ghl_contact_id, contact_name, contact_phone, appointment_date, booked_at, calendar_name, appointment_status, outcome, start_time')
        .gte('booked_at', `${sinceDate(range)} 00:00:00`)
        .neq('appointment_status', 'cancelled')
      setAllAppointments(data || [])
      setAutoBookings((data || []).filter(a => INTRO_CALENDARS.includes(a.calendar_name)))
    }
    fetchAppointments()
  }, [range])

  // Fetch all GHL pipelines with summaries on mount and range change
  useEffect(() => {
    setLoadingPipeline(true)
    setPipelineData([])
    fetchAllPipelineSummaries((name, loaded, total) => {
      setPipelineProgress(`${name}: ${loaded}/${total}`)
    }).then(data => {
      setPipelineData(data || [])
      setLoadingPipeline(false)
    }).catch(err => {
      console.error('Failed to fetch GHL pipelines:', err)
      setPipelineData([])
      setLoadingPipeline(false)
    })
  }, [range])

  // Fetch WAVV aggregates (fast — only 3 columns, no pagination needed)
  useEffect(() => {
    setWavvLoaded(false)
    setStlCalls(null) // reset STL on range change
    fetchWavvAggregates(days).then(agg => {
      setWavvAgg(agg)
      setWavvLoaded(true)
    }).catch(() => setWavvLoaded(true))
  }, [range])

  // Fetch STL calls eagerly on mount/range change
  useEffect(() => {
    fetchWavvCallsForSTL(days).then(setStlCalls).catch(() => setStlCalls([]))
  }, [range])

  // Fetch all setter_leads for the date range
  useEffect(() => {
    async function fetchLeads() {
      setLoadingLeads(true)
      const { data } = await supabase
        .from('setter_leads')
        .select('id, setter_id, closer_id, lead_name, lead_source, date_set, appointment_date, status, revenue_attributed, closer:team_members!setter_leads_closer_id_fkey(name)')
        .gte('date_set', sinceDate(range))
        .order('date_set', { ascending: false })
      setAllLeads(data || [])
      setLoadingLeads(false)
    }
    fetchLeads()
  }, [range])

  if (loadingMembers || loadingLeads || loadingReports) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 bg-bg-card rounded-xl" />
          <div className="h-8 w-40 bg-bg-card rounded-xl" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          {[1,2,3,4,5,6,7,8].map(i => <div key={i} className="bg-bg-card border border-border-default rounded-2xl h-24" />)}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1,2,3,4].map(i => <div key={i} className="bg-bg-card border border-border-default rounded-2xl h-32" />)}
        </div>
      </div>
    )
  }

  // Company-level pipeline stats from setter_leads
  const totalSets = allLeads.length
  const showedLeads = allLeads.filter(l => ['showed', 'not_closed', 'closed'].includes(l.status))
  const closedLeads = allLeads.filter(l => l.status === 'closed')
  const noShowLeads = allLeads.filter(l => l.status === 'no_show')
  const totalRevenue = allLeads.reduce((s, l) => s + parseFloat(l.revenue_attributed || 0), 0)
  const resolvedLeads = allLeads.filter(l => ['showed', 'not_closed', 'closed', 'no_show'].includes(l.status))
  const showRate = resolvedLeads.length > 0 ? ((showedLeads.length / resolvedLeads.length) * 100).toFixed(1) : 0
  const closeRate = showedLeads.length > 0 ? ((closedLeads.length / showedLeads.length) * 100).toFixed(1) : 0

  // Company-level activity — prefer WAVV data for dials/pickups/MCs, EOD for leads/sets/reschedules
  const eodActivity = reports.reduce((acc, r) => ({
    dials: acc.dials + (r.outbound_calls || 0),
    leads: acc.leads + (r.total_leads || 0),
    pickups: acc.pickups + (r.pickups || 0),
    mcs: acc.mcs + (r.meaningful_conversations || 0),
    sets: acc.sets + (r.sets || 0),
    reschedules: acc.reschedules + (r.reschedules || 0),
  }), { dials: 0, leads: 0, pickups: 0, mcs: 0, sets: 0, reschedules: 0 })

  const hasWavv = wavvAgg.totals.dials > 0
  const companyActivity = {
    dials: hasWavv ? wavvAgg.totals.dials : eodActivity.dials,
    pickups: hasWavv ? wavvAgg.totals.pickups : eodActivity.pickups,
    mcs: hasWavv ? wavvAgg.totals.mcs : eodActivity.mcs,
    leads: hasWavv ? wavvAgg.uniqueContacts : eodActivity.leads,
    sets: eodActivity.sets,
    reschedules: eodActivity.reschedules,
  }

  const pickupRate = companyActivity.dials > 0 ? ((companyActivity.pickups / companyActivity.dials) * 100).toFixed(1) : 0
  const dialsPerSet = totalSets > 0 ? (companyActivity.dials / totalSets).toFixed(1) : 0

  // Company-wide conversion rates (the 5 blanket stats)
  const companyRates = {
    leadToSet: companyActivity.leads > 0 ? parseFloat(((totalSets / companyActivity.leads) * 100).toFixed(1)) : 0,
    callToSet: companyActivity.dials > 0 ? parseFloat(((totalSets / companyActivity.dials) * 100).toFixed(1)) : 0,
    pickupToSet: companyActivity.pickups > 0 ? parseFloat(((totalSets / companyActivity.pickups) * 100).toFixed(1)) : 0,
    mcToSet: companyActivity.mcs > 0 ? parseFloat(((totalSets / companyActivity.mcs) * 100).toFixed(1)) : 0,
    leadToClose: companyActivity.leads > 0 ? parseFloat(((closedLeads.length / companyActivity.leads) * 100).toFixed(1)) : 0,
    pickupRate: parseFloat(pickupRate),
  }
  const leadsPerClose = closedLeads.length > 0 ? parseFloat((companyActivity.leads / closedLeads.length).toFixed(1)) : 0

  // Auto vs Manual booking breakdown
  const autoLeads = allLeads.filter(l => l.lead_source === 'auto')
  const manualLeads = allLeads.filter(l => l.lead_source !== 'auto')
  const showStatuses = ['showed', 'closed', 'not_closed']
  const resolvedStatuses = ['showed', 'closed', 'not_closed', 'no_show']
  const autoResolved = autoLeads.filter(l => resolvedStatuses.includes(l.status))
  const manualResolved = manualLeads.filter(l => resolvedStatuses.includes(l.status))
  const booking = {
    autoTotal: autoLeads.length,
    autoShows: autoLeads.filter(l => showStatuses.includes(l.status)).length,
    autoNoShows: autoLeads.filter(l => l.status === 'no_show').length,
    autoCloses: autoLeads.filter(l => l.status === 'closed').length,
    autoShowRate: autoResolved.length > 0 ? parseFloat(((autoLeads.filter(l => showStatuses.includes(l.status)).length / autoResolved.length) * 100).toFixed(1)) : 0,
    autoCloseRate: autoLeads.filter(l => showStatuses.includes(l.status)).length > 0 ? parseFloat(((autoLeads.filter(l => l.status === 'closed').length / autoLeads.filter(l => showStatuses.includes(l.status)).length) * 100).toFixed(1)) : 0,
    manualTotal: manualLeads.length,
    manualShows: manualLeads.filter(l => showStatuses.includes(l.status)).length,
    manualNoShows: manualLeads.filter(l => l.status === 'no_show').length,
    manualCloses: manualLeads.filter(l => l.status === 'closed').length,
    manualShowRate: manualResolved.length > 0 ? parseFloat(((manualLeads.filter(l => showStatuses.includes(l.status)).length / manualResolved.length) * 100).toFixed(1)) : 0,
    manualCloseRate: manualLeads.filter(l => showStatuses.includes(l.status)).length > 0 ? parseFloat(((manualLeads.filter(l => l.status === 'closed').length / manualLeads.filter(l => showStatuses.includes(l.status)).length) * 100).toFixed(1)) : 0,
  }

  // Auto-booking distribution per setter (matched by ghl_user_id)
  const totalAutoBookings = autoBookings.length
  const autoBookingsBySetter = {}
  for (const setter of setters) {
    const myAuto = autoBookings.filter(a => a.ghl_user_id === setter.ghl_user_id || a.closer_id === setter.id)
    autoBookingsBySetter[setter.id] = {
      count: myAuto.length,
      pct: totalAutoBookings > 0 ? parseFloat(((myAuto.length / totalAutoBookings) * 100).toFixed(1)) : 0,
    }
  }
  const unassignedAuto = autoBookings.filter(a => {
    return !setters.some(s => a.ghl_user_id === s.ghl_user_id || a.closer_id === s.id)
  }).length

  // Per-setter breakdown — uses pre-aggregated WAVV data (no raw call filtering)
  const setterCards = setters.map(setter => {
    // Look up pre-aggregated WAVV stats for this setter
    const wavvUser = setter.wavv_user_id ? wavvAgg.byUser[setter.wavv_user_id] : null
    const setterHasWavv = wavvUser && wavvUser.dials > 0

    // Activity from EODs (fallback when no WAVV data)
    const myReports = reports.filter(r => r.setter_id === setter.id)
    const eod = myReports.reduce((acc, r) => ({
      dials: acc.dials + (r.outbound_calls || 0),
      leads: acc.leads + (r.total_leads || 0),
      pickups: acc.pickups + (r.pickups || 0),
      mcs: acc.mcs + (r.meaningful_conversations || 0),
      sets: acc.sets + (r.sets || 0),
    }), { dials: 0, leads: 0, pickups: 0, mcs: 0, sets: 0 })

    // Use WAVV for dials/pickups/MCs when available, EOD for leads/sets
    const dials = setterHasWavv ? wavvUser.dials : eod.dials
    const pickups = setterHasWavv ? wavvUser.pickups : eod.pickups
    const mcs = setterHasWavv ? wavvUser.mcs : eod.mcs

    // Pipeline from setter_leads
    const myLeads = allLeads.filter(l => l.setter_id === setter.id)
    const myShowed = myLeads.filter(l => ['showed', 'not_closed', 'closed'].includes(l.status))
    const myClosed = myLeads.filter(l => l.status === 'closed')
    const myNoShow = myLeads.filter(l => l.status === 'no_show')
    const myResolved = myLeads.filter(l => ['showed', 'not_closed', 'closed', 'no_show'].includes(l.status))
    const myRevenue = myLeads.reduce((s, l) => s + parseFloat(l.revenue_attributed || 0), 0)

    // Use EOD sets total (more accurate than setter_leads count for historical data)
    const eodSets = eod.sets

    // Per-pipeline breakdown for this setter
    const pipelineSources = {}
    myLeads.forEach(l => {
      const src = l.lead_source || 'manual'
      pipelineSources[src] = (pipelineSources[src] || 0) + 1
    })
    const topPipelines = Object.entries(pipelineSources)
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({ source, count }))

    return {
      id: setter.id,
      name: setter.name,
      dataSource: setterHasWavv ? 'wavv' : 'eod',
      // Activity — WAVV-primary for dials/pickups/MCs/leads worked
      dials,
      leads: setterHasWavv ? wavvUser.uniqueContacts : eod.leads,
      pickups,
      mcs,
      pickupRate: dials ? parseFloat(((pickups / dials) * 100).toFixed(1)) : 0,
      // Use whichever sets count is higher — EOD totals or setter_leads records
      totalSets: eodSets > myLeads.length ? eodSets : myLeads.length,
      leadsPerSet: (eodSets || myLeads.length) > 0 ? parseFloat((eod.leads / (eodSets || myLeads.length)).toFixed(1)) : 0,
      callsPerSet: (eodSets || myLeads.length) > 0 ? parseFloat((dials / (eodSets || myLeads.length)).toFixed(1)) : 0,
      pickupsPerSet: (eodSets || myLeads.length) > 0 ? parseFloat((pickups / (eodSets || myLeads.length)).toFixed(1)) : 0,
      // Pipeline
      showed: myShowed.length,
      closed: myClosed.length,
      noShows: myNoShow.length,
      revenue: myRevenue,
      showRate: myResolved.length > 0 ? parseFloat(((myShowed.length / myResolved.length) * 100).toFixed(1)) : 0,
      closeRate: myShowed.length > 0 ? parseFloat(((myClosed.length / myShowed.length) * 100).toFixed(1)) : 0,
      dialsPerSet: (eodSets || myLeads.length) > 0 ? parseFloat((dials / (eodSets || myLeads.length)).toFixed(1)) : 0,
      topPipelines,
      // Auto bookings
      autoBookingCount: autoBookingsBySetter[setter.id]?.count || 0,
      autoBookingPct: autoBookingsBySetter[setter.id]?.pct || 0,
      // WAVV enrichment — from pre-aggregated data
      avgDuration: setterHasWavv ? wavvUser.avgDuration : 0,
      avgCallsPerContact: setterHasWavv ? wavvUser.avgCallsPerContact : 0,
      uniqueContacts: setterHasWavv ? wavvUser.uniqueContacts : 0,
    }
  })

  // Speed to Lead — only computed when STL calls are loaded (lazy)
  const allOpps = pipelineData.flatMap(p => p.summary.opportunities || [])
  const stl = allOpps.length > 0 && stlCalls && stlCalls.length > 0
    ? computeSpeedToLead(allOpps, stlCalls, allAppointments)
    : null

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Setter Performance</h1>
        <div className="flex items-center gap-3">
          <Link to="/sales/eod?tab=setter" className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-opt-yellow text-bg-primary text-xs font-semibold hover:brightness-110 transition-colors">
            <Plus size={14} />
            New EOD
          </Link>
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* Company-Level KPIs - two rows */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 sm:gap-3 mb-6">
        <KPICard label="Total Dials" value={companyActivity.dials.toLocaleString()} />
        <KPICard label="Leads Worked" value={companyActivity.leads.toLocaleString()} />
        <KPICard label="MCs" value={companyActivity.mcs} />
        <KPICard label="Sets" value={totalSets} subtitle={totalSets > 0 ? `${dialsPerSet} dials/set` : ''} />
        <KPICard label="Avg STL" value={stl ? stl.avgDisplay : '—'} subtitle={stl ? `${stl.pctUnder5m}% < 5m` : ''} />
        <KPICard label="Avg Duration" value={hasWavv ? (() => { const totalDur = Object.values(wavvAgg.byUser).reduce((s, u) => s + (u.avgDuration * u.dials), 0); const totalDials = wavvAgg.totals.dials; const avg = totalDials > 0 ? totalDur / totalDials : 0; return avg < 60 ? `${Math.round(avg)}s` : `${Math.round(avg / 60)}m`; })() : '—'} subtitle={hasWavv ? `${wavvAgg.totals.dials} calls` : ''} />
        <KPICard label="No Shows" value={noShowLeads.length} />
        <KPICard label="Revenue" value={`$${totalRevenue.toLocaleString()}`} />
      </div>

      {/* Company conversion gauges */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3 mb-6">
        <Gauge label="Pickup Rate" value={parseFloat(pickupRate)} target={30} />
        <Gauge label="Show Rate" value={parseFloat(showRate)} target={70} />
        <Gauge label="Close Rate" value={parseFloat(closeRate)} target={25} />
        <Gauge label="MC → Set %" value={companyRates.mcToSet} target={30} max={100} />
      </div>

      {/* Blanket Conversion Rates */}
      <h2 className="text-sm font-medium text-text-secondary mb-3">Conversion Rates</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 sm:gap-3 mb-6">
        <Gauge label="Lead → Set" value={companyRates.leadToSet} target={5} max={50} />
        <Gauge label="Lead → Close" value={companyRates.leadToClose} target={2} max={20} />
        <Gauge label="Call → Set" value={companyRates.callToSet} target={3} max={20} />
        <Gauge label="Pickup → Set" value={companyRates.pickupToSet} target={10} max={50} />
        <Gauge label="MC → Set" value={companyRates.mcToSet} target={30} max={100} />
      </div>
      {leadsPerClose > 0 && (
        <div className="bg-bg-card border border-border-default rounded-2xl px-4 py-3 mb-6 flex items-center gap-3">
          <span className="text-xs text-text-400">Leads per Close:</span>
          <span className="text-lg font-bold text-opt-yellow">{leadsPerClose}</span>
          <span className="text-xs text-text-400">({closedLeads.length} closes from {companyActivity.leads.toLocaleString()} leads)</span>
        </div>
      )}

      {/* Auto vs Manual Booking Breakdown */}
      {(booking.autoTotal > 0 || booking.manualTotal > 0) && (
        <>
          <h2 className="text-sm font-medium text-text-secondary mb-3">Auto Booking vs Manual Sets</h2>
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Shows</th>
                    <th className="px-3 py-2 text-right">No Shows</th>
                    <th className="px-3 py-2 text-right">Closes</th>
                    <th className="px-3 py-2 text-right">Show Rate</th>
                    <th className="px-3 py-2 text-right">Close Rate</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border-default/30">
                    <td className="px-3 py-2 font-medium text-cyan-400">Auto Bookings</td>
                    <td className="px-3 py-2 text-right font-medium">{booking.autoTotal}</td>
                    <td className="px-3 py-2 text-right text-success">{booking.autoShows}</td>
                    <td className="px-3 py-2 text-right text-danger">{booking.autoNoShows}</td>
                    <td className="px-3 py-2 text-right font-medium text-text-primary">{booking.autoCloses}</td>
                    <td className={`px-3 py-2 text-right font-medium ${booking.autoShowRate >= 70 ? 'text-success' : booking.autoShowRate >= 50 ? 'text-opt-yellow' : 'text-danger'}`}>{booking.autoShowRate}%</td>
                    <td className={`px-3 py-2 text-right font-medium ${booking.autoCloseRate >= 25 ? 'text-success' : booking.autoCloseRate >= 15 ? 'text-opt-yellow' : 'text-danger'}`}>{booking.autoCloseRate}%</td>
                  </tr>
                  <tr className="border-b border-border-default/30">
                    <td className="px-3 py-2 font-medium text-opt-yellow">Manual Sets</td>
                    <td className="px-3 py-2 text-right font-medium">{booking.manualTotal}</td>
                    <td className="px-3 py-2 text-right text-success">{booking.manualShows}</td>
                    <td className="px-3 py-2 text-right text-danger">{booking.manualNoShows}</td>
                    <td className="px-3 py-2 text-right font-medium text-text-primary">{booking.manualCloses}</td>
                    <td className={`px-3 py-2 text-right font-medium ${booking.manualShowRate >= 70 ? 'text-success' : booking.manualShowRate >= 50 ? 'text-opt-yellow' : 'text-danger'}`}>{booking.manualShowRate}%</td>
                    <td className={`px-3 py-2 text-right font-medium ${booking.manualCloseRate >= 25 ? 'text-success' : booking.manualCloseRate >= 15 ? 'text-opt-yellow' : 'text-danger'}`}>{booking.manualCloseRate}%</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr className="border-t border-border-default bg-bg-card-hover/30 font-medium">
                    <td className="px-3 py-2">Combined</td>
                    <td className="px-3 py-2 text-right">{totalSets}</td>
                    <td className="px-3 py-2 text-right">{showedLeads.length}</td>
                    <td className="px-3 py-2 text-right">{noShowLeads.length}</td>
                    <td className="px-3 py-2 text-right">{closedLeads.length}</td>
                    <td className="px-3 py-2 text-right">{showRate}%</td>
                    <td className="px-3 py-2 text-right">{closeRate}%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Speed to Lead */}
      <h2 className="text-sm font-medium text-text-secondary mb-3">Speed to Lead</h2>
      {stl ? (
        <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <KPICard label="Avg Speed to Lead" value={stl.avgDisplay} subtitle={`${stl.worked} leads`} />
            <KPICard label="< 5 min" value={`${stl.pctUnder5m}%`} subtitle={`${stl.under5m} of ${stl.worked} leads`} />
          </div>
          {stl.leads.length > 0 && (
            <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
              <button onClick={() => setStlOpen(!stlOpen)} className="w-full px-4 py-2 border-b border-border-default flex items-center justify-between hover:bg-bg-card-hover/50 transition-colors">
                <span className="text-xs font-medium text-text-secondary">Recent Leads — Response Times ({stl.allLeads.length}){stl.notCalled > 0 && <span className="ml-2 text-danger">{stl.notCalled} not called</span>}</span>
                <ChevronDown size={14} className={`text-text-400 transition-transform ${stlOpen ? 'rotate-180' : ''}`} />
              </button>
              {stlOpen && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                        <th className="px-3 py-2 text-left">Lead</th>
                        <th className="px-3 py-2 text-left">Setter</th>
                        <th className="px-3 py-2 text-left">Entered Pipeline</th>
                        <th className="px-3 py-2 text-left">Called At</th>
                        <th className="px-3 py-2 text-right">Talk Time</th>
                        <th className="px-3 py-2 text-right">Response Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stl.allLeads.slice(0, 50).map((l, i) => {
                        const tzOpts = { timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
                        const setterName = l.setterId ? (setters.find(s => s.wavv_user_id === l.setterId)?.name || '—') : '—'
                        const closerName = l.bookingCloserId ? (closers.find(c => c.id === l.bookingCloserId || c.ghl_user_id === l.bookingCloserId)?.name || null) : null
                        return (
                          <tr key={i} className={`border-b border-border-default/30 ${l.uncalled ? 'bg-danger/5' : ''} ${l.hasBooking ? 'bg-cyan-500/5' : ''}`}>
                            <td className="px-3 py-1.5">
                              <span className="font-medium text-text-primary">{l.name}</span>
                              {l.isAutoBooking && (
                                <span className="ml-2 text-[9px] font-medium px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400">
                                  AUTO BOOKED{l.bookingDate ? ` · ${l.bookingDate}` : ''}{closerName ? ` · ${closerName}` : ''}
                                </span>
                              )}
                              {l.isStrategyBooking && (
                                <span className="ml-2 text-[9px] font-medium px-1.5 py-0.5 rounded bg-success/15 text-success">
                                  SET CALL{l.bookingDate ? ` · ${l.bookingDate}` : ''}{closerName ? ` · ${closerName}` : ''}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-opt-yellow">{setterName}</td>
                            <td className="px-3 py-1.5 text-text-400">{new Date(l.created).toLocaleString('en-US', tzOpts)}</td>
                            <td className="px-3 py-1.5 text-text-400">{l.calledAt ? new Date(l.calledAt).toLocaleString('en-US', tzOpts) : <span className="text-danger text-[10px] font-medium px-1.5 py-0.5 rounded bg-danger/10">NOT CALLED</span>}</td>
                            <td className={`px-3 py-1.5 text-right ${l.talkTime > 60 ? 'text-success' : l.talkTime > 0 ? 'text-text-400' : 'text-text-400'}`}>
                              {l.talkTime > 0 ? <><span className="font-medium">{l.talkTimeDisplay}</span>{l.callCount > 1 && <span className="text-[9px] text-text-400 ml-1">({l.callCount})</span>}</> : '—'}
                            </td>
                            <td className={`px-3 py-1.5 text-right font-medium ${l.uncalled ? 'text-danger' : l.responseSecs < 300 ? 'text-success' : l.responseSecs < 3600 ? 'text-opt-yellow' : 'text-danger'}`}>
                              {l.responseDisplay}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="bg-bg-card border border-border-default rounded-2xl p-6 text-center mb-6">
          {loadingPipeline || !stlCalls ? (
            <><Loader className="animate-spin text-opt-yellow mx-auto mb-2 h-4 w-4" /><span className="text-xs text-text-400">Loading speed to lead data...</span></>
          ) : !hasWavv ? (
            <span className="text-xs text-text-400">No WAVV call data yet — publish your Zapier zap to start tracking speed to lead</span>
          ) : (
            <span className="text-xs text-text-400">No GHL opportunities with matching phone numbers found</span>
          )}
        </div>
      )}

      {/* GHL Pipeline Performance */}
      <h2 className="text-sm font-medium text-text-secondary mb-3">GHL Pipeline Performance</h2>
      {loadingPipeline ? (
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center mb-6">
          <Loader className="animate-spin text-opt-yellow mx-auto mb-2" />
          <span className="text-xs text-text-400">Loading pipelines... {pipelineProgress}</span>
        </div>
      ) : pipelineData.length > 0 ? (
        <div className="space-y-4 mb-6">
          {pipelineData.map(pipe => {
            const s = pipe.summary
            const hasZapier = hasWavv
            const tw = hasZapier ? wavvAgg.totals : (s.totalWavv || { dials: 0, pickups: 0, mcs: 0 })
            const rateColor = (v, good, ok) => v === '—' ? 'text-text-400' : parseFloat(v) >= good ? 'text-success' : parseFloat(v) >= ok ? 'text-opt-yellow' : 'text-danger'
            const fmtRate = (num, den) => den > 0 ? ((num / den) * 100).toFixed(1) : '—'
            return (
              <div key={pipe.id} className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
                <div className="px-3 sm:px-4 py-3 border-b border-border-default flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-0">
                  <h3 className="text-sm font-bold text-text-primary">{pipe.name}</h3>
                  <div className="flex flex-wrap gap-2 sm:gap-4 text-[10px] sm:text-xs text-text-400">
                    <span>{s.total.toLocaleString()} leads</span>
                    <span>{tw.dials.toLocaleString()} dials</span>
                    <span>{tw.pickups} pickups</span>
                    <span>{tw.mcs} MCs</span>
                    <span className="text-cyan-400 font-medium">{totalSets} sets</span>
                    {hasZapier && <span className="text-success text-[10px]">WAVV LIVE</span>}
                    {!hasZapier && tw.dials > 0 && <span className="text-text-400 text-[10px]">GHL TAGS</span>}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                        <th className="px-3 py-2 text-left">Stage</th>
                        <th className="px-3 py-2 text-right">Count</th>
                        <th className="px-3 py-2 text-right">Dials</th>
                        <th className="px-3 py-2 text-right">Pickups</th>
                        <th className="px-3 py-2 text-right">MCs</th>
                        <th className="px-3 py-2 text-right">Pickup %</th>
                        <th className="px-3 py-2 text-right">Lead→Set %</th>
                        <th className="px-3 py-2 text-right">Call→Set %</th>
                        <th className="px-3 py-2 text-right">Pickup→Set %</th>
                        <th className="px-3 py-2 text-right">MC→Set %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.stageFlow.map(stage => {
                        const w = stage.wavv || { dials: 0, pickups: 0, mcs: 0 }
                        const pickupPct = fmtRate(w.pickups, w.dials)
                        // Set conversion rates use totalSets from setter_leads, not WAVV duration
                        const leadToSet = fmtRate(totalSets, stage.count)
                        const callToSet = '—'
                        const pickupToSet = '—'
                        const mcToSet = '—'
                        return (
                          <tr key={stage.id} className="border-b border-border-default/30 hover:bg-bg-card-hover/50">
                            <td className="px-3 py-2 font-medium text-text-primary">{stage.name}</td>
                            <td className="px-3 py-2 text-right font-medium text-text-primary">{stage.count}</td>
                            <td className="px-3 py-2 text-right text-text-400">{w.dials.toLocaleString()}</td>
                            <td className="px-3 py-2 text-right text-text-400">{w.pickups}</td>
                            <td className="px-3 py-2 text-right text-text-400">{w.mcs}</td>
                            <td className={`px-3 py-2 text-right font-medium ${rateColor(pickupPct, 20, 10)}`}>{pickupPct !== '—' ? `${pickupPct}%` : '—'}</td>
                            <td className={`px-3 py-2 text-right font-medium ${rateColor(leadToSet, 5, 2)}`}>{leadToSet !== '—' ? `${leadToSet}%` : '—'}</td>
                            <td className={`px-3 py-2 text-right font-medium ${rateColor(callToSet, 3, 1)}`}>{callToSet !== '—' ? `${callToSet}%` : '—'}</td>
                            <td className={`px-3 py-2 text-right font-medium ${rateColor(pickupToSet, 10, 5)}`}>{pickupToSet !== '—' ? `${pickupToSet}%` : '—'}</td>
                            <td className={`px-3 py-2 text-right font-medium ${rateColor(mcToSet, 30, 15)}`}>{mcToSet !== '—' ? `${mcToSet}%` : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border-default bg-bg-card-hover/30 font-medium">
                        <td className="px-3 py-2">Total</td>
                        <td className="px-3 py-2 text-right">{s.total.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">{tw.dials.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">{tw.pickups}</td>
                        <td className="px-3 py-2 text-right">{tw.mcs}</td>
                        <td className={`px-3 py-2 text-right ${rateColor(fmtRate(tw.pickups, tw.dials), 20, 10)}`}>{tw.dials > 0 ? `${fmtRate(tw.pickups, tw.dials)}%` : '—'}</td>
                        <td className={`px-3 py-2 text-right ${rateColor(fmtRate(totalSets, s.total), 5, 2)}`}>{s.total > 0 ? `${fmtRate(totalSets, s.total)}%` : '—'}</td>
                        <td className={`px-3 py-2 text-right ${rateColor(fmtRate(totalSets, tw.dials), 3, 1)}`}>{tw.dials > 0 ? `${fmtRate(totalSets, tw.dials)}%` : '—'}</td>
                        <td className={`px-3 py-2 text-right ${rateColor(fmtRate(totalSets, tw.pickups), 10, 5)}`}>{tw.pickups > 0 ? `${fmtRate(totalSets, tw.pickups)}%` : '—'}</td>
                        <td className={`px-3 py-2 text-right ${rateColor(fmtRate(totalSets, tw.mcs), 30, 15)}`}>{tw.mcs > 0 ? `${fmtRate(totalSets, tw.mcs)}%` : '—'}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center text-text-400 mb-6">
          No GHL pipeline data available
        </div>
      )}

      {/* Per-Setter Cards */}
      <h2 className="text-sm font-medium text-text-secondary mb-3">Individual Performance</h2>
      {setterCards.length === 0 ? (
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center text-text-400">
          No setters found. Add team members in Supabase.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {setterCards.map(s => (
            <Link
              key={s.id}
              to={`/sales/setters/${s.id}`}
              className="bg-bg-card border border-border-default rounded-2xl p-3 sm:p-5 hover:bg-bg-card-hover transition-colors block"
            >
              <div className="flex items-center justify-between mb-3 sm:mb-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-base sm:text-lg font-bold">{s.name}</h3>
                  {s.dataSource === 'wavv' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success">WAVV</span>}
                </div>
                <div className="flex gap-2 sm:gap-3 text-[10px] sm:text-xs text-text-400">
                  <span>{s.totalSets} sets</span>
                  <span className="text-success">{s.closed} closed</span>
                  <span className="text-danger">{s.noShows} NS</span>
                </div>
              </div>

              {/* Gauges */}
              <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-3 sm:mb-4">
                <Gauge label="Show Rate" value={s.showRate} target={70} />
                <Gauge label="Close Rate" value={s.closeRate} target={25} />
                <Gauge label="Pickup %" value={s.pickupRate} target={30} />
              </div>

              {/* Bottom stats */}
              <div className="flex flex-wrap gap-4 text-xs">
                <span className="text-text-400">Dials: <strong className="text-text-primary">{s.dials}</strong></span>
                <span className="text-text-400">MCs: <strong className="text-text-primary">{s.mcs}</strong></span>
                <span className="text-text-400">Dials/Set: <strong className="text-text-primary">{s.dialsPerSet}</strong></span>
                <span className="text-text-400">Avg Dur: <strong className="text-text-primary">{s.avgDuration < 60 ? `${s.avgDuration}s` : `${Math.round(s.avgDuration / 60)}m`}</strong></span>
                <span className="text-text-400">Calls/Contact: <strong className="text-text-primary">{s.avgCallsPerContact}x</strong></span>
                <span className="text-text-400">Revenue: <strong className="text-success">${s.revenue.toLocaleString()}</strong></span>
                <span className="text-text-400">Auto Books: <strong className="text-cyan-400">{s.autoBookingCount}</strong> <span className="text-[10px]">({s.autoBookingPct}%)</span></span>
              </div>

              {/* Pipeline source tags */}
              {s.topPipelines.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-border-default/30">
                  {s.topPipelines.map(p => (
                    <span key={p.source} className="text-[10px] px-2 py-0.5 rounded bg-bg-card-hover text-text-400 capitalize">
                      {p.source}: <strong className="text-text-primary">{p.count}</strong>
                    </span>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}

      {/* Setter Stats Table */}
      <h2 className="text-sm font-medium text-text-secondary mb-3">Setter Conversion Table</h2>
      <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                <th className="px-3 py-2 text-left">Setter</th>
                <th className="px-3 py-2 text-right">Dials</th>
                <th className="px-3 py-2 text-right">Pickups</th>
                <th className="px-3 py-2 text-right">MCs</th>
                <th className="px-3 py-2 text-right">Sets</th>
                <th className="px-3 py-2 text-right">Pickup %</th>
                <th className="px-3 py-2 text-right">Lead→Set %</th>
                <th className="px-3 py-2 text-right">Call→Set %</th>
                <th className="px-3 py-2 text-right">Pickup→Set %</th>
                <th className="px-3 py-2 text-right">MC→Set %</th>
                <th className="px-3 py-2 text-right">Auto Books</th>
                <th className="px-3 py-2 text-right">Auto %</th>
                <th className="px-3 py-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {setterCards.map(s => {
                const pickupPct = s.dials > 0 ? ((s.pickups / s.dials) * 100).toFixed(1) : '—'
                const leadToSet = s.leads > 0 ? ((s.totalSets / s.leads) * 100).toFixed(1) : '—'
                const callToSet = s.dials > 0 ? ((s.totalSets / s.dials) * 100).toFixed(1) : '—'
                const pickupToSet = s.pickups > 0 ? ((s.totalSets / s.pickups) * 100).toFixed(1) : '—'
                const mcToSet = s.mcs > 0 ? ((s.totalSets / s.mcs) * 100).toFixed(1) : '—'

                return (
                  <tr key={s.id} className="border-b border-border-default/30 hover:bg-bg-card-hover/50">
                    <td className="px-3 py-2 font-medium">
                      <Link to={`/sales/setters/${s.id}`} className="text-opt-yellow hover:underline">{s.name}</Link>
                    </td>
                    <td className="px-3 py-2 text-right text-text-400">{s.dials.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-text-400">{s.pickups.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-text-400">{s.mcs}</td>
                    <td className="px-3 py-2 text-right font-medium text-text-primary">{s.totalSets}</td>
                    <td className={`px-3 py-2 text-right font-medium ${pickupPct !== '—' && parseFloat(pickupPct) >= 20 ? 'text-success' : pickupPct !== '—' && parseFloat(pickupPct) >= 10 ? 'text-opt-yellow' : 'text-danger'}`}>{pickupPct !== '—' ? `${pickupPct}%` : '—'}</td>
                    <td className={`px-3 py-2 text-right font-medium ${leadToSet !== '—' && parseFloat(leadToSet) >= 5 ? 'text-success' : leadToSet !== '—' && parseFloat(leadToSet) >= 2 ? 'text-opt-yellow' : 'text-danger'}`}>{leadToSet !== '—' ? `${leadToSet}%` : '—'}</td>
                    <td className={`px-3 py-2 text-right font-medium ${callToSet !== '—' && parseFloat(callToSet) >= 3 ? 'text-success' : callToSet !== '—' && parseFloat(callToSet) >= 1 ? 'text-opt-yellow' : 'text-danger'}`}>{callToSet !== '—' ? `${callToSet}%` : '—'}</td>
                    <td className={`px-3 py-2 text-right font-medium ${pickupToSet !== '—' && parseFloat(pickupToSet) >= 10 ? 'text-success' : pickupToSet !== '—' && parseFloat(pickupToSet) >= 5 ? 'text-opt-yellow' : 'text-danger'}`}>{pickupToSet !== '—' ? `${pickupToSet}%` : '—'}</td>
                    <td className={`px-3 py-2 text-right font-medium ${mcToSet !== '—' && parseFloat(mcToSet) >= 30 ? 'text-success' : mcToSet !== '—' && parseFloat(mcToSet) >= 15 ? 'text-opt-yellow' : 'text-danger'}`}>{mcToSet !== '—' ? `${mcToSet}%` : '—'}</td>
                    <td className="px-3 py-2 text-right text-cyan-400 font-medium">{s.autoBookingCount}</td>
                    <td className="px-3 py-2 text-right text-text-400">{s.autoBookingPct > 0 ? `${s.autoBookingPct}%` : '—'}</td>
                    <td className="px-3 py-2 text-right text-success font-medium">${s.revenue.toLocaleString()}</td>
                  </tr>
                )
              })}
              {/* Totals row */}
              {setterCards.length > 0 && (() => {
                const totDials = setterCards.reduce((s, c) => s + c.dials, 0)
                const totPickups = setterCards.reduce((s, c) => s + c.pickups, 0)
                const totMcs = setterCards.reduce((s, c) => s + c.mcs, 0)
                const totLeads = setterCards.reduce((s, c) => s + c.leads, 0)
                const totSets = setterCards.reduce((s, c) => s + c.totalSets, 0)
                const totRev = setterCards.reduce((s, c) => s + c.revenue, 0)
                const tPickup = totDials > 0 ? ((totPickups / totDials) * 100).toFixed(1) : '—'
                const tLeadSet = totLeads > 0 ? ((totSets / totLeads) * 100).toFixed(1) : '—'
                const tCallSet = totDials > 0 ? ((totSets / totDials) * 100).toFixed(1) : '—'
                const tPickSet = totPickups > 0 ? ((totSets / totPickups) * 100).toFixed(1) : '—'
                const tMcSet = totMcs > 0 ? ((totSets / totMcs) * 100).toFixed(1) : '—'
                return (
                  <tr className="border-t border-border-default bg-bg-card-hover/30 font-medium">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2 text-right">{totDials.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">{totPickups.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">{totMcs}</td>
                    <td className="px-3 py-2 text-right text-text-primary">{totSets}</td>
                    <td className="px-3 py-2 text-right">{tPickup !== '—' ? `${tPickup}%` : '—'}</td>
                    <td className="px-3 py-2 text-right">{tLeadSet !== '—' ? `${tLeadSet}%` : '—'}</td>
                    <td className="px-3 py-2 text-right">{tCallSet !== '—' ? `${tCallSet}%` : '—'}</td>
                    <td className="px-3 py-2 text-right">{tPickSet !== '—' ? `${tPickSet}%` : '—'}</td>
                    <td className="px-3 py-2 text-right">{tMcSet !== '—' ? `${tMcSet}%` : '—'}</td>
                    <td className="px-3 py-2 text-right text-cyan-400">{totalAutoBookings}</td>
                    <td className="px-3 py-2 text-right text-text-400">{unassignedAuto > 0 ? `${unassignedAuto} unassigned` : '100%'}</td>
                    <td className="px-3 py-2 text-right text-success">${totRev.toLocaleString()}</td>
                  </tr>
                )
              })()}
              {setterCards.length === 0 && (
                <tr><td colSpan={13} className="px-3 py-8 text-center text-text-400">No setter data</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Leads — live from GHL pipeline */}
      {(() => {
        const ghlLeads = pipelineData
          .flatMap(p => (p.summary.opportunities || []).map(o => {
            const stageMap = {}
            ;(p.stages || []).forEach(s => { stageMap[s.id] = s.name })
            return { ...o, stageName: stageMap[o.pipelineStageId] || 'Unknown', pipelineName: p.name }
          }))
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

        const timeAgo = (iso) => {
          if (!iso) return '—'
          const secs = (Date.now() - new Date(iso).getTime()) / 1000
          if (secs < 60) return 'just now'
          if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
          if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
          return `${Math.floor(secs / 86400)}d ago`
        }

        const stageColor = (name) => {
          const n = name.replace(/[🔵🟡🟢🔴🟣🟠]/g, '').trim().toLowerCase()
          if (/closed|ascend|won/.test(n)) return 'bg-success/15 text-success'
          if (/no.show/.test(n)) return 'bg-danger/15 text-danger'
          if (/set.call|proposal|24.hour/.test(n)) return 'bg-cyan-400/15 text-cyan-400'
          if (/triage|auto.booked/.test(n)) return 'bg-purple-400/15 text-purple-400'
          if (/contact/.test(n)) return 'bg-opt-yellow/15 text-opt-yellow'
          if (/follow.up|nurture/.test(n)) return 'bg-orange-400/15 text-orange-400'
          if (/not.interested|unqualified|dead|not.responsive/.test(n)) return 'bg-text-400/15 text-text-400'
          if (/new.lead/.test(n)) return 'bg-blue-400/15 text-blue-400'
          return 'bg-text-400/15 text-text-400'
        }

        return (
          <>
            <h2 className="text-sm font-medium text-text-secondary mb-3">
              Recent Leads — Live from GHL ({ghlLeads.length})
              {loadingPipeline && <span className="text-[10px] text-text-400 ml-2">loading... {pipelineProgress}</span>}
            </h2>
            <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                      <th className="px-3 py-2 text-left">Lead</th>
                      <th className="px-3 py-2 text-left">Company</th>
                      <th className="px-3 py-2 text-left">Source</th>
                      <th className="px-3 py-2 text-left">Stage</th>
                      <th className="px-3 py-2 text-left">Pipeline</th>
                      <th className="px-3 py-2 text-left">Created</th>
                      <th className="px-3 py-2 text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ghlLeads.slice(0, showAllLeads ? 50 : 10).map(opp => (
                      <tr key={opp.id} className="border-b border-border-default/30 hover:bg-bg-card-hover/50">
                        <td className="px-3 py-1.5 font-medium">{opp.contact?.name || opp.name || '—'}</td>
                        <td className="px-3 py-1.5 text-text-400 truncate max-w-[140px]">{opp.contact?.companyName || '—'}</td>
                        <td className="px-3 py-1.5 text-text-400">{opp.source || '—'}</td>
                        <td className="px-3 py-1.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${stageColor(opp.stageName)}`}>
                            {opp.stageName.replace(/[🔵🟡🟢🔴🟣🟠]/g, '').trim()}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-text-400 text-[10px]">{opp.pipelineName}</td>
                        <td className="px-3 py-1.5 text-text-400" title={opp.createdAt}>{timeAgo(opp.createdAt)}</td>
                        <td className="px-3 py-1.5 text-right">
                          {(opp.monetaryValue || 0) > 0 ? (
                            <span className="text-success">${opp.monetaryValue.toLocaleString()}</span>
                          ) : '—'}
                        </td>
                      </tr>
                    ))}
                    {ghlLeads.length === 0 && !loadingPipeline && (
                      <tr><td colSpan={7} className="px-3 py-8 text-center text-text-400">No leads found</td></tr>
                    )}
                    {loadingPipeline && ghlLeads.length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-8 text-center text-text-400">
                        <Loader size={14} className="animate-spin inline mr-2" />Loading pipeline data...
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {ghlLeads.length > 10 && (
                <button
                  onClick={() => setShowAllLeads(v => !v)}
                  className="w-full py-3 text-xs font-medium text-opt-yellow hover:bg-bg-card-hover transition-colors flex items-center justify-center gap-1.5 border-t border-border-default"
                >
                  {showAllLeads ? <><ChevronUp size={14} /> Show less</> : <><ChevronDown size={14} /> Show all {Math.min(ghlLeads.length, 50)} leads</>}
                </button>
              )}
            </div>
          </>
        )
      })()}
    </div>
  )
}
