import { useEffect, useMemo, useState, useRef } from 'react'
import { supabase } from '../../lib/supabase'

/*
  MetricTrendPanel — historical trend chart for any Marketing KPI.

  Drops into DrilldownModal at the top. Self-contained: pulls daily data
  from lib_marketing_by_audience_daily + marketing_tracker (for EOD-only
  fields like cancels / reschedules), aggregates client-side by week or
  month, renders a yellow-bar + ink-line chart with per-period hover.

  Controls (editorial design system, JetBrains Mono labels):
    Granularity · Weekly | Monthly
    Range       · 30d | 90d | 6mo | 1yr | All | Custom

  When `variantOptions` is supplied, a third toggle group lets the user
  switch the metric in-panel (e.g. Show Rate → Gross | Net).
*/

const METRIC_DEFS = {
  leads:        { title: 'Leads',                    fmt: 'n', numKey: 'leads' },
  cpl:          { title: 'Cost per Lead',            fmt: '$', numKey: 'adspend',           denKey: 'leads',              numLabel: 'spend', denLabel: 'leads' },
  bookings:     { title: 'Qualified Bookings',       fmt: 'n', numKey: 'qualified_bookings' },
  qbookings:    { title: 'Qualified Bookings',       fmt: 'n', numKey: 'qualified_bookings' },
  cpb:          { title: 'Cost per Booking',         fmt: '$', numKey: 'adspend',           denKey: 'qualified_bookings', numLabel: 'spend', denLabel: 'bookings' },
  cpqb:         { title: 'Cost per Q.Booking',       fmt: '$', numKey: 'adspend',           denKey: 'qualified_bookings', numLabel: 'spend', denLabel: 'q.bookings' },
  live:         { title: 'Net New Live Calls',       fmt: 'n', numKey: 'live_calls' },
  cpnew:        { title: 'Cost per New Live',        fmt: '$', numKey: 'adspend',           denKey: 'live_calls',         numLabel: 'spend', denLabel: 'lives' },
  closes:       { title: 'Total Closes',             fmt: 'n', numKey: 'closes' },
  closerate:    { title: 'Close Rate',               fmt: '%', numKey: 'closes',            denKey: 'live_calls',         numLabel: 'closes', denLabel: 'lives' },
  cpatrial:     { title: 'CAC (Trial)',              fmt: '$', numKey: 'adspend',           denKey: 'closes',             numLabel: 'spend', denLabel: 'closes' },
  revenue:      { title: 'Trial Contracted Revenue', fmt: '$', numKey: 'trial_revenue' },
  cash:         { title: 'Trial Cash Collected',     fmt: '$', numKey: 'trial_cash' },
  roas:         { title: 'Trial FE Cash ROAS',       fmt: 'x', numKey: 'trial_cash',        denKey: 'adspend',            numLabel: 'cash',  denLabel: 'spend' },
  adspend:        { title: 'Ad Spend',               fmt: '$', numKey: 'adspend' },
  ascensions:     { title: 'Ascensions',             fmt: 'n', numKey: 'ascensions' },
  ascensions_closed: { title: 'Ascensions Closed',   fmt: 'n', numKey: 'ascensions_closed' },
  ascend_cash:    { title: 'Ascension Cash',         fmt: '$', numKey: 'ascend_cash' },
  ascend_revenue: { title: 'Ascension Revenue',      fmt: '$', numKey: 'ascend_revenue' },
  finance_offers: { title: 'Finance Offers',         fmt: 'n', numKey: 'finance_offers' },
  net_live_calls: { title: 'Net Live (NC+FU)',       fmt: 'n', numKey: 'net_live_calls' },
  fu_lives:       { title: 'Follow-up Lives',        fmt: 'n', numKey: 'fu_lives' },
  // Show rate variants — denominator depends on variant.
  // Gross: live / qualified_bookings  (both audience-aware via view)
  // Net:   live / (qualified_bookings - cancels - reschedules) — all three
  //        now audience-aware via migration 137, no scaling hack.
  showrate_gross: { title: 'Gross Show Rate', fmt: '%', numKey: 'live_calls', denKey: 'qualified_bookings',  numLabel: 'lives', denLabel: 'booked',    variantOf: 'showrate' },
  showrate_net:   { title: 'Net Show Rate',   fmt: '%', numKey: 'live_calls', denKey: 'confirmed_audience', numLabel: 'lives', denLabel: 'confirmed', variantOf: 'showrate', needsAudienceConfirmed: true },
  noshow_rate:    { title: 'No-Show Rate',    fmt: '%', numKey: 'no_shows',   denKey: 'qualified_bookings',  numLabel: 'no-shows', denLabel: 'booked' },
}

const VARIANT_GROUPS = {
  showrate: [
    { key: 'showrate_gross', label: 'Gross' },
    { key: 'showrate_net',   label: 'Net' },
  ],
}

const PRESETS = [
  { key: '30d',    label: '30d',    days: 30 },
  { key: '90d',    label: '90d',    days: 90 },
  { key: '180d',   label: '6mo',    days: 180 },
  { key: '365d',   label: '1yr',    days: 365 },
  { key: 'all',    label: 'All',    days: null },
  { key: 'custom', label: 'Custom', days: null },
]

function isoDate(d) { return d.toISOString().slice(0, 10) }
function parse(s) { return new Date(s + 'T00:00:00Z') }
function fmtPeriod(s, gran) {
  const d = parse(s)
  return gran === 'month'
    ? d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function bucketKey(dateStr, gran) {
  const d = parse(dateStr)
  if (gran === 'month') {
    return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
  }
  // ISO week starting Monday
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - day + 1)
  return isoDate(d)
}

function formatValue(v, fmt) {
  if (v == null || !isFinite(v)) return '—'
  if (fmt === '$') {
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
    if (Math.abs(v) >= 10_000)    return `$${(v / 1_000).toFixed(1)}k`
    return `$${Math.round(v).toLocaleString()}`
  }
  if (fmt === '%') return `${v.toFixed(1)}%`
  if (fmt === 'x') return `${v.toFixed(2)}x`
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (Math.abs(v) >= 10_000)    return `${(v / 1_000).toFixed(1)}k`
  return Math.round(v).toLocaleString()
}

function clip(txt, max) {
  if (!txt) return ''
  return txt.length > max ? `${txt.slice(0, max - 1)}…` : txt
}

export default function MetricTrendPanel({ metric, selectedAudiences, height = 360 }) {
  // When the incoming `metric` matches a variant group (e.g. 'showrate'),
  // open with the first variant. Otherwise treat metric as a leaf key.
  const [activeMetric, setActiveMetric] = useState(() => {
    if (VARIANT_GROUPS[metric]) return VARIANT_GROUPS[metric][0].key
    return metric
  })
  const variantGroupKey = METRIC_DEFS[activeMetric]?.variantOf || (VARIANT_GROUPS[metric] ? metric : null)
  const variantGroup = variantGroupKey ? VARIANT_GROUPS[variantGroupKey] : null
  const def = METRIC_DEFS[activeMetric]

  const [daily, setDaily] = useState([])           // lib_marketing_by_audience_daily rows
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState(null)
  const [granularity, setGranularity] = useState('week')
  // Default to 1yr so the chart surfaces full historical context (ad spend
  // history goes back to May 2025). Operators were defaulting to "the
  // dashboard only has March data" -- it doesn't, the 90d default just
  // happened to start in March 2026.
  const [rangeKey, setRangeKey] = useState('365d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const svgRef = useRef(null)
  const [hoverIdx, setHoverIdx] = useState(null)

  // Pull all-time daily data once. Filter client-side by audience + range.
  useEffect(() => {
    let alive = true
    setBusy(true); setErr(null)
    // All audience-aware columns (incl. no_shows, reschedules, cancels
    // from migration 137). No marketing_tracker fallback needed any more
    // — every metric variant computes from the audience view alone.
    const COLS = 'date, audience, adspend, leads, qualified_bookings, live_calls, closes, trial_revenue, trial_cash, ascensions, ascensions_closed, ascend_cash, ascend_revenue, no_shows, reschedules, cancels, net_live_calls, fu_lives, finance_offers'
    // Read the materialized copy (migration 139). The live view recomputes the
    // whole close-resolver chain on every read and times out over all-time.
    // Fall back to the live view when the matview isn't deployed yet.
    const load = async () => {
      let res = await supabase
        .from('lib_marketing_by_audience_daily_mv')
        .select(COLS).order('date', { ascending: true }).limit(20000)
      if (res.error) {
        res = await supabase
          .from('lib_marketing_by_audience_daily')
          .select(COLS).order('date', { ascending: true }).limit(20000)
      }
      if (!alive) return
      if (res.error) { setErr(res.error.message); return }
      setDaily(res.data || [])
    }
    load().finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [])

  // Audience-filter the raw rows, then bucket by granularity.
  const buckets = useMemo(() => {
    if (!def) return []
    const wanted = (selectedAudiences && selectedAudiences.size > 0) ? selectedAudiences : null
    // Determine date window
    let from, to
    if (rangeKey === 'all') {
      from = daily[0]?.date || isoDate(new Date())
      to   = daily[daily.length - 1]?.date || isoDate(new Date())
    } else if (rangeKey === 'custom') {
      from = customFrom || daily[0]?.date
      to   = customTo   || daily[daily.length - 1]?.date
    } else {
      const days = PRESETS.find(p => p.key === rangeKey)?.days || 90
      const lastDate = daily[daily.length - 1]?.date
      const lastDT = lastDate ? parse(lastDate) : new Date()
      const fromDT = new Date(lastDT); fromDT.setUTCDate(fromDT.getUTCDate() - days + 1)
      const minDT = daily[0]?.date ? parse(daily[0].date) : fromDT
      from = isoDate(fromDT < minDT ? minDT : fromDT)
      to   = isoDate(lastDT)
    }
    if (!from || !to) return []
    const fromDT = parse(from), toDT = parse(to)
    // Pre-seed empty buckets so gaps render as inactive bars
    const map = new Map()
    const cursor = new Date(fromDT)
    if (granularity === 'month') cursor.setUTCDate(1)
    else { const day = cursor.getUTCDay() || 7; cursor.setUTCDate(cursor.getUTCDate() - day + 1) }
    while (cursor <= toDT) {
      const k = isoDate(cursor)
      map.set(k, { period: k, num: 0, den: 0 })
      if (granularity === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1)
      else                          cursor.setUTCDate(cursor.getUTCDate() + 7)
    }
    // Fold audience-daily rows into buckets
    if (def.needsAudienceConfirmed) {
      // Net show rate from the audience view directly: every column we need
      // (live_calls, qualified_bookings, cancels, reschedules) is now
      // audience-aware via migration 137. No date-level fallback / scaling.
      for (const r of daily) {
        if (wanted && !wanted.has(r.audience)) continue
        const d = parse(r.date)
        if (d < fromDT || d > toDT) continue
        const k = bucketKey(r.date, granularity)
        if (!map.has(k)) map.set(k, { period: k, num: 0, den: 0 })
        const b = map.get(k)
        b.num += Number(r.live_calls) || 0
        const qb      = Number(r.qualified_bookings) || 0
        const cancels = Number(r.cancels) || 0
        const resched = Number(r.reschedules) || 0
        b.den += Math.max(0, qb - cancels - resched)
      }
    } else {
      // Standard path — sum numerator/denom from audience-daily
      for (const r of daily) {
        if (wanted && !wanted.has(r.audience)) continue
        const d = parse(r.date)
        if (d < fromDT || d > toDT) continue
        const k = bucketKey(r.date, granularity)
        if (!map.has(k)) map.set(k, { period: k, num: 0, den: 0 })
        const b = map.get(k)
        b.num += Number(r[def.numKey]) || 0
        if (def.denKey) b.den += Number(r[def.denKey]) || 0
      }
    }
    const arr = [...map.values()].sort((a, b) => a.period.localeCompare(b.period))
    return arr.map(b => {
      let value
      if (def.denKey) {
        if (b.den > 0) value = def.fmt === '%' ? (b.num / b.den) * 100 : (b.num / b.den)
        else value = null
      } else {
        value = b.num
      }
      return { ...b, value }
    })
  }, [daily, def, granularity, rangeKey, customFrom, customTo, selectedAudiences])

  // 4-period trailing average
  const trailing = useMemo(() => buckets.map((row, i) => {
    const w = buckets.slice(Math.max(0, i - 3), i + 1)
    const num = w.reduce((s, r) => s + r.num, 0)
    const den = w.reduce((s, r) => s + r.den, 0)
    if (def?.denKey) return den > 0 ? (def.fmt === '%' ? (num / den) * 100 : num / den) : null
    return num / w.length
  }), [buckets, def])

  if (!def) return null

  // Chart geometry
  const W = 1000, H = height
  const PAD_L = 80, PAD_R = 32, PAD_T = 24, PAD_B = 56
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const peak = Math.max(...buckets.filter(b => b.value != null && isFinite(b.value)).map(b => b.value), 0)
  // Y-axis ceiling: round up nicely
  let Y_MAX
  if (def.fmt === '%') Y_MAX = Math.min(100, Math.max(30, Math.ceil((peak + 5) / 15) * 15))
  else if (peak === 0) Y_MAX = 1
  else { const order = Math.pow(10, Math.floor(Math.log10(peak))); Y_MAX = Math.ceil(peak / order * 1.15) * order }

  const xs = i => buckets.length === 0 ? PAD_L : PAD_L + (buckets.length === 1 ? innerW / 2 : (i * innerW) / (buckets.length - 1))
  const ys = v => PAD_T + innerH - (Math.min(v, Y_MAX) / Y_MAX) * innerH
  const yTicks = []; for (let i = 0; i <= 4; i++) yTicks.push((Y_MAX / 4) * i)
  const tickStep = Math.max(1, Math.ceil(buckets.length / 8))
  const xTicks = buckets.map((_, i) => i).filter(i => i % tickStep === 0 || i === buckets.length - 1)

  // Path for trailing average line
  const linePath = trailing
    .map((v, i) => v == null ? null : `${i === 0 || trailing[i - 1] == null ? 'M' : 'L'} ${xs(i).toFixed(1)},${ys(v).toFixed(1)}`)
    .filter(Boolean).join(' ')

  // Range-average horizontal line
  const totalNum = buckets.reduce((s, b) => s + b.num, 0)
  const totalDen = buckets.reduce((s, b) => s + b.den, 0)
  const rangeAvg = def.denKey
    ? (totalDen > 0 ? (def.fmt === '%' ? (totalNum / totalDen) * 100 : totalNum / totalDen) : null)
    : (buckets.length > 0 ? totalNum / buckets.length : null)

  const periodLabel = granularity === 'month' ? 'month' : 'week'
  const activeCount = buckets.filter(b => (def.denKey ? b.den > 0 : b.num > 0)).length

  return (
    <div style={{ background: 'var(--paper)', borderBottom: '1px solid var(--rule)', padding: '14px 18px 18px' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 12, fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{def.title} trend</span>
        {variantGroup && (
          <>
            <span style={tbSepStyle} />
            <span>View</span>
            <div style={tbGroupStyle}>
              {variantGroup.map(v => (
                <button key={v.key} type="button" onClick={() => setActiveMetric(v.key)} style={tbBtn(activeMetric === v.key)}>{v.label}</button>
              ))}
            </div>
          </>
        )}
        <span style={tbSepStyle} />
        <span>Granularity</span>
        <div style={tbGroupStyle}>
          {['week', 'month'].map(g => (
            <button key={g} type="button" onClick={() => setGranularity(g)} style={tbBtn(granularity === g)}>{g === 'week' ? 'Weekly' : 'Monthly'}</button>
          ))}
        </div>
        <span style={tbSepStyle} />
        <span>Range</span>
        <div style={tbGroupStyle}>
          {PRESETS.map(p => (
            <button key={p.key} type="button" onClick={() => setRangeKey(p.key)} style={tbBtn(rangeKey === p.key)}>{p.label}</button>
          ))}
        </div>
        {rangeKey === 'custom' && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={tbInputStyle} />
            <span style={{ color: 'var(--ink-3)' }}>→</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={tbInputStyle} />
          </span>
        )}
        {def.needsAggregateOnly && (
          <span style={{ marginLeft: 'auto', fontStyle: 'italic', textTransform: 'none', letterSpacing: 0 }}>
            Aggregate-only metric — not audience-filterable.
          </span>
        )}
      </div>

      {busy && <div style={{ padding: 60, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.10em', color: 'var(--ink-3)' }}>Loading historical data…</div>}
      {err && <div style={{ padding: 12, color: '#b53e3e', fontFamily: 'var(--mono)', fontSize: 11 }}>Error: {err}</div>}
      {!busy && !err && buckets.length === 0 && (
        <div style={{ padding: 60, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.10em', color: 'var(--ink-3)' }}>No data in range</div>
      )}
      {!busy && !err && buckets.length > 0 && activeCount === 0 && (
        <div style={{ padding: 60, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.10em', color: 'var(--ink-3)' }}>
          No {def.title.toLowerCase()} activity in this range
          {selectedAudiences && selectedAudiences.size > 0 ? ' for the selected audience(s)' : ''}
        </div>
      )}
      {!busy && !err && buckets.length > 0 && activeCount > 0 && (
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', maxHeight: H }} preserveAspectRatio="xMidYMid meet">
          {/* Gridlines */}
          {yTicks.map((t, i) => (
            <line key={i} x1={PAD_L} y1={ys(t)} x2={W - PAD_R} y2={ys(t)} stroke="var(--rule-2, #ece8da)" strokeWidth="1" strokeDasharray="2 4" />
          ))}
          {/* Y-axis labels */}
          {yTicks.map((t, i) => (
            <text key={i} x={PAD_L - 8} y={ys(t) + 4} textAnchor="end" fontFamily="var(--mono)" fontSize="10" fill="var(--ink-3)">
              {formatValue(t, def.fmt)}
            </text>
          ))}
          {/* Range avg horizontal */}
          {rangeAvg != null && (
            <>
              <line x1={PAD_L} y1={ys(rangeAvg)} x2={W - PAD_R} y2={ys(rangeAvg)} stroke="var(--ink)" strokeWidth="0.6" strokeDasharray="4 5" opacity="0.4" />
              <text x={W - PAD_R - 4} y={ys(rangeAvg) - 6} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--ink)" opacity="0.55">
                range avg · {formatValue(rangeAvg, def.fmt)}
              </text>
            </>
          )}
          {/* Columns — bar + hot-zone (no murky overlay rect) */}
          {buckets.map((b, i) => {
            const x = xs(i)
            const colW = innerW / buckets.length
            const isActive = b.value != null && isFinite(b.value) && (def.denKey ? b.den > 0 : b.num > 0)
            return (
              <g key={i}
                 onMouseEnter={() => setHoverIdx(i)}
                 onMouseLeave={() => setHoverIdx(prev => prev === i ? null : prev)}>
                {/* Invisible hot-zone for hover */}
                <rect x={x - colW / 2} y={PAD_T} width={colW} height={innerH}
                      fill="transparent" />
                {/* Bar */}
                {isActive ? (
                  (() => {
                    const y = ys(b.value)
                    const bw = Math.max(4, colW - 4)
                    const bh = (PAD_T + innerH) - y
                    return <rect x={x - bw / 2} y={y} width={bw} height={bh}
                                 fill="var(--accent)" fillOpacity={hoverIdx === i ? 1 : 0.78} rx={1}
                                 style={{ transition: 'fill-opacity 120ms ease' }} />
                  })()
                ) : (
                  <rect x={x - colW / 2 + 3} y={PAD_T + innerH - 3} width={colW - 6} height={2}
                        fill="var(--rule)" opacity="0.5" />
                )}
              </g>
            )
          })}
          {/* Trailing avg line on top of bars */}
          {linePath && <path d={linePath} fill="none" stroke="var(--ink)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />}
          {trailing.map((v, i) => v == null ? null : (
            <circle key={i} cx={xs(i)} cy={ys(v)} r={hoverIdx === i ? 5 : 3} fill="var(--ink)" stroke="var(--paper)" strokeWidth="1.5"
                    style={{ transition: 'r 120ms ease' }} pointerEvents="none" />
          ))}
          {/* X-axis */}
          <line x1={PAD_L} y1={PAD_T + innerH} x2={W - PAD_R} y2={PAD_T + innerH} stroke="var(--ink-3)" strokeWidth="0.6" />
          {xTicks.map(i => (
            <text key={i} x={xs(i)} y={PAD_T + innerH + 22} textAnchor="middle"
                  fontFamily="var(--mono)" fontSize="10"
                  fill={hoverIdx === i ? 'var(--ink)' : 'var(--ink-3)'}
                  fontWeight={hoverIdx === i ? 500 : 400}
                  style={{ transition: 'fill 120ms ease' }}>
              {fmtPeriod(buckets[i].period, granularity)}
            </text>
          ))}
          {/* Crosshair vertical line — single clean guideline at hovered column */}
          {hoverIdx != null && (
            <line x1={xs(hoverIdx)} y1={PAD_T} x2={xs(hoverIdx)} y2={PAD_T + innerH}
                  stroke="var(--ink)" strokeWidth="1" strokeDasharray="2 3" opacity="0.35" pointerEvents="none" />
          )}
          {/* Tooltip layer — drawn LAST so it sits on top of every column */}
          {hoverIdx != null && buckets[hoverIdx] && (() => {
            const b = buckets[hoverIdx]
            const t = trailing[hoverIdx]
            const x = xs(hoverIdx)

            // Build lines — each entry is the rendered string.
            const lines = []
            lines.push({
              txt: clip(`${granularity === 'month' ? 'MONTH' : 'WEEK'} · ${fmtPeriod(b.period, granularity)}`, 30),
              accent: true,
            })
            if (b.value != null) {
              lines.push({ txt: `${formatValue(b.value, def.fmt)} ${def.title.toLowerCase()}` })
              if (def.denKey) {
                const numLabel = def.numLabel || def.numKey
                const denLabel = def.denLabel || def.denKey
                const numStr = def.fmt === '$' || def.numKey === 'adspend' || def.numKey === 'trial_cash' || def.numKey === 'trial_revenue'
                  ? formatValue(b.num, '$')
                  : Math.round(b.num).toLocaleString()
                const denStr = def.denKey === 'adspend'
                  ? formatValue(b.den, '$')
                  : Math.round(b.den).toLocaleString()
                lines.push({ txt: clip(`${numStr} ${numLabel} / ${denStr} ${denLabel}`, 36) })
              }
            } else {
              lines.push({ txt: 'No activity' })
            }
            if (t != null) {
              lines.push({ txt: `${formatValue(t, def.fmt)} · 4-${periodLabel} trailing`, muted: true })
            }

            // Width: 6.4px per mono char (10px font) + horizontal padding both sides (12+12)
            const longest = Math.max(...lines.map(l => l.txt.length))
            const tipW = Math.min(380, Math.max(180, longest * 6.4 + 24))
            const lineH = 14, padY = 10
            const tipH = lines.length * lineH + padY * 2

            // Pin within chart bounds, prefer right of column. Avoid the legend below.
            const wantRight = x + 14 + tipW < W - PAD_R
            const tipX = wantRight ? x + 14 : Math.max(PAD_L, x - tipW - 14)
            let tipY = b.value != null ? ys(b.value) - tipH - 8 : PAD_T + 12
            if (tipY < PAD_T + 4) tipY = PAD_T + 4
            if (tipY + tipH > PAD_T + innerH - 4) tipY = PAD_T + innerH - tipH - 4

            return (
              <g transform={`translate(${tipX.toFixed(1)}, ${tipY.toFixed(1)})`} pointerEvents="none">
                <rect width={tipW} height={tipH} rx="2" fill="var(--ink)" />
                {lines.map((l, idx) => (
                  <text key={idx} x={12} y={padY + 11 + idx * lineH}
                        fontFamily="var(--mono)" fontSize="10"
                        fill={l.accent ? 'var(--accent)' : 'var(--paper)'}
                        opacity={l.muted ? 0.72 : 1}
                        fontWeight={l.accent ? 600 : 400}>
                    {l.txt}
                  </text>
                ))}
              </g>
            )
          })()}
        </svg>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: 18, marginTop: 8, fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        <span><i style={{ display: 'inline-block', width: 18, height: 3, verticalAlign: 'middle', marginRight: 6, background: 'var(--accent)' }} />Per-{periodLabel}</span>
        <span><i style={{ display: 'inline-block', width: 18, height: 3, verticalAlign: 'middle', marginRight: 6, background: 'var(--ink)' }} />4-{periodLabel} trailing</span>
        <span style={{ marginLeft: 'auto' }}>{activeCount} active of {buckets.length} {periodLabel}s</span>
      </div>
    </div>
  )
}

const tbBtn = (active) => ({
  fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
  letterSpacing: '0.08em', textTransform: 'uppercase',
  color: active ? 'var(--paper)' : 'var(--ink-2)',
  background: active ? 'var(--ink)' : 'var(--paper)',
  border: 'none', padding: '6px 12px', cursor: 'pointer',
  borderRight: '1px solid var(--rule)',
  transition: 'background 120ms ease, color 120ms ease',
})
const tbGroupStyle = { display: 'inline-flex', border: '1px solid var(--rule)' }
const tbSepStyle = { width: 1, height: 18, background: 'var(--rule)' }
const tbInputStyle = {
  fontFamily: 'var(--mono)', fontSize: 11, padding: '5px 7px',
  border: '1px solid var(--rule)', background: 'var(--paper)',
  color: 'var(--ink)', outline: 'none',
}
