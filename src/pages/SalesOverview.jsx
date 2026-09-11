import { useState, useEffect, useRef, useMemo } from 'react'
import { todayET, rangeToDays } from '../lib/dateUtils'
import KPICard from '../components/KPICard'
import DateRangeSelector from '../components/DateRangeSelector'
import LeadStatusBadge from '../components/LeadStatusBadge'
import LeaderTable, { Card, Person } from '../components/house/LeaderTable'
import Modal from '../components/editorial/Modal'
import MetricDrilldown from '../components/house/MetricDrilldown'
import { Loader, Clock, Check, AlertTriangle, Trophy, X } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { fetchWavvAggregates } from '../services/wavvService'
import { buildSetterSchedules } from '../services/ghlPipeline'
import { fetchSpeedToLeadFromDb } from '../services/speedToLeadDb'
import { useSalesMetrics, rates, EMPTY_TOTALS } from '../hooks/useSalesMetrics'
import { useLeadAttribution } from '../hooks/useLeadAttribution'
import { useBenchmarks } from '../hooks/useBenchmarks'
import { supabase } from '../lib/supabase'
import { useRegion } from '../lib/region'
import { checkEndangeredLeads } from '../services/engagementCheck'

/*
  Sales Overview (rebuilt 2026-09-06, Ben's list).

  The page answers one question per row, in the house tile grid:
    1. The money       ad spend, front-end cash ROAS, CAC, revenue per lead,
                       revenue per booked call
    2. Cost + conversion   cost per lead / booked call / live call, show rate,
                       close rate
    3. Speed to lead   average, this week, inside operating hours, outside
    4. Boards          closer leaderboard, setter leaderboard
    5. Lists           upcoming strategy calls, recent leads

  Sources are unchanged from the previous version: ad spend and leads from
  marketing_tracker, bookings from the calendar matview (same ET window as
  the Marketing page), lives / closes / cash from closer EODs with the
  prospect-level close rate, dials from WAVV, speed to lead from GHL
  opportunities matched to WAVV calls.
*/

/* ── Confetti Canvas ── */
function Confetti({ active }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight

    const colors = ['#d4f50c', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#ef4444', '#f97316', '#06b6d4', '#ffffff']
    const pieces = []
    for (let i = 0; i < 150; i++) {
      pieces.push({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * canvas.height * 0.5,
        w: 4 + Math.random() * 8,
        h: 6 + Math.random() * 12,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 4,
        vy: 2 + Math.random() * 4,
        spin: (Math.random() - 0.5) * 0.2,
        angle: Math.random() * Math.PI * 2,
        opacity: 1,
      })
    }

    let frame
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      let alive = false
      for (const p of pieces) {
        p.x += p.vx
        p.y += p.vy
        p.vy += 0.08
        p.vx *= 0.99
        p.angle += p.spin
        if (p.y > canvas.height + 50) {
          p.opacity -= 0.02
        }
        if (p.opacity <= 0) continue
        alive = true
        ctx.save()
        ctx.globalAlpha = p.opacity
        ctx.translate(p.x, p.y)
        ctx.rotate(p.angle)
        ctx.fillStyle = p.color
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
        ctx.restore()
      }
      if (alive) frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [active])

  if (!active) return null
  return <canvas ref={canvasRef} className="fixed inset-0 z-[200] pointer-events-none" />
}

/* ── Close Celebration Banner ── */
function CloseCelebration({ closes, onDismiss }) {
  const [visible, setVisible] = useState(false)
  const [showConfetti, setShowConfetti] = useState(false)

  useEffect(() => {
    if (!closes?.length) return
    // Stagger: confetti first, then banner slides in
    setShowConfetti(true)
    const t1 = setTimeout(() => setVisible(true), 300)
    const t2 = setTimeout(() => setShowConfetti(false), 4000)
    const t3 = setTimeout(() => { setVisible(false); setTimeout(onDismiss, 500) }, 8000)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [closes, onDismiss])

  if (!closes?.length) return null

  const totalCash = closes.reduce((s, c) => s + (c.cash_collected || 0), 0)
  const totalRevenue = closes.reduce((s, c) => s + (c.revenue || 0), 0)

  return (
    <>
      <Confetti active={showConfetti} />
      <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[190] transition-all duration-700 ease-out ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-8'}`}>
        <div className="bg-bg-card border-2 border-success/40 rounded-sm shadow-[0_0_40px_rgba(34,197,94,0.2)] px-6 py-4 max-w-lg">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-full bg-success/20 flex items-center justify-center shrink-0">
              <Trophy size={20} className="text-success" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-success">
                {closes.length === 1 ? 'New Close Today!' : `${closes.length} Closes Today!`}
              </h3>
              <p className="text-[10px] text-text-400">
                {totalCash > 0 && `$${totalCash.toLocaleString()} cash collected`}
                {totalCash > 0 && totalRevenue > 0 && ' · '}
                {totalRevenue > 0 && `$${totalRevenue.toLocaleString()} revenue`}
              </p>
            </div>
            <button onClick={() => { setVisible(false); setTimeout(onDismiss, 500) }} className="ml-auto text-text-400 hover:text-text-primary">
              <X size={14} />
            </button>
          </div>
          <div className="space-y-1.5">
            {closes.map((c, i) => (
              <div
                key={i}
                className="flex items-center justify-between bg-bg-primary rounded-sm px-3 py-2 transition-all duration-500"
                style={{ animationDelay: `${i * 200 + 500}ms`, animation: 'slideInRight 0.5s ease-out forwards', opacity: 0, transform: 'translateX(20px)' }}
              >
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-success/15 flex items-center justify-center">
                    <Check size={12} className="text-success" />
                  </div>
                  <span className="text-sm font-medium">{c.prospect_name}</span>
                </div>
                <div className="text-right">
                  {c.cash_collected > 0 && <span className="text-xs font-semibold text-text-primary">${c.cash_collected.toLocaleString()}</span>}
                  {c.revenue > 0 && <span className="text-[10px] text-text-400 ml-1.5">(${c.revenue.toLocaleString()})</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes slideInRight {
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </>
  )
}

/* ── Rate Gauge (semi-circle, editorial) ──
   Track is the editorial hairline rule. Fill is ink for primary signal,
   accent yellow when at-or-above target. Single-accent rule, no stoplight. */
export default function SalesOverview() {
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const [wavvAgg, setWavvAgg] = useState(null)
  const [wavvLoading, setWavvLoading] = useState(true)
  const [stl, setStl] = useState(null)
  const [stlLoading, setStlLoading] = useState(true)
  const [stlError, setStlError] = useState(null)

  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const m = useSalesMetrics(range)
  const region = useRegion()
  const { members: closers, loading: loadingClosers } = useTeamMembers('closer')
  const { members: setters, loading: loadingSetters } = useTeamMembers('setter')
  const { bm } = useBenchmarks()
  const { leads: recentLeads } = useLeadAttribution(days)

  const [endangeredLeads, setEndangeredLeads] = useState([])
  const [loadingEndangered, setLoadingEndangered] = useState(false)
  const [showRevenueBreakdown, setShowRevenueBreakdown] = useState(false)
  const [drill, setDrill] = useState(null) // 'leads' | 'booked' | 'live' | 'show' | 'close' | 'conversion' | 'cac'
  // Share of marked calls that were confirmed before the call vs not (lib_call_confirmation_by_closer)
  const confSplit = useMemo(() => {
    const t = m.totals
    const conf = t.confCalls, unconf = t.unconfCalls, total = conf + unconf
    if (!total) return null
    const confPct = parseFloat(((conf / total) * 100).toFixed(1))
    return { conf, unconf, total, confPct, unconfPct: parseFloat((100 - confPct).toFixed(1)) }
  }, [m.totals])
  const [revenueDeals, setRevenueDeals] = useState(null)

  // ── Pending EOD: check who hasn't submitted today ──
  const [pendingEOD, setPendingEOD] = useState({ closers: [], setters: [] })

  useEffect(() => {
    async function checkPending() {
      const today = todayET()
      const [closerEods, setterEods] = await Promise.all([
        supabase.from('closer_eod_reports').select('closer_id').eq('report_date', today).eq('is_confirmed', true),
        supabase.from('setter_eod_reports').select('setter_id').eq('report_date', today).eq('is_confirmed', true),
      ])
      const submittedCloserIds = new Set((closerEods.data || []).map(r => r.closer_id))
      const submittedSetterIds = new Set((setterEods.data || []).map(r => r.setter_id))
      setPendingEOD({
        closers: closers.filter(c => !submittedCloserIds.has(c.id)),
        setters: setters.filter(s => !submittedSetterIds.has(s.id)),
      })
    }
    if (closers.length || setters.length) checkPending()
  }, [closers, setters])

  // ── Celebration: check for today's closes ──
  const [todayCloses, setTodayCloses] = useState(null)
  const [showCelebration, setShowCelebration] = useState(false)

  useEffect(() => {
    // Only show once per session
    if (sessionStorage.getItem('celebration_shown')) return
    async function checkTodayCloses() {
      const today = todayET()
      // Get today's closer EOD report IDs
      const { data: todayEods } = await supabase
        .from('closer_eod_reports')
        .select('id')
        .eq('report_date', today)
      if (!todayEods?.length) return

      // Get closed calls from today's reports
      const { data: closedCalls } = await supabase
        .from('closer_calls')
        .select('prospect_name, revenue, cash_collected, outcome')
        .in('eod_report_id', todayEods.map(e => e.id))
        .eq('outcome', 'closed')

      if (closedCalls?.length) {
        setTodayCloses(closedCalls)
        setShowCelebration(true)
        sessionStorage.setItem('celebration_shown', '1')
      }
    }
    checkTodayCloses()
  }, [])

  // The Revenue tile counts every EOD in the window, confirmed or not, because
  // that is what the matview behind it does. m.calls deliberately holds only
  // CONFIRMED reports, so building this list from it hid every deal whose EOD
  // had not been ticked off yet and left the headline unexplainable: the tile
  // said $27,097 while the list it opened showed $8,100. Read the window
  // directly instead, and mark the rows still awaiting an EOD so the reason is
  // visible rather than silent.
  const openRevenueBreakdown = async () => {
    setShowRevenueBreakdown(true)
    setRevenueDeals(null)
    if (!m.window) { setRevenueDeals([]); return }
    const { data: reps } = await supabase
      .from('closer_eod_reports')
      .select('id, report_date, is_confirmed')
      .gte('report_date', m.window.startStr)
      .lte('report_date', m.window.endStr)
    if (!reps?.length) { setRevenueDeals([]); return }
    const meta = Object.fromEntries(reps.map(r => [r.id, r]))
    const { data: rows } = await supabase
      .from('closer_calls')
      .select('eod_report_id, prospect_name, call_type, outcome, revenue, cash_collected')
      .in('eod_report_id', reps.map(r => r.id))
      .in('outcome', ['closed', 'ascended'])
    setRevenueDeals(
      (rows || [])
        .map(c => ({
          date: meta[c.eod_report_id]?.report_date,
          prospect_name: (c.prospect_name || '—').split(' - ')[0],
          call_type: c.call_type,
          revenue: c.revenue,
          cash_collected: c.cash_collected,
          pending: !meta[c.eod_report_id]?.is_confirmed,
        }))
        .sort((x, y) => (y.date || '').localeCompare(x.date || ''))
    )
  }


  // Fetch WAVV calls and check endangered leads (live from GHL)
  useEffect(() => {
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
  }, [])

  // WAVV aggregates
  useEffect(() => {
    setWavvLoading(true)
    fetchWavvAggregates(days, region).then(data => { setWavvAgg(data); setWavvLoading(false) })
  }, [days, region])

  // Speed to Lead (selected range, with per-setter working-hour filter)
  const stlSchedules = buildSetterSchedules(setters)
  const scheduleKey = JSON.stringify(stlSchedules)
  useEffect(() => {
    let alive = true
    setStlLoading(true); setStlError(null)
    fetchSpeedToLeadFromDb(range, stlSchedules)
      .then(res => { if (alive) { setStl(res); setStlLoading(false) } })
      .catch(err => { console.warn('speed to lead failed:', err); if (alive) { setStl(null); setStlError(err?.message || 'failed'); setStlLoading(false) } })
    return () => { alive = false }
  }, [range, scheduleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Everything below reads the unified layer (useSalesMetrics) ──
  const T = m.totals
  const R = m.r
  const mkt = { adspend: T.adspend, leads: T.leads }
  const calBooked = m.loading ? null : T.qualifiedBookings
  const ct = { liveCalls: T.lives, liveNC: T.lives, ncBooked: T.qualifiedBookings, cash: T.trialCash, ascendCash: T.ascendCash, revenue: T.trialRevenue, ascendRevenue: T.ascendRevenue, closes: T.closes }
  const totalRevenue = R.revenue
  const totalCash = R.cash
  const showRate = R.showRate
  const closeRate = R.closeRate
  const cpl = R.cpl ?? 0
  const cpbc = R.costPerBooked ?? 0
  const feRoas = R.feRoas ?? 0

  // WAVV totals
  const wt = wavvAgg?.totals || { dials: 0, pickups: 0, mcs: 0 }

  // Per-closer leaderboard: same call rows as the company totals
  const closerBoard = closers.map(c => {
    const t = m.byCloser[c.id] || { ...EMPTY_TOTALS }
    const r = rates(t)
    return { id: c.id, name: c.name, liveNC: t.lives, closes: t.closes, booked: t.qualifiedBookings, offers: t.offers, revenue: r.revenue, cash: t.trialCash, ascendCash: t.ascendCash, totalCash: r.cash,
      showPct: r.showRate.toFixed(1), closePct: r.closeRate.toFixed(1), offerPct: r.offerRate.toFixed(1) }
  }).sort((a, b) => b.totalCash - a.totalCash)

  // Per-setter leaderboard: dials from WAVV, sets = leads they logged
  const setterBoard = setters.map(s => {
    const w = wavvAgg?.byUser?.[s.wavv_user_id] || { dials: 0, pickups: 0, mcs: 0, uniqueContacts: 0, avgDuration: 0 }
    const sets = recentLeads.filter(l => l.setter_id === s.id).length
    return { id: s.id, name: s.name, dials: w.dials, pickups: w.pickups, mcs: w.mcs,
      contacts: w.uniqueContacts, avgDur: w.avgDuration, sets,
      pickupPct: w.dials ? ((w.pickups / w.dials) * 100).toFixed(1) : '0.0',
      mcPct: w.dials ? ((w.mcs / w.dials) * 100).toFixed(1) : '0.0',
    }
  }).sort((a, b) => b.dials - a.dials)

  const isLoading = m.loading || wavvLoading
  const dataReady = !m.loading && !wavvLoading && !loadingClosers && !loadingSetters

  // ── Speed to lead splits (this week / in hours / out of hours) ──
  const stlSplit = splitSpeedToLead(stl, stlSchedules)
  const closes = T.closes
  const cac = R.cac
  const costPerLive = R.costPerLive
  const revPerLead = R.revPerLead
  const revPerBooked = R.revPerBooked
  const money = (n) => n == null ? '—' : `$${Math.round(n).toLocaleString()}`
  const money2 = (n) => n == null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`

  const upcoming = [...(endangeredLeads || [])]
    .sort((a, b) => (a.hoursUntil ?? 1e9) - (b.hoursUntil ?? 1e9))
  const tierCounts = upcoming.reduce((a, l) => { a[l.tier] = (a[l.tier] || 0) + 1; return a }, {})

  return (
    <div className="space-y-7">
      {showCelebration && (
        <CloseCelebration closes={todayCloses} onDismiss={() => setShowCelebration(false)} />
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Overview</span>
          <h1 className="h2 mt-2">Where you <em>stand</em>.</h1>
        </div>
        <div className="flex items-center gap-3">
          {isLoading && <Loader size={14} className="animate-spin" style={{ color: 'var(--ink-3)' }} />}
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* Pending EOD */}
      {(pendingEOD.closers.length > 0 || pendingEOD.setters.length > 0) && (
        <div className="tile px-5 py-3 flex flex-wrap items-center gap-3" style={{ borderColor: 'rgba(244,225,74,.6)', background: 'rgba(244,225,74,.08)', boxShadow: 'none' }}>
          <div className="flex items-center gap-2" style={{ fontSize: 13.5, fontWeight: 600 }}>
            <Clock size={14} /> EOD still due today
          </div>
          {[...pendingEOD.closers.map(c => ({ ...c, kind: 'closer' })), ...pendingEOD.setters.map(s => ({ ...s, kind: 'setter' }))].map(p => (
            <Link key={p.id} to={`/sales/eod/submit?tab=${p.kind}&member=${p.id}`} className="pill" style={{ background: '#fff' }}>
              {p.name} <span style={{ color: 'var(--ink-4)', fontWeight: 500 }}>{p.kind}</span>
            </Link>
          ))}
        </div>
      )}

      {/* Skeleton */}
      {!dataReady && (
        <div className="space-y-7 animate-pulse">
          <div className="kpi-grid">{Array.from({ length: 5 }, (_, i) => <div key={i} className="tile h-28" style={{ boxShadow: 'none' }} />)}</div>
          <div className="kpi-grid">{Array.from({ length: 5 }, (_, i) => <div key={i} className="tile h-28" style={{ boxShadow: 'none' }} />)}</div>
          <div className="kpi-grid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="tile h-28" style={{ boxShadow: 'none' }} />)}</div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5"><div className="tile h-64" style={{ boxShadow: 'none' }} /><div className="tile h-64" style={{ boxShadow: 'none' }} /></div>
        </div>
      )}

      {m.error && <div className="callout"><b>Some numbers could not be loaded.</b> {m.error}</div>}

      {dataReady && <>
        {/* ── 1. Headline: the six numbers Ben runs the floor on, one row ── */}
        <section>
          <SectionLabel>Headline</SectionLabel>
          <div className="kpi-grid kpi-grid-6">
            <KPICard label="Cost per lead" value={mkt.leads > 0 && mkt.adspend > 0 ? money(cpl) : '—'} subtitle={mkt.leads > 0 ? `${mkt.leads} leads` : 'no leads'} target={bm('cpl')} direction="below" onClick={() => setDrill('leads')} />
            <KPICard label="Cost per booked call" value={calBooked > 0 && mkt.adspend > 0 ? money(cpbc) : '—'} subtitle={calBooked > 0 ? `${calBooked} booked` : 'no bookings'} target={bm('cpb')} direction="below" onClick={() => setDrill('booked')} />
            <KPICard label="Cost per live call" value={money(costPerLive)} subtitle={T.lives > 0 ? `${T.lives} live calls` : 'no live calls'} target={bm('cost_per_live_call')} direction="below" onClick={() => setDrill('live')} />
            <KPICard label="Show rate" value={`${showRate}%`} subtitle={`${T.lives} live of ${T.qualifiedBookings} booked`} target={bm('show_rate_new') ?? 70} direction="above" onClick={() => setDrill('show')} />
            <KPICard label="Close rate" value={`${closeRate}%`} subtitle={`${T.closes} of ${T.lives} live calls`} target={bm('close_rate') ?? 25} direction="above" onClick={() => setDrill('close')} />
            <KPICard label="CAC" value={money(cac)} subtitle={closes > 0 ? `${closes} ${closes === 1 ? 'close' : 'closes'}` : 'no closes yet'} target={bm('cpa_trial')} direction="below" onClick={() => setDrill('cac')} />
          </div>
        </section>

        {/* ── 2. Revenue ── */}
        <section>
          <SectionLabel>Revenue</SectionLabel>
          <div className="kpi-grid kpi-grid-6">
            <KPICard highlight label="Revenue" value={money2(totalRevenue)} subtitle={`${closes} ${closes === 1 ? 'close' : 'closes'} · ${money(revPerLead)} per lead · ${money(revPerBooked)} per booked call`} onClick={openRevenueBreakdown} />
            <KPICard label="Cash collected" value={money2(totalCash)} subtitle={totalRevenue > 0 ? `${Math.round((totalCash / totalRevenue) * 100)}% of revenue` : 'no revenue yet'} onClick={openRevenueBreakdown} />
            <KPICard label="Ad spend" value={money2(mkt.adspend)} subtitle={mkt.adspend > 0 ? 'tracked marketing spend' : 'no spend logged'} />
            <KPICard label="Front-end cash ROAS" value={mkt.adspend > 0 ? `${feRoas.toFixed(2)}x` : '—'} subtitle={`$${Math.round(ct.cash).toLocaleString()} trial cash`} target={bm('trial_fe_roas')} direction="above" />
            <KPICard label="Revenue rate" value={R.revenueRoas != null ? `${R.revenueRoas.toFixed(2)}x` : '—'} subtitle="revenue ÷ ad spend" target={bm('revenue_roas') ?? 5} direction="above" onClick={openRevenueBreakdown} />
            <KPICard label="Conversion rate" value={T.leads > 0 ? `${R.leadToClose}%` : '—'} subtitle={`lead → booked ${R.leadToBooked}% · booked → live ${R.bookedToLive}% · live → close ${R.closeRate}%`} target={bm('lead_to_close') ?? 1} direction="above" onClick={() => setDrill('conversion')} />
          </div>
        </section>

        {/* ── 3. Calls: did they turn up, and how fast did we dial ── */}
        <section>
          <SectionLabel>Calls</SectionLabel>
          <div className="kpi-grid">
            <KPICard label="Confirmed show rate" value={R.confShowRate != null ? `${R.confShowRate}%` : '—'} subtitle={`${T.confShowed} of ${T.confShowed + T.confNoShow} confirmed calls showed`} target={bm('show_rate_new') ?? 50} direction="above" onClick={() => setDrill('show')} />
            <KPICard label="Unconfirmed show rate" value={R.unconfShowRate != null ? `${R.unconfShowRate}%` : '—'} subtitle={`${T.unconfShowed} of ${T.unconfShowed + T.unconfNoShow} unconfirmed calls showed`} target={bm('show_rate_new') ?? 50} direction="above" onClick={() => setDrill('show')} />
            <KPICard label="Calls confirmed" value={confSplit ? `${confSplit.confPct}%` : '—'} subtitle={confSplit ? `${confSplit.unconfPct}% unconfirmed · ${confSplit.conf} of ${confSplit.total} marked calls` : 'no confirmation marks in this window'} target={bm('confirmed_share')} direction="above" onClick={() => setDrill('show')} />
            <KPICard label="Speed to lead" value={stl ? stl.avgDisplay : stlLoading ? '…' : '—'} subtitle={stlSplit ? `in hours ${fmtSecs(stlSplit.inHours)} · out of hours ${fmtSecs(stlSplit.outHours)} · this week ${fmtSecs(stlSplit.week)}` : stlLoading ? 'matching leads to dials' : stlError ? `could not load: ${stlError}` : 'no leads with a phone number'} score={stl?.avgSecs} target={300} direction="below" targetLabel="Target under 5 min" />
            <KPICard label="Dialled within 5 minutes" value={stl ? `${stl.pctUnder5m}%` : stlLoading ? '…' : '—'} subtitle={stl ? `${stl.under5m} of ${stl.worked} dialled leads · ${stl.notCalled} never dialled` : undefined} target={80} direction="above" targetLabel="Target 80%" />
          </div>
        </section>

        {/* ── 4. Boards ── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <Card title="Closer leaderboard" to="/sales/closers">
            <LeaderTable
              rows={closerBoard}
              onRowClick={(r) => navigate(`/sales/closers/${r.id}`)}
              footer={{ name: 'Team', liveNC: ct.liveNC, closes, showPct: showRate, closePct: closeRate, totalCash }}
              columns={[
                { key: 'name', label: 'Closer', render: (r, f) => f ? <span style={{ fontWeight: 700 }}>Team</span> : <Person name={r.name} rank={r._rank} /> },
                { key: 'booked', label: 'Booked', align: 'right' },
                { key: 'liveNC', label: 'Live', align: 'right' },
                { key: 'closes', label: 'Closes', align: 'right', strong: true },
                { key: 'showPct', label: 'Show', align: 'right', render: r => `${r.showPct}%`, tone: r => tone(parseFloat(r.showPct), bm('show_rate_new') ?? 70, 'above') },
                { key: 'closePct', label: 'Close', align: 'right', render: r => `${r.closePct}%`, tone: r => tone(parseFloat(r.closePct), bm('close_rate') ?? 25, 'above') },
                { key: 'totalCash', label: 'Cash', align: 'right', strong: true, render: r => `$${Math.round(r.totalCash).toLocaleString()}` },
              ]}
            />
          </Card>

          <Card title="Setter leaderboard" to="/sales/setters">
            <LeaderTable
              rows={setterBoard.map(s => {
                const member = setters.find(m => m.id === s.id)
                const arr = member?.wavv_user_id ? stl?.perSetter?.[member.wavv_user_id] : null
                return { ...s, stlSecs: arr && arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null }
              })}
              onRowClick={(r) => navigate(`/sales/setters/${r.id}`)}
              footer={{ name: 'Team', dials: wt.dials, pickups: wt.pickups, pickupPct: wt.dials ? ((wt.pickups / wt.dials) * 100).toFixed(1) : '0.0', sets: setterBoard.reduce((a, s) => a + s.sets, 0), stlSecs: stl?.avgSecs ?? null }}
              columns={[
                { key: 'name', label: 'Setter', render: (r, f) => f ? <span style={{ fontWeight: 700 }}>Team</span> : <Person name={r.name} rank={r._rank} /> },
                { key: 'dials', label: 'Dials', align: 'right', strong: true, render: r => r.dials.toLocaleString() },
                { key: 'pickups', label: 'Pickups', align: 'right', render: r => r.pickups.toLocaleString() },
                { key: 'pickupPct', label: 'Pickup', align: 'right', render: r => `${r.pickupPct}%`, tone: r => tone(parseFloat(r.pickupPct), 20, 'above') },
                { key: 'sets', label: 'Sets', align: 'right', strong: true },
                { key: 'stlSecs', label: 'Speed to lead', align: 'right', render: r => r.stlSecs != null ? fmtSecs(r.stlSecs) : '—', tone: r => r.stlSecs == null ? null : tone(r.stlSecs, 300, 'below') },
              ]}
            />
          </Card>
        </div>

        {/* ── 5. Lists ── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <Card
            title="Upcoming strategy calls"
            count={upcoming.length}
            right={
              <div className="flex gap-2 flex-wrap justify-end">
                {tierCounts.cancel_risk > 0 && <span className="pill" style={{ color: 'var(--house-bad)', borderColor: 'rgba(224,86,30,.35)' }}><AlertTriangle size={11} /> {tierCounts.cancel_risk} cancel risk</span>}
                {(tierCounts.critical || 0) + (tierCounts.warning || 0) > 0 && <span className="pill" style={{ color: 'var(--house-warn)', borderColor: 'rgba(184,134,11,.35)' }}>{(tierCounts.critical || 0) + (tierCounts.warning || 0)} no engagement</span>}
                {tierCounts.confirmed > 0 && <span className="pill" style={{ color: 'var(--house-good)', borderColor: 'rgba(22,163,74,.35)' }}><Check size={11} /> {tierCounts.confirmed} confirmed</span>}
              </div>
            }
          >
            <LeaderTable
              rows={loadingEndangered ? [] : upcoming.slice(0, 8)}
              rowKey={(r) => r.ghl_event_id || r.contact_name}
              highlightFirst={false}
              empty={loadingEndangered ? 'Checking the calendar…' : 'No strategy calls in the next 7 days.'}
              columns={[
                { key: 'contact_name', label: 'Prospect', render: r => <Person name={(r.contact_name || 'Unknown').split(' - ')[0]} sub={r.contact_phone || undefined} /> },
                { key: 'startTime', label: 'When', render: r => r.startTime ? new Date(r.startTime).toLocaleString('en-US', { timeZone: 'America/Indiana/Indianapolis', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : r.appointment_date },
                { key: 'hoursUntil', label: 'In', align: 'right', render: r => fmtHours(r.hoursUntil) },
                { key: 'tier', label: 'Status', align: 'right', render: r => <TierPill tier={r.tier} /> },
              ]}
            />
          </Card>

          <Card title="Recent leads" count={recentLeads.length} to="/sales/setters">
            <LeaderTable
              rows={recentLeads.slice(0, 8)}
              highlightFirst={false}
              empty="No leads logged in this period."
              columns={[
                { key: 'lead_name', label: 'Lead', render: r => <Person name={r.lead_name || '—'} sub={r.lead_source || undefined} /> },
                { key: 'setter_name', label: 'Setter' },
                { key: 'date_set', label: 'Set', render: r => r.date_set ? new Date(r.date_set + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—' },
                { key: 'status', label: 'Status', align: 'right', render: r => <LeadStatusBadge status={r.status} /> },
              ]}
            />
          </Card>
        </div>
      </>}

      <MetricDrilldown kind={drill} onClose={() => setDrill(null)} metrics={m} closers={closers} />

      {/* Revenue breakdown: every closed and ascended deal in the period */}
      <Modal
        open={showRevenueBreakdown}
        onClose={() => setShowRevenueBreakdown(false)}
        eyebrow="Revenue"
        title="Revenue breakdown"
        subtitle="Every closed and ascended deal in this period, from the closers' call rows"
        size="md"
      >
        <div className="kpi-grid" style={{ padding: '18px 24px 6px' }}>
          <KPICard label="Trial revenue" value={money2(ct.revenue)} />
          <KPICard label="Trial cash" value={money2(ct.cash)} />
          <KPICard label="Ascend revenue" value={money2(ct.ascendRevenue)} />
          <KPICard label="Ascend cash" value={money2(ct.ascendCash)} />
        </div>
        <div style={{ padding: '6px 0 0' }}>
          {!revenueDeals ? (
            <div className="flex items-center justify-center py-8"><Loader className="animate-spin" size={20} /></div>
          ) : (
            <LeaderTable
              rows={revenueDeals}
              rowKey={(r, i) => `${r.date}-${r.prospect_name}-${i}`}
              highlightFirst={false}
              empty="No closed deals in this period."
              footer={(() => {
                const rowRevenue = revenueDeals.reduce((t, d) => t + parseFloat(d.revenue || 0), 0)
                const rowCash = revenueDeals.reduce((t, d) => t + parseFloat(d.cash_collected || 0), 0)
                const diff = []
                if (Math.round(rowRevenue) !== Math.round(totalRevenue)) diff.push(`EOD says $${Math.round(totalRevenue).toLocaleString()} revenue`)
                if (Math.round(rowCash) !== Math.round(totalCash)) diff.push(`$${Math.round(totalCash).toLocaleString()} cash`)
                return { date: 'Total', prospect_name: diff.length ? diff.join(', ') : '', call_type: '', revenue: rowRevenue, cash_collected: rowCash }
              })()}
              columns={[
                { key: 'date', label: 'Date' },
                { key: 'prospect_name', label: 'Prospect', render: (r, f) => f ? <span style={{ fontSize: 12, color: 'var(--ink-4)', fontWeight: 500 }}>{r.prospect_name}</span> : r.prospect_name },
                { key: 'call_type', label: 'Type', render: (r, f) => f ? '' : (
                  <>
                    <span className="pill">{r.call_type === 'ascension' ? 'Ascension' : 'Trial'}</span>
                    {r.pending && <span className="pill" style={{ marginLeft: 6, background: 'var(--mid-soft)', color: 'var(--mid-ink)' }} title="Counted in the totals, but this closer has not confirmed their EOD yet">EOD pending</span>}
                  </>
                ) },
                { key: 'revenue', label: 'Revenue', align: 'right', render: r => `$${Math.round(parseFloat(r.revenue || 0)).toLocaleString()}` },
                { key: 'cash_collected', label: 'Cash', align: 'right', strong: true, render: r => `$${Math.round(parseFloat(r.cash_collected || 0)).toLocaleString()}` },
              ]}
            />
          )}
        </div>
      </Modal>
    </div>
  )
}

/* ── Page-local helpers ─────────────────────────────────────────────── */

const STL_TZ = 'America/Indiana/Indianapolis'
const DEFAULT_HOURS = { startHour: 9, endHour: 17 }

function avgOf(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null }

// this week / in hours / out of hours, from computeSpeedToLead's per-lead rows
function splitSpeedToLead(stl, schedules) {
  if (!stl?.leads?.length) return null
  const weekAgo = Date.now() - 7 * 86400000
  const week = [], inH = [], outH = []
  for (const l of stl.leads) {
    if (l.responseSecs == null) continue
    const created = new Date(l.created).getTime()
    if (created >= weekAgo) week.push(l.responseSecs)
    const sch = (l.setterId && schedules[l.setterId]) || DEFAULT_HOURS
    const h = parseInt(new Date(created).toLocaleString('en-US', { timeZone: STL_TZ, hour: 'numeric', hour12: false }), 10)
    ;(h >= sch.startHour && h < sch.endHour ? inH : outH).push(l.responseSecs)
  }
  return { week: avgOf(week), inHours: avgOf(inH), outHours: avgOf(outH), nWeek: week.length, nIn: inH.length, nOut: outH.length }
}

function fmtSecs(secs) {
  if (secs == null) return '—'
  if (secs < 60) return `${Math.round(secs)}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60)
  if (secs < 86400) return `${h}h ${m}m`
  return `${Math.floor(secs / 86400)}d ${Math.round((secs % 86400) / 3600)}h`
}

// Same thresholds as getColor: within 20% of target is 'warn'
function tone(value, target, direction = 'above') {
  if (value == null || target == null || !Number.isFinite(value)) return null
  if (direction === 'above') return value >= target ? 'good' : value >= target * 0.8 ? 'warn' : 'bad'
  return value <= target ? 'good' : value <= target * 1.2 ? 'warn' : 'bad'
}

function fmtHours(hours) {
  if (hours == null) return '—'
  if (hours < 1) return '<1h'
  if (hours < 24) return `${hours}h`
  const d = Math.floor(hours / 24), r = hours % 24
  return r > 0 ? `${d}d ${r}h` : `${d}d`
}

function SectionLabel({ children, hint }) {
  return (
    <div className="flex items-baseline justify-between gap-4 mb-3">
      <h2 className="eyebrow" style={{ margin: 0 }}>{children}</h2>
      {hint && <span style={{ fontSize: 12.5, color: 'var(--ink-4)', textAlign: 'right' }}>{hint}</span>}
    </div>
  )
}

function TierPill({ tier }) {
  const map = {
    critical:    { label: 'At risk',     color: 'var(--house-bad)',  border: 'rgba(224,86,30,.35)' },
    cancel_risk: { label: 'Cancel risk', color: 'var(--house-bad)',  border: 'rgba(224,86,30,.35)' },
    warning:     { label: 'Warning',     color: 'var(--house-warn)', border: 'rgba(184,134,11,.35)' },
    monitor:     { label: 'Monitor',     color: 'var(--ink-2)',      border: 'var(--rule)' },
    confirmed:   { label: 'Confirmed',   color: 'var(--house-good)', border: 'rgba(22,163,74,.35)' },
  }
  const t = map[tier] || map.monitor
  return <span className="pill" style={{ color: t.color, borderColor: t.border }}>{t.label}</span>
}
