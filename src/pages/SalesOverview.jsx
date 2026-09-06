import { useState, useEffect, useRef } from 'react'
import { todayET, dateRangeBoundsET, rangeToDays } from '../lib/dateUtils'
import KPICard from '../components/KPICard'
import DateRangeSelector from '../components/DateRangeSelector'
import LeadStatusBadge from '../components/LeadStatusBadge'
import { Loader, Clock, ArrowUpRight, X, Trophy, Check, AlertTriangle } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCloserEODs, useCloserCallBreakdown } from '../hooks/useCloserData'
import { useSetterEODs } from '../hooks/useSetterData'
import { useFunnelData } from '../hooks/useFunnelData'
import { fetchWavvAggregates, fetchWavvCallsForSTL } from '../services/wavvService'
import { fetchAllPipelineSummaries, computeSpeedToLead, buildSetterSchedules } from '../services/ghlPipeline'
import { useMarketingTracker, computeMarketingStats } from '../hooks/useMarketingTracker'
import { useLeadAttribution } from '../hooks/useLeadAttribution'
import { supabase } from '../lib/supabase'
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

  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const { loading: loadingFunnel } = useFunnelData(days)
  const { members: closers } = useTeamMembers('closer')
  const { members: setters } = useTeamMembers('setter')
  const { reports: closerReports } = useCloserEODs(null, days)
  const { breakdown: callBreakdown } = useCloserCallBreakdown(null, days)
  const { reports: setterReports } = useSetterEODs(null, days)
  const { entries: marketingEntries } = useMarketingTracker()
  const { leads: recentLeads } = useLeadAttribution(days)

  const [endangeredLeads, setEndangeredLeads] = useState([])
  const [loadingEndangered, setLoadingEndangered] = useState(false)
  const [showRevenueBreakdown, setShowRevenueBreakdown] = useState(false)
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

  // ── Calendar-true booked count for the acquisition-cost metrics ──
  // Cost/Booked, Cost/Q.Booked, CPBC and Lead→Set are acquisition metrics
  // (ad spend ÷ bookings), so they must divide by the SAME calendar count the
  // marketing dashboard uses — not the closer-EOD tally (ct.booked, e.g. 34,
  // which includes follow-ups) or marketing_tracker.qualified_bookings (30).
  // Same source as the marketing Q.Books tile + trend charts:
  // lib_marketing_by_audience_daily.qualified_bookings (← b.booked_at, deduped,
  // booking_excluded honoured). The operational closer metrics (show / reschedule
  // / close / leaderboard) deliberately stay on EOD — they're per-closer and
  // about calls actually handled. (Ben 2026-07-15 — align cost-per-booked across pages.)
  const [calBooked, setCalBooked] = useState(null)
  useEffect(() => {
    let cancelled = false
    async function loadCalBooked() {
      // Same ET window the Marketing page uses (dateRangeBoundsET), so the
      // Cost / Booked figure here and the Q.Books tile there agree.
      const { startStr: since, endStr: to } = dateRangeBoundsET(range)
      let { data, error } = await supabase
        .from('lib_marketing_by_audience_daily_mv')
        .select('qualified_bookings, date').gte('date', since).lte('date', to)
      if (error) {
        ({ data } = await supabase
          .from('lib_marketing_by_audience_daily')
          .select('qualified_bookings, date').gte('date', since).lte('date', to))
      }
      if (cancelled) return
      setCalBooked((data || []).reduce((n, r) => n + (Number(r.qualified_bookings) || 0), 0))
    }
    loadCalBooked()
    return () => { cancelled = true }
  }, [range])

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

  const openRevenueBreakdown = async () => {
    setShowRevenueBreakdown(true)
    if (revenueDeals) return // already loaded
    const reportIds = closerReports.map(r => r.id)
    if (!reportIds.length) { setRevenueDeals([]); return }
    const { data: calls } = await supabase
      .from('closer_calls')
      .select('prospect_name, call_type, outcome, revenue, cash_collected, eod_report_id')
      .in('eod_report_id', reportIds)
      .in('outcome', ['closed', 'ascended'])
    // Map report_id to date
    const reportDateMap = {}
    for (const r of closerReports) reportDateMap[r.id] = r.report_date
    setRevenueDeals((calls || []).map(c => ({
      ...c,
      date: reportDateMap[c.eod_report_id] || '',
    })).sort((a, b) => b.date.localeCompare(a.date)))
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
    fetchWavvAggregates(days).then(data => { setWavvAgg(data); setWavvLoading(false) })
  }, [days])

  // Speed to Lead (selected range, with per-setter working-hour filter)
  const stlSchedules = buildSetterSchedules(setters)
  useEffect(() => {
    setStlLoading(true)
    Promise.all([
      fetchAllPipelineSummaries(() => {}),
      fetchWavvCallsForSTL(days),
    ]).then(([pipelines, calls]) => {
      const opps = pipelines.flatMap(p => p.summary?.opportunities || [])
      if (opps.length > 0 && calls.length > 0) {
        setStl(computeSpeedToLead(opps, calls, [], stlSchedules))
      } else {
        setStl(null)
      }
      setStlLoading(false)
    }).catch(() => setStlLoading(false))
  }, [days])

  // Filter marketing entries by range
  const sinceStr = dateRangeBoundsET(range).startStr
  const filteredMarketing = marketingEntries.filter(e => e.date >= sinceStr)
  const mkt = computeMarketingStats(filteredMarketing)

  // Closer totals
  const ct = closerReports.reduce((a, r) => ({
    booked: a.booked + (r.nc_booked || 0) + (r.fu_booked || 0),
    ncBooked: a.ncBooked + (r.nc_booked || 0),
    liveCalls: a.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
    liveNC: a.liveNC + (r.live_nc_calls || 0),
    noShows: a.noShows + (r.nc_no_shows || 0) + (r.fu_no_shows || 0),
    ncNoShows: a.ncNoShows + (r.nc_no_shows || 0),
    offers: a.offers + (r.offers || 0),
    closes: a.closes + (r.closes || 0),
    revenue: a.revenue + parseFloat(r.total_revenue || 0),
    cash: a.cash + parseFloat(r.total_cash_collected || 0),
    ascensions: a.ascensions + (r.deposits || 0),
    ascendCash: a.ascendCash + parseFloat(r.ascend_cash || 0),
    ascendRevenue: a.ascendRevenue + parseFloat(r.ascend_revenue || 0),
    reschedules: a.reschedules + (r.reschedules || 0),
  }), { booked: 0, ncBooked: 0, liveCalls: 0, liveNC: 0, noShows: 0, ncNoShows: 0, offers: 0, closes: 0, revenue: 0, cash: 0, ascensions: 0, ascendCash: 0, ascendRevenue: 0, reschedules: 0 })

  const totalRevenue = ct.revenue + ct.ascendRevenue
  const totalCash = ct.cash + ct.ascendCash
  // Close rate is computed at the PROSPECT level: unique prospects who
  // closed / unique prospects who had a live NC or FU call. Multiple
  // follow-ups on the same prospect collapse to one — closing on a FU
  // still counts as a close. See useCloserCallBreakdown for the full
  // rationale and the audit script at scripts/close-rate-audit.mjs.
  const prospectSum = Object.values(callBreakdown || {}).reduce((a, b) => ({
    live:   a.live   + (b.liveProspects   || 0),
    closed: a.closed + (b.closedProspects || 0),
  }), { live: 0, closed: 0 })
  const showRate = ct.ncBooked ? ((ct.liveNC / ct.ncBooked) * 100).toFixed(1) : 0
  const closeRate = prospectSum.live > 0 ? ((prospectSum.closed / prospectSum.live) * 100).toFixed(1) : 0

  // Marketing derived
  const cpl = mkt.leads > 0 ? mkt.adspend / mkt.leads : 0
  // Calendar-basis cost per booked call (matches the marketing dashboard).
  // Falls back to null while calBooked is still loading so the tile shows '—'
  // rather than a stale EOD-based figure.
  const cpbc = calBooked > 0 ? mkt.adspend / calBooked : 0
  const feRoas = mkt.adspend > 0 ? ct.cash / mkt.adspend : 0

  // WAVV totals
  const wt = wavvAgg?.totals || { dials: 0, pickups: 0, mcs: 0 }

  // Per-closer leaderboard
  const closerBoard = closers.map(c => {
    const my = closerReports.filter(r => r.closer_id === c.id)
    const t = my.reduce((a, r) => ({
      booked: a.booked + (r.nc_booked || 0) + (r.fu_booked || 0),
      ncBooked: a.ncBooked + (r.nc_booked || 0),
      live: a.live + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
      liveNC: a.liveNC + (r.live_nc_calls || 0),
      offers: a.offers + (r.offers || 0),
      closes: a.closes + (r.closes || 0),
      revenue: a.revenue + parseFloat(r.total_revenue || 0),
      cash: a.cash + parseFloat(r.total_cash_collected || 0),
      ascendCash: a.ascendCash + parseFloat(r.ascend_cash || 0),
    }), { booked: 0, ncBooked: 0, live: 0, liveNC: 0, offers: 0, closes: 0, revenue: 0, cash: 0, ascendCash: 0 })
    // Close rate is prospect-level: unique closed prospects / unique live
    // prospects. Pulls from useCloserCallBreakdown so multiple FUs on the
    // same prospect dedup to one. See the audit script at
    // scripts/close-rate-audit.mjs.
    const cb = (callBreakdown || {})[c.id] || { liveProspects: 0, closedProspects: 0 }
    return { id: c.id, name: c.name, ...t, totalCash: t.cash + t.ascendCash,
      showPct: t.ncBooked ? ((t.liveNC / t.ncBooked) * 100).toFixed(1) : '0.0',
      closePct: cb.liveProspects > 0 ? ((cb.closedProspects / cb.liveProspects) * 100).toFixed(1) : '0.0',
      offerPct: t.live ? ((t.offers / t.live) * 100).toFixed(1) : '0.0',
    }
  }).sort((a, b) => b.totalCash - a.totalCash)

  // Per-setter leaderboard
  const setterBoard = setters.map(s => {
    const w = wavvAgg?.byUser?.[s.wavv_user_id] || { dials: 0, pickups: 0, mcs: 0, uniqueContacts: 0, avgDuration: 0 }
    const eodSets = setterReports.filter(r => r.setter_id === s.id).reduce((a, r) => a + (r.sets || 0), 0)
    return { id: s.id, name: s.name, dials: w.dials, pickups: w.pickups, mcs: w.mcs,
      contacts: w.uniqueContacts, avgDur: w.avgDuration, sets: eodSets,
      pickupPct: w.dials ? ((w.pickups / w.dials) * 100).toFixed(1) : '0.0',
      mcPct: w.dials ? ((w.mcs / w.dials) * 100).toFixed(1) : '0.0',
    }
  }).sort((a, b) => b.dials - a.dials)

  const isLoading = loadingFunnel || wavvLoading
  // Wait for all above-the-fold data before revealing. Previous gate flipped as
  // soon as funnel loaded, then other sections popped in one-by-one as their
  // independent hooks resolved. Now we block until the critical set is ready
  // so content appears in one coordinated paint.
  const dataReady = !loadingFunnel && !wavvLoading && closers.length > 0 && setters.length > 0

  // ── Speed to lead splits (this week / in hours / out of hours) ──
  const stlSplit = splitSpeedToLead(stl, stlSchedules)
  const closes = prospectSum.closed
  const cac = mkt.adspend > 0 && closes > 0 ? mkt.adspend / closes : null
  const costPerLive = mkt.adspend > 0 && ct.liveCalls > 0 ? mkt.adspend / ct.liveCalls : null
  const revPerLead = mkt.leads > 0 ? totalRevenue / mkt.leads : null
  const revPerBooked = calBooked > 0 ? totalRevenue / calBooked : null
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

      {dataReady && <>
        {/* ── 1. The money ── */}
        <section>
          <SectionLabel>The money</SectionLabel>
          <div className="kpi-grid">
            <KPICard highlight label="Ad spend" value={money2(mkt.adspend)} subtitle={mkt.adspend > 0 ? 'tracked marketing spend' : 'no spend logged'} />
            <KPICard label="Front-end cash ROAS" value={mkt.adspend > 0 ? `${feRoas.toFixed(2)}x` : '—'} subtitle={`$${Math.round(ct.cash).toLocaleString()} trial cash`} />
            <KPICard label="CAC" value={money(cac)} subtitle={closes > 0 ? `${closes} ${closes === 1 ? 'close' : 'closes'}` : 'no closes yet'} onClick={openRevenueBreakdown} />
            <KPICard label="Revenue per lead" value={money(revPerLead)} subtitle={mkt.leads > 0 ? `$${Math.round(totalRevenue).toLocaleString()} over ${mkt.leads} leads` : 'no leads logged'} onClick={openRevenueBreakdown} />
            <KPICard label="Revenue per booked call" value={money(revPerBooked)} subtitle={calBooked > 0 ? `${calBooked} booked` : calBooked == null ? 'loading…' : 'no bookings'} onClick={openRevenueBreakdown} />
          </div>
        </section>

        {/* ── 2. Cost and conversion ── */}
        <section>
          <SectionLabel>Cost and conversion</SectionLabel>
          <div className="kpi-grid">
            <KPICard label="Cost per lead" value={mkt.leads > 0 && mkt.adspend > 0 ? money(cpl) : '—'} subtitle={mkt.leads > 0 ? `${mkt.leads} leads` : 'no leads'} />
            <KPICard label="Cost per booked call" value={calBooked > 0 && mkt.adspend > 0 ? money(cpbc) : '—'} subtitle={calBooked > 0 ? `${calBooked} booked on the calendar` : 'no bookings'} />
            <KPICard label="Cost per live call" value={money(costPerLive)} subtitle={ct.liveCalls > 0 ? `${ct.liveCalls} live calls` : 'no live calls'} />
            <KPICard label="Show rate" value={`${showRate}%`} subtitle={`${ct.liveNC} of ${ct.ncBooked} new calls showed`} target={70} direction="above" />
            <KPICard label="Close rate" value={`${closeRate}%`} subtitle={`${prospectSum.closed} of ${prospectSum.live} live prospects`} target={25} direction="above" />
          </div>
        </section>

        {/* ── 3. Speed to lead ── */}
        <section>
          <SectionLabel hint="From a lead landing in GHL to the first WAVV dial. Operating hours are each setter's dial window from the Team page (9am to 5pm ET when none is set).">Speed to lead</SectionLabel>
          <div className="kpi-grid">
            <KPICard highlight label="Average" value={stl ? stl.avgDisplay : stlLoading ? '…' : '—'} subtitle={stl ? `${stl.pctUnder5m}% under 5 minutes · ${stl.worked} leads` : stlLoading ? 'matching leads to dials' : 'no data'} />
            <KPICard label="This week" value={stlSplit?.week != null ? fmtSecs(stlSplit.week) : '—'} subtitle={stlSplit ? `${stlSplit.nWeek} leads in the last 7 days` : '—'} />
            <KPICard label="In operating hours" value={stlSplit?.inHours != null ? fmtSecs(stlSplit.inHours) : '—'} subtitle={stlSplit ? `${stlSplit.nIn} leads` : '—'} />
            <KPICard label="Outside operating hours" value={stlSplit?.outHours != null ? fmtSecs(stlSplit.outHours) : '—'} subtitle={stlSplit ? `${stlSplit.nOut} leads` : '—'} />
          </div>
        </section>

        {/* ── 4. Boards ── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <Board title="Closer leaderboard" to="/sales/closers">
            <table>
              <thead><tr>
                <th style={{ width: 36 }}></th><th>Closer</th>
                <th className="num">Net new</th><th className="num">Closes</th><th className="num">Show</th><th className="num">Close</th><th className="num">Cash</th>
              </tr></thead>
              <tbody>
                {closerBoard.map((c, i) => (
                  <tr key={c.id} onClick={() => navigate(`/sales/closers/${c.id}`)} className={`cursor-pointer ${i === 0 ? 'bg-opt-yellow-subtle' : ''}`}>
                    <td><Rank n={i + 1} /></td>
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{c.name}</td>
                    <td className="num">{c.liveNC}</td>
                    <td className="num" style={{ fontWeight: 700 }}>{c.closes}</td>
                    <td className="num">{c.showPct}%</td>
                    <td className="num">{c.closePct}%</td>
                    <td className="num" style={{ fontWeight: 700 }}>${c.totalCash.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
              {closerBoard.length > 1 && (
                <tfoot><tr>
                  <td colSpan={2}>Team</td>
                  <td className="num">{ct.liveNC}</td><td className="num">{closes}</td>
                  <td className="num">{showRate}%</td><td className="num">{closeRate}%</td>
                  <td className="num">${totalCash.toLocaleString()}</td>
                </tr></tfoot>
              )}
            </table>
          </Board>

          <Board title="Setter leaderboard" to="/sales/setters">
            <table>
              <thead><tr>
                <th style={{ width: 36 }}></th><th>Setter</th>
                <th className="num">Dials</th><th className="num">Pickups</th><th className="num">Pickup</th><th className="num">Sets</th><th className="num">Speed to lead</th>
              </tr></thead>
              <tbody>
                {setterBoard.map((s, i) => {
                  const member = setters.find(m => m.id === s.id)
                  const arr = member?.wavv_user_id ? stl?.perSetter?.[member.wavv_user_id] : null
                  const mine = arr && arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
                  return (
                    <tr key={s.id} onClick={() => navigate(`/sales/setters/${s.id}`)} className={`cursor-pointer ${i === 0 ? 'bg-opt-yellow-subtle' : ''}`}>
                      <td><Rank n={i + 1} /></td>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{s.name}</td>
                      <td className="num" style={{ fontWeight: 700 }}>{s.dials.toLocaleString()}</td>
                      <td className="num">{s.pickups.toLocaleString()}</td>
                      <td className="num">{s.pickupPct}%</td>
                      <td className="num" style={{ fontWeight: 700 }}>{s.sets}</td>
                      <td className="num">{mine != null ? fmtSecs(mine) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
              {setterBoard.length > 1 && (
                <tfoot><tr>
                  <td colSpan={2}>Team</td>
                  <td className="num">{wt.dials.toLocaleString()}</td><td className="num">{wt.pickups.toLocaleString()}</td>
                  <td className="num">{wt.dials ? ((wt.pickups / wt.dials) * 100).toFixed(1) : 0}%</td>
                  <td className="num">{setterBoard.reduce((a, s) => a + s.sets, 0)}</td>
                  <td className="num">{stl ? stl.avgDisplay : '—'}</td>
                </tr></tfoot>
              )}
            </table>
          </Board>
        </div>

        {/* ── 5. Lists ── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <Board
            title="Upcoming strategy calls"
            right={
              <div className="flex gap-2 flex-wrap justify-end">
                {tierCounts.cancel_risk > 0 && <span className="pill" style={{ color: 'var(--house-bad)', borderColor: 'rgba(224,86,30,.35)' }}><AlertTriangle size={11} /> {tierCounts.cancel_risk} cancel risk</span>}
                {(tierCounts.critical || 0) + (tierCounts.warning || 0) > 0 && <span className="pill" style={{ color: 'var(--house-warn)', borderColor: 'rgba(184,134,11,.35)' }}>{(tierCounts.critical || 0) + (tierCounts.warning || 0)} no engagement</span>}
                {tierCounts.confirmed > 0 && <span className="pill" style={{ color: 'var(--house-good)', borderColor: 'rgba(22,163,74,.35)' }}><Check size={11} /> {tierCounts.confirmed} confirmed</span>}
              </div>
            }
          >
            {loadingEndangered ? (
              <Empty>Checking the calendar…</Empty>
            ) : upcoming.length === 0 ? (
              <Empty>No strategy calls in the next 7 days.</Empty>
            ) : (
              <table>
                <thead><tr><th>Prospect</th><th>When</th><th className="num">In</th><th>Status</th></tr></thead>
                <tbody>
                  {upcoming.slice(0, 8).map((l, i) => (
                    <tr key={l.ghl_event_id || i}>
                      <td style={{ fontWeight: 600 }}>{(l.contact_name || 'Unknown').split(' - ')[0]}</td>
                      <td style={{ color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{l.startTime ? new Date(l.startTime).toLocaleString('en-US', { timeZone: 'America/Indiana/Indianapolis', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : l.appointment_date}</td>
                      <td className="num" style={{ color: 'var(--ink-4)' }}>{fmtHours(l.hoursUntil)}</td>
                      <td><TierPill tier={l.tier} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Board>

          <Board title="Recent leads" to="/sales/setters" count={recentLeads.length}>
            {recentLeads.length === 0 ? (
              <Empty>No leads logged in this period.</Empty>
            ) : (
              <table>
                <thead><tr><th>Lead</th><th>Source</th><th>Setter</th><th>Set</th><th>Status</th></tr></thead>
                <tbody>
                  {recentLeads.slice(0, 8).map(lead => (
                    <tr key={lead.id}>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{lead.lead_name || '—'}</td>
                      <td style={{ color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{lead.lead_source || '—'}</td>
                      <td style={{ color: 'var(--ink-2)' }}>{lead.setter_name}</td>
                      <td style={{ color: 'var(--ink-4)', whiteSpace: 'nowrap' }}>{lead.date_set ? new Date(lead.date_set + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</td>
                      <td><LeadStatusBadge status={lead.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Board>
        </div>
      </>}

      {/* Revenue Breakdown Modal */}
      {showRevenueBreakdown && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(251,251,249,.55)', backdropFilter: 'blur(6px)' }} onClick={() => setShowRevenueBreakdown(false)}>
          <div className="tile tile-feedback shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-default flex items-center justify-between">
              <div>
                <h2 className="editorial-panel-title" style={{ margin: 0 }}>Revenue breakdown</h2>
                <p style={{ fontSize: 13, color: 'var(--ink-4)', margin: '2px 0 0' }}>Every closed and ascended deal in this period</p>
              </div>
              <button onClick={() => setShowRevenueBreakdown(false)} className="w-9 h-9 flex items-center justify-center" style={{ borderRadius: 999, border: '1px solid var(--house-line-strong)', background: '#fff' }}>
                <X size={16} />
              </button>
            </div>

            {/* Summary */}
            <div className="px-5 py-3 border-b border-border-default grid grid-cols-4 gap-3">
              <div>
                <p className="eyebrow">Trial Revenue</p>
                <p className="text-sm font-bold">${ct.revenue.toLocaleString()}</p>
              </div>
              <div>
                <p className="eyebrow">Trial Cash</p>
                <p className="text-sm font-bold text-success">${ct.cash.toLocaleString()}</p>
              </div>
              <div>
                <p className="eyebrow">Ascend Revenue</p>
                <p className="text-sm font-bold">${ct.ascendRevenue.toLocaleString()}</p>
              </div>
              <div>
                <p className="eyebrow">Ascend Cash</p>
                <p className="text-sm font-bold text-success">${ct.ascendCash.toLocaleString()}</p>
              </div>
            </div>

            {/* Deal list */}
            <div className="overflow-y-auto max-h-[50vh]">
              {!revenueDeals ? (
                <div className="flex items-center justify-center py-8"><Loader className="animate-spin text-text-primary" size={20} /></div>
              ) : revenueDeals.length === 0 ? (
                <p className="text-text-400 text-sm text-center py-8">No closed deals in this period.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="sticky top-0" style={{ background: '#fff' }}>
                      <th className="text-left px-4 py-2 font-medium">Date</th>
                      <th className="text-left px-3 py-2 font-medium">Prospect</th>
                      <th className="text-center px-3 py-2 font-medium">Type</th>
                      <th className="text-right px-3 py-2 font-medium">Revenue</th>
                      <th className="text-right px-4 py-2 font-medium">Cash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revenueDeals.map((d, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2 text-text-400 whitespace-nowrap">{d.date}</td>
                        <td className="px-3 py-2 text-text-primary font-medium">{d.prospect_name}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                            d.call_type === 'ascension' ? 'bg-purple-500/20 text-purple-400' : 'bg-success/20 text-success'
                          }`}>
                            {d.call_type === 'ascension' ? 'Ascension' : 'Trial'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">${parseFloat(d.revenue || 0).toLocaleString()}</td>
                        <td className="px-4 py-2 text-right text-success font-medium">${parseFloat(d.cash_collected || 0).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {(() => {
                      // Footer totals come from the SAME closer_calls rows
                      // shown in the table body, so the modal reconciles
                      // top-to-bottom. Previously the footer used the EOD
                      // aggregate (ct.revenue + ct.ascendRevenue) which
                      // could differ from the sum of visible rows by
                      // whatever drift the closer introduced between their
                      // per-call entries and their summary counters.
                      const rowRevenue = (revenueDeals || []).reduce((s, d) => s + parseFloat(d.revenue || 0), 0)
                      const rowCash    = (revenueDeals || []).reduce((s, d) => s + parseFloat(d.cash_collected || 0), 0)
                      const eodDiffs = []
                      if (rowRevenue !== totalRevenue) eodDiffs.push(`EOD: $${totalRevenue.toLocaleString()} rev`)
                      if (rowCash    !== totalCash)    eodDiffs.push(`$${totalCash.toLocaleString()} cash`)
                      return (
                        <tr>
                          <td className="px-4 py-2" colSpan={3}>
                            Total {eodDiffs.length > 0 && <span className="text-[10px] font-normal text-text-400 ml-2">({eodDiffs.join(' · ')})</span>}
                          </td>
                          <td className="px-3 py-2 text-right">${rowRevenue.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right text-success">${rowCash.toLocaleString()}</td>
                        </tr>
                      )
                    })()}
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
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

function Board({ title, to, count, right, children }) {
  return (
    <div className="tile overflow-hidden" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="flex items-center justify-between gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <h2 className="editorial-panel-title" style={{ margin: 0 }}>
          {title}{count != null && <span style={{ fontFamily: 'var(--sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-4)', marginLeft: 10 }}>{count}</span>}
        </h2>
        {right}
        {to && !right && (
          <Link to={to} className="editorial-btn-ghost" style={{ height: 34, padding: '0 14px', fontSize: 12.5 }}>
            View all <ArrowUpRight size={12} />
          </Link>
        )}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}

function Empty({ children }) {
  return <p style={{ margin: 0, padding: '28px 20px', fontSize: 13.5, color: 'var(--ink-4)', textAlign: 'center' }}>{children}</p>
}

function Rank({ n }) {
  const first = n === 1
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 26, height: 26, borderRadius: 999,
      background: first ? 'var(--accent)' : '#fff',
      border: `1px solid ${first ? 'var(--accent)' : 'var(--rule)'}`,
      fontFamily: 'var(--serif)', fontSize: 14, fontWeight: 500, color: 'var(--ink)',
    }}>{first ? <Trophy size={12} /> : n}</span>
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
