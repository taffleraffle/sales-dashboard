import { Link, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useSetterEODs } from '../hooks/useSetterData'
import { supabase } from '../lib/supabase'
import { sinceDate, rangeToDays } from '../lib/dateUtils'
import { syncGHLAppointments } from '../services/ghlCalendar'
import { fetchWavvAggregates } from '../services/wavvService'
import { Plus } from 'lucide-react'
import { computeShowRate } from '../utils/metricCalculations'
import { INTRO_CALENDARS } from '../utils/constants'
import { checkEndangeredLeads } from '../services/engagementCheck'
import EndangeredLeadsTable from '../components/EndangeredLeadsTable'

export default function SetterOverview() {
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const { members: setters, loading: loadingMembers } = useTeamMembers('setter')
  const { reports, loading: loadingReports } = useSetterEODs(null, days)
  const [allLeads, setAllLeads] = useState([])
  const [loadingLeads, setLoadingLeads] = useState(true)
  const [wavvAgg, setWavvAgg] = useState({ totals: { dials: 0, pickups: 0, mcs: 0 }, byUser: {}, uniqueContacts: 0 })
  const [autoBookings, setAutoBookings] = useState([])
  const [showAllRecent, setShowAllRecent] = useState(false)
  const [endangeredLeads, setEndangeredLeads] = useState([])
  const [loadingEndangered, setLoadingEndangered] = useState(false)
  const [dateStats, setDateStats] = useState({})

  // Fetch auto-booking appointments (INTRO_CALENDARS only) — auto-sync if stale
  useEffect(() => {
    async function fetchAppointments() {
      const { data } = await supabase
        .from('ghl_appointments')
        .select('ghl_event_id, closer_id, ghl_user_id, ghl_contact_id, calendar_name, appointment_status, created_at')
        .gte('booked_at', `${sinceDate(range)} 00:00:00`)
        .neq('appointment_status', 'cancelled')
      setAutoBookings((data || []).filter(a => INTRO_CALENDARS.includes(a.calendar_name)))

      const newest = (data || []).reduce((latest, r) => {
        const t = new Date(r.created_at || 0).getTime()
        return t > latest ? t : latest
      }, 0)
      const isStale = !data?.length || (Date.now() - newest) > 60 * 60 * 1000
      if (isStale) {
        const today = new Date().toISOString().split('T')[0]
        syncGHLAppointments(sinceDate(range), today)
          .then(async () => {
            const { data: fresh } = await supabase
              .from('ghl_appointments')
              .select('ghl_event_id, closer_id, ghl_user_id, ghl_contact_id, calendar_name, appointment_status, created_at')
              .gte('booked_at', `${sinceDate(range)} 00:00:00`)
              .neq('appointment_status', 'cancelled')
            setAutoBookings((fresh || []).filter(a => INTRO_CALENDARS.includes(a.calendar_name)))
          })
          .catch(err => console.warn('Auto GHL sync failed:', err.message))
      }
    }
    fetchAppointments()
  }, [range])

  // Fetch WAVV aggregates (fast — only 3 columns, no pagination needed)
  useEffect(() => {
    fetchWavvAggregates(days).then(setWavvAgg).catch(() => {})
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
        .limit(500)
      setAllLeads(data || [])
      setLoadingLeads(false)
    }
    fetchLeads()
  }, [range])

  // Fetch closer EOD aggregates for show rate calculation
  useEffect(() => {
    supabase
      .from('closer_eod_reports')
      .select('report_date, nc_booked, nc_no_shows, live_nc_calls, fu_booked, fu_no_shows, live_fu_calls')
      .gte('report_date', sinceDate(range))
      .then(({ data }) => {
        const stats = {}
        for (const e of (data || [])) {
          if (!stats[e.report_date]) stats[e.report_date] = { booked: 0, noShows: 0, live: 0 }
          stats[e.report_date].booked += (e.nc_booked || 0) + (e.fu_booked || 0)
          stats[e.report_date].noShows += (e.nc_no_shows || 0) + (e.fu_no_shows || 0)
          stats[e.report_date].live += (e.live_nc_calls || 0) + (e.live_fu_calls || 0)
        }
        setDateStats(stats)
      })
  }, [range])

  // Fetch recent WAVV calls and check endangered leads (live from GHL)
  useEffect(() => {
    // Defer the endangered-leads fetch to AFTER first paint. checkEndangeredLeads
    // chains Supabase → GHL API and is non-critical (sits at bottom of page).
    // Running it inline blocks the main render by ~400ms on slow networks.
    const timer = setTimeout(() => {
      setLoadingEndangered(true)
      const since = new Date()
      since.setDate(since.getDate() - 7)
      supabase
        .from('wavv_calls')
        .select('phone_number, call_duration')
        .gte('started_at', since.toISOString())
        .then(({ data }) => {
          checkEndangeredLeads(data || [])
            .then(setEndangeredLeads)
            .finally(() => setLoadingEndangered(false))
        })
    }, 400)
    return () => clearTimeout(timer)
  }, [])

  if (loadingMembers || loadingLeads || loadingReports) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 bg-bg-card rounded-xl" />
          <div className="h-8 w-40 bg-bg-card rounded-xl" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          {[1,2,3,4,5,6,7,8].map(i => <div key={i} className="tile tile-feedback h-24" />)}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1,2,3,4].map(i => <div key={i} className="tile tile-feedback h-32" />)}
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
  const { showRate: showRateVal } = computeShowRate(allLeads, dateStats)
  const showRate = showRateVal
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
  // lead_source can be 'auto' (new records) or a raw calendar ID (legacy records)
  const isAutoLead = l => l.lead_source === 'auto' || INTRO_CALENDARS.includes(l.lead_source)
  const autoLeads = allLeads.filter(isAutoLead)
  const manualLeads = allLeads.filter(l => !isAutoLead(l))
  const showStatuses = ['showed', 'closed', 'not_closed']
  const autoShowResult = computeShowRate(autoLeads, dateStats)
  const manualShowResult = computeShowRate(manualLeads, dateStats)
  const booking = {
    autoTotal: autoLeads.length,
    autoShows: autoLeads.filter(l => showStatuses.includes(l.status)).length,
    autoNoShows: autoLeads.filter(l => l.status === 'no_show').length,
    autoCloses: autoLeads.filter(l => l.status === 'closed').length,
    autoShowRate: autoShowResult.showRate,
    autoCloseRate: autoLeads.filter(l => showStatuses.includes(l.status)).length > 0 ? parseFloat(((autoLeads.filter(l => l.status === 'closed').length / autoLeads.filter(l => showStatuses.includes(l.status)).length) * 100).toFixed(1)) : 0,
    manualTotal: manualLeads.length,
    manualShows: manualLeads.filter(l => showStatuses.includes(l.status)).length,
    manualNoShows: manualLeads.filter(l => l.status === 'no_show').length,
    manualCloses: manualLeads.filter(l => l.status === 'closed').length,
    manualShowRate: manualShowResult.showRate,
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
    const myShowResult = computeShowRate(myLeads, dateStats)
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
      showRate: myShowResult.showRate,
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

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Setter Performance</h1>
        <div className="flex items-center gap-3">
          <Link to="/sales/eod/submit?tab=setter" className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-opt-yellow text-bg-primary text-xs font-semibold hover:brightness-110 transition-colors">
            <Plus size={14} />
            New EOD
          </Link>
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto">

      {/* Company-Level KPIs - two rows */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 sm:gap-3 mb-6">
        <KPICard label="Total Dials" value={companyActivity.dials.toLocaleString()} />
        <KPICard label="Pickups" value={companyActivity.pickups.toLocaleString()} subtitle={`${pickupRate}% pickup`} />
        <KPICard label="Leads Worked" value={companyActivity.leads.toLocaleString()} />
        <KPICard label="MCs" value={companyActivity.mcs} />
        <KPICard label="Sets" value={totalSets} subtitle={totalSets > 0 ? `${dialsPerSet} dials/set` : ''} />
        <KPICard label="Shows" value={showedLeads.length} subtitle={`${showRate}% show rate`} />
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

      {/* Blanket Conversion Rates — 6 gauges including Leads/Close (moved from isolated full-width tile) */}
      <h2 className="text-sm font-medium text-text-secondary mb-4">Conversion Rates</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 sm:gap-3 mb-6">
        <Gauge label="Lead → Set" value={companyRates.leadToSet} target={5} max={50} />
        <Gauge label="Lead → Close" value={companyRates.leadToClose} target={2} max={20} />
        <Gauge label="Call → Set" value={companyRates.callToSet} target={3} max={20} />
        <Gauge label="Pickup → Set" value={companyRates.pickupToSet} target={10} max={50} />
        <Gauge label="MC → Set" value={companyRates.mcToSet} target={30} max={100} />
        {leadsPerClose > 0 && <Gauge label="Leads / Close" value={leadsPerClose} target={10} max={50} />}
      </div>

      {/* Auto vs Manual Booking Breakdown */}
      {(booking.autoTotal > 0 || booking.manualTotal > 0) && (
        <>
          <h2 className="text-sm font-medium text-text-secondary mb-3">Auto Booking vs Manual Sets</h2>
          <div className="tile tile-feedback overflow-hidden mb-6">
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

      {/* Pipeline-specific metrics — moved to /sales/pipeline */}
      <div className="mb-6 tile tile-feedback px-4 py-3 flex items-center justify-between gap-3 text-xs">
        <span className="text-text-secondary">
          Looking for Speed to Lead, GHL Pipeline Performance, or the live leads table?
        </span>
        <Link to="/sales/pipeline" className="text-opt-yellow font-medium hover:underline whitespace-nowrap">
          Open Pipeline Performance →
        </Link>
      </div>

      {/* Per-Setter Cards */}
      <h2 className="text-sm font-medium text-text-secondary mb-4">Individual Performance</h2>
      {setterCards.length === 0 ? (
        <div className="tile tile-feedback p-8 text-center text-text-400">
          No setters found. Add team members in Supabase.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {setterCards.map(s => (
            <Link
              key={s.id}
              to={`/sales/setters/${s.id}`}
              className="tile tile-feedback p-3 sm:p-5 hover:bg-bg-card-hover transition-colors block"
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

      {/* Setter Conversion — leaderboard cards (matches Closer Performance style) */}
      <h2 className="text-sm font-medium text-text-secondary mb-4">Setter Conversion</h2>
      {setterCards.length === 0 ? (
        <div className="tile tile-feedback p-8 text-center text-text-400 mb-6">No setter data</div>
      ) : (
        <div className="space-y-2 mb-6">
          {setterCards.map(s => (
            <SetterLeaderboardRow
              key={s.id}
              setter={s}
              onClick={() => navigate(`/sales/setters/${s.id}`)}
            />
          ))}
          {/* Team total */}
          {(() => {
            const totDials = setterCards.reduce((a, c) => a + c.dials, 0)
            const totPickups = setterCards.reduce((a, c) => a + c.pickups, 0)
            const totMcs = setterCards.reduce((a, c) => a + c.mcs, 0)
            const totSets = setterCards.reduce((a, c) => a + c.totalSets, 0)
            const totRev = setterCards.reduce((a, c) => a + c.revenue, 0)
            const tPickup = totDials > 0 ? ((totPickups / totDials) * 100).toFixed(1) : 0
            const tMcSet = totMcs > 0 ? ((totSets / totMcs) * 100).toFixed(1) : 0
            const tCallSet = totDials > 0 ? ((totSets / totDials) * 100).toFixed(1) : 0
            return (
              <div className="tile border-t-2 border-opt-yellow/30 px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
                <div className="flex items-center gap-3 min-w-0 sm:min-w-[180px]">
                  <div className="w-9 h-9 rounded-full bg-opt-yellow/20 border border-opt-yellow/40 flex items-center justify-center">
                    <span className="text-[11px] font-bold text-opt-yellow">∑</span>
                  </div>
                  <span className="text-sm font-semibold text-text-primary">Team Total</span>
                </div>
                <div className="flex items-baseline gap-4 sm:gap-6">
                  <SetterStatBlock label="Sets" value={totSets} />
                  <SetterStatBlock label="Dials" value={totDials.toLocaleString()} accent="muted" />
                  <SetterStatBlock label="Revenue" value={`$${totRev.toLocaleString()}`} accent="success" />
                </div>
                <div className="flex flex-wrap gap-2 sm:ml-auto">
                  <SetterPill label="Show" value={`${showRate}%`} good={parseFloat(showRate) >= 70} ok={parseFloat(showRate) >= 50} />
                  <SetterPill label="Pickup" value={`${tPickup}%`} good={parseFloat(tPickup) >= 20} ok={parseFloat(tPickup) >= 10} />
                  <SetterPill label="Call→Set" value={`${tCallSet}%`} good={parseFloat(tCallSet) >= 3} ok={parseFloat(tCallSet) >= 1} />
                  <SetterPill label="MC→Set" value={`${tMcSet}%`} good={parseFloat(tMcSet) >= 30} ok={parseFloat(tMcSet) >= 15} />
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* Recent Leads (from setter_leads) + Upcoming Strategy Calls — side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-6">
        <div>
          <h2 className="text-sm font-medium text-text-secondary mb-4">
            Recent Leads Set ({allLeads.length})
          </h2>
          <div className="tile tile-feedback overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                    <th className="px-3 py-2 text-left">Lead</th>
                    <th className="px-3 py-2 text-left">Setter</th>
                    <th className="px-3 py-2 text-left">Source</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {allLeads.slice(0, showAllRecent ? 50 : 10).map(l => {
                    const setterName = setters.find(s => s.id === l.setter_id)?.name || '—'
                    const statusStyle = (status) => {
                      if (status === 'closed') return 'bg-success/15 text-success'
                      if (status === 'showed' || status === 'not_closed') return 'bg-cyan-400/15 text-cyan-400'
                      if (status === 'no_show') return 'bg-danger/15 text-danger'
                      if (status === 'rescheduled') return 'bg-orange-400/15 text-orange-400'
                      return 'bg-text-400/15 text-text-400'
                    }
                    const isAuto = l.lead_source === 'auto' || INTRO_CALENDARS.includes(l.lead_source)
                    const sourceLabel = isAuto ? 'auto' : (l.lead_source || 'manual')
                    return (
                      <tr key={l.id} className="border-b border-border-default/30 hover:bg-bg-card-hover/50">
                        <td className="px-3 py-1.5 font-medium text-text-primary truncate max-w-[160px]">{l.lead_name || '—'}</td>
                        <td className="px-3 py-1.5 text-opt-yellow">{setterName}</td>
                        <td className="px-3 py-1.5 text-text-400 capitalize truncate max-w-[100px]" title={l.lead_source || ''}>{sourceLabel}</td>
                        <td className="px-3 py-1.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${statusStyle(l.status)}`}>
                            {(l.status || 'pending').replace('_', ' ')}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {parseFloat(l.revenue_attributed || 0) > 0 ? (
                            <span className="text-success">${parseFloat(l.revenue_attributed).toLocaleString()}</span>
                          ) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                  {allLeads.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-8 text-center text-text-400">No leads in this range</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {allLeads.length > 10 && (
              <button
                onClick={() => setShowAllRecent(v => !v)}
                className="w-full py-3 text-xs font-medium text-opt-yellow hover:bg-bg-card-hover transition-colors flex items-center justify-center gap-1.5 border-t border-border-default"
              >
                {showAllRecent ? 'Show less' : `Show all ${Math.min(allLeads.length, 50)} leads`}
              </button>
            )}
          </div>
        </div>

        {/* Endangered Leads — upcoming appointments with no engagement */}
        <div>
          <EndangeredLeadsTable leads={endangeredLeads} loading={loadingEndangered} />
        </div>
      </div>

      </div> {/* end max-w-[1600px] mx-auto */}
    </div>
  )
}

function setterInitials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function SetterPill({ label, value, good, ok }) {
  const color = good ? 'bg-success/15 text-success border-success/30'
    : ok ? 'bg-opt-yellow/15 text-opt-yellow border-opt-yellow/30'
    : 'bg-danger/15 text-danger border-danger/30'
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium ${color}`}>
      <span className="text-text-400 font-normal">{label}</span>
      <span>{value}</span>
    </span>
  )
}

function SetterStatBlock({ label, value, accent }) {
  const color = accent === 'success' ? 'text-success'
    : accent === 'opt-yellow' ? 'text-opt-yellow'
    : accent === 'muted' ? 'text-text-secondary'
    : 'text-text-primary'
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-text-400">{label}</span>
      <span className={`text-base sm:text-lg font-bold leading-tight ${color} tabular-nums`}>{value}</span>
    </div>
  )
}

function SetterLeaderboardRow({ setter, onClick }) {
  const s = setter
  const pickupPct = s.dials > 0 ? ((s.pickups / s.dials) * 100).toFixed(1) : 0
  const callToSet = s.dials > 0 ? ((s.totalSets / s.dials) * 100).toFixed(1) : 0
  const mcToSet = s.mcs > 0 ? ((s.totalSets / s.mcs) * 100).toFixed(1) : 0

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className="tile tile-hover px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5"
    >
      {/* Name + initials */}
      <div className="flex items-center gap-3 min-w-0 sm:min-w-[180px]">
        <div className="w-9 h-9 rounded-full bg-opt-yellow/15 border border-opt-yellow/30 flex items-center justify-center shrink-0 text-[11px] font-bold text-opt-yellow">
          {setterInitials(s.name)}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary truncate">{s.name}</div>
          {s.dataSource === 'wavv' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-success/15 text-success">WAVV</span>
          )}
        </div>
      </div>

      {/* Primary stats */}
      <div className="flex items-baseline gap-4 sm:gap-6">
        <SetterStatBlock label="Sets" value={s.totalSets} />
        <SetterStatBlock label="Dials" value={s.dials.toLocaleString()} accent="muted" />
        <SetterStatBlock label="Revenue" value={`$${s.revenue.toLocaleString()}`} accent="success" />
      </div>

      {/* Rate pills */}
      <div className="flex flex-wrap gap-2 sm:ml-auto">
        <SetterPill label="Show" value={`${s.showRate}%`} good={s.showRate >= 70} ok={s.showRate >= 50} />
        <SetterPill label="Pickup" value={`${pickupPct}%`} good={parseFloat(pickupPct) >= 20} ok={parseFloat(pickupPct) >= 10} />
        <SetterPill label="Call→Set" value={`${callToSet}%`} good={parseFloat(callToSet) >= 3} ok={parseFloat(callToSet) >= 1} />
        <SetterPill label="MC→Set" value={`${mcToSet}%`} good={parseFloat(mcToSet) >= 30} ok={parseFloat(mcToSet) >= 15} />
        {s.autoBookingCount > 0 && (
          <SetterPill label="Auto" value={s.autoBookingCount} good={true} ok={true} />
        )}
      </div>
    </div>
  )
}
