import { useState, useEffect } from 'react'
import KPICard from '../components/KPICard'
import DateRangeSelector from '../components/DateRangeSelector'
import { Loader, Phone, DollarSign, Target, BarChart3, Zap, Users, TrendingUp, Award, Clock, ArrowUpRight, ChevronDown, Check, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCloserEODs } from '../hooks/useCloserData'
import { useSetterEODs } from '../hooks/useSetterData'
import { useFunnelData } from '../hooks/useFunnelData'
import { fetchWavvAggregates, fetchWavvCallsForSTL } from '../services/wavvService'
import { fetchAllPipelineSummaries, computeSpeedToLead } from '../services/ghlPipeline'
import { useMarketingTracker, computeMarketingStats } from '../hooks/useMarketingTracker'
import { useLeadAttribution } from '../hooks/useLeadAttribution'
import { supabase } from '../lib/supabase'
import { getColor } from '../utils/metricCalculations'

/* ── Rate Gauge (semi-circle) ── */
function RateGauge({ label, value, target, max = 100, suffix = '%', size = 120 }) {
  const pct = Math.min(value / max, 1)
  const radius = 38
  const circumference = Math.PI * radius
  const strokeDash = pct * circumference
  const color = value >= target ? '#d4f50c' : value >= target * 0.8 ? '#facc15' : '#ef4444'

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.55} viewBox="0 0 100 55">
        <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="#222" strokeWidth="7" strokeLinecap="round" />
        <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${strokeDash} ${circumference}`} />
        <text x="50" y="44" textAnchor="middle" fill="#f0f0f0" fontSize="15" fontWeight="bold" fontFamily="Inter, sans-serif">{value}{suffix}</text>
      </svg>
      <p className="text-[10px] text-text-400 uppercase tracking-wider mt-1 font-medium">{label}</p>
      <p className="text-[9px] text-text-400">target {target}{suffix}</p>
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
    <div className="flex-1 flex flex-col items-center gap-1.5">
      {!isFirst && <span className="text-[10px] text-success font-semibold">{convPct}%</span>}
      {isFirst && <div className="h-4" />}
      <div
        className="w-full bg-opt-yellow/10 border border-opt-yellow/20 rounded-xl flex items-center justify-center transition-all duration-500"
        style={{ height: `${height}px` }}
      >
        <span className="text-base font-bold text-text-primary">{count}</span>
      </div>
      <p className="text-[10px] text-text-400 uppercase tracking-wider font-medium">{label}</p>
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
  const [range, setRange] = useState(30)
  const [wavvAgg, setWavvAgg] = useState(null)
  const [wavvLoading, setWavvLoading] = useState(true)
  const [stl, setStl] = useState(null)
  const [stlLoading, setStlLoading] = useState(true)

  const { data: funnelData, loading: loadingFunnel } = useFunnelData(range)
  const { members: closers } = useTeamMembers('closer')
  const { members: setters } = useTeamMembers('setter')
  const { reports: closerReports } = useCloserEODs(null, range)
  const { reports: setterReports } = useSetterEODs(null, range)
  const { entries: marketingEntries } = useMarketingTracker({ autoSync: true })
  const { leads: recentLeads, refresh: refreshLeads } = useLeadAttribution(range)

  const toggleContacted = async (leadId, current) => {
    await supabase.from('setter_leads').update({ contacted: !current }).eq('id', leadId)
    refreshLeads()
  }

  // WAVV aggregates
  useEffect(() => {
    setWavvLoading(true)
    fetchWavvAggregates(range).then(data => { setWavvAgg(data); setWavvLoading(false) })
  }, [range])

  // Speed to Lead
  useEffect(() => {
    setStlLoading(true)
    Promise.all([
      fetchAllPipelineSummaries(() => {}),
      fetchWavvCallsForSTL(range),
    ]).then(([pipelines, calls]) => {
      const opps = pipelines.flatMap(p => p.summary?.opportunities || [])
      if (opps.length > 0 && calls.length > 0) {
        setStl(computeSpeedToLead(opps, calls))
      } else {
        setStl(null)
      }
      setStlLoading(false)
    }).catch(() => setStlLoading(false))
  }, [range])

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
    liveCalls: a.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
    noShows: a.noShows + (r.nc_no_shows || 0) + (r.fu_no_shows || 0),
    offers: a.offers + (r.offers || 0),
    closes: a.closes + (r.closes || 0),
    revenue: a.revenue + parseFloat(r.total_revenue || 0),
    cash: a.cash + parseFloat(r.total_cash_collected || 0),
    ascensions: a.ascensions + (r.deposits || 0),
    ascendCash: a.ascendCash + parseFloat(r.ascend_cash || 0),
    ascendRevenue: a.ascendRevenue + parseFloat(r.ascend_revenue || 0),
    reschedules: a.reschedules + (r.reschedules || 0),
  }), { booked: 0, liveCalls: 0, noShows: 0, offers: 0, closes: 0, revenue: 0, cash: 0, ascensions: 0, ascendCash: 0, ascendRevenue: 0, reschedules: 0 })

  const totalRevenue = ct.revenue + ct.ascendRevenue
  const totalCash = ct.cash + ct.ascendCash
  const showRate = ct.booked ? ((ct.liveCalls / ct.booked) * 100).toFixed(1) : 0
  const closeRate = ct.liveCalls ? ((ct.closes / ct.liveCalls) * 100).toFixed(1) : 0
  const offerRate = ct.liveCalls ? ((ct.offers / ct.liveCalls) * 100).toFixed(1) : 0
  const rescheduleRate = ct.booked ? ((ct.reschedules / ct.booked) * 100).toFixed(1) : 0
  const noShowRate = ct.booked ? ((ct.noShows / ct.booked) * 100).toFixed(1) : 0

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
      live: a.live + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
      offers: a.offers + (r.offers || 0),
      closes: a.closes + (r.closes || 0),
      revenue: a.revenue + parseFloat(r.total_revenue || 0),
      cash: a.cash + parseFloat(r.total_cash_collected || 0),
      ascendCash: a.ascendCash + parseFloat(r.ascend_cash || 0),
    }), { booked: 0, live: 0, offers: 0, closes: 0, revenue: 0, cash: 0, ascendCash: 0 })
    return { id: c.id, name: c.name, ...t, totalCash: t.cash + t.ascendCash,
      showPct: t.booked ? ((t.live / t.booked) * 100).toFixed(1) : '0.0',
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
  const dataReady = closerReports.length > 0 || closers.length > 0 || !loadingFunnel

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sales Overview</h1>
          <p className="text-sm text-text-400 mt-1">Performance dashboard</p>
        </div>
        <div className="flex items-center gap-4">
          {isLoading && <Loader size={16} className="animate-spin text-opt-yellow" />}
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* Loading skeleton */}
      {!dataReady && (
        <div className="space-y-4 animate-pulse">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1,2,3,4].map(i => <div key={i} className="bg-bg-card border border-border-default rounded-2xl h-28" />)}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            {[1,2,3,4,5,6,7,8].map(i => <div key={i} className="bg-bg-card border border-border-default rounded-2xl h-24" />)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-bg-card border border-border-default rounded-2xl h-64" />
            <div className="bg-bg-card border border-border-default rounded-2xl h-64" />
          </div>
        </div>
      )}

      {!dataReady ? null : <>

      {/* ═══ HERO KPIs ═══ */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard label="Total Revenue" value={`$${totalRevenue.toLocaleString()}`} subtitle={`${ct.closes} closes`} highlight />
        <KPICard label="Total Cash" value={`$${totalCash.toLocaleString()}`} subtitle={totalRevenue > 0 ? `${((totalCash / totalRevenue) * 100).toFixed(0)}% collected` : ''} />
        <KPICard label="Show Rate" value={`${showRate}%`} target={70} direction="above" subtitle={`${ct.liveCalls}/${ct.booked}`} />
        <KPICard label="Avg STL" value={stl ? stl.avgDisplay : stlLoading ? '...' : '—'} subtitle={stl ? `${stl.pctUnder5m}% < 5m` : ''} />
      </div>

      {/* Secondary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <KPICard label="Trial Cash" value={`$${ct.cash.toLocaleString()}`} subtitle={`$${ct.revenue.toLocaleString()} rev`} />
        <KPICard label="Ascend Cash" value={`$${ct.ascendCash.toLocaleString()}`} subtitle={`${ct.ascensions} ascensions`} />
        <KPICard label="Close Rate" value={`${closeRate}%`} target={25} direction="above" subtitle={`${ct.closes}/${ct.liveCalls}`} />
        <KPICard label="Offer Rate" value={`${offerRate}%`} target={80} direction="above" />
        {mkt.adspend > 0 && <>
          <KPICard label="Ad Spend" value={`$${mkt.adspend.toLocaleString()}`} />
          <KPICard label="FE ROAS" value={`${feRoas.toFixed(2)}x`} subtitle="trial / spend" />
          <KPICard label="NET ROAS" value={`${netRoas.toFixed(2)}x`} subtitle="all / spend" />
          <KPICard label="CPA" value={ct.closes > 0 ? `$${(mkt.adspend / ct.closes).toFixed(0)}` : '—'} />
        </>}
      </div>

      {/* ═══ TWO-COLUMN: Funnel + Rates ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Sales Funnel */}
        <div className="bg-bg-card border border-border-default rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <BarChart3 size={16} className="text-opt-yellow" /> Sales Funnel
            </h2>
            <div className="flex gap-3 text-[11px] text-text-400">
              {funnel.closes > 0 && <>
                <span>Lead→Close <strong className="text-text-primary">{((funnel.closes / funnel.leads) * 100).toFixed(1)}%</strong></span>
              </>}
            </div>
          </div>
          <div className="flex items-end gap-2">
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
        <div className="bg-bg-card border border-border-default rounded-2xl p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-5 flex items-center gap-2">
            <Target size={16} className="text-opt-yellow" /> Key Rates
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <RateGauge label="Show Rate" value={parseFloat(showRate)} target={70} />
            <RateGauge label="Offer Rate" value={parseFloat(offerRate)} target={80} />
            <RateGauge label="Close Rate" value={parseFloat(closeRate)} target={25} max={50} />
            <RateGauge label="Reschedule" value={parseFloat(rescheduleRate)} target={15} max={40} />
          </div>
          <div className="grid grid-cols-4 gap-3 mt-5 pt-4 border-t border-border-default text-center">
            <div>
              <p className="text-[10px] text-text-400 uppercase font-medium">No Shows</p>
              <p className={`text-lg font-bold ${parseFloat(noShowRate) <= 25 ? 'text-success' : 'text-danger'}`}>{noShowRate}%</p>
              <p className="text-[10px] text-text-400">{ct.noShows} missed</p>
            </div>
            <div>
              <p className="text-[10px] text-text-400 uppercase font-medium">Resched</p>
              <p className="text-lg font-bold text-warning">{ct.reschedules}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-400 uppercase font-medium">Ascend %</p>
              <p className="text-lg font-bold">{ct.closes ? ((ct.ascensions / ct.closes) * 100).toFixed(0) : 0}%</p>
              <p className="text-[10px] text-text-400">{ct.ascensions}/{ct.closes}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-400 uppercase font-medium">Avg Deal</p>
              <p className="text-lg font-bold text-success">${ct.closes ? Math.round(totalRevenue / ct.closes).toLocaleString() : 0}</p>
            </div>
          </div>
        </div>
      </div>

      {/* ═══ CASH BREAKDOWN + MARKETING ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Cash Breakdown */}
        <div className="bg-bg-card border border-border-default rounded-2xl p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-5 flex items-center gap-2">
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
          <div className="bg-bg-card border border-border-default rounded-2xl p-6">
            <h2 className="text-sm font-semibold text-text-primary mb-5 flex items-center gap-2">
              <TrendingUp size={16} className="text-opt-yellow" /> Marketing
            </h2>
            <div className="space-y-4">
              {[
                { label: 'CPL', value: `$${cpl.toFixed(0)}`, sub: `${mkt.leads} leads` },
                { label: 'CPBC', value: cpbc > 0 ? `$${cpbc.toFixed(0)}` : '—', sub: `${ct.booked} booked` },
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
            <div className="grid grid-cols-2 gap-3 mt-5 pt-4 border-t border-border-default text-center">
              <div>
                <p className="text-[10px] text-text-400 uppercase font-medium">FE ROAS</p>
                <p className={`text-xl font-bold ${feRoas >= 1 ? 'text-success' : 'text-danger'}`}>{feRoas.toFixed(2)}x</p>
              </div>
              <div>
                <p className="text-[10px] text-text-400 uppercase font-medium">NET ROAS</p>
                <p className={`text-xl font-bold ${netRoas >= 1 ? 'text-success' : 'text-danger'}`}>{netRoas.toFixed(2)}x</p>
              </div>
            </div>
          </div>
        )}

        {/* WAVV Dialer */}
        <div className="bg-bg-card border border-border-default rounded-2xl p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-5 flex items-center gap-2">
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
                <p className={`text-xl font-bold ${m.accent ? 'text-opt-yellow' : ''}`}>{m.raw ? m.val : m.val.toLocaleString()}</p>
                <p className="text-[10px] text-text-400 uppercase font-medium mt-0.5">{m.label}</p>
                {m.sub && <p className="text-[10px] text-text-400">{m.sub}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ CLOSER LEADERBOARD ═══ */}
      <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border-default flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Award size={16} className="text-opt-yellow" /> Closer Leaderboard
          </h2>
          <Link to="/sales/closers" className="text-xs text-opt-yellow hover:underline flex items-center gap-1">
            View all <ArrowUpRight size={12} />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-primary/30 text-[10px] text-text-400 uppercase tracking-wider">
                <th className="py-3 px-4 text-left w-10"></th>
                <th className="py-3 px-4 text-left">Closer</th>
                <th className="py-3 px-4 text-right">Live</th>
                <th className="py-3 px-4 text-right">Closes</th>
                <th className="py-3 px-4 text-right">Show%</th>
                <th className="py-3 px-4 text-right">Offer%</th>
                <th className="py-3 px-4 text-right">Close%</th>
                <th className="py-3 px-4 text-right">Trial $</th>
                <th className="py-3 px-4 text-right">Ascend $</th>
                <th className="py-3 px-4 text-right">Total Cash</th>
              </tr>
            </thead>
            <tbody>
              {closerBoard.map((c, i) => (
                <tr key={c.id} className={`border-t border-border-default/40 hover:bg-bg-card-hover transition-colors ${i === 0 ? 'bg-opt-yellow-subtle' : ''}`}>
                  <td className="py-3 px-4"><RankBadge rank={i + 1} /></td>
                  <td className="py-3 px-4">
                    <Link to={`/sales/closers/${c.id}`} className="font-medium text-text-primary hover:text-opt-yellow transition-colors">{c.name}</Link>
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">{c.live}</td>
                  <td className="py-3 px-4 text-right tabular-nums font-semibold">{c.closes}</td>
                  <td className={`py-3 px-4 text-right tabular-nums font-medium ${getColor(parseFloat(c.showPct), 70, 'above')}`}>{c.showPct}%</td>
                  <td className={`py-3 px-4 text-right tabular-nums font-medium ${getColor(parseFloat(c.offerPct), 80, 'above')}`}>{c.offerPct}%</td>
                  <td className={`py-3 px-4 text-right tabular-nums font-medium ${getColor(parseFloat(c.closePct), 25, 'above')}`}>{c.closePct}%</td>
                  <td className="py-3 px-4 text-right tabular-nums">${c.cash.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right tabular-nums text-blue-400">${c.ascendCash.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right tabular-nums font-bold text-success">${c.totalCash.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            {closerBoard.length > 1 && (
              <tfoot>
                <tr className="border-t-2 border-border-default bg-bg-primary/20 font-medium">
                  <td className="py-3 px-4" colSpan={2}>Team</td>
                  <td className="py-3 px-4 text-right tabular-nums">{ct.liveCalls}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{ct.closes}</td>
                  <td className={`py-3 px-4 text-right tabular-nums ${getColor(parseFloat(showRate), 70, 'above')}`}>{showRate}%</td>
                  <td className={`py-3 px-4 text-right tabular-nums ${getColor(parseFloat(offerRate), 80, 'above')}`}>{offerRate}%</td>
                  <td className={`py-3 px-4 text-right tabular-nums ${getColor(parseFloat(closeRate), 25, 'above')}`}>{closeRate}%</td>
                  <td className="py-3 px-4 text-right tabular-nums">${ct.cash.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right tabular-nums text-blue-400">${ct.ascendCash.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right tabular-nums font-bold text-success">${totalCash.toLocaleString()}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ═══ SETTER LEADERBOARD ═══ */}
      <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border-default flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Phone size={16} className="text-opt-yellow" /> Setter Leaderboard
          </h2>
          <Link to="/sales/setters" className="text-xs text-opt-yellow hover:underline flex items-center gap-1">
            View all <ArrowUpRight size={12} />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-primary/30 text-[10px] text-text-400 uppercase tracking-wider">
                <th className="py-3 px-4 text-left w-10"></th>
                <th className="py-3 px-4 text-left">Setter</th>
                <th className="py-3 px-4 text-right">Dials</th>
                <th className="py-3 px-4 text-right">Pickups</th>
                <th className="py-3 px-4 text-right">MCs</th>
                <th className="py-3 px-4 text-right">Contacts</th>
                <th className="py-3 px-4 text-right">Pickup%</th>
                <th className="py-3 px-4 text-right">MC%</th>
                <th className="py-3 px-4 text-right">Avg Dur</th>
                <th className="py-3 px-4 text-right">Sets</th>
              </tr>
            </thead>
            <tbody>
              {setterBoard.map((s, i) => (
                <tr key={s.id} className={`border-t border-border-default/40 hover:bg-bg-card-hover transition-colors ${i === 0 ? 'bg-opt-yellow-subtle' : ''}`}>
                  <td className="py-3 px-4"><RankBadge rank={i + 1} /></td>
                  <td className="py-3 px-4">
                    <Link to={`/sales/setters/${s.id}`} className="font-medium text-text-primary hover:text-opt-yellow transition-colors">{s.name}</Link>
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums font-semibold">{s.dials.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{s.pickups.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{s.mcs}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{s.contacts}</td>
                  <td className="py-3 px-4 text-right tabular-nums font-medium">{s.pickupPct}%</td>
                  <td className="py-3 px-4 text-right tabular-nums font-medium">{s.mcPct}%</td>
                  <td className="py-3 px-4 text-right tabular-nums">{s.avgDur > 0 ? `${Math.floor(s.avgDur / 60)}:${String(s.avgDur % 60).padStart(2, '0')}` : '—'}</td>
                  <td className="py-3 px-4 text-right tabular-nums font-bold text-opt-yellow">{s.sets}</td>
                </tr>
              ))}
            </tbody>
            {setterBoard.length > 1 && (
              <tfoot>
                <tr className="border-t-2 border-border-default bg-bg-primary/20 font-medium">
                  <td className="py-3 px-4" colSpan={2}>Team</td>
                  <td className="py-3 px-4 text-right tabular-nums">{wt.dials.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{wt.pickups.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{wt.mcs}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{wavvAgg?.uniqueContacts || 0}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{wt.dials ? ((wt.pickups / wt.dials) * 100).toFixed(1) : 0}%</td>
                  <td className="py-3 px-4 text-right tabular-nums">{wt.dials ? ((wt.mcs / wt.dials) * 100).toFixed(1) : 0}%</td>
                  <td className="py-3 px-4 text-right tabular-nums">—</td>
                  <td className="py-3 px-4 text-right tabular-nums font-bold text-opt-yellow">{setterBoard.reduce((a, s) => a + s.sets, 0)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
      {/* ── Recent Leads ── */}
      <div className="bg-bg-card border border-border-default rounded-2xl p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Users size={16} className="text-opt-yellow" /> Recent Leads
          </h2>
          <span className="text-[11px] text-text-400">{recentLeads.length} leads</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-text-400 uppercase tracking-wider">
                <th className="py-2 px-4 text-left">Lead</th>
                <th className="py-2 px-4 text-left">Source</th>
                <th className="py-2 px-4 text-left">Setter</th>
                <th className="py-2 px-4 text-left">Date Set</th>
                <th className="py-2 px-4 text-left">Status</th>
                <th className="py-2 px-4 text-center">Contacted</th>
              </tr>
            </thead>
            <tbody>
              {recentLeads.slice(0, 15).map(lead => (
                <tr key={lead.id} className="border-t border-border-default/40 hover:bg-bg-card-hover transition-colors">
                  <td className="py-3 px-4 font-medium text-text-primary">{lead.lead_name || '—'}</td>
                  <td className="py-3 px-4 text-text-secondary text-xs">{lead.lead_source || '—'}</td>
                  <td className="py-3 px-4 text-text-secondary text-xs">{lead.setter_name}</td>
                  <td className="py-3 px-4 text-text-400 text-xs tabular-nums">
                    {lead.date_set ? new Date(lead.date_set + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }) : '—'}
                  </td>
                  <td className="py-3 px-4">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                      lead.status === 'closed' ? 'bg-success/15 text-success' :
                      lead.status === 'showed' ? 'bg-blue-500/15 text-blue-400' :
                      lead.status === 'no_show' ? 'bg-danger/15 text-danger' :
                      lead.status === 'not_closed' ? 'bg-warning/15 text-warning' :
                      'bg-bg-primary text-text-400'
                    }`}>{lead.status?.replace('_', ' ') || 'pending'}</span>
                  </td>
                  <td className="py-3 px-4 text-center">
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
      </div>
      </>}
    </div>
  )
}
