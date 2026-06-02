import { useEffect, useMemo, useState, useRef } from 'react'
import { supabase } from '../../lib/supabase'

/*
  MetricTrendPanel — historical trend chart for any Marketing KPI.

  Drops into DrilldownModal at the top. Self-contained: pulls daily data
  from lib_marketing_by_audience_daily + marketing_tracker (for EOD-only
  fields), aggregates client-side by week or month, renders a yellow-bar +
  ink-line chart with per-period hover tooltips.

  Controls (mirrors the editorial design system, JetBrains Mono labels):
    Granularity · Weekly | Monthly
    Range       · 30d | 90d | 6mo | 1yr | All | Custom (from/to date inputs)

  Metric is inferred from the drilldown `kind`:
    leads     → SUM(leads)
    cpl       → SUM(adspend) / SUM(leads)
    bookings  → SUM(qualified_bookings)  (no separate "all bookings" in view)
    cpb       → SUM(adspend) / SUM(qualified_bookings)
    qbookings → SUM(qualified_bookings)
    cpqb      → SUM(adspend) / SUM(qualified_bookings)
    live      → SUM(live_calls)          (NC count)
    cpnew     → SUM(adspend) / SUM(live_calls)
    closes    → SUM(closes)              (audience view, Referral excluded)
    closerate → SUM(closes) / SUM(live_calls)
    cpatrial  → SUM(adspend) / SUM(closes)
    revenue   → SUM(trial_revenue)
    cash      → SUM(trial_cash)
    roas      → SUM(trial_cash) / SUM(adspend)

  Tooltip layer lives at the BOTTOM of the SVG (top z-order) so later
  columns' bars don't draw over earlier columns' tooltips.
*/

const METRIC_DEFS = {
  leads:     { title: 'Leads',                      fmt: 'n',  numeratorKey: 'leads' },
  cpl:       { title: 'Cost per Lead',              fmt: '$',  numeratorKey: 'adspend',           denominatorKey: 'leads' },
  bookings:  { title: 'Qualified Bookings',         fmt: 'n',  numeratorKey: 'qualified_bookings' },
  qbookings: { title: 'Qualified Bookings',         fmt: 'n',  numeratorKey: 'qualified_bookings' },
  cpb:       { title: 'Cost per Booking',           fmt: '$',  numeratorKey: 'adspend',           denominatorKey: 'qualified_bookings' },
  cpqb:      { title: 'Cost per Qualified Booking', fmt: '$',  numeratorKey: 'adspend',           denominatorKey: 'qualified_bookings' },
  live:      { title: 'Net New Live Calls',         fmt: 'n',  numeratorKey: 'live_calls' },
  cpnew:     { title: 'Cost per New Live',          fmt: '$',  numeratorKey: 'adspend',           denominatorKey: 'live_calls' },
  closes:    { title: 'Total Closes',               fmt: 'n',  numeratorKey: 'closes' },
  closerate: { title: 'Close Rate',                 fmt: '%',  numeratorKey: 'closes',            denominatorKey: 'live_calls' },
  cpatrial:  { title: 'CPA (Trial)',                fmt: '$',  numeratorKey: 'adspend',           denominatorKey: 'closes' },
  revenue:   { title: 'Trial Contracted Revenue',   fmt: '$',  numeratorKey: 'trial_revenue' },
  cash:      { title: 'Trial Cash Collected',       fmt: '$',  numeratorKey: 'trial_cash' },
  roas:      { title: 'Trial FE Cash ROAS',         fmt: 'x',  numeratorKey: 'trial_cash',        denominatorKey: 'adspend' },
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
  if (fmt === '$') return v >= 10000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v).toLocaleString()}`
  if (fmt === '%') return `${v.toFixed(1)}%`
  if (fmt === 'x') return `${v.toFixed(2)}x`
  return Math.round(v).toLocaleString()
}

export default function MetricTrendPanel({ metric, selectedAudiences, height = 360 }) {
  const def = METRIC_DEFS[metric]
  const [daily, setDaily] = useState([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState(null)
  const [granularity, setGranularity] = useState('week')
  const [rangeKey, setRangeKey] = useState('90d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const svgRef = useRef(null)
  const [hoverIdx, setHoverIdx] = useState(null)

  // Pull all-time daily data once. Filter client-side by audience + range.
  useEffect(() => {
    let alive = true
    setBusy(true); setErr(null)
    supabase
      .from('lib_marketing_by_audience_daily')
      .select('date, audience, adspend, leads, qualified_bookings, live_calls, closes, trial_revenue, trial_cash')
      .order('date', { ascending: true })
      .limit(20000)
      .then(({ data, error }) => {
        if (!alive) return
        if (error) { setErr(error.message); setDaily([]); return }
        setDaily(data || [])
      })
      .finally(() => { if (alive) setBusy(false) })
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
    const buckets = new Map()
    const cursor = new Date(fromDT)
    if (granularity === 'month') cursor.setUTCDate(1)
    else { const day = cursor.getUTCDay() || 7; cursor.setUTCDate(cursor.getUTCDate() - day + 1) }
    while (cursor <= toDT) {
      const k = isoDate(cursor)
      buckets.set(k, { period: k, num: 0, den: 0 })
      if (granularity === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1)
      else                          cursor.setUTCDate(cursor.getUTCDate() + 7)
    }
    // Fold daily rows into buckets
    for (const r of daily) {
      if (wanted && !wanted.has(r.audience)) continue
      const d = parse(r.date)
      if (d < fromDT || d > toDT) continue
      const k = bucketKey(r.date, granularity)
      if (!buckets.has(k)) buckets.set(k, { period: k, num: 0, den: 0 })
      const b = buckets.get(k)
      b.num += Number(r[def.numeratorKey]) || 0
      if (def.denominatorKey) b.den += Number(r[def.denominatorKey]) || 0
    }
    const arr = [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period))
    return arr.map(b => {
      let value
      if (def.denominatorKey) {
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
    if (def?.denominatorKey) return den > 0 ? (def.fmt === '%' ? (num / den) * 100 : num / den) : null
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
  const rangeAvg = def.denominatorKey
    ? (totalDen > 0 ? (def.fmt === '%' ? (totalNum / totalDen) * 100 : totalNum / totalDen) : null)
    : (buckets.length > 0 ? totalNum / buckets.length : null)

  const periodLabel = granularity === 'month' ? 'month' : 'week'

  return (
    <div style={{ background: 'var(--paper)', borderBottom: '1px solid var(--rule)', padding: '14px 18px 18px' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 12, fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        <span>{def.title} trend</span>
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
      </div>

      {busy && <div style={{ padding: 60, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.10em', color: 'var(--ink-3)' }}>Loading historical data…</div>}
      {err && <div style={{ padding: 12, color: '#b53e3e', fontFamily: 'var(--mono)', fontSize: 11 }}>Error: {err}</div>}
      {!busy && !err && buckets.length === 0 && (
        <div style={{ padding: 60, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.10em', color: 'var(--ink-3)' }}>No data in range</div>
      )}
      {!busy && !err && buckets.length > 0 && (
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
          {/* Trailing avg line (drawn below bars so bars cover) */}
          {/* Columns (bars + dots + overlays) */}
          {buckets.map((b, i) => {
            const x = xs(i)
            const colW = innerW / buckets.length
            const isActive = b.value != null && isFinite(b.value) && (def.denominatorKey ? b.den > 0 : b.num > 0)
            return (
              <g key={i}
                 onMouseEnter={() => setHoverIdx(i)}
                 onMouseLeave={() => setHoverIdx(prev => prev === i ? null : prev)}>
                {/* Hot-zone overlay */}
                <rect x={x - colW / 2} y={PAD_T} width={colW} height={innerH}
                      fill="var(--ink)" opacity={hoverIdx === i ? 0.06 : 0}
                      style={{ transition: 'opacity 120ms ease' }} />
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
          {/* Trailing avg line on top */}
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
          {/* Tooltip layer (top z-order) */}
          {hoverIdx != null && buckets[hoverIdx] && (() => {
            const b = buckets[hoverIdx]
            const t = trailing[hoverIdx]
            const x = xs(hoverIdx)
            const right = hoverIdx > buckets.length / 2
            const tipX = right ? x - 192 : x + 10
            const tipY = b.value != null ? Math.max(28, ys(b.value) - 12) : PAD_T + 40
            const lines = [
              { txt: `${granularity === 'month' ? 'MTH' : 'WK'} ${fmtPeriod(b.period, granularity)}`, accent: true },
              { txt: b.value != null ? `${formatValue(b.value, def.fmt)} ${def.title.toLowerCase()}` : 'NO ACTIVITY' },
              def.denominatorKey
                ? { txt: `${b.num.toLocaleString()} ${def.numeratorKey} / ${b.den.toLocaleString()} ${def.denominatorKey}` }
                : null,
              { txt: t != null ? `${formatValue(t, def.fmt)} 4-${periodLabel} trailing` : '' },
            ].filter(Boolean)
            const lineH = 14, tipH = lines.length * lineH + 14
            return (
              <g transform={`translate(${tipX}, ${tipY - tipH / 2})`} pointerEvents="none">
                <rect width="182" height={tipH} rx="2" fill="var(--ink)" />
                {lines.map((l, idx) => (
                  <text key={idx} x={10} y={15 + idx * lineH}
                        fontFamily="var(--mono)" fontSize="10"
                        fill={l.accent ? 'var(--accent)' : 'var(--paper)'}
                        fontWeight={l.accent ? 600 : 400}>{l.txt}</text>
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
        <span style={{ marginLeft: 'auto' }}>{buckets.filter(b => (def.denominatorKey ? b.den > 0 : b.num > 0)).length} active of {buckets.length} {periodLabel}s</span>
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
