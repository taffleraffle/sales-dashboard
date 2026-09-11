import { Link, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import LeaderTable, { Card, Person } from '../components/house/LeaderTable'
import SetterDrilldown from '../components/house/SetterDrilldown'
import MetricDrilldown from '../components/house/MetricDrilldown'
import { useBenchmarks } from '../hooks/useBenchmarks'
import { useSalesMetrics } from '../hooks/useSalesMetrics'
import { setterLeadInRegion, useRegion } from '../lib/region'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useSetterEODs } from '../hooks/useSetterData'
import { supabase } from '../lib/supabase'
import { sinceDate, rangeToDays } from '../lib/dateUtils'
import { syncGHLAppointments } from '../services/ghlCalendar'
import { fetchWavvAggregates } from '../services/wavvService'
import { Plus } from 'lucide-react'
import { INTRO_CALENDARS } from '../utils/constants'

export default function SetterOverview() {
  const { bm } = useBenchmarks()
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  // Company show rate = live new calls over qualified bookings, the one number every page uses
  const sm = useSalesMetrics(range)
  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  // Former setters stay on the board while they still have numbers in the window
  const { members: setters, loading: loadingMembers } = useTeamMembers('setter', { includeFormer: true })
  const { reports, loading: loadingReports } = useSetterEODs(null, days)
  const [allLeadsRaw, setAllLeads] = useState([])
  const region = useRegion()
  // Setter-logged leads follow the top-bar region (source, UTMs, +61 phone)
  const allLeads = allLeadsRaw.filter(l => setterLeadInRegion(l, region))
  const [drill, setDrill] = useState(null) // 'dials' | 'pickups' | 'mcs' | 'sets'
  const [mdrill, setMdrill] = useState(null) // 'show' | 'close' (shared Overview pop-ups)
  // Confirmed vs unconfirmed show rate from the shared hook (same source as the Overview, follows the region)
  const conf = { cShow: sm.totals.confShowed, cNo: sm.totals.confNoShow, uShow: sm.totals.unconfShowed, uNo: sm.totals.unconfNoShow }
  const confShowRate = sm.r.confShowRate
  const unconfShowRate = sm.r.unconfShowRate
  const [loadingLeads, setLoadingLeads] = useState(true)
  const [wavvAgg, setWavvAgg] = useState({ totals: { dials: 0, pickups: 0, mcs: 0 }, byUser: {}, uniqueContacts: 0 })
  const [autoBookings, setAutoBookings] = useState([])

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
    fetchWavvAggregates(days, region).then(setWavvAgg).catch(() => {})
  }, [range, region])

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


  if (loadingMembers || loadingLeads || loadingReports) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 bg-bg-card rounded-sm" />
          <div className="h-8 w-40 bg-bg-card rounded-sm" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
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
  const showRate = sm.r.showRate
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
  const setterCards = setters.filter(s => s.status !== 'former' || allLeads.some(l => l.setter_id === s.id)).map(setter => {
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
      totalSets: myLeads.length,   // logged leads only: same number as the Overview and Marketing
      leadsPerSet: (eodSets || myLeads.length) > 0 ? parseFloat((eod.leads / (eodSets || myLeads.length)).toFixed(1)) : 0,
      callsPerSet: (eodSets || myLeads.length) > 0 ? parseFloat((dials / (eodSets || myLeads.length)).toFixed(1)) : 0,
      pickupsPerSet: (eodSets || myLeads.length) > 0 ? parseFloat((pickups / (eodSets || myLeads.length)).toFixed(1)) : 0,
      // Pipeline
      showed: myShowed.length,
      closed: myClosed.length,
      noShows: myNoShow.length,
      revenue: myRevenue,
      showRate: (myShowed.length + myNoShow.length) > 0 ? parseFloat(((myShowed.length / (myShowed.length + myNoShow.length)) * 100).toFixed(1)) : 0,
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
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Setters</span>
          <h1 className="h2 mt-2">The <em>setter</em> floor.</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/sales/eod/submit?tab=setter" className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-opt-yellow text-text-primary text-xs font-semibold hover:brightness-110 transition-colors">
            <Plus size={14} />
            New EOD
          </Link>
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      <div>

      {/* Company-Level KPIs - two rows */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 sm:gap-3 mb-6">
        <KPICard label="Total dials" value={companyActivity.dials.toLocaleString()} onClick={() => setDrill('dials')} />
        <KPICard label="Pickups" value={companyActivity.pickups.toLocaleString()} subtitle={`${pickupRate}% pickup`} onClick={() => setDrill('pickups')} />
        <KPICard label="Leads worked" value={companyActivity.leads.toLocaleString()} subtitle="unique numbers dialled" onClick={() => setDrill('dials')} />
        <KPICard label="Meaningful conversations" value={companyActivity.mcs} subtitle="60 seconds or more" onClick={() => setDrill('mcs')} />
        <KPICard label="Sets" value={totalSets} subtitle={totalSets > 0 ? `${dialsPerSet} dials per set` : ''} onClick={() => setDrill('sets')} />
        <KPICard label="Shows" value={sm.totals.lives} subtitle={`${showRate}% show rate · live new calls`} onClick={() => setMdrill('show')} />
        <KPICard label="Revenue" value={`$${Math.round(sm.r.revenue || 0).toLocaleString()}`} subtitle="trial + ascension, same as the Overview" onClick={() => setMdrill('close')} />
      </div>

      {/* Company conversion gauges */}
      <div className="kpi-grid mb-6">
        <Gauge label="Pickup Rate" value={parseFloat(pickupRate)} target={30} />
        <Gauge label="Show Rate" value={parseFloat(showRate)} target={bm('show_rate_new', 70)} hint="Live new calls over qualified bookings, the same number as the Overview and Closers pages. Per-setter rows below use the leads each setter logged." />
        {/* Close rate here is SCOPED to setter-booked leads only (subset of
            closer universe). The company close rate on /sales/closers and
            /sales/marketing measures all live new-calls, not just
            setter-booked. Labelling explicitly so the difference doesn't
            read as a bug. */}
        <div title="Of the leads setters booked that showed (showed + not_closed + closed), what % closed. This is a SUBSET of company close rate — setter-booked leads typically convert higher than the full lead universe seen on /sales/closers and /sales/marketing.">
          <Gauge label="Close · Setter-booked" value={parseFloat(closeRate)} target={bm('close_rate', 25)} />
        </div>
        <Gauge label="Confirmed show rate" value={confShowRate} target={bm('show_rate_new', 50)} hint={`${conf.cShow} showed of ${conf.cShow + conf.cNo} confirmed calls`} />
        <Gauge label="Unconfirmed show rate" value={unconfShowRate} target={bm('show_rate_new', 50)} hint={`${conf.uShow} showed of ${conf.uShow + conf.uNo} unconfirmed calls`} />
      </div>

      <h2 className="eyebrow" style={{ marginBottom: 14, display: 'block' }}>Conversion</h2>
      <div className="kpi-grid mb-6">
        <Gauge label="Lead → Set" value={companyRates.leadToSet} target={5} max={50} hint="Sets over leads worked" />
        <Gauge label="MC → Set" value={companyRates.mcToSet} target={30} max={100} hint="Sets over meaningful conversations" />
        <Gauge label="Lead → Close" value={companyRates.leadToClose} target={2} max={20} hint="Closes over leads worked" />
      </div>

      {/* One table per setter: replaces the card grid + conversion rows that
          showed the same setterCards twice (DUPLICATE-METRICS doc, item 4). */}
      {(() => {
        const rows = [...setterCards].sort((a, b) => b.totalSets - a.totalSets)
        const tot = rows.reduce((a, c) => ({ dials: a.dials + c.dials, pickups: a.pickups + c.pickups, mcs: a.mcs + c.mcs, totalSets: a.totalSets + c.totalSets, autoBookingCount: a.autoBookingCount + (c.autoBookingCount || 0), revenue: a.revenue + c.revenue }), { dials: 0, pickups: 0, mcs: 0, totalSets: 0, autoBookingCount: 0, revenue: 0 })
        return (
          <Card title="Setters" count={rows.length}>
            <LeaderTable
              rows={rows}
              onRowClick={(r) => navigate(`/sales/setters/${r.id}`)}
              empty="No setters found. Add people on the Team page."
              footer={{ name: 'Team', ...tot, pickupRate: tot.dials ? parseFloat(((tot.pickups / tot.dials) * 100).toFixed(1)) : 0, showRate: parseFloat(showRate) || 0, closeRate: parseFloat(closeRate) || 0 }}
              columns={[
                { key: 'name', label: 'Setter', render: (r, f) => f ? <span style={{ fontWeight: 700 }}>Team</span> : <Person name={r.name} rank={r._rank} sub={r.dataSource === 'eod' ? 'EOD only, no WAVV link' : undefined} /> },
                { key: 'dials', label: 'Dials', align: 'right', strong: true, render: r => (r.dials || 0).toLocaleString() },
                { key: 'pickups', label: 'Pickups', align: 'right', render: r => (r.pickups || 0).toLocaleString() },
                { key: 'pickupRate', label: 'Pickup', align: 'right', render: r => `${r.pickupRate ?? 0}%`, tone: r => toneOf(r.pickupRate, 20) },
                { key: 'mcs', label: 'MCs', align: 'right' },
                { key: 'totalSets', label: 'Sets', align: 'right', strong: true },
                { key: 'autoBookingCount', label: 'Auto', align: 'right' },
                { key: 'showRate', label: 'Show', align: 'right', render: r => `${r.showRate ?? 0}%`, tone: r => toneOf(r.showRate, bm('show_rate_new', 70)) },
                { key: 'closeRate', label: 'Close · booked', align: 'right', render: r => `${r.closeRate ?? 0}%`, tone: r => toneOf(r.closeRate, bm('close_rate', 25)) },
                { key: 'revenue', label: 'Revenue', align: 'right', strong: true, render: r => `$${Math.round(r.revenue || 0).toLocaleString()}` },
              ]}
            />
          </Card>
        )
      })()}

      <MetricDrilldown kind={mdrill} onClose={() => setMdrill(null)} metrics={sm} closers={[]} />
      <SetterDrilldown kind={drill} onClose={() => setDrill(null)} range={range} leads={allLeads} setters={setters} windowLabel={typeof range === 'number' ? `Last ${range} days` : range === 'mtd' ? 'Month to date' : 'Custom range'} />


      </div>
    </div>
  )
}

function toneOf(value, target) {
  const v = parseFloat(value)
  if (!Number.isFinite(v)) return null
  return v >= target ? 'good' : v >= target * 0.8 ? 'warn' : 'bad'
}
