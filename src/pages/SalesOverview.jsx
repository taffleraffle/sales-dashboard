import { useState, useEffect, useRef } from 'react'
import { todayET } from '../lib/dateUtils'
import KPICard from '../components/KPICard'
import DateRangeSelector from '../components/DateRangeSelector'
import { Loader, Phone, DollarSign, Target, BarChart3, Zap, Users, TrendingUp, Award, Clock, ArrowUpRight, ChevronDown, ChevronUp, Check, X, Trophy } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCloserEODs } from '../hooks/useCloserData'
import { useSetterEODs } from '../hooks/useSetterData'
import { useFunnelData } from '../hooks/useFunnelData'
import { fetchWavvAggregates, fetchWavvCallsForSTL } from '../services/wavvService'
import { fetchAllPipelineSummaries, computeSpeedToLead, buildSetterSchedules } from '../services/ghlPipeline'
import { rangeToDays } from '../lib/dateUtils'
import { useMarketingTracker, computeMarketingStats } from '../hooks/useMarketingTracker'
import { useLeadAttribution } from '../hooks/useLeadAttribution'
import { supabase } from '../lib/supabase'
import { getColor } from '../utils/metricCalculations'
import { checkEndangeredLeads } from '../services/engagementCheck'
import EndangeredLeadsTable from '../components/EndangeredLeadsTable'

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
        <div className="bg-bg-card border-2 border-success/40 rounded-2xl shadow-[0_0_40px_rgba(34,197,94,0.2)] px-6 py-4 max-w-lg">
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
                className="flex items-center justify-between bg-bg-primary rounded-xl px-3 py-2 transition-all duration-500"
                style={{ animationDelay: `${i * 200 + 500}ms`, animation: 'slideInRight 0.5s ease-out forwards', opacity: 0, transform: 'translateX(20px)' }}
              >
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-success/15 flex items-center justify-center">
                    <Check size={12} className="text-success" />
                  </div>
                  <span className="text-sm font-medium">{c.prospect_name}</span>
                </div>
                <div className="text-right">
                  {c.cash_collected > 0 && <span className="text-xs font-semibold text-opt-yellow">${c.cash_collected.toLocaleString()}</span>}
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

/* ── Rate Gauge (semi-circle) ── */
function RateGauge({ label, value, target, max = 100, suffix = '%' }) {
  const pct = Math.min(value / max, 1)
  const radius = 38
  const circumference = Math.PI * radius
  const strokeDash = pct * circumference
  const color = value >= target ? '#d4f50c' : value >= target * 0.8 ? '#facc15' : '#ef4444'

  return (
    <div className="flex flex-col items-center">
      <svg className="w-[80px] h-[44px] sm:w-[120px] sm:h-[66px]" viewBox="0 0 100 55">
        <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="#222" strokeWidth="7" strokeLinecap="round" />
        <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${strokeDash} ${circumference}`} />
        <text x="50" y="44" textAnchor="middle" fill="#f0f0f0" fontSize="15" fontWeight="bold" fontFamily="Inter, sans-serif">{value}{suffix}</text>
      </svg>
      <p className="text-[9px] sm:text-[10px] text-text-400 uppercase tracking-wider mt-1 font-medium">{label}</p>
      <p className="text-[8px] sm:text-[9px] text-text-400">target {target}{suffix}</p>
    </div>
  )
}

/* ── Funnel Bar ── */
function FunnelStep({ label, count, prevCount, isFirst, maxCount, stepIndex, totalSteps }) {
  // Graduated sizing: first bar is 100%, last bar is at least 35%, with smooth interpolation
  const ratio = maxCount > 0 ? count / maxCount : 0
  // Blend between actual ratio and a minimum floor that increases per step
  const minPct = 100 - (stepIndex / (totalSteps - 1)) * 65 // 100% → 35%
  const widthPct = Math.max(ratio * 100, minPct * 0.5, 30)
  const convPct = prevCount && prevCount > 0 ? ((count / prevCount) * 100).toFixed(1) : null
  // Height tapers down the funnel
  const height = 52 - stepIndex * 2

  return (
    <div className="flex-1 flex flex-col items-center gap-1 sm:gap-1.5 min-w-0">
      {!isFirst && <span className="text-[9px] sm:text-[10px] text-success font-semibold">{convPct}%</span>}
      {isFirst && <div className="h-3 sm:h-4" />}
      <div
        className="w-full bg-opt-yellow/10 border border-opt-yellow/20 rounded-lg sm:rounded-xl flex items-center justify-center transition-all duration-500"
        style={{ height: `${Math.max(height - 8, 36)}px` }}
      >
        <span className="text-sm sm:text-base font-bold text-text-primary">{count}</span>
      </div>
      <p className="text-[8px] sm:text-[10px] text-text-400 uppercase tracking-wider font-medium truncate max-w-full">{label}</p>
    </div>
  )
}

/* ── Rank Badge ── */
function RankBadge({ rank }) {
  if (rank === 1) return <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-opt-yellow/20 text-opt-yellow text-[11px] font-bold">{rank}</span>
  if (rank === 2) return <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-gray-500/15 text-gray-300 text-[11px] font-bold">{rank}</span>
  if (rank === 3) return <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-amber-700/15 text-amber-500 text-[11px] font-bold">{rank}</span>
  return <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-bg-primary text-text-400 text-[11px] font-bold">{rank}</span>
}

/* ── Status Pill ── */
function StatusPill({ label, count, active }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
      active ? 'bg-opt-yellow text-bg-primary' : 'bg-bg-card-hover text-text-secondary border border-border-default'
    }`}>
      {label} <span className={`text-[10px] ${active ? 'bg-bg-primary/20 px-1.5 py-0.5 rounded-full' : ''}`}>{count}</span>
    </span>
  )
}

export default function SalesOverview() {
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const [wavvAgg, setWavvAgg] = useState(null)
  const [wavvLoading, setWavvLoading] = useState(true)
  const [stl, setStl] = useState(null)
  const [stlLoading, setStlLoading] = useState(true)

  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const { data: funnelData, loading: loadingFunnel } = useFunnelData(days)
  const { members: closers } = useTeamMembers('closer')
  const { members: setters } = useTeamMembers('setter')
  const { reports: closerReports } = useCloserEODs(null, days)
  const { reports: setterReports } = useSetterEODs(null, days)
  const { entries: marketingEntries } = useMarketingTracker()
  const { leads: recentLeads, refresh: refreshLeads } = useLeadAttribution(days)

  const [showAllRecentLeads, setShowAllRecentLeads] = useState(false)
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

  const toggleContacted = async (leadId, current) => {
    await supabase.from('setter_leads').update({ contacted: !current }).eq('id', leadId)
    refreshLeads()
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
  const sinceStr = (() => {
    if (range && typeof range === 'object' && range.from) return range.from
    const now = new Date()
    if (range === 'mtd') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    const d = new Date(); d.setDate(d.getDate() - (typeof range === 'number' ? range : 30))
    return d.toISOString().split('T')[0]
  })()
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
  // Show rate + no-show rate: new-call only. Follow-ups aren't qualified
  // bookings so they shouldn't affect show%. Close/offer/reschedule rates
  // remain against all live calls / total booked (a close on a follow-up
  // is still a close).
  const showRate = ct.ncBooked ? ((ct.liveNC / ct.ncBooked) * 100).toFixed(1) : 0
  const closeRate = ct.liveCalls ? ((ct.closes / ct.liveCalls) * 100).toFixed(1) : 0
  const offerRate = ct.liveCalls ? ((ct.offers / ct.liveCalls) * 100).toFixed(1) : 0
  const rescheduleRate = ct.booked ? ((ct.reschedules / ct.booked) * 100).toFixed(1) : 0
  const noShowRate = ct.ncBooked ? ((ct.ncNoShows / ct.ncBooked) * 100).toFixed(1) : 0

  // Funnel
  const funnel = { leads: funnelData.leads, bookings: funnelData.bookings, shows: funnelData.shows, offers: ct.offers, closes: funnelData.closes }

  // Marketing derived
  const cpl = mkt.leads > 0 ? mkt.adspend / mkt.leads : 0
  const cpbc = ct.booked > 0 ? mkt.adspend / ct.booked : 0
  const feRoas = mkt.adspend > 0 ? ct.cash / mkt.adspend : 0
  const netRoas = mkt.adspend > 0 ? (ct.cash + ct.ascendCash + mkt.ar_collected) / mkt.adspend : 0

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
    return { id: c.id, name: c.name, ...t, totalCash: t.cash + t.ascendCash,
      // Show rate: new-call only (live_nc / nc_booked). See ct comment above.
      showPct: t.ncBooked ? ((t.liveNC / t.ncBooked) * 100).toFixed(1) : '0.0',
      closePct: t.live ? ((t.closes / t.live) * 100).toFixed(1) : '0.0',
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

  return (
    <div className="space-y-6">
      {/* Close Celebration */}
      {showCelebration && (
        <CloseCelebration
          closes={todayCloses}
          onDismiss={() => setShowCelebration(false)}
        />
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Sales Overview</h1>
          <p className="text-xs sm:text-sm text-text-400 mt-0.5 sm:mt-1">Performance dashboard</p>
        </div>
        <div className="flex items-center gap-4">
          {isLoading && <Loader size={16} className="animate-spin text-opt-yellow" />}
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* Loading skeleton — mirrors the final layout shape so the jump is minimal */}
      {!dataReady && (
        <div className="space-y-6 animate-pulse">
          {/* Hero KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
            {Array.from({ length: 4 }, (_, i) => <div key={i} className="tile tile-feedback h-28" />)}
          </div>
          {/* Secondary KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 sm:gap-3">
            {Array.from({ length: 8 }, (_, i) => <div key={i} className="tile tile-feedback h-24" />)}
          </div>
          {/* Funnel + Key Rates */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="tile tile-feedback h-64" />
            <div className="tile tile-feedback h-64" />
          </div>
          {/* Cash / Marketing / Dialer */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="tile tile-feedback h-56" />
            <div className="tile tile-feedback h-56" />
            <div className="tile tile-feedback h-56" />
          </div>
          {/* Closer Leaderboard */}
          <div className="tile tile-feedback h-72" />
          {/* Setter Leaderboard */}
          <div className="tile tile-feedback h-72" />
          {/* Recent Leads */}
          <div className="tile tile-feedback h-64" />
        </div>
      )}

      {/* Pending EOD */}
      {(pendingEOD.closers.length > 0 || pendingEOD.setters.length > 0) && (
        <div className="bg-bg-card border border-opt-yellow/20 rounded-2xl px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-opt-yellow" />
            <span className="text-xs font-medium text-opt-yellow">Pending EOD Today</span>
          </div>
          {pendingEOD.closers.map(c => (
            <Link key={c.id} to={`/sales/eod/submit?tab=closer&member=${c.id}`} className="text-[11px] px-2 py-1 rounded-lg bg-bg-primary border border-border-default text-text-secondary hover:border-opt-yellow/30 hover:text-text-primary transition-colors">
              {c.name} <span className="text-text-400">(closer)</span>
            </Link>
          ))}
          {pendingEOD.setters.map(s => (
            <Link key={s.id} to={`/sales/eod/submit?tab=setter&member=${s.id}`} className="text-[11px] px-2 py-1 rounded-lg bg-bg-primary border border-border-default text-text-secondary hover:border-opt-yellow/30 hover:text-text-primary transition-colors">
              {s.name} <span className="text-text-400">(setter)</span>
            </Link>
          ))}
        </div>
      )}

      {!dataReady ? null : <>

      {/* ═══ HERO KPIs ═══ */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
        <KPICard label="Total Revenue" value={`$${totalRevenue.toLocaleString()}`} subtitle={`${ct.closes} closes`} highlight onClick={openRevenueBreakdown} />
        <KPICard label="Total Cash" value={`$${totalCash.toLocaleString()}`} subtitle={totalRevenue > 0 ? `${((totalCash / totalRevenue) * 100).toFixed(0)}% collected` : ''} onClick={openRevenueBreakdown} />
        <KPICard label="Show Rate" value={`${showRate}%`} target={70} direction="above" subtitle={`${ct.liveCalls}/${ct.booked}`} />
        <KPICard label="Avg STL" value={stl ? stl.avgDisplay : stlLoading ? '...' : '—'} subtitle={stl ? `${stl.pctUnder5m}% < 5m` : ''} />
      </div>

      {/* Secondary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 sm:gap-3">
        <KPICard label="Trial Cash" value={`$${ct.cash.toLocaleString()}`} subtitle={`$${ct.revenue.toLocaleString()} rev`} />
        <KPICard label="Ascend Cash" value={`$${ct.ascendCash.toLocaleString()}`} subtitle={`${ct.ascensions} ascensions`} />
        <KPICard label="Close Rate" value={`${closeRate}%`} target={25} direction="above" subtitle={`${ct.closes}/${ct.liveCalls}`} />
        <KPICard label="Offer Rate" value={`${offerRate}%`} target={80} direction="above" />
        {mkt.adspend > 0 && <>
          <KPICard label="Ad Spend" value={`$${mkt.adspend.toLocaleString()}`} />
          <KPICard label="FE ROAS" value={`${feRoas.toFixed(2)}x`} subtitle="trial / spend" />
          <KPICard label="NET ROAS" value={`${netRoas.toFixed(2)}x`} subtitle="all / spend" />
          <KPICard label="CPA" value={ct.closes > 0 ? `$${Math.round(mkt.adspend / ct.closes).toLocaleString()}` : '—'} />
        </>}
      </div>

      {/* ═══ TWO-COLUMN: Funnel + Rates ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Sales Funnel */}
        <div className="tile tile-feedback p-4 sm:p-6">
          <div className="flex items-center justify-between mb-4 sm:mb-5">
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <BarChart3 size={16} className="text-opt-yellow" /> Sales Funnel
            </h2>
            <div className="flex gap-3 text-[11px] text-text-400">
              {funnel.closes > 0 && <>
                <span>Lead→Close <strong className="text-text-primary">{((funnel.closes / funnel.leads) * 100).toFixed(1)}%</strong></span>
              </>}
            </div>
          </div>
          <div className="flex items-end gap-1 sm:gap-2">
            {['leads','bookings','shows','offers','closes'].map((key, i, arr) => (
              <FunnelStep key={key} label={key} count={funnel[key]}
                prevCount={i > 0 ? funnel[arr[i - 1]] : null} isFirst={i === 0} maxCount={funnel.leads}
                stepIndex={i} totalSteps={arr.length} />
            ))}
          </div>
          {/* Auto vs Manual */}
          <div className="grid grid-cols-2 gap-4 mt-5 pt-4 border-t border-border-default">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-opt-yellow/10 flex items-center justify-center">
                <Zap size={13} className="text-opt-yellow" />
              </div>
              <div>
                <p className="text-xs font-medium">{funnelData.autoBookings} auto-booked</p>
                <p className="text-[10px] text-text-400">
                  <span className={funnelData.autoShowRate >= 70 ? 'text-success' : 'text-danger'}>{funnelData.autoShowRate}% show</span>
                  {' · '}
                  <span className={funnelData.autoCloseRate >= 25 ? 'text-success' : 'text-danger'}>{funnelData.autoCloseRate}% close</span>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-bg-card-hover flex items-center justify-center">
                <Phone size={13} className="text-text-400" />
              </div>
              <div>
                <p className="text-xs font-medium">{funnelData.manualSets} manual sets</p>
                <p className="text-[10px] text-text-400">
                  <span className={funnelData.manualShowRate >= 70 ? 'text-success' : 'text-danger'}>{funnelData.manualShowRate}% show</span>
                  {' · '}
                  <span className={funnelData.manualCloseRate >= 25 ? 'text-success' : 'text-danger'}>{funnelData.manualCloseRate}% close</span>
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Key Rates */}
        <div className="tile tile-feedback p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-4 sm:mb-5 flex items-center gap-2">
            <Target size={16} className="text-opt-yellow" /> Key Rates
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <RateGauge label="Show Rate" value={parseFloat(showRate)} target={70} />
            <RateGauge label="Offer Rate" value={parseFloat(offerRate)} target={80} />
            <RateGauge label="Close Rate" value={parseFloat(closeRate)} target={25} max={50} />
            <RateGauge label="Reschedule" value={parseFloat(rescheduleRate)} target={15} max={40} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mt-4 sm:mt-5 pt-3 sm:pt-4 border-t border-border-default text-center">
            <div>
              <p className="text-[9px] sm:text-[10px] text-text-400 uppercase font-medium">No Shows</p>
              <p className={`text-base sm:text-lg font-bold ${parseFloat(noShowRate) <= 25 ? 'text-success' : 'text-danger'}`}>{noShowRate}%</p>
              <p className="text-[9px] sm:text-[10px] text-text-400">{ct.noShows} missed</p>
            </div>
            <div>
              <p className="text-[9px] sm:text-[10px] text-text-400 uppercase font-medium">Resched</p>
              <p className="text-base sm:text-lg font-bold text-warning">{ct.reschedules}</p>
            </div>
            <div>
              <p className="text-[9px] sm:text-[10px] text-text-400 uppercase font-medium">Ascend %</p>
              <p className="text-base sm:text-lg font-bold">{ct.closes ? ((ct.ascensions / ct.closes) * 100).toFixed(0) : 0}%</p>
              <p className="text-[9px] sm:text-[10px] text-text-400">{ct.ascensions}/{ct.closes}</p>
            </div>
            <div>
              <p className="text-[9px] sm:text-[10px] text-text-400 uppercase font-medium">Avg Deal</p>
              <p className="text-base sm:text-lg font-bold text-success">${ct.closes ? Math.round(totalRevenue / ct.closes).toLocaleString() : 0}</p>
            </div>
          </div>
        </div>
      </div>

      {/* ═══ CASH BREAKDOWN + MARKETING ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Cash Breakdown */}
        <div className="tile tile-feedback p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-4 sm:mb-5 flex items-center gap-2">
            <DollarSign size={16} className="text-opt-yellow" /> Cash Breakdown
          </h2>
          <div className="space-y-4">
            {[
              { label: 'Trial Cash', val: ct.cash, color: 'bg-success' },
              { label: 'Ascend Cash', val: ct.ascendCash, color: 'bg-blue-400' },
            ].map(({ label, val, color }) => (
              <div key={label}>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-text-400">{label}</span>
                  <span className="font-semibold">${val.toLocaleString()}</span>
                </div>
                <div className="h-2 bg-bg-primary rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${totalCash > 0 ? (val / totalCash) * 100 : 0}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 pt-4 border-t border-border-default space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-text-400">Total Cash</span>
              <span className="font-bold text-success">${totalCash.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-text-400">Total Revenue</span>
              <span className="font-medium">${totalRevenue.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-text-400">Collect %</span>
              <span className={`font-medium ${totalRevenue > 0 && (totalCash / totalRevenue) >= 0.5 ? 'text-success' : 'text-warning'}`}>
                {totalRevenue > 0 ? ((totalCash / totalRevenue) * 100).toFixed(0) : 0}%
              </span>
            </div>
          </div>
        </div>

        {/* Marketing metrics */}
        {mkt.adspend > 0 && (
          <div className="tile tile-feedback p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text-primary mb-4 sm:mb-5 flex items-center gap-2">
              <TrendingUp size={16} className="text-opt-yellow" /> Marketing
            </h2>
            <div className="space-y-4">
              {[
                { label: 'CPL', value: `$${Math.round(cpl).toLocaleString()}`, sub: `${mkt.leads} leads` },
                { label: 'CPBC', value: cpbc > 0 ? `$${Math.round(cpbc).toLocaleString()}` : '—', sub: `${ct.booked} booked` },
              ].map(r => (
                <div key={r.label} className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-text-400">{r.label}</p>
                    <p className="text-[10px] text-text-400">{r.sub}</p>
                  </div>
                  <p className="text-lg font-bold">{r.value}</p>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:gap-3 mt-4 sm:mt-5 pt-3 sm:pt-4 border-t border-border-default text-center">
              <div>
                <p className="text-[9px] sm:text-[10px] text-text-400 uppercase font-medium">FE ROAS</p>
                <p className={`text-lg sm:text-xl font-bold ${feRoas >= 1 ? 'text-success' : 'text-danger'}`}>{feRoas.toFixed(2)}x</p>
              </div>
              <div>
                <p className="text-[9px] sm:text-[10px] text-text-400 uppercase font-medium">NET ROAS</p>
                <p className={`text-lg sm:text-xl font-bold ${netRoas >= 1 ? 'text-success' : 'text-danger'}`}>{netRoas.toFixed(2)}x</p>
              </div>
            </div>
          </div>
        )}

        {/* WAVV Dialer */}
        <div className="tile tile-feedback p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-4 sm:mb-5 flex items-center gap-2">
            <Phone size={16} className="text-opt-yellow" /> Dialer Activity
          </h2>
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: 'Dials', val: wt.dials, sub: null },
              { label: 'Pickups', val: wt.pickups, sub: wt.dials ? `${((wt.pickups / wt.dials) * 100).toFixed(1)}%` : '0%' },
              { label: 'MCs (60s+)', val: wt.mcs, sub: wt.dials ? `${((wt.mcs / wt.dials) * 100).toFixed(1)}%` : '0%' },
              { label: 'Contacts', val: wavvAgg?.uniqueContacts || 0, sub: null },
              { label: 'Avg STL', val: stl ? stl.avgDisplay : '—', raw: true, sub: stl ? `${stl.pctUnder5m}% < 5m` : null },
              { label: 'Dials/MC', val: wt.mcs ? (wt.dials / wt.mcs).toFixed(0) : '—', raw: true, sub: null, accent: true },
            ].map(m => (
              <div key={m.label} className="text-center py-2">
                <p className={`text-base sm:text-xl font-bold ${m.accent ? 'text-opt-yellow' : ''}`}>{m.raw ? m.val : m.val.toLocaleString()}</p>
                <p className="text-[9px] sm:text-[10px] text-text-400 uppercase font-medium mt-0.5">{m.label}</p>
                {m.sub && <p className="text-[10px] text-text-400">{m.sub}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ CLOSER LEADERBOARD ═══ */}
      <div className="tile tile-feedback overflow-hidden">
        <div className="px-3 sm:px-6 py-3 sm:py-4 border-b border-border-default flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Award size={16} className="text-opt-yellow" /> Closer Leaderboard
          </h2>
          <Link to="/sales/closers" className="text-xs text-opt-yellow hover:underline flex items-center gap-1">
            View all <ArrowUpRight size={12} />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead>
              <tr className="bg-bg-primary/30 text-[10px] text-text-400 uppercase tracking-wider">
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-left w-8 sm:w-10"></th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-left">Closer</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Live</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Closes</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Show%</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Offer%</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Close%</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Trial $</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Ascend $</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Total Cash</th>
              </tr>
            </thead>
            <tbody>
              {closerBoard.map((c, i) => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/sales/closers/${c.id}`)}
                  className={`border-t border-border-default/40 hover:bg-bg-card-hover cursor-pointer transition-colors ${i === 0 ? 'bg-opt-yellow-subtle' : ''}`}
                >
                  <td className="py-2 sm:py-3 px-2 sm:px-4"><RankBadge rank={i + 1} /></td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 font-medium text-text-primary whitespace-nowrap">{c.name}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{c.live}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-semibold">{c.closes}</td>
                  <td className={`py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-medium ${getColor(parseFloat(c.showPct), 70, 'above')}`}>{c.showPct}%</td>
                  <td className={`py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-medium ${getColor(parseFloat(c.offerPct), 80, 'above')}`}>{c.offerPct}%</td>
                  <td className={`py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-medium ${getColor(parseFloat(c.closePct), 25, 'above')}`}>{c.closePct}%</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums whitespace-nowrap">${c.cash.toLocaleString()}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums text-blue-400 whitespace-nowrap">${c.ascendCash.toLocaleString()}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-bold text-success whitespace-nowrap">${c.totalCash.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            {closerBoard.length > 1 && (
              <tfoot>
                <tr className="border-t-2 border-border-default bg-bg-primary/20 font-medium">
                  <td className="py-2 sm:py-3 px-2 sm:px-4" colSpan={2}>Team</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{ct.liveCalls}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{ct.closes}</td>
                  <td className={`py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums ${getColor(parseFloat(showRate), 70, 'above')}`}>{showRate}%</td>
                  <td className={`py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums ${getColor(parseFloat(offerRate), 80, 'above')}`}>{offerRate}%</td>
                  <td className={`py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums ${getColor(parseFloat(closeRate), 25, 'above')}`}>{closeRate}%</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums whitespace-nowrap">${ct.cash.toLocaleString()}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums text-blue-400 whitespace-nowrap">${ct.ascendCash.toLocaleString()}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-bold text-success whitespace-nowrap">${totalCash.toLocaleString()}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ═══ SETTER LEADERBOARD ═══ */}
      <div className="tile tile-feedback overflow-hidden">
        <div className="px-3 sm:px-6 py-3 sm:py-4 border-b border-border-default flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Phone size={16} className="text-opt-yellow" /> Setter Leaderboard
          </h2>
          <Link to="/sales/setters" className="text-xs text-opt-yellow hover:underline flex items-center gap-1">
            View all <ArrowUpRight size={12} />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead>
              <tr className="bg-bg-primary/30 text-[10px] text-text-400 uppercase tracking-wider">
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-left w-8 sm:w-10"></th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-left">Setter</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Dials</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Pickups</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">MCs</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Contacts</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Pickup%</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">MC%</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Avg Dur</th>
                <th className="py-2 sm:py-3 px-2 sm:px-4 text-right">Sets</th>
              </tr>
            </thead>
            <tbody>
              {setterBoard.map((s, i) => (
                <tr
                  key={s.id}
                  onClick={() => navigate(`/sales/setters/${s.id}`)}
                  className={`border-t border-border-default/40 hover:bg-bg-card-hover cursor-pointer transition-colors ${i === 0 ? 'bg-opt-yellow-subtle' : ''}`}
                >
                  <td className="py-2 sm:py-3 px-2 sm:px-4"><RankBadge rank={i + 1} /></td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 font-medium text-text-primary whitespace-nowrap">{s.name}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-semibold">{s.dials.toLocaleString()}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{s.pickups.toLocaleString()}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{s.mcs}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{s.contacts}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-medium">{s.pickupPct}%</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-medium">{s.mcPct}%</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums whitespace-nowrap">{s.avgDur > 0 ? `${Math.floor(s.avgDur / 60)}:${String(s.avgDur % 60).padStart(2, '0')}` : '—'}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-bold text-opt-yellow">{s.sets}</td>
                </tr>
              ))}
            </tbody>
            {setterBoard.length > 1 && (
              <tfoot>
                <tr className="border-t-2 border-border-default bg-bg-primary/20 font-medium">
                  <td className="py-2 sm:py-3 px-2 sm:px-4" colSpan={2}>Team</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{wt.dials.toLocaleString()}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{wt.pickups.toLocaleString()}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{wt.mcs}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{wavvAgg?.uniqueContacts || 0}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{wt.dials ? ((wt.pickups / wt.dials) * 100).toFixed(1) : 0}%</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">{wt.dials ? ((wt.mcs / wt.dials) * 100).toFixed(1) : 0}%</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums">—</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-right tabular-nums font-bold text-opt-yellow">{setterBoard.reduce((a, s) => a + s.sets, 0)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
      {/* ── Recent Leads ── */}
      <div className="tile tile-feedback p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4 sm:mb-5">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Users size={16} className="text-opt-yellow" /> Recent Leads
          </h2>
          <span className="text-[11px] text-text-400">{recentLeads.length} leads</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead>
              <tr className="text-[10px] sm:text-[11px] text-text-400 uppercase tracking-wider">
                <th className="py-2 px-2 sm:px-4 text-left">Lead</th>
                <th className="py-2 px-2 sm:px-4 text-left">Source</th>
                <th className="py-2 px-2 sm:px-4 text-left">Setter</th>
                <th className="py-2 px-2 sm:px-4 text-left">Date Set</th>
                <th className="py-2 px-2 sm:px-4 text-left">Status</th>
                <th className="py-2 px-2 sm:px-4 text-center">Contacted</th>
              </tr>
            </thead>
            <tbody>
              {recentLeads.slice(0, showAllRecentLeads ? 15 : 5).map(lead => (
                <tr key={lead.id} className="border-t border-border-default/40 hover:bg-bg-card-hover transition-colors">
                  <td className="py-2 sm:py-3 px-2 sm:px-4 font-medium text-text-primary whitespace-nowrap">{lead.lead_name || '—'}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-text-secondary text-xs whitespace-nowrap">{lead.lead_source || '—'}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-text-secondary text-xs whitespace-nowrap">{lead.setter_name}</td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-text-400 text-xs tabular-nums whitespace-nowrap">
                    {lead.date_set ? new Date(lead.date_set + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }) : '—'}
                  </td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4">
                    <span className={`text-[10px] sm:text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${
                      lead.status === 'closed' ? 'bg-success/15 text-success' :
                      lead.status === 'showed' ? 'bg-blue-500/15 text-blue-400' :
                      lead.status === 'no_show' ? 'bg-danger/15 text-danger' :
                      lead.status === 'not_closed' ? 'bg-warning/15 text-warning' :
                      'bg-bg-primary text-text-400'
                    }`}>{lead.status?.replace('_', ' ') || 'pending'}</span>
                  </td>
                  <td className="py-2 sm:py-3 px-2 sm:px-4 text-center">
                    <button
                      onClick={() => toggleContacted(lead.id, lead.contacted)}
                      className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
                        lead.contacted
                          ? 'bg-success/20 text-success'
                          : 'bg-bg-primary text-text-400 border border-border-default hover:text-text-primary'
                      }`}
                    >
                      {lead.contacted ? <Check size={14} /> : <X size={14} />}
                    </button>
                  </td>
                </tr>
              ))}
              {recentLeads.length === 0 && (
                <tr><td colSpan={6} className="py-8 text-center text-text-400 text-xs">No leads found for this period</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {recentLeads.length > 5 && (
          <button
            onClick={() => setShowAllRecentLeads(v => !v)}
            className="w-full py-3 text-xs font-medium text-opt-yellow hover:bg-bg-card-hover transition-colors flex items-center justify-center gap-1.5 border-t border-border-default"
          >
            {showAllRecentLeads ? <><ChevronUp size={14} /> Show less</> : <><ChevronDown size={14} /> Show all {recentLeads.length} leads</>}
          </button>
        )}
      </div>
      </>}

      {/* Endangered Leads — upcoming appointments with no engagement */}
      <EndangeredLeadsTable leads={endangeredLeads} loading={loadingEndangered} />

      {/* Revenue Breakdown Modal */}
      {showRevenueBreakdown && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowRevenueBreakdown(false)}>
          <div className="tile tile-feedback shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-default flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold">Revenue Breakdown</h2>
                <p className="text-[10px] text-text-400 mt-0.5">All closed & ascended deals in this period</p>
              </div>
              <button onClick={() => setShowRevenueBreakdown(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Summary */}
            <div className="px-5 py-3 border-b border-border-default grid grid-cols-4 gap-3">
              <div>
                <p className="text-[9px] text-text-400 uppercase">Trial Revenue</p>
                <p className="text-sm font-bold">${ct.revenue.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-[9px] text-text-400 uppercase">Trial Cash</p>
                <p className="text-sm font-bold text-success">${ct.cash.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-[9px] text-text-400 uppercase">Ascend Revenue</p>
                <p className="text-sm font-bold">${ct.ascendRevenue.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-[9px] text-text-400 uppercase">Ascend Cash</p>
                <p className="text-sm font-bold text-success">${ct.ascendCash.toLocaleString()}</p>
              </div>
            </div>

            {/* Deal list */}
            <div className="overflow-y-auto max-h-[50vh]">
              {!revenueDeals ? (
                <div className="flex items-center justify-center py-8"><Loader className="animate-spin text-opt-yellow" size={20} /></div>
              ) : revenueDeals.length === 0 ? (
                <p className="text-text-400 text-sm text-center py-8">No closed deals in this period.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-text-400 uppercase border-b border-border-default sticky top-0 bg-bg-card">
                      <th className="text-left px-4 py-2 font-medium">Date</th>
                      <th className="text-left px-3 py-2 font-medium">Prospect</th>
                      <th className="text-center px-3 py-2 font-medium">Type</th>
                      <th className="text-right px-3 py-2 font-medium">Revenue</th>
                      <th className="text-right px-4 py-2 font-medium">Cash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revenueDeals.map((d, i) => (
                      <tr key={i} className={`border-b border-border-default/30 ${i % 2 ? 'bg-bg-primary/30' : ''}`}>
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
                    <tr className="border-t border-border-default bg-bg-primary/50 font-semibold">
                      <td className="px-4 py-2" colSpan={3}>Total</td>
                      <td className="px-3 py-2 text-right">${totalRevenue.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right text-success">${totalCash.toLocaleString()}</td>
                    </tr>
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
