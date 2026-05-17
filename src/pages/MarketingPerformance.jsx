import { useState, useRef, useEffect, useMemo, memo, useCallback, startTransition } from 'react'
import { useMarketingTracker, computeMarketingStats } from '../hooks/useMarketingTracker'
import { useCloserCallProspectMetrics } from '../hooks/useCloserCallProspectMetrics'
import EditorialDate from '../components/EditorialDate'
import DateRangeSelector from '../components/DateRangeSelector'
import SyncStatusIndicator from '../components/SyncStatusIndicator'
import { Loader, Upload, Plus, SlidersHorizontal, Trash2, X, Edit3, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../hooks/useToast'
import { STRATEGY_CALL_CALENDARS, DQ_BOOKING_CALENDARS } from '../utils/constants'
import { isDQRevenueTier } from '../services/ghlCalendar'
import { BASE_URL, ghlFetch } from '../services/ghlClient'

import { todayET, etDateOffset } from '../lib/dateUtils'

const toLocalDateStr = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// All trailing-window math anchors on ET ("today" in the business timezone)
// so a user in NZ and a user in US ET see the same numbers for the same
// trailing-Nd selection. Without this, browser-local TZ produced different
// windows depending on where the user is sitting.
function filterByDays(entries, days) {
  if (days === 'mtd') {
    const todayStr = todayET()
    const start = todayStr.slice(0, 7) + '-01'
    return entries.filter(e => e.date >= start)
  }
  // Custom range: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
  if (days && typeof days === 'object' && days.from) {
    return entries.filter(e => e.date >= days.from && e.date <= days.to)
  }
  // sinceStr = first day of an N-day window ending today (so "Today" = today
  // only, "7d" = today and the prior 6 days). Off-by-one on this caused the
  // "Today" preset to include yesterday's data too.
  const sinceStr = etDateOffset(-Math.max(0, days - 1))
  return entries.filter(e => e.date >= sinceStr)
}

// Get the previous equivalent period for comparison
function filterPreviousPeriod(entries, days) {
  const now = new Date()
  if (days === 'mtd') {
    // Previous month's same MTD window
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const prevEnd = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate()))
    const from = toLocalDateStr(prevMonth)
    const to = toLocalDateStr(prevEnd)
    return entries.filter(e => e.date >= from && e.date <= to)
  }
  if (days && typeof days === 'object' && days.from) {
    const fromDate = new Date(days.from + 'T12:00:00')
    const toDate = new Date(days.to + 'T12:00:00')
    const span = Math.round((toDate - fromDate) / 86400000) + 1
    const prevEnd = new Date(fromDate)
    prevEnd.setDate(prevEnd.getDate() - 1)
    const prevStart = new Date(prevEnd)
    prevStart.setDate(prevStart.getDate() - span + 1)
    return entries.filter(e => e.date >= toLocalDateStr(prevStart) && e.date <= toLocalDateStr(prevEnd))
  }
  // Numeric days: e.g. 30d selected → previous 30d is day -60 to day -31
  const end = new Date()
  end.setDate(end.getDate() - days)
  const start = new Date()
  start.setDate(start.getDate() - days * 2)
  return entries.filter(e => e.date >= toLocalDateStr(start) && e.date < toLocalDateStr(end))
}

// ── Formatters ─────────────────────────────────────────────────────
const f$ = v => (v == null || isNaN(v)) ? '—' : `$${Math.round(v).toLocaleString()}`
const fP = v => (v == null || isNaN(v)) ? '—' : `${v.toFixed(1)}%`
const fX = v => (v == null || isNaN(v)) ? '—' : `${v.toFixed(2)}x`
const fN = v => (v == null || isNaN(v)) ? '—' : v.toLocaleString()
const fmt = (v, format) => format === '$' ? f$(v) : format === '%' ? fP(v) : format === 'x' ? fX(v) : fN(v)

// ── KPI Card with benchmark + info tooltip + period arrow ─────────
// Pass `onClick` to make a KPI clickable (used for drill-down modals).
const KPI = memo(function KPI({ label, value, format, benchmark, trailing, prev, tip, whatIf, onClick }) {
  // Cost metrics where lower = better (CPL, CPB, CPA, Cost/Live, Cost Per Offer)
  const costLabels = ['CPL', 'Cost/', 'CPA', 'Resch%']
  const lowerIsBetter = costLabels.some(c => label.includes(c))
  // Only color red/green if there's a benchmark to compare against
  const isGood = benchmark != null && value !== 0 && (lowerIsBetter ? value <= benchmark : value >= benchmark)
  const isBad = benchmark != null && value !== 0 && !isGood

  // What-if delta (computed first because it overrides the prev arrow —
  // when what-if is active, the displayed big number is the simulated value,
  // so the inline arrow should describe Δ vs CURRENT actual, not Δ vs prev
  // period. Otherwise the arrow describes a baseline that isn't visible
  // anywhere on the tile, which is what burned Ben on 2026-05-14.)
  const displayValue = whatIf != null ? whatIf : value
  const hasWhatIfDelta = whatIf != null && Math.abs(whatIf - value) > 0.01

  let arrow = null
  if (hasWhatIfDelta && value !== 0) {
    const pctChange = ((whatIf - value) / value) * 100
    const improved = lowerIsBetter ? whatIf < value : whatIf > value
    arrow = (
      <span className={`inline-flex items-center gap-0.5 text-[9px] font-medium ${improved ? 'text-success' : 'text-danger'}`} title="What-if change vs current actual">
        {improved ? '▲' : '▼'}{Math.abs(pctChange).toFixed(0)}%
      </span>
    )
  } else if (prev != null && prev !== 0 && value !== 0) {
    // Period-over-period arrow (only shown when no what-if is active)
    const pctChange = ((value - prev) / prev) * 100
    const improved = lowerIsBetter ? value < prev : value > prev
    const worsened = lowerIsBetter ? value > prev : value < prev
    if (Math.abs(pctChange) >= 0.5) {
      arrow = (
        <span className={`inline-flex items-center gap-0.5 text-[9px] font-medium ${improved ? 'text-success' : worsened ? 'text-danger' : 'text-text-400'}`} title="vs previous period">
          {improved ? '▲' : worsened ? '▼' : '—'}
          {Math.abs(pctChange).toFixed(0)}%
        </span>
      )
    }
  }

  const Wrapper = onClick ? 'button' : 'div'
  const interactiveCls = onClick ? 'text-left cursor-pointer hover:border-opt-yellow/40 hover:bg-bg-card-hover transition-colors w-full' : ''
  return (
    <Wrapper
      onClick={onClick}
      className={`bg-bg-card border rounded-sm p-3 relative group ${hasWhatIfDelta ? 'border-opt-yellow/40' : 'border-border-default'} ${interactiveCls}`}
    >
      <div className="flex items-center gap-1">
        <p className="text-[9px] uppercase tracking-wider text-text-400 mb-0.5 leading-tight truncate">{label}</p>
        {arrow}
        {tip && (
          <div className="relative">
            <span className="text-[8px] text-text-400/50 cursor-help mb-0.5">&#9432;</span>
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 rounded-lg bg-[#1a1a1a] border border-border-default text-[10px] text-text-secondary whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
              {tip}
              <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-[#1a1a1a]" />
            </div>
          </div>
        )}
      </div>
      <p className={`text-lg font-bold leading-tight ${displayValue === 0 ? 'text-text-400' : isGood ? 'text-success' : isBad ? 'text-danger' : 'text-text-primary'}`}>
        {fmt(displayValue, format)}
        {hasWhatIfDelta && (
          <span className={`text-[10px] font-normal ml-1.5 ${(whatIf > value) === !lowerIsBetter ? 'text-success' : 'text-danger'}`}>
            ({whatIf > value ? '+' : ''}{fmt(whatIf - value, format === '%' ? '%' : format === 'x' ? 'x' : '$')})
          </span>
        )}
      </p>
      <div className="flex items-center gap-2 mt-0.5">
        {hasWhatIfDelta && <span className="text-[9px] text-text-400">now: {fmt(value, format)}</span>}
        {trailing != null && <span className="text-[9px] text-text-400">30d: {fmt(trailing, format)}</span>}
        {benchmark != null && <span className="text-[9px] text-text-400">BM: {fmt(benchmark, format)}</span>}
        {onClick && <span className="text-[9px] text-text-400/60 ml-auto">click to view</span>}
      </div>
    </Wrapper>
  )
})

// ── Section Header ─────────────────────────────────────────────────
// Keep one-row-per-section at lg: — the outer page wrapper now caps content
// width so cards don't stretch to 300px+ on ultrawide.
const colsMap = {
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-5',
  6: 'lg:grid-cols-6',
  7: 'lg:grid-cols-7',
  8: 'lg:grid-cols-8',
  9: 'lg:grid-cols-9',
}

function Section({ title, children, cols = 6 }) {
  return (
    <div className="mb-4">
      <h3 className="text-[10px] uppercase tracking-widest text-text-400 font-medium mb-2 pl-1">{title}</h3>
      <div className={`grid grid-cols-2 md:grid-cols-3 ${colsMap[cols] || 'lg:grid-cols-6'} gap-2`}>
        {children}
      </div>
    </div>
  )
}


// ── MTD Funnel ─────────────────────────────────────────────────────
function MTDFunnel({ stats }) {
  const steps = [
    { label: 'Leads', value: stats.leads },
    { label: 'Booked', value: stats.qualified_bookings },
    // NC-only — matches the headline "Net New Live" tile and the Ads
    // page Live count. Prior used stats.live_calls (NC + FU) which
    // showed a different number than the same metric label everywhere
    // else on the page.
    { label: 'Net Live', value: stats.new_live_calls },
    { label: 'Offers', value: stats.offers },
    { label: 'Closes', value: stats.closes },
    { label: 'Ascensions', value: stats.ascensions },
  ]
  const maxVal = Math.max(...steps.map(s => s.value), 1)

  return (
    <div className="tile tile-feedback p-5">
      <h2 className="text-sm font-medium mb-4 flex items-center gap-2">
        <span className="text-text-primary">&#9660;</span> MTD Funnel
      </h2>
      <div className="space-y-1.5">
        {steps.map((step, i) => {
          const prev = i > 0 ? steps[i - 1].value : null
          const pct = prev && prev > 0 ? ((step.value / prev) * 100).toFixed(0) : null
          const w = Math.max((step.value / maxVal) * 100, 2)
          return (
            <div key={step.label} className="flex items-center gap-2">
              <span className="text-[10px] text-text-400 w-16 shrink-0 text-right">{step.label}</span>
              <div className="flex-1 h-4 bg-bg-primary rounded-full overflow-hidden relative">
                <div className="h-full rounded-full bg-opt-yellow transition-all duration-500" style={{ width: `${w}%`, opacity: step.value > 0 ? 1 : 0.2 }} />
                <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-text-primary">{step.value}</span>
              </div>
              <span className="text-[10px] text-text-400 w-8 shrink-0">{pct ? `${pct}%` : ''}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Trailing Period Summary ────────────────────────────────────────
// `applyProspectMetrics` is passed in so each trailing period gets the
// same deduped numbers the top tiles use. Without this, the table
// silently showed legacy EOD self-report counts while the rest of the
// page used per-call truth — same drift class as everything else.
function TrailingTable({ entries, applyProspectMetrics }) {
  const periods = [
    { label: '4 Days', days: 4 },
    { label: '7 Days', days: 7 },
    { label: '30 Days', days: 30 },
    { label: 'MTD', days: 'mtd' },
  ]
  const rows = periods.map(p => ({
    ...p,
    s: applyProspectMetrics
      ? applyProspectMetrics(computeMarketingStats(filterByDays(entries, p.days)), p.days)
      : computeMarketingStats(filterByDays(entries, p.days)),
  }))

  const cols = [
    { label: 'Spend', k: 'adspend', f: f$ },
    { label: 'Leads', k: 'leads', f: fN },
    { label: 'CPL', k: 'cpl', f: f$ },
    { label: 'Booked', k: 'qualified_bookings', f: fN },
    { label: 'L→B%', k: 'lead_to_booking_pct', f: fP },
    // Net Live uses new_live_calls (NC-only, deduped) — matches the
    // headline "Net New Live" tile and the Ads page Live count.
    { label: 'Net Live', k: 'new_live_calls', f: fN },
    { label: 'Show%', k: 'show_rate', f: fP },
    { label: 'Offers', k: 'offers', f: fN },
    { label: 'Closes', k: 'closes', f: fN },
    { label: 'Cl%', k: 'close_rate', f: fP },
    { label: 'CPA', k: 'cpa_trial', f: f$ },
    { label: 'T.Cash', k: 'trial_cash', f: f$ },
    { label: 'FE ROAS', k: 'trial_fe_roas', f: fX },
    { label: 'Asc', k: 'ascensions', f: fN },
    { label: 'Asc%', k: 'ascend_rate', f: fP },
    { label: 'AllCash', k: 'all_cash', f: f$ },
    { label: 'NET ROAS', k: 'all_cash_roas', f: fX },
  ]

  const rateColor = (k, v) => {
    if (v === 0) return ''
    if (k === 'show_rate') return v >= 70 ? 'text-success' : v >= 50 ? 'text-text-primary' : 'text-danger'
    if (k === 'close_rate') return v >= 25 ? 'text-success' : v >= 15 ? 'text-text-primary' : 'text-danger'
    if (k === 'offer_rate') return v >= 80 ? 'text-success' : v >= 60 ? 'text-text-primary' : 'text-danger'
    if (k.includes('roas')) return v >= 2 ? 'text-success' : v >= 1 ? 'text-text-primary' : 'text-danger'
    return ''
  }

  return (
    <div className="tile tile-feedback overflow-hidden">
      <div className="px-4 py-3 border-b border-border-default">
        <h2 className="text-sm font-medium">Trailing Period Summary</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-border-default text-text-400 uppercase text-[9px]">
              <th className="px-2 py-1.5 text-left sticky left-0 bg-bg-card z-10">Period</th>
              {cols.map(c => <th key={c.k} className="px-2 py-1.5 text-right whitespace-nowrap">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label} className="border-b border-border-default/30">
                <td className="px-2 py-1.5 font-medium text-text-primary sticky left-0 bg-bg-card z-10">{r.label}</td>
                {cols.map(c => (
                  <td key={c.k} className={`px-2 py-1.5 text-right ${rateColor(c.k, r.s[c.k])}`}>
                    {c.f(r.s[c.k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Daily Tracker ──────────────────────────────────────────────────
const DailyTracker = memo(function DailyTracker({ entries, onDelete, onSave }) {
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [sortKey, setSortKey] = useState('date')
  const [sortDir, setSortDir] = useState('desc')
  const [editDate, setEditDate] = useState(null)
  const [editForm, setEditForm] = useState({})

  let filtered = [...entries]
  if (fromDate) filtered = filtered.filter(e => e.date >= fromDate)
  if (toDate) filtered = filtered.filter(e => e.date <= toDate)
  filtered.sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey]
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    return sortDir === 'asc' ? (parseFloat(av || 0) - parseFloat(bv || 0)) : (parseFloat(bv || 0) - parseFloat(av || 0))
  })

  const toggleSort = k => { if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('desc') } }

  const TH = ({ k, label }) => (
    <th className="px-2 py-1.5 text-right cursor-pointer hover:text-text-primary select-none whitespace-nowrap" onClick={() => toggleSort(k)}>
      {label}{sortKey === k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )

  const fmtP = (n, d) => d > 0 ? `${((n / d) * 100).toFixed(0)}%` : '-'

  const [saving, setSaving] = useState(false)
  const startEdit = e => { setEditDate(e.date); setEditForm({ ...e }) }
  const saveEdit = async () => {
    setSaving(true)
    try { await onSave(editForm) } catch (err) { console.error('Save failed:', err) }
    setSaving(false)
    setEditDate(null)
  }
  const editGroups = [
    { label: 'Spend & Leads', fields: [
      { k: 'adspend', l: 'Ad Spend ($)' }, { k: 'leads', l: 'Leads' },
    ]},
    { label: 'Bookings', fields: [
      { k: 'auto_bookings', l: 'Auto Books' }, { k: 'qualified_bookings', l: 'Qual Books' },
    ]},
    { label: 'Calls', fields: [
      { k: 'live_calls', l: 'Net Live' }, { k: 'reschedules', l: 'Reschedules' },
      { k: 'cancelled_dtf', l: 'Cancel DTF' }, { k: 'cancelled_by_prospect', l: 'Cancel Prospect' },
    ]},
    { label: 'Offers & Closes', fields: [
      { k: 'offers', l: 'Offers' }, { k: 'closes', l: 'Closes' },
    ]},
    { label: 'Trial Financials', fields: [
      { k: 'trial_cash', l: 'Trial Cash ($)' }, { k: 'trial_revenue', l: 'Trial Revenue ($)' },
    ]},
    { label: 'Ascension', fields: [
      { k: 'ascensions', l: 'Ascensions' }, { k: 'ascend_cash', l: 'Ascend Cash ($)' },
      { k: 'ascend_revenue', l: 'Ascend Revenue ($)' },
      { k: 'finance_offers', l: 'Finance Offers' }, { k: 'finance_accepted', l: 'Finance Accepted' },
    ]},
    { label: 'AR & Refunds', fields: [
      { k: 'ar_collected', l: 'AR Collected ($)' }, { k: 'ar_defaulted', l: 'AR Defaulted ($)' },
      { k: 'refund_count', l: 'Refunds (#)' }, { k: 'refund_amount', l: 'Refund Amt ($)' },
    ]},
  ]

  // Show-rate + close-rate use NC-only (matches the headline Gross/Net Show%
  // and Close Rate tiles, which call computeMarketingStats). Prior helpers
  // returned NC+FU which made the per-row Gross.Show% systematically lower
  // than the headline for the same window. Fallback to qualified_bookings /
  // live_calls only when the NC-specific columns are null (pre-migration
  // rows). Offer-rate stays on NC+FU because computeMarketingStats does:
  // offer_rate = offers / live_calls.
  const getCalls    = e => e.nc_booked != null ? e.nc_booked : (e.net_new_calls || e.qualified_bookings || 0)
  const getLive     = e => e.new_live_calls != null ? e.new_live_calls : (e.live_calls || e.net_live_calls || 0)
  const getNetLive  = e => e.live_calls || e.net_live_calls || 0  // NC + FU, for offer-rate denominator

  // Color helpers for table cells
  const clrRate = (v, good, ok) => v >= good ? 'text-success' : v >= ok ? 'text-text-primary' : 'text-danger'
  const clrRoas = v => v >= 2 ? 'text-success' : v >= 1 ? 'text-text-primary' : 'text-danger'
  const clrCash = v => v > 0 ? 'text-success' : ''

  const dataCols = [
    { k: 'adspend', label: 'Spend', fmt: f$ },
    { k: 'leads', label: 'Leads', fmt: fN },
    { k: null, label: 'CPL', calc: e => e.leads > 0 ? f$(parseFloat(e.adspend || 0) / e.leads) : '-' },
    { k: 'auto_bookings', label: 'A.Book', fmt: fN },
    { k: 'qualified_bookings', label: 'Q.Book', fmt: fN },
    { k: null, label: 'L→Q%', calc: e => fmtP(e.qualified_bookings, e.leads),
      color: e => e.leads > 0 ? clrRate((e.qualified_bookings || 0) / e.leads * 100, 15, 8) : '' },
    { k: 'live_calls', label: 'Net Live', fmt: fN },
    { k: null, label: 'Gr.Show%', calc: e => { const cal = getCalls(e); return cal > 0 ? fmtP(getLive(e), cal) : '-' },
      color: e => { const cal = getCalls(e); return cal > 0 ? clrRate(getLive(e) / cal * 100, 70, 50) : '' } },
    { k: null, label: 'Net Show%', calc: e => { const net = getCalls(e) - (e.cancelled_dtf || 0) - (e.cancelled_by_prospect || 0) - (e.reschedules || 0); return net > 0 ? fmtP(getLive(e), net) : '-' },
      color: e => { const net = getCalls(e) - (e.cancelled_dtf || 0) - (e.cancelled_by_prospect || 0) - (e.reschedules || 0); return net > 0 ? clrRate(getLive(e) / net * 100, 80, 60) : '' } },
    { k: 'reschedules', label: 'Resch', fmt: fN, color: e => (e.reschedules || 0) > 0 ? 'text-text-secondary' : '' },
    { k: null, label: 'R%', calc: e => { const cal = getCalls(e); return cal > 0 ? fmtP(e.reschedules, cal) : '-' },
      color: e => { const cal = getCalls(e); return cal > 0 && (e.reschedules || 0) > 0 ? 'text-text-secondary' : '' } },
    { k: 'offers', label: 'Offer', fmt: fN },
    { k: null, label: 'Ofr%', calc: e => getNetLive(e) > 0 ? fmtP(e.offers, getNetLive(e)) : '-',
      color: e => getNetLive(e) > 0 ? clrRate((e.offers || 0) / getNetLive(e) * 100, 80, 60) : '' },
    { k: 'closes', label: 'Close', fmt: fN, color: e => (e.closes || 0) > 0 ? 'text-success font-medium' : '' },
    { k: null, label: 'Cl%', calc: e => fmtP(e.closes, getLive(e)),
      color: e => getLive(e) > 0 ? clrRate((e.closes || 0) / getLive(e) * 100, 25, 15) : '' },
    { k: 'trial_cash', label: 'T$', fmt: f$, color: e => clrCash(parseFloat(e.trial_cash || 0)) },
    { k: null, label: 'FE ROAS', calc: e => { const spend = parseFloat(e.adspend || 0); const cash = parseFloat(e.trial_cash || 0); return spend > 0 ? fX(cash / spend) : '-' },
      color: e => { const spend = parseFloat(e.adspend || 0); const cash = parseFloat(e.trial_cash || 0); return spend > 0 ? clrRoas(cash / spend) : '' } },
    { k: 'ascensions', label: 'Asc', fmt: fN, color: e => (e.ascensions || 0) > 0 ? 'text-cyan-400' : '' },
    { k: 'ascend_cash', label: 'A$', fmt: f$, color: e => parseFloat(e.ascend_cash || 0) > 0 ? 'text-cyan-400' : '' },
    { k: 'finance_offers', label: 'Fin', fmt: fN },
    { k: 'finance_accepted', label: 'F.Acc', fmt: fN, color: e => (e.finance_accepted || 0) > 0 ? 'text-purple-400' : '' },
    { k: 'ar_collected', label: 'AR', fmt: f$ },
    { k: null, label: 'NET ROAS', calc: e => { const spend = parseFloat(e.adspend || 0); const cash = parseFloat(e.trial_cash || 0) + parseFloat(e.ascend_cash || 0) + parseFloat(e.ar_collected || 0); return spend > 0 ? fX(cash / spend) : '-' },
      color: e => { const spend = parseFloat(e.adspend || 0); const cash = parseFloat(e.trial_cash || 0) + parseFloat(e.ascend_cash || 0) + parseFloat(e.ar_collected || 0); return spend > 0 ? clrRoas(cash / spend) : '' } },
  ]

  const editableFields = ['adspend', 'leads', 'auto_bookings', 'qualified_bookings',
    'calls_on_calendar', 'live_calls', 'no_shows', 'cancelled_dtf', 'cancelled_by_prospect', 'offers', 'closes', 'reschedules',
    'trial_cash', 'trial_revenue', 'ascensions', 'ascend_cash', 'ascend_revenue',
    'finance_offers', 'finance_accepted', 'monthly_offers', 'monthly_accepted',
    'ar_collected', 'ar_defaulted', 'refund_count', 'refund_amount']

  return (
    <div className="tile tile-feedback overflow-hidden">
      <div className="px-4 py-3 border-b border-border-default flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium">Daily Tracker Data</h2>
        <div className="flex items-center gap-2 ml-auto">
          <EditorialDate value={fromDate} onChange={setFromDate} max={toDate || undefined} placeholder="From" compact />
          <span className="text-text-400 text-xs">to</span>
          <EditorialDate value={toDate} onChange={setToDate} min={fromDate || undefined} placeholder="To" compact />
          <button onClick={() => { setFromDate(''); setToDate('') }} className="px-3 py-1 rounded text-xs font-medium bg-opt-yellow text-text-primary">FILTER</button>
          <span className="text-xs text-text-400">{filtered.length} days</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-border-default text-text-400 uppercase text-[9px]">
              <th className="px-2 py-1.5 text-left sticky left-0 bg-bg-card z-10 cursor-pointer" onClick={() => toggleSort('date')}>
                Date{sortKey === 'date' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
              </th>
              {dataCols.map((c, i) => c.k ? <TH key={i} k={c.k} label={c.label} /> : <th key={i} className="px-2 py-1.5 text-right whitespace-nowrap">{c.label}</th>)}
              <th className="px-2 py-1.5 w-14"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(e => {
              const isEd = editDate === e.date
              return (
                <tr key={e.date} className={`border-b border-border-default/30 hover:bg-bg-card-hover/50 group ${isEd ? 'bg-opt-yellow/5 border-opt-yellow/20' : ''}`}>
                  <td className={`px-2 py-1 font-medium whitespace-nowrap sticky left-0 z-10 ${isEd ? 'text-text-primary bg-opt-yellow/5' : 'text-text-primary bg-bg-card group-hover:bg-bg-card-hover/50'}`}>{e.date}</td>
                  {dataCols.map((c, i) => {
                    let val
                    if (c.calc) {
                      val = c.calc(e)
                    } else if (c.get) {
                      val = c.fmt(c.get(e))
                    } else {
                      val = c.fmt(c.k ? (typeof e[c.k] === 'string' ? parseFloat(e[c.k] || 0) : e[c.k]) : 0)
                    }
                    const clr = c.color ? c.color(e) : ''
                    return <td key={i} className={`px-2 py-1 text-right ${clr || 'text-text-400'}`}>{val}</td>
                  })}
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => startEdit(e)} className="w-6 h-6 rounded-md text-text-400 hover:text-text-primary hover:bg-opt-yellow/10 flex items-center justify-center transition-colors"><Edit3 size={11} /></button>
                      <button onClick={() => onDelete(e.date)} className="w-6 h-6 rounded-md text-text-400 hover:text-danger hover:bg-danger/10 flex items-center justify-center transition-colors"><Trash2 size={11} /></button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && <tr><td colSpan={20} className="px-3 py-8 text-center text-text-400">No data</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Edit panel */}
      {editDate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEditDate(null)}>
          <div className="tile tile-feedback w-full max-w-[520px] max-h-[85vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-border-default">
              <div className="flex items-center gap-2">
                <Edit3 size={14} className="text-text-primary" />
                <h3 className="text-sm font-semibold">Edit {editDate}</h3>
              </div>
              <button onClick={() => setEditDate(null)} className="text-text-400 hover:text-text-primary"><X size={14} /></button>
            </div>
            <div className="p-5 overflow-y-auto max-h-[calc(85vh-110px)] space-y-4">
              {editGroups.map(g => (
                <div key={g.label}>
                  <p className="text-[9px] uppercase tracking-widest text-text-400 font-medium mb-2">{g.label}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {g.fields.map(f => (
                      <div key={f.k} className="flex items-center gap-2">
                        <label className="text-[10px] text-text-400 w-24 shrink-0 truncate">{f.l}</label>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={editForm[f.k] ?? ''}
                          onChange={e => setEditForm(p => ({ ...p, [f.k]: e.target.value }))}
                          onBlur={e => {
                            const v = e.target.value.trim()
                            setEditForm(p => ({ ...p, [f.k]: v === '' ? 0 : Number(v) || 0 }))
                          }}
                          className="flex-1 bg-bg-primary border border-border-default rounded-lg px-2.5 py-1.5 text-xs text-text-primary text-right focus:border-opt-yellow/50 outline-none transition-colors"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-default">
              <button onClick={() => setEditDate(null)} className="px-4 py-1.5 text-xs text-text-400 border border-border-default rounded-lg hover:bg-bg-card-hover transition-colors">Cancel</button>
              <button onClick={saveEdit} disabled={saving} className="px-5 py-1.5 text-xs font-semibold bg-opt-yellow text-text-primary rounded-lg hover:brightness-110 disabled:opacity-50 transition-all">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

// ── Add Entry Modal ─────────────────────────────────────────────────
const manualFields = [
  { key: 'date', label: 'Date', type: 'date', full: true },
  { key: 'adspend', label: 'Ad Spend ($)', type: 'number', step: '0.01', group: 'Spend & Leads', auto: 'Meta Ads' },
  { key: 'leads', label: 'Total Leads', type: 'number', group: 'Spend & Leads', auto: 'GHL' },
  { key: 'auto_bookings', label: 'Auto Bookings', type: 'number', group: 'Bookings', auto: 'GHL' },
  { key: 'qualified_bookings', label: 'Qualified Bookings', type: 'number', group: 'Bookings', auto: 'GHL' },
  { key: 'calls_on_calendar', label: 'Calls on Calendar', type: 'number', group: 'Calls', auto: 'GHL' },
  { key: 'live_calls', label: 'Live Calls Taken', type: 'number', group: 'Calls', auto: 'EOD' },
  { key: 'offers', label: 'Offers Made', type: 'number', group: 'Calls', auto: 'EOD' },
  { key: 'closes', label: 'Total Closes', type: 'number', group: 'Calls', auto: 'EOD' },
  { key: 'trial_cash', label: 'Trial Cash Collected ($)', type: 'number', step: '0.01', group: 'Trial' },
  { key: 'trial_revenue', label: 'Trial Contracted Revenue ($)', type: 'number', step: '0.01', group: 'Trial' },
  { key: 'ascensions', label: 'Total Ascensions', type: 'number', group: 'Ascension' },
  { key: 'ascend_cash', label: 'Ascend Cash Collected ($)', type: 'number', step: '0.01', group: 'Ascension' },
  { key: 'ascend_revenue', label: 'Ascend Contracted Revenue ($)', type: 'number', step: '0.01', group: 'Ascension' },
  { key: 'finance_offers', label: 'Finance Offers Made', type: 'number', group: 'Ascension' },
  { key: 'finance_accepted', label: 'Finance Accepted', type: 'number', group: 'Ascension' },
  { key: 'monthly_offers', label: 'Monthly Payment Offers', type: 'number', group: 'Ascension' },
  { key: 'monthly_accepted', label: 'Monthly Accepted', type: 'number', group: 'Ascension' },
  { key: 'ar_collected', label: 'AR Collected ($)', type: 'number', step: '0.01', group: 'AR & Refunds' },
  { key: 'ar_defaulted', label: 'AR Defaulted ($)', type: 'number', step: '0.01', group: 'AR & Refunds' },
  { key: 'refund_count', label: 'Refunds/Disputes (#)', type: 'number', group: 'AR & Refunds' },
  { key: 'refund_amount', label: 'Refunds/Disputes ($)', type: 'number', step: '0.01', group: 'AR & Refunds' },
]

function AddEntryModal({ onSave, onClose }) {
  const [form, setForm] = useState({ date: todayET() })
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await onSave(form)
      toast.success(`Saved entry for ${form.date}`)
      onClose()
    } catch (err) {
      toast.error(`Save failed: ${err.message}`)
    }
    setSaving(false)
  }

  let lastGroup = ''
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="tile tile-feedback w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold">Add Daily Entry</h3>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="grid grid-cols-2 gap-3">
            {manualFields.map(f => {
              const showGroup = f.group && f.group !== lastGroup
              lastGroup = f.group
              return (
                <div key={f.key} className={f.full ? 'col-span-2' : ''}>
                  {showGroup && <p className="col-span-2 text-[10px] uppercase tracking-widest text-text-primary font-medium mt-2 mb-1 border-t border-border-default pt-2">{f.group}</p>}
                  <label className="text-[10px] uppercase text-text-400 block mb-0.5 flex items-center gap-1">
                    {f.label}
                    {f.auto && <span className="text-[8px] px-1 py-0 rounded bg-success/15 text-success normal-case">auto: {f.auto}</span>}
                  </label>
                  <input type={f.type} step={f.step} value={form[f.key] ?? ''}
                    onChange={e => setForm(p => ({ ...p, [f.key]: f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value }))}
                    className="w-full bg-bg-primary border border-border-default rounded px-3 py-1.5 text-sm text-text-primary" required={f.key === 'date'} />
                </div>
              )
            })}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-xs text-text-400 border border-border-default rounded">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-1.5 text-xs font-medium bg-opt-yellow text-text-primary rounded disabled:opacity-50">
              {saving ? 'Saving...' : 'Save Entry'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Benchmarks Modal ───────────────────────────────────────────────
const benchmarkDefs = [
  { key: 'cpl', label: 'CPL ($)' }, { key: 'lead_to_booking', label: 'Lead→Booking %' },
  { key: 'cpb', label: 'Cost Per Booking ($)' },
  { key: 'show_rate_new', label: 'Show Rate %' },
  { key: 'cost_per_live_call', label: 'Cost Per Live Call ($)' },
  { key: 'offer_rate', label: 'Offer Rate %' },
  { key: 'close_rate', label: 'Close Rate %' }, { key: 'cpa_trial', label: 'CPA Trial ($)' },
  { key: 'trial_fe_roas', label: 'Trial FE ROAS (x)' },
  { key: 'trial_uf_cash_pct', label: 'Trial Cash Collected %' },
  { key: 'ascend_rate', label: 'Ascend Rate %' }, { key: 'cpa_ascend', label: 'CPA Ascend ($)' },
  { key: 'ascend_uf_cash_pct', label: 'Ascend Cash Collected %' },
  { key: 'net_fe_roas', label: 'Net FE ROAS (x)' },
  { key: 'revenue_roas', label: 'Revenue ROAS (x)' }, { key: 'all_cash_roas', label: 'All Cash ROAS (x)' },
  { key: 'ar_success_rate', label: 'AR Success Rate %' },
]

function BenchmarksModal({ benchmarks, onSave, onClose }) {
  const [form, setForm] = useState({ ...benchmarks })
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const handleSave = async () => {
    setSaving(true)
    try {
      for (const d of benchmarkDefs) {
        if (form[d.key] != null && form[d.key] !== benchmarks[d.key]) await onSave(d.key, form[d.key])
      }
      toast.success('Benchmarks saved')
      onClose()
    } catch (err) {
      toast.error(`Save failed: ${err.message}`)
    }
    setSaving(false)
  }
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="tile tile-feedback w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold flex items-center gap-2"><SlidersHorizontal size={14} /> Edit Benchmarks</h3>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary"><X size={16} /></button>
        </div>
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {benchmarkDefs.map(d => (
            <div key={d.key} className="flex items-center gap-3">
              <label className="text-xs text-text-400 w-40 shrink-0">{d.label}</label>
              <input type="number" step="0.01" value={form[d.key] ?? ''}
                onChange={e => setForm(p => ({ ...p, [d.key]: e.target.value === '' ? 0 : Number(e.target.value) }))}
                className="flex-1 bg-bg-primary border border-border-default rounded px-3 py-1.5 text-sm text-text-primary" />
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-1.5 text-xs text-text-400 border border-border-default rounded">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-xs font-medium bg-opt-yellow text-text-primary rounded disabled:opacity-50">
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── CSV Parser ─────────────────────────────────────────────────────
const CSV_COL_MAP = {
  date: 'date', adspend: 'adspend', ad_spend: 'adspend', spend: 'adspend', total_adspend: 'adspend',
  leads: 'leads', total_leads: 'leads', new_leads: 'leads',
  auto_bookings: 'auto_bookings', auto_booking: 'auto_bookings',
  qualified_bookings: 'qualified_bookings', bookings: 'qualified_bookings', total_qualified_bookings: 'qualified_bookings', q_bookings: 'qualified_bookings',
  calls_on_calendar: 'calls_on_calendar', calendar_calls: 'calls_on_calendar', booked: 'calls_on_calendar', booked_calls: 'calls_on_calendar',
  live_calls: 'live_calls', live_calls_taken: 'live_calls', live: 'live_calls', shows: 'live_calls', showed: 'live_calls',
  new_live_calls: 'new_live_calls', net_live_calls: 'net_live_calls',
  offers: 'offers', offers_made: 'offers',
  closes: 'closes', total_closes: 'closes', closed: 'closes',
  reschedules: 'reschedules', rescheduled: 'reschedules', resch: 'reschedules',
  trial_cash: 'trial_cash', total_trial_cash_collected: 'trial_cash', trial_cash_collected: 'trial_cash', cash: 'trial_cash', cash_collected: 'trial_cash',
  trial_revenue: 'trial_revenue', trial_contracted_revenue_generated: 'trial_revenue', trial_contracted_revenue: 'trial_revenue', revenue: 'trial_revenue',
  ascensions: 'ascensions', total_ascensions: 'ascensions', ascended: 'ascensions',
  ascend_cash: 'ascend_cash', total_ascend_cash_collected: 'ascend_cash', ascend_cash_collected: 'ascend_cash',
  ascend_revenue: 'ascend_revenue', contracted_revenue_generated: 'ascend_revenue', ascend_contracted_revenue: 'ascend_revenue',
  finance_offers: 'finance_offers', finance_accepted: 'finance_accepted',
  monthly_offers: 'monthly_offers', monthly_accepted: 'monthly_accepted',
  ar_collected: 'ar_collected', total_ar_collected: 'ar_collected',
  ar_defaulted: 'ar_defaulted', total_defaulted: 'ar_defaulted',
  refund_count: 'refund_count', no_of_refunds__disputes: 'refund_count', refunds: 'refund_count',
  refund_amount: 'refund_amount', total_refunds__disputes_amount: 'refund_amount',
  no_shows: 'no_shows', noshow: 'no_shows', no_show: 'no_shows',
  cancelled_dtf: 'cancelled_dtf', cancelled_by_prospect: 'cancelled_by_prospect',
  net_new_calls: 'net_new_calls', net_fu_calls: 'net_fu_calls',
  notes: 'notes',
}

const CSV_TEMPLATE_COLS = ['date','adspend','leads','qualified_bookings','calls_on_calendar','live_calls','reschedules','offers','closes','trial_cash','trial_revenue','ascensions','ascend_cash','ascend_revenue','finance_offers','finance_accepted','ar_collected','notes']

function parseCSV(text) {
  // Handle both comma and tab delimited
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []
  const delimiter = lines[0].includes('\t') ? '\t' : ','
  const headers = lines[0].split(delimiter).map(h => h.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''))
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(delimiter).map(v => v.trim())
    if (vals.length < 2) continue
    const row = {}
    headers.forEach((h, j) => {
      const mapped = CSV_COL_MAP[h]
      if (mapped && vals[j] !== undefined && vals[j] !== '') {
        if (mapped === 'date') {
          // Normalize date formats: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD
          let d = vals[j]
          if (d.includes('/')) {
            const parts = d.split('/')
            if (parts[2]?.length === 4) {
              // Could be DD/MM/YYYY or MM/DD/YYYY — assume DD/MM for non-US
              d = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`
            }
          }
          row.date = d
        } else if (mapped === 'notes') {
          row[mapped] = vals[j]
        } else {
          const raw = vals[j].replace(/[$,%x"]/g, '').trim()
          // Skip empty cells and zeros — don't overwrite existing data with nothing
          if (raw === '' || raw === '-') return
          const num = Number(raw)
          if (isNaN(num)) return
          // Dollar fields stay as decimals, everything else must be integer
          const dollarFields = ['adspend','trial_cash','trial_revenue','ascend_cash','ascend_revenue','ar_collected','ar_defaulted','refund_amount']
          row[mapped] = dollarFields.includes(mapped) ? num : Math.round(num)
        }
      }
    })
    if (row.date) rows.push(row)
  }
  return rows
}

function downloadTemplate() {
  const csv = CSV_TEMPLATE_COLS.join(',') + '\n2026-01-01,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,\n'
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'marketing_tracker_template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

function CSVImportModal({ onClose, onImport }) {
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const fileInputRef = useRef(null)

  const colLabels = {
    adspend: 'Spend', leads: 'Leads', qualified_bookings: 'Q.Book', calls_on_calendar: 'Booked',
    live_calls: 'Net Live', new_live_calls: 'New Live', net_live_calls: 'Net Live', reschedules: 'Resch',
    offers: 'Offers', closes: 'Closes', trial_cash: 'T.Cash', trial_revenue: 'T.Rev',
    ascensions: 'Asc', ascend_cash: 'A.Cash', ascend_revenue: 'A.Rev',
    finance_offers: 'Fin.Ofr', finance_accepted: 'Fin.Acc', ar_collected: 'AR',
    auto_bookings: 'A.Book', no_shows: 'No Show', notes: 'Notes',
  }

  const fmtVal = (v, col) => {
    if (v === undefined || v === null) return '—'
    if (['adspend','trial_cash','trial_revenue','ascend_cash','ascend_revenue','ar_collected','refund_amount'].includes(col))
      return `$${Number(v).toLocaleString()}`
    return String(v)
  }

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLoading(true)
    setError(null)
    try {
      const rows = parseCSV(await file.text())
      if (!rows.length) { setError('No valid rows found. Check the CSV format.'); setPreview(null); setLoading(false); return }

      // Get all columns from CSV
      const cols = new Set()
      for (const r of rows) Object.keys(r).forEach(k => k !== 'date' && cols.add(k))
      const colList = [...cols]
      const dates = rows.map(r => r.date).sort()

      // Fetch existing entries for these dates
      const { data: existing } = await supabase
        .from('marketing_tracker')
        .select('*')
        .in('date', rows.map(r => r.date))
      const existingMap = {}
      for (const e of (existing || [])) existingMap[e.date] = e

      // Build diff: for each row, show what's changing
      let newCount = 0
      let overwriteCount = 0
      const changes = []

      for (const row of rows) {
        const ex = existingMap[row.date]
        if (!ex) {
          newCount++
          changes.push({ date: row.date, type: 'new', row })
        } else {
          const diffs = []
          for (const col of colList) {
            if (row[col] === undefined) continue
            const oldVal = ex[col] ?? 0
            const newVal = row[col]
            if (Number(oldVal) !== Number(newVal) && !(col === 'notes' && oldVal === newVal)) {
              diffs.push({ col, old: oldVal, new: newVal })
            }
          }
          if (diffs.length > 0) {
            overwriteCount++
            changes.push({ date: row.date, type: 'update', row, diffs })
          } else {
            changes.push({ date: row.date, type: 'unchanged', row })
          }
        }
      }

      setPreview({ rows, cols: colList, dateRange: [dates[0], dates[dates.length - 1]], changes, newCount, overwriteCount })
    } catch (err) {
      setError('Parse error: ' + err.message)
      setPreview(null)
    }
    setLoading(false)
  }

  const handleImport = () => {
    if (!preview?.rows?.length) return
    onImport(preview.rows)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="tile tile-feedback w-full max-w-[640px] max-h-[85vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-default">
          <div className="flex items-center gap-2">
            <Upload size={16} className="text-text-primary" />
            <h3 className="text-sm font-semibold">Import Historical Data</h3>
          </div>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary"><X size={14} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto max-h-[calc(85vh-60px)]">
          {/* Upload area */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-border-default rounded-sm p-6 text-center cursor-pointer hover:border-opt-yellow/40 transition-colors"
          >
            <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt" onChange={handleFile} className="hidden" />
            <Upload size={24} className="mx-auto text-text-400 mb-2" />
            <p className="text-sm text-text-secondary">{preview ? 'Upload a different file' : 'Click to upload a CSV file'}</p>
            <p className="text-[10px] text-text-400 mt-1">Supports .csv and .tsv — dates, spend, leads, live calls, closes, ascensions, etc.</p>
          </div>

          {/* Template download */}
          <button onClick={downloadTemplate} className="text-[11px] text-text-primary hover:underline">
            Download CSV template with all supported columns
          </button>

          {loading && <div className="flex items-center justify-center py-4"><Loader size={16} className="animate-spin text-text-primary" /><span className="text-xs text-text-400 ml-2">Comparing with existing data...</span></div>}

          {error && <p className="text-xs text-danger bg-danger/10 rounded-lg px-3 py-2">{error}</p>}

          {/* Preview with diff */}
          {preview && (
            <div className="space-y-3">
              {/* Summary */}
              <div className="bg-bg-primary rounded-sm p-3">
                <h4 className="text-xs font-semibold text-text-primary mb-2">Import Summary</h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <div><span className="text-text-400">Rows:</span> <strong>{preview.rows.length}</strong></div>
                  <div><span className="text-text-400">Date range:</span> <strong>{preview.dateRange[0]} → {preview.dateRange[1]}</strong></div>
                  <div><span className="text-text-400">New entries:</span> <strong className="text-success">{preview.newCount}</strong></div>
                  <div><span className="text-text-400">Will overwrite:</span> <strong className={preview.overwriteCount > 0 ? 'text-text-primary' : ''}>{preview.overwriteCount}</strong></div>
                </div>
                <div className="mt-2">
                  <span className="text-[10px] text-text-400">Matched columns:</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {preview.cols.map(c => (
                      <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success">{colLabels[c] || c}</span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Overwrite diff */}
              {preview.overwriteCount > 0 && (
                <div className="bg-bg-primary rounded-sm p-3">
                  <h4 className="text-xs font-semibold text-text-primary mb-2">Values Being Overwritten</h4>
                  <p className="text-[10px] text-text-400 mb-2">CSV data will replace these existing values:</p>
                  <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                    {preview.changes.filter(c => c.type === 'update').map((c, i) => (
                      <div key={i} className="bg-bg-card rounded-lg px-3 py-2 border border-border-default/50">
                        <span className="text-[10px] font-semibold text-text-primary">{c.date}</span>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                          {c.diffs.map((d, j) => (
                            <span key={j} className="text-[10px]">
                              <span className="text-text-400">{colLabels[d.col] || d.col}: </span>
                              <span className="text-danger line-through">{fmtVal(d.old, d.col)}</span>
                              <span className="text-text-400 mx-0.5">→</span>
                              <span className="text-success font-medium">{fmtVal(d.new, d.col)}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* New entries preview */}
              {preview.newCount > 0 && (
                <div className="bg-bg-primary rounded-sm p-3">
                  <h4 className="text-xs font-semibold text-success mb-2">New Entries ({preview.newCount})</h4>
                  <div className="overflow-x-auto">
                    <table className="text-[10px] w-full">
                      <thead>
                        <tr>
                          <th className="text-left px-1.5 py-1 text-text-400">Date</th>
                          {preview.cols.slice(0, 8).map(c => (
                            <th key={c} className="text-right px-1.5 py-1 text-text-400">{colLabels[c] || c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.changes.filter(c => c.type === 'new').slice(0, 5).map((c, i) => (
                          <tr key={i} className="border-t border-border-default/30">
                            <td className="px-1.5 py-1 text-text-primary">{c.date}</td>
                            {preview.cols.slice(0, 8).map(col => (
                              <td key={col} className="text-right px-1.5 py-1">{fmtVal(c.row[col], col)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {preview.newCount > 5 && <p className="text-[9px] text-text-400 mt-1">+ {preview.newCount - 5} more new entries</p>}
                  </div>
                </div>
              )}

              {/* Confirmation */}
              <div className="text-[10px] bg-opt-yellow/5 border border-opt-yellow/20 rounded-lg px-3 py-2">
                <strong className="text-text-primary">CSV data takes priority.</strong>
                <span className="text-text-400"> Non-empty CSV values will override existing data. Empty cells and zeros in the CSV are skipped — they won't wipe existing data.</span>
              </div>

              <button
                onClick={handleImport}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-sm bg-opt-yellow text-text-primary font-semibold text-sm hover:brightness-110 transition-all"
              >
                <Check size={14} />
                Confirm Import — {preview.rows.length} entries
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Generic drill-down modal ───────────────────────────────────────
// Opens when the user clicks a KPI on the Marketing page (Net Live,
// Booked, Resch+Cancel, Leads). Each KPI passes its own `kind` and the
// modal runs the matching fetcher + column layout.
//
// Fetchers all accept a `range` (numeric days, 'mtd', or {from,to}) and
// return an array of plain objects. Range is resolved to ET-anchored
// from/to so all users see the same window.
function resolveRange(range) {
  const today = todayET()
  if (range === 'mtd') return { from: today.slice(0, 7) + '-01', to: today }
  if (range && typeof range === 'object' && range.from) return { from: range.from, to: range.to }
  const days = typeof range === 'number' ? range : 30
  return { from: etDateOffset(-Math.max(0, days - 1)), to: today }
}

async function fetchLiveCalls({ from, to }) {
  const { data: reports } = await supabase
    .from('closer_eod_reports')
    .select('id, report_date, closer:team_members!closer_eod_reports_closer_id_fkey(name)')
    .gte('report_date', from).lte('report_date', to).eq('is_confirmed', true)
  const reportIds = (reports || []).map(r => r.id)
  const reportMap = Object.fromEntries((reports || []).map(r => [r.id, r]))
  if (reportIds.length === 0) return []
  const { data: callRows } = await supabase
    .from('closer_calls')
    .select('eod_report_id, prospect_name, call_type, outcome, revenue, cash_collected')
    .in('eod_report_id', reportIds)
    .in('outcome', ['not_closed', 'closed'])
    .eq('call_type', 'new_call') // "Net New" = NEW CALLS only (no follow-ups, no ascensions)
  const rows = (callRows || []).map(c => ({
    date: reportMap[c.eod_report_id]?.report_date,
    closer: reportMap[c.eod_report_id]?.closer?.name || '—',
    type: c.call_type,
    prospect: c.prospect_name || '—',
    email: null,
    outcome: c.outcome,
    revenue: c.revenue,
    cash: c.cash_collected,
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  await enrichRowsWithProspectEmails(rows)
  return rows
}

async function fetchCloses({ from, to }) {
  // Every closed deal in window — closes only (not ascensions). Includes both
  // new_call and follow_up call types since a follow-up that closes is still
  // a marketing-attributed close.
  const { data: reports } = await supabase
    .from('closer_eod_reports')
    .select('id, report_date, closer:team_members!closer_eod_reports_closer_id_fkey(name)')
    .gte('report_date', from).lte('report_date', to).eq('is_confirmed', true)
  const reportIds = (reports || []).map(r => r.id)
  const reportMap = Object.fromEntries((reports || []).map(r => [r.id, r]))
  if (reportIds.length === 0) return []
  const { data: callRows } = await supabase
    .from('closer_calls')
    .select('eod_report_id, prospect_name, call_type, outcome, revenue, cash_collected, offered_finance')
    .in('eod_report_id', reportIds)
    .eq('outcome', 'closed')
    .neq('call_type', 'ascension')
  return (callRows || []).map(c => ({
    date: reportMap[c.eod_report_id]?.report_date,
    closer: reportMap[c.eod_report_id]?.closer?.name || '—',
    type: c.call_type,
    prospect: c.prospect_name || '—',
    revenue: c.revenue,
    cash: c.cash_collected,
    finance: c.offered_finance ? 'yes' : 'no',
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

async function fetchAscensions({ from, to }) {
  // Every ascension in window — call_type = 'ascension'. Includes both ascended
  // and not-ascended outcomes so the user can see the full ascension funnel.
  const { data: reports } = await supabase
    .from('closer_eod_reports')
    .select('id, report_date, closer:team_members!closer_eod_reports_closer_id_fkey(name)')
    .gte('report_date', from).lte('report_date', to).eq('is_confirmed', true)
  const reportIds = (reports || []).map(r => r.id)
  const reportMap = Object.fromEntries((reports || []).map(r => [r.id, r]))
  if (reportIds.length === 0) return []
  const { data: callRows } = await supabase
    .from('closer_calls')
    .select('eod_report_id, prospect_name, call_type, outcome, revenue, cash_collected, offered_finance')
    .in('eod_report_id', reportIds)
    .eq('call_type', 'ascension')
  return (callRows || []).map(c => ({
    date: reportMap[c.eod_report_id]?.report_date,
    closer: reportMap[c.eod_report_id]?.closer?.name || '—',
    prospect: c.prospect_name || '—',
    outcome: c.outcome,
    revenue: c.revenue,
    cash: c.cash_collected,
    finance: c.offered_finance ? 'yes' : 'no',
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

async function fetchBookings({ from, to }) {
  // Every strategy-calendar booking made in window (by booked_at), DEDUPED
  // by prospect (ghl_contact_id). If Khaled books 3 times in the window, he
  // counts as 1. Earliest booking in the window wins so the displayed call
  // date matches the prospect's first commitment, not their latest reshuffle.
  const { data } = await supabase
    .from('ghl_appointments')
    .select('contact_name, calendar_name, booked_at, appointment_date, revenue_tier, appointment_status, ghl_contact_id')
    .in('calendar_name', STRATEGY_CALL_CALENDARS)
    .neq('appointment_status', 'cancelled')
    .gte('booked_at', from).lte('booked_at', to + ' 23:59:59')
  const byContact = new Map()
  for (const r of data || []) {
    // Use ghl_contact_id as the dedupe key; fall back to contact_name for
    // legacy rows missing the contact link.
    const key = r.ghl_contact_id || `name:${r.contact_name}`
    const existing = byContact.get(key)
    if (!existing || (r.booked_at || '') < (existing.booked_at || '')) {
      byContact.set(key, r)
    }
  }
  return [...byContact.values()].map(r => ({
    booked: String(r.booked_at).split(' ')[0].split('T')[0],
    prospect: r.contact_name,
    revenue_tier: r.revenue_tier,
    appt_date: r.appointment_date,
    is_dq: DQ_BOOKING_CALENDARS.includes(r.calendar_name) || (r.revenue_tier ? isDQRevenueTier(r.revenue_tier) : false),
  })).sort((a, b) => (b.booked || '').localeCompare(a.booked || ''))
}

async function fetchReschCancel({ from, to }) {
  const { data: reports } = await supabase
    .from('closer_eod_reports')
    .select('id, report_date, closer:team_members!closer_eod_reports_closer_id_fkey(name)')
    .gte('report_date', from).lte('report_date', to).eq('is_confirmed', true)
  const reportIds = (reports || []).map(r => r.id)
  const reportMap = Object.fromEntries((reports || []).map(r => [r.id, r]))
  if (reportIds.length === 0) return []
  const { data: callRows } = await supabase
    .from('closer_calls')
    .select('eod_report_id, prospect_name, call_type, outcome')
    .in('eod_report_id', reportIds)
    .in('outcome', ['rescheduled', 'canceled'])
  return (callRows || []).map(c => ({
    date: reportMap[c.eod_report_id]?.report_date,
    closer: reportMap[c.eod_report_id]?.closer?.name || '—',
    type: c.call_type,
    prospect: c.prospect_name || '—',
    outcome: c.outcome,
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

async function fetchLeads({ from, to }) {
  // Pull live from GHL — we don't cache opportunities locally. SCIO USA only.
  // Slow first call (~3-8s for 30d) but accurate.
  const SCIO_USA = 'ZN1DW9S9qS540PNAXSxa'
  const headers = {
    Authorization: `Bearer ${import.meta.env.VITE_GHL_API_KEY}`,
    Version: '2021-07-28',
  }
  const BASE = 'https://services.leadconnectorhq.com'
  const LOC = import.meta.env.VITE_GHL_LOCATION_ID
  let all = []
  let startAfterId = null, startAfter = null
  for (let p = 0; p < 50; p++) {
    const params = new URLSearchParams({ location_id: LOC, pipeline_id: SCIO_USA, limit: '100' })
    if (startAfterId) { params.set('startAfterId', startAfterId); params.set('startAfter', String(startAfter)) }
    const r = await fetch(`${BASE}/opportunities/search?${params}`, { headers })
    if (!r.ok) break
    const j = await r.json()
    all = all.concat(j.opportunities || [])
    if (!j.meta?.startAfterId || (j.opportunities || []).length === 0) break
    startAfterId = j.meta.startAfterId; startAfter = j.meta.startAfter
  }
  return all
    .filter(o => {
      const d = (o.createdAt || '').split('T')[0]
      return d >= from && d <= to
    })
    .map(o => ({
      created: (o.createdAt || '').split('T')[0],
      name: o.contact?.name || o.name || '—',
      email: o.contact?.email || '—',
      phone: o.contact?.phone || '—',
      source: o.source || '—',
      stage: o.pipelineStageId || '—',
    }))
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
}

const DRILLDOWN_CONFIG = {
  live: {
    title: 'Net New Calls',
    subtitle: 'Closer EOD reports · NEW calls only (no follow-ups, no ascensions) · outcome = not_closed or closed',
    fetcher: fetchLiveCalls,
    columns: [
      { key: 'date', label: 'Date', cls: 'tabular-nums' },
      { key: 'closer', label: 'Closer', cls: 'text-text-primary' },
      { key: 'type', label: 'Type', cls: 'text-[10px] uppercase text-text-400' },
      { key: 'prospect', label: 'Prospect', cls: 'text-text-primary' },
      { key: 'email', label: 'Email', render: r => r.email
        ? <a href={`mailto:${r.email}`} className="text-text-primary hover:underline" onClick={e => e.stopPropagation()}>{r.email}</a>
        : <span className="text-text-400/60">—</span> },
      { key: 'outcome', label: 'Outcome', render: r => <span className={r.outcome === 'closed' ? 'text-success' : 'text-text-secondary'}>{r.outcome}</span> },
      { key: 'revenue', label: 'Revenue', align: 'right', render: r => r.revenue ? `$${parseFloat(r.revenue).toLocaleString()}` : '—' },
      { key: 'cash', label: 'Cash', align: 'right', render: r => r.cash ? `$${parseFloat(r.cash).toLocaleString()}` : '—' },
    ],
    emptyMsg: 'No live calls logged in this window. Closers may have filed aggregate-only EODs without per-row data.',
  },
  bookings: {
    title: 'Bookings',
    subtitle: 'Every strategy-calendar booking made in this window (by booked_at)',
    fetcher: fetchBookings,
    columns: [
      { key: 'booked', label: 'Booked', cls: 'tabular-nums' },
      { key: 'prospect', label: 'Prospect', cls: 'text-text-primary' },
      { key: 'revenue_tier', label: 'Revenue', render: r => r.revenue_tier || '—' },
      { key: 'appt_date', label: 'Call Date', cls: 'tabular-nums text-text-400' },
      { key: 'is_dq', label: 'Type', render: r => r.is_dq
        ? <span className="text-orange-400 text-[10px] uppercase">DQ</span>
        : <span className="text-success text-[10px] uppercase">Qual</span> },
    ],
    emptyMsg: 'No strategy bookings in this window.',
  },
  rc: {
    title: 'Reschedules + Cancellations',
    subtitle: 'Closer EOD reports · outcome = rescheduled or canceled',
    fetcher: fetchReschCancel,
    columns: [
      { key: 'date', label: 'Date', cls: 'tabular-nums' },
      { key: 'closer', label: 'Closer', cls: 'text-text-primary' },
      { key: 'type', label: 'Type', cls: 'text-[10px] uppercase text-text-400' },
      { key: 'prospect', label: 'Prospect', cls: 'text-text-primary' },
      { key: 'outcome', label: 'Outcome', render: r => r.outcome === 'canceled'
        ? <span className="text-orange-400">Canceled</span>
        : <span className="text-text-secondary">Rescheduled</span> },
    ],
    emptyMsg: 'No reschedules or cancellations in this window.',
  },
  leads: {
    title: 'Leads',
    subtitle: 'New opportunities in SCIO USA pipeline (created in this window)',
    fetcher: fetchLeads,
    columns: [
      { key: 'created', label: 'Date', cls: 'tabular-nums' },
      { key: 'name', label: 'Name', cls: 'text-text-primary' },
      { key: 'email', label: 'Email', cls: 'text-text-400 text-[10px]' },
      { key: 'phone', label: 'Phone', cls: 'text-text-400 text-[10px]' },
      { key: 'source', label: 'Source', cls: 'text-text-400 text-[10px]' },
    ],
    emptyMsg: 'No leads in this window.',
    slowFirstLoad: true,
  },
  closes: {
    title: 'Closes',
    subtitle: 'Closer EOD reports · outcome = closed · ascensions excluded',
    fetcher: fetchCloses,
    columns: [
      { key: 'date', label: 'Date', cls: 'tabular-nums' },
      { key: 'closer', label: 'Closer', cls: 'text-text-primary' },
      { key: 'type', label: 'Type', cls: 'text-[10px] uppercase text-text-400' },
      { key: 'prospect', label: 'Prospect', cls: 'text-text-primary' },
      { key: 'revenue', label: 'Revenue', align: 'right', render: r => r.revenue ? `$${parseFloat(r.revenue).toLocaleString()}` : '—' },
      { key: 'cash', label: 'Cash', align: 'right', render: r => r.cash ? `$${parseFloat(r.cash).toLocaleString()}` : '—' },
      { key: 'finance', label: 'Finance', cls: 'text-[10px] uppercase text-text-400' },
    ],
    emptyMsg: 'No closes in this window.',
  },
  ascensions: {
    title: 'Ascensions',
    subtitle: 'Closer EOD reports · call_type = ascension (all outcomes)',
    fetcher: fetchAscensions,
    columns: [
      { key: 'date', label: 'Date', cls: 'tabular-nums' },
      { key: 'closer', label: 'Closer', cls: 'text-text-primary' },
      { key: 'prospect', label: 'Prospect', cls: 'text-text-primary' },
      { key: 'outcome', label: 'Outcome', render: r => <span className={r.outcome === 'ascended' ? 'text-success' : 'text-text-secondary'}>{r.outcome}</span> },
      { key: 'revenue', label: 'Revenue', align: 'right', render: r => r.revenue ? `$${parseFloat(r.revenue).toLocaleString()}` : '—' },
      { key: 'cash', label: 'Cash', align: 'right', render: r => r.cash ? `$${parseFloat(r.cash).toLocaleString()}` : '—' },
      { key: 'finance', label: 'Finance', cls: 'text-[10px] uppercase text-text-400' },
    ],
    emptyMsg: 'No ascensions in this window.',
  },
}

// Normalize a prospect/contact name for fuzzy matching across closer EOD rows
// (e.g. "Joseph Guaracino - RestorationConnect Strategy Call") and GHL contact
// records (e.g. "Joseph Guaracino"). Strips trailing calendar suffixes.
function normalizeProspectName(name) {
  if (!name) return ''
  return name
    .toLowerCase()
    .trim()
    .replace(/\s*[-–—]\s*(remodeler|restoration|plumber|remodel|service|pool)connect.*$/i, '')
    .replace(/\s*[-–—]\s*(strategy|intro|discovery).*call.*$/i, '')
    .replace(/\s+x\s+\w+\b.*/i, '') // "Jesus x Daniel ..."
    .replace(/\s*[-–—]\s*remodel(ing|er)?\s*ai.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Bulk-enrich an array of call rows with the matched contact's email address.
//
// Mutates rows in place — sets `row.email` when a match is found.
//
// Email source preference (in order):
//   1. ghl_appointments.contact_email  — direct from GHL sync, most reliable
//      since every strategy call has a booking with the email attached.
//   2. clients.email                   — for prospects who closed and became
//      clients (prospect_name often becomes the client name).
//   3. ghl_contacts_cache.email        — last-resort fallback for any matched
//      contact_id whose appointment row was synced before the email column
//      was populated.
//
// Match logic for #1 and #3: appointment_date within ±14 days of the call
// date AND fuzzy contact_name match (full overlap or first+last name match).
// When multiple appointments match, closest by date wins.
async function enrichRowsWithProspectEmails(rows) {
  if (!rows?.length) return

  const dates = rows.map(r => r.date).filter(Boolean).sort()
  if (dates.length === 0) return
  const fmt = dt => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`
  const minDate = new Date(dates[0] + 'T00:00:00'); minDate.setDate(minDate.getDate() - 14)
  const maxDate = new Date(dates[dates.length - 1] + 'T00:00:00'); maxDate.setDate(maxDate.getDate() + 14)

  // Single wide pull — appointments carry contact_email directly, so no
  // second hop required for the common case.
  const { data: appts } = await supabase
    .from('ghl_appointments')
    .select('ghl_contact_id, contact_name, contact_email, appointment_date')
    .gte('appointment_date', fmt(minDate))
    .lte('appointment_date', fmt(maxDate))
    .limit(5000)

  const matchScore = (norm, candidate) => {
    if (!norm || !candidate) return false
    if (candidate === norm || candidate.includes(norm) || norm.includes(candidate)) return true
    const np = norm.split(/\s+/), cp = candidate.split(/\s+/)
    return np.length > 1 && cp.length > 1
      && np[0] === cp[0]
      && np[np.length - 1] === cp[cp.length - 1]
  }

  const unresolvedContactIds = new Set()
  const rowToContactId = new Map()

  for (const row of rows) {
    const norm = normalizeProspectName(row.prospect)
    if (!norm || norm.length < 2) continue
    const candidates = []
    for (const a of (appts || [])) {
      const an = normalizeProspectName(a.contact_name)
      if (!matchScore(norm, an)) continue
      const dDiff = Math.abs((new Date(a.appointment_date) - new Date(row.date)) / 86400000)
      candidates.push({ appt: a, dDiff })
    }
    if (candidates.length === 0) continue
    candidates.sort((a, b) => a.dDiff - b.dDiff)
    const best = candidates[0].appt
    if (best.contact_email && best.contact_email.includes('@')) {
      row.email = best.contact_email
    } else if (best.ghl_contact_id) {
      // Appointment row has no email but we know the contact_id — queue for
      // ghl_contacts_cache fallback below.
      rowToContactId.set(row, best.ghl_contact_id)
      unresolvedContactIds.add(best.ghl_contact_id)
    }
  }

  // Fallback path 1 — ghl_contacts_cache for any contact_id we couldn't
  // resolve via appointment.contact_email.
  if (unresolvedContactIds.size > 0) {
    const { data: contacts } = await supabase
      .from('ghl_contacts_cache')
      .select('id, email')
      .in('id', [...unresolvedContactIds])
      .not('email', 'is', null)
    const emailMap = Object.fromEntries((contacts || []).map(c => [c.id, c.email]))
    for (const row of rows) {
      if (row.email) continue
      const cid = rowToContactId.get(row)
      if (cid && emailMap[cid]) row.email = emailMap[cid]
    }
  }

  // Fallback path 2 — clients table for prospects who closed and became
  // active clients. Matches by client.name (fuzzy).
  const stillUnresolved = rows.filter(r => !r.email)
  if (stillUnresolved.length > 0) {
    const { data: clients } = await supabase
      .from('clients')
      .select('name, email')
      .not('email', 'is', null)
      .limit(2000)
    if (clients?.length) {
      for (const row of stillUnresolved) {
        const norm = normalizeProspectName(row.prospect)
        if (!norm || norm.length < 2) continue
        const hit = clients.find(c => matchScore(norm, normalizeProspectName(c.name)))
        if (hit?.email) row.email = hit.email
      }
    }
  }

  // Fallback path 3 — direct GHL contact lookup for any row we have a
  // contact_id for but still no email. The ghl_appointments sync drops
  // contact_email on roughly 89% of rows; pulling the contact directly
  // from GHL covers the gap. We backfill the result into both
  // ghl_appointments and ghl_contacts_cache so subsequent loads are fast.
  const ghlLookups = []
  for (const row of rows) {
    if (row.email) continue
    const cid = rowToContactId.get(row)
    if (cid) ghlLookups.push({ row, cid })
  }
  if (ghlLookups.length > 0) {
    const cacheUpserts = []
    // Parallel batches of 5 to respect GHL rate limits.
    for (let i = 0; i < ghlLookups.length; i += 5) {
      const batch = ghlLookups.slice(i, i + 5)
      await Promise.all(batch.map(async ({ row, cid }) => {
        try {
          const r = await ghlFetch(`${BASE_URL}/contacts/${cid}`)
          if (!r.ok) return
          const d = await r.json()
          const c = d.contact || d
          const email = c.email || (c.emails && c.emails[0])
          if (email && email.includes('@')) {
            row.email = email
            cacheUpserts.push({
              id: cid,
              name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || null,
              email,
              synced_at: new Date().toISOString(),
            })
          }
        } catch (e) { void e }
      }))
    }
    if (cacheUpserts.length > 0) {
      // Backfill ghl_contacts_cache + ghl_appointments.contact_email so the
      // next render skips the GHL hop entirely. Fire-and-forget — failures
      // here don't affect the user-visible result.
      supabase.from('ghl_contacts_cache')
        .upsert(cacheUpserts, { onConflict: 'id' })
        .then(({ error }) => { if (error) console.warn('contacts cache backfill failed:', error) })
      for (const c of cacheUpserts) {
        supabase.from('ghl_appointments')
          .update({ contact_email: c.email })
          .eq('ghl_contact_id', c.id)
          .is('contact_email', null)
          .then(() => {}, () => {})
        supabase.from('ghl_appointments')
          .update({ contact_email: c.email })
          .eq('ghl_contact_id', c.id)
          .eq('contact_email', '')
          .then(() => {}, () => {})
      }
    }
  }
}

function DrilldownModal({ kind, range, onClose }) {
  const config = DRILLDOWN_CONFIG[kind]
  const [rows, setRows] = useState(null)
  useEffect(() => {
    if (!config) return
    let cancelled = false
    setRows(null)
    config.fetcher(resolveRange(range))
      .then(r => { if (!cancelled) setRows(r) })
      .catch(e => { if (!cancelled) { console.warn(`${kind} drilldown failed:`, e); setRows([]) } })
    return () => { cancelled = true }
  }, [kind, range, config])

  if (!config) return null

  const rangeLabel = range === 'mtd'
    ? 'MTD'
    : (range && typeof range === 'object' && range.from)
      ? `${range.from} → ${range.to}`
      : `Last ${range}d`

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-sm max-w-4xl w-full max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-default">
          <div>
            <h2 className="text-sm font-semibold">{config.title}</h2>
            <p className="text-[10px] text-text-400">{rangeLabel} &middot; {config.subtitle}</p>
          </div>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {rows == null && <div className="p-6 text-center text-text-400 text-xs">{config.slowFirstLoad ? 'Fetching from GHL — may take a few seconds…' : 'Loading…'}</div>}
          {rows != null && rows.length === 0 && <div className="p-6 text-center text-text-400 text-xs">{config.emptyMsg}</div>}
          {rows != null && rows.length > 0 && (
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-bg-card border-b border-border-default text-[9px] uppercase tracking-wider text-text-400">
                <tr>
                  {config.columns.map(c => (
                    <th key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-border-default/30">
                    {config.columns.map(c => (
                      <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : 'text-left'} ${c.cls || ''}`}>
                        {c.render ? c.render(row) : (row[c.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-5 py-2 text-[10px] text-text-400/80 border-t border-border-default">
          <span>{rows != null && `${rows.length} row${rows.length === 1 ? '' : 's'} shown`}</span>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────
export default function MarketingPerformance() {
  const { entries, benchmarks, loading, upsertEntry, upsertMany, updateBenchmark, deleteEntry, reload } = useMarketingTracker()
  const [range, setRange] = useState(30)
  const [showAddEntry, setShowAddEntry] = useState(false)
  const [showBenchmarks, setShowBenchmarks] = useState(false)
  const [drilldown, setDrilldown] = useState(null) // 'live' | 'bookings' | 'rc' | 'leads' | 'closes' | 'ascensions' | null
  const [importStatus, setImportStatus] = useState(null)
  const [showImportModal, setShowImportModal] = useState(false)
  const fileRef = useRef(null)
  const toast = useToast()

  // Auto-sync EOD data on page load (silent, no loading spinner)
  const autoSyncRan = useRef(false)
  useEffect(() => {
    if (autoSyncRan.current || loading) return
    autoSyncRan.current = true
    ;(async () => {
      try {
        const { syncEODToTracker } = await import('../hooks/useMarketingTracker')
        await syncEODToTracker()
        await reload()
      } catch (e) { console.warn('Auto-sync failed:', e) }
    })()
  }, [loading])

  // Bookings split (all vs qualified vs DQ) for the Spend & Lead Acquisition
  // KPIs. Pulled live from ghl_appointments. Each appointment row carries the
  // prospect's monthly-revenue tier (synced from the GHL contact's custom
  // field by syncGHLAppointments) — the DQ split is "$0-$30,000" tier ⇒ DQ.
  // This is more accurate than splitting by calendar ID because the same
  // calendar can hold both qualified and DQ bookings (e.g. RestorationConnect
  // Strategy Call gets both direct and form-DQ-routed prospects).
  //
  // Falls back to calendar-ID classification if revenue_tier is null (older
  // rows synced before the column landed).
  // Per-date booking records (NOT pre-counted). Each entry is the list of
  // appointments on that date with the contact_id attached, so window-level
  // sums can dedupe by prospect (Khaled booking 3 times = 1 prospect).
  const [bookingsByDate, setBookingsByDate] = useState({}) // { 'YYYY-MM-DD': [{contactKey, isDq, contactName}] }
  // Same dataset, bucketed by appointment_date (call held date). Used for
  // cohort show rate so numerator and denominator clock the same event.
  const [cohortBookingsByDate, setCohortBookingsByDate] = useState({})
  // Lead-cohort bucketing: each booking attributed to its LEAD's createdAt
  // (via ghl_opportunities mirror — see migration 055). Makes Q.Book ≤ Leads
  // by definition, so L→Q% becomes a real conversion rate. Falls back to
  // booked_at when no opportunity is found for the contact.
  const [leadCohortBookingsByDate, setLeadCohortBookingsByDate] = useState({})
  useEffect(() => {
    let cancelled = false
    async function loadBookings() {
      // 730-day window matches the "2y" preset on both the Marketing
      // and Ads pages, and matches useCloserCallProspectMetrics.
      // Prior 90-day cap silently returned {all:0, qualified:0, dq:0}
      // for any custom range with `from` older than 90 days — and
      // because bk.qualified is the denominator for Gross/Net Show%,
      // Reschedule%, and Cancel%, all four tiles collapsed to 0%
      // without warning whenever Ben picked a long custom range.
      const since = new Date()
      since.setDate(since.getDate() - 730)
      const sinceStr = since.toISOString().split('T')[0]
      const todayStr = new Date().toISOString().split('T')[0]

      // Parallel pull: appointments + opportunity mirror (for lead-cohort).
      // Opportunities are populated by syncMetaToTracker → fetchGHLLeadsByDate.
      // If the mirror is empty (migration 055 not yet applied), leadDate
      // map below is empty and the bucketing falls back to booked_at —
      // i.e. behaves identically to before.
      const [{ data, error }, { data: oppRows, error: oppErr }] = await Promise.all([
        supabase
          .from('ghl_appointments')
          .select('booked_at, appointment_date, calendar_name, revenue_tier, ghl_contact_id, contact_name')
          .or(`booked_at.gte.${sinceStr},appointment_date.gte.${sinceStr}`)
          .neq('appointment_status', 'cancelled')
          .in('calendar_name', STRATEGY_CALL_CALENDARS),
        supabase
          .from('ghl_opportunities')
          .select('ghl_contact_id, created_at')
          .gte('created_at', sinceStr),
      ])
      if (cancelled) return
      if (error) { console.warn('Bookings load failed:', error.message); return }
      if (oppErr) console.warn('ghl_opportunities load failed (falling back to booked_at):', oppErr.message)

      // contact_id → earliest opportunity createdAt. If a contact has
      // multiple opportunities, earliest wins so bookings attribute to
      // the first time they entered the pipeline.
      const leadDateByContact = {}
      for (const o of (oppRows || [])) {
        if (!o.ghl_contact_id || !o.created_at) continue
        const d = String(o.created_at).split('T')[0]
        const prev = leadDateByContact[o.ghl_contact_id]
        if (!prev || d < prev) leadDateByContact[o.ghl_contact_id] = d
      }

      const map = {}
      const cohortMap = {}
      const leadCohortMap = {}
      for (const a of data || []) {
        const dqByTier = a.revenue_tier ? isDQRevenueTier(a.revenue_tier) : null
        const dqByCalendar = DQ_BOOKING_CALENDARS.includes(a.calendar_name)
        const isDq = dqByTier !== null ? dqByTier : dqByCalendar
        const contactKey = a.ghl_contact_id || `name:${a.contact_name || 'unknown'}`
        // Keep the human-readable name for cross-contact-id duplicate
        // detection (e.g. "Mike White" and "Michael" booked as separate
        // GHL contacts — same person, two contact_ids).
        const contactName = a.contact_name || ''

        // booked_at-bucketed
        const rawBooked = a.booked_at || a.appointment_date
        if (rawBooked) {
          const d = String(rawBooked).split(' ')[0].split('T')[0]
          if (d >= sinceStr && d <= todayStr) {
            if (!map[d]) map[d] = []
            map[d].push({ contactKey, isDq, contactName })
          }
        }

        // appointment_date-bucketed (cap at today — exclude future calls)
        const rawApt = a.appointment_date
        if (rawApt) {
          const d = String(rawApt).split(' ')[0].split('T')[0]
          if (d >= sinceStr && d <= todayStr) {
            if (!cohortMap[d]) cohortMap[d] = []
            cohortMap[d].push({ contactKey, isDq, contactName })
          }
        }

        // Lead-cohort-bucketed (booking attributed to its LEAD's createdAt).
        // Falls back to booked_at when no opportunity is known for the
        // contact (orphan booking — e.g. Calendly direct, no pipeline op).
        const leadDate = leadDateByContact[a.ghl_contact_id]
        const cohortDate = leadDate || (rawBooked ? String(rawBooked).split(' ')[0].split('T')[0] : null)
        if (cohortDate && cohortDate >= sinceStr && cohortDate <= todayStr) {
          if (!leadCohortMap[cohortDate]) leadCohortMap[cohortDate] = []
          leadCohortMap[cohortDate].push({ contactKey, isDq, contactName })
        }
      }
      setBookingsByDate(map)
      setCohortBookingsByDate(cohortMap)
      setLeadCohortBookingsByDate(leadCohortMap)
    }
    loadBookings()
    return () => { cancelled = true }
  }, [])

  // Cross-contact-id duplicate detector. The bk.qualified count dedupes
  // by ghl_contact_id — but the same person can appear in GHL as two
  // separate contacts (e.g. "Mike White - RestorationConnect" via Calendly
  // and "Michael" via a webhook lead). Both contact_ids count, inflating
  // bookings by 1 per duplicate pair. We can't safely auto-merge (real
  // different people share names), but we CAN flag candidates and ask
  // Ben to merge in GHL.
  //
  // Conservative match: same normalized last name AND first names that
  // are recognized nicknames OR start with the same first letter. List
  // of common nickname pairs is small and intentional — anything else
  // is left alone to avoid collapsing different people.
  //
  // Strip Calendly calendar suffixes ("- RestorationConnect Strategy
  // Call", " and OPT Digital", " and Daniel Gomez De La Vega") before
  // comparing — those are calendar metadata, not part of the name.
  const NICKNAMES = [
    ['mike', 'michael'], ['mick', 'michael'],
    ['rob', 'robert'], ['bob', 'robert'], ['bobby', 'robert'],
    ['jim', 'james'], ['jimmy', 'james'],
    ['bill', 'william'], ['billy', 'william'], ['will', 'william'],
    ['rick', 'richard'], ['dick', 'richard'], ['rich', 'richard'],
    ['dan', 'daniel'], ['danny', 'daniel'],
    ['dave', 'david'],
    ['chris', 'christopher'], ['chris', 'christian'],
    ['matt', 'matthew'], ['nick', 'nicholas'], ['tom', 'thomas'],
    ['joe', 'joseph'], ['joey', 'joseph'],
    ['tony', 'anthony'], ['ed', 'edward'], ['eddie', 'edward'],
    ['steve', 'stephen'], ['steve', 'steven'],
    ['sam', 'samuel'], ['sammy', 'samuel'],
    ['ben', 'benjamin'], ['benny', 'benjamin'],
    ['greg', 'gregory'], ['fred', 'frederick'], ['ted', 'theodore'],
    ['pat', 'patrick'], ['phil', 'philip'], ['hal', 'harold'],
    ['cliff', 'clifford'], ['gabe', 'gabriel'],
  ]
  const nicknameKey = (first) => {
    const f = first.toLowerCase()
    for (const [a, b] of NICKNAMES) {
      if (f === a || f === b) return `${a}/${b}`
    }
    return f
  }
  // Strip noise from contact_name. Calendly stuffs the calendar name into
  // the contact field; we want just the prospect's actual name tokens.
  const stripBookingSuffix = (raw) => {
    if (!raw) return ''
    return raw
      .replace(/\s*-\s*(restorationconnect|remodelerconnect|plumberconnect|poolconnect|opt digital)?[^,]*$/i, '')
      .replace(/\s+and\s+(opt digital|daniel\s+gomez.*)$/i, '')
      .trim()
  }
  const detectDuplicateBookings = useCallback((days) => {
    const filterDate = (() => {
      if (days === 'mtd') {
        const todayStr = todayET()
        const start = todayStr.slice(0, 7) + '-01'
        return d => d >= start
      }
      if (days && typeof days === 'object' && days.from) return d => d >= days.from && d <= days.to
      const sinceStr = etDateOffset(-Math.max(0, days - 1))
      return d => d >= sinceStr
    })()
    // Collect unique contacts (post contact_id dedup) in the window
    const seen = new Map() // contactKey -> { rawName, normFirst, normLast }
    for (const [d, list] of Object.entries(bookingsByDate)) {
      if (!filterDate(d)) continue
      for (const b of list) {
        if (seen.has(b.contactKey)) continue
        const clean = stripBookingSuffix(b.contactName)
        const tokens = clean.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).filter(Boolean)
        if (!tokens.length) continue
        const first = tokens[0]
        const last  = tokens.length > 1 ? tokens[tokens.length - 1] : ''
        seen.set(b.contactKey, { rawName: b.contactName, normFirst: first, normLast: last })
      }
    }
    // Group by (nicknameKey, last). Anything with > 1 contactKey is a
    // candidate duplicate.
    const groups = new Map()
    for (const [cid, info] of seen.entries()) {
      if (!info.normLast) continue  // single-token names can't be safely matched
      const k = `${nicknameKey(info.normFirst)}|${info.normLast}`
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push({ contactKey: cid, name: info.rawName })
    }
    const dupes = []
    for (const [k, arr] of groups.entries()) {
      if (arr.length > 1) dupes.push({ key: k, members: arr })
    }
    // Edge case: also surface single-token first-name-only contacts that
    // match the last name of a multi-token contact. E.g. "Mike White" + "Mike".
    // Walk all seen with no last name and check if their first name matches
    // (or nickname-matches) someone we already have.
    const singletons = [...seen.entries()].filter(([, v]) => !v.normLast)
    for (const [cid, info] of singletons) {
      const nick = nicknameKey(info.normFirst)
      for (const [otherCid, otherInfo] of seen.entries()) {
        if (otherCid === cid) continue
        if (!otherInfo.normLast) continue
        if (nicknameKey(otherInfo.normFirst) === nick) {
          // Group them under the multi-token person's key
          const k = `${nick}|${otherInfo.normLast}*`
          let grp = dupes.find(g => g.key === k)
          if (!grp) { grp = { key: k, members: [{ contactKey: otherCid, name: otherInfo.rawName }] }; dupes.push(grp) }
          if (!grp.members.find(m => m.contactKey === cid)) {
            grp.members.push({ contactKey: cid, name: info.rawName, noLastName: true })
          }
        }
      }
    }
    return dupes
  }, [bookingsByDate])

  // Sum a per-date bookings map over the same window the rest of the page uses.
  // Anchored to ET (matches filterByDays above) so all users see the same
  // window regardless of their browser timezone.
  // Count UNIQUE prospects (by ghl_contact_id) whose booked_at falls in the
  // window. A prospect who books 3 times in the window counts once. Splits
  // into qualified vs DQ based on the most-recent classification — if any of
  // the prospect's bookings landed on a qualified calendar, they're qualified.
  const sumBookings = useCallback((days) => {
    const filterDate = (() => {
      if (days === 'mtd') {
        const todayStr = todayET()
        const start = todayStr.slice(0, 7) + '-01'
        return d => d >= start
      }
      if (days && typeof days === 'object' && days.from) return d => d >= days.from && d <= days.to
      const sinceStr = etDateOffset(-Math.max(0, days - 1))
      return d => d >= sinceStr
    })()
    const seen = new Map() // contactKey -> { isDq } (qualified wins over DQ)
    for (const [d, list] of Object.entries(bookingsByDate)) {
      if (!filterDate(d)) continue
      for (const b of list) {
        const existing = seen.get(b.contactKey)
        if (!existing) seen.set(b.contactKey, { isDq: b.isDq })
        else if (existing.isDq && !b.isDq) seen.set(b.contactKey, { isDq: false })
      }
    }
    let all = 0, qualified = 0, dq = 0
    for (const v of seen.values()) {
      all++
      if (v.isDq) dq++
      else qualified++
    }
    return { all, qualified, dq }
  }, [bookingsByDate])

  // Same dedupe rule but on appointment_date (call-held) buckets. Used for
  // cohort show rate so numerator (lives) and denominator (scheduled calls)
  // both clock the same event AND both count unique prospects.
  const sumCohortBookings = useCallback((days) => {
    const filterDate = (() => {
      if (days === 'mtd') {
        const todayStr = todayET()
        const start = todayStr.slice(0, 7) + '-01'
        return d => d >= start
      }
      if (days && typeof days === 'object' && days.from) return d => d >= days.from && d <= days.to
      const sinceStr = etDateOffset(-Math.max(0, days - 1))
      return d => d >= sinceStr
    })()
    const seen = new Map()
    for (const [d, list] of Object.entries(cohortBookingsByDate)) {
      if (!filterDate(d)) continue
      for (const b of list) {
        const existing = seen.get(b.contactKey)
        if (!existing) seen.set(b.contactKey, { isDq: b.isDq })
        else if (existing.isDq && !b.isDq) seen.set(b.contactKey, { isDq: false })
      }
    }
    let all = 0, qualified = 0, dq = 0
    for (const v of seen.values()) {
      all++
      if (v.isDq) dq++
      else qualified++
    }
    return { all, qualified, dq }
  }, [cohortBookingsByDate])

  // Lead-cohort booking sum: count unique prospects whose LEAD's createdAt
  // fell in the window, regardless of when they booked. Pairs with stats.leads
  // (also bucketed by lead createdAt) so L→Q% = qualified / stats.leads is a
  // true conversion rate where Q.Book is always ≤ Leads.
  //
  // When migration 055 hasn't been applied yet, leadCohortBookingsByDate is
  // empty and this returns { all:0, qualified:0, dq:0 } — the callsite then
  // falls back to bk.qualified (booked_at-bucketed) and caps the ratio at
  // 100%, preserving prior behavior.
  const sumLeadCohortBookings = useCallback((days) => {
    const filterDate = (() => {
      if (days === 'mtd') {
        const todayStr = todayET()
        const start = todayStr.slice(0, 7) + '-01'
        return d => d >= start
      }
      if (days && typeof days === 'object' && days.from) return d => d >= days.from && d <= days.to
      const sinceStr = etDateOffset(-Math.max(0, days - 1))
      return d => d >= sinceStr
    })()
    const seen = new Map()
    for (const [d, list] of Object.entries(leadCohortBookingsByDate)) {
      if (!filterDate(d)) continue
      for (const b of list) {
        const existing = seen.get(b.contactKey)
        if (!existing) seen.set(b.contactKey, { isDq: b.isDq })
        else if (existing.isDq && !b.isDq) seen.set(b.contactKey, { isDq: false })
      }
    }
    let all = 0, qualified = 0, dq = 0
    for (const v of seen.values()) {
      all++
      if (v.isDq) dq++
      else qualified++
    }
    return { all, qualified, dq }
  }, [leadCohortBookingsByDate])

  const rangeEntries = useMemo(() => filterByDays(entries, range), [entries, range])
  const mtdEntries = useMemo(() => filterByDays(entries, 'mtd'), [entries])
  const prevEntries = useMemo(() => filterPreviousPeriod(entries, range), [entries, range])

  // Per-call prospect-deduped close-rate. Single source of truth shared
  // with CloserOverview / CloserDetail / SalesOverview. Replaces the
  // self-reported EOD summary counters which drift from the actual
  // call rows the closer entered.
  const { byRange: prospectMetricsByRange } = useCloserCallProspectMetrics()

  // Helper: apply prospect-deduped overrides to a computed stats bundle.
  // We override new_live_calls and closes (and recompute close_rate +
  // cpa_trial) so the Marketing page now reports the same numbers as the
  // Closer dashboard. Other ratios that depend on closes (ascend_rate,
  // trial cash per close, etc.) follow automatically.
  // Accepts either a numeric day count, 'mtd', or { from, to }. byRange now
  // accepts the same union so custom historical ranges use the exact same
  // window as the filterByDays() data view above.
  const applyProspectMetrics = (statsBundle, rangeOrDays) => {
    if (!statsBundle) return statsBundle
    const pm = prospectMetricsByRange(rangeOrDays)
    const liveProspects = pm.liveProspects
    const closedProspects = pm.closedProspects
    // Only override when we actually have call-row data; if a window had
    // no closer_calls rows, keep the original numbers.
    if (liveProspects === 0 && closedProspects === 0) return statsBundle
    const new_live_calls = liveProspects
    const closes = closedProspects
    const close_rate = new_live_calls > 0 ? (closes / new_live_calls) * 100 : 0
    const cpa_trial = closes > 0 ? statsBundle.adspend / closes : 0
    const ascend_rate = closes > 0 ? (statsBundle.ascensions / closes) * 100 : 0
    const trial_cash_per_close = closes > 0 ? statsBundle.trial_cash / closes : 0
    // CRITICAL: every derived field that divided by t.new_live_calls or
    // t.closes inside computeMarketingStats is now stale because we just
    // swapped the denominator. If we don't recompute them here, the live
    // page shows cost_per_new_live_call against EOD-count while the What-If
    // cascade (which reads stats.new_live_calls — the OVERRIDDEN value)
    // computes against the deduped count. That mismatch is the 2026-05-14
    // bug Ben hit: increasing adspend made cost/new APPEAR to drop because
    // the baseline divisor was smaller than the cascade's divisor.
    const denom = new_live_calls
    const nc = statsBundle.nc_booked || 0
    const cancels = statsBundle.cancels || 0
    const reschedules = statsBundle.reschedules || 0
    const netDenom = Math.max(0, nc - cancels - reschedules)
    // Also override live_calls (NC + FU combined denominator used by
    // offer_rate). We scale the original NC+FU total by the same factor
    // we just applied to NC, preserving the FU contribution. Without
    // this, Offer Rate read against the un-overridden EOD live_calls
    // while every other rate read against the deduped denominator —
    // same drift class as the cost_per_new_live_call bug Ben hit.
    const origNew = statsBundle.new_live_calls_original ?? statsBundle.new_live_calls ?? 0
    const fuRatio = origNew > 0 ? (statsBundle.live_calls || 0) / origNew : 1
    const live_calls = Math.round(new_live_calls * fuRatio)
    // no_shows recompute precedes no_show_rate so we can reuse the value.
    const no_shows = statsBundle.no_shows > 0
      ? statsBundle.no_shows
      : Math.max(0, nc - denom - cancels - reschedules)
    return {
      ...statsBundle,
      new_live_calls,
      new_live_calls_original: origNew,  // preserved for downstream consumers
      live_calls,
      closes,
      close_rate,
      cpa_trial,
      ascend_rate,
      trial_cash_per_close,
      no_shows,
      // Recomputed against overridden denominators so every tile reads
      // from the same numerator the cascade uses.
      cost_per_new_live_call: denom > 0 ? statsBundle.adspend / denom : 0,
      cost_per_live_call:     live_calls > 0 ? statsBundle.adspend / live_calls : 0,
      offer_rate:             live_calls > 0 ? ((statsBundle.offers || 0) / live_calls) * 100 : 0,
      cost_per_offer: statsBundle.offers > 0 ? statsBundle.adspend / statsBundle.offers : (statsBundle.cost_per_offer || 0),
      gross_show_rate: nc > 0 ? Math.min(100, (denom / nc) * 100) : 0,
      net_show_rate: netDenom > 0 ? Math.min(100, (denom / netDenom) * 100) : 0,
      show_rate: nc > 0 ? Math.min(100, (denom / nc) * 100) : 0,
      no_show_rate: nc > 0 ? (no_shows / nc) * 100 : 0,
      _prospect_metrics_applied: true,
    }
  }

  // MTD = first-of-month → today (variable day count). For everything else,
  // `range` is already a day count.
  const mtdDays = useMemo(() => new Date().getDate(), [])
  // Custom date ranges arrive as { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }.
  // Previously this fell through to 30 days, which meant byRange(30) was
  // called for the prospect-metrics override on every custom window — the
  // 30-day numerator silently replaced the actual window's closes count.
  // Compute the real span in days for custom ranges so prospect-metrics
  // and the displayed window agree.
  const rangeDays = useMemo(() => {
    if (typeof range === 'number') return range
    if (range === 'mtd') return new Date().getDate()
    if (range && typeof range === 'object' && range.from && range.to) {
      const ms = new Date(range.to + 'T23:59:59Z') - new Date(range.from + 'T00:00:00Z')
      return Math.max(1, Math.round(ms / 86400000) + 1)
    }
    return 30
  }, [range])

  // Pass the raw `range` (number | 'mtd' | { from, to }) to applyProspectMetrics
  // so byRange filters on the SAME window as filterByDays. Passing rangeDays
  // (a number) for custom { from, to } ranges previously misaligned the
  // prospect-metrics window with the displayed entries.
  // Surface useCloserCallProspectMetrics.outOfWindow so a date range
  // older than the 730-day fetch window doesn't silently zero out
  // closer_calls-derived counts. The hook now returns this flag; we
  // render a banner above the dashboard when it fires.
  const prospectWindow = useMemo(() => prospectMetricsByRange(range), [range, prospectMetricsByRange])
  const stats = useMemo(() => applyProspectMetrics(computeMarketingStats(rangeEntries), range), [rangeEntries, range, prospectMetricsByRange])
  const stats30 = useMemo(() => applyProspectMetrics(computeMarketingStats(filterByDays(entries, 30)), 30), [entries, prospectMetricsByRange])
  const statsMTD = useMemo(() => applyProspectMetrics(computeMarketingStats(mtdEntries), 'mtd'), [mtdEntries, prospectMetricsByRange])
  // Previous-period stats now ALSO pass through applyProspectMetrics so
  // the per-tile ▲▼ arrows compare like-for-like (deduped current vs
  // deduped prev). The useCloserCallProspectMetrics hook fetches a
  // 730-day window so the prior-period sub-window is always covered.
  // Without this, the period-over-period delta on Close Rate /
  // Cost/New / CPA was structurally biased: current used per-call
  // truth, prev used EOD self-report. Tiles routinely showed
  // "+15%" or "-20%" purely from source switch, not real change.
  // Prior-period {from,to} window matching the current range's shape.
  // For numeric ranges (7d/30d/90d/...) the prior is the SAME length
  // immediately before the current window. For 'mtd' the prior is the
  // previous calendar month, capped at today's day-of-month so a
  // mid-month comparison isn't pre-empted by future calendar dates.
  // For explicit {from,to} we mirror the same length backwards.
  const prevRange = useMemo(() => {
    const toDateStr = (d) => d.toISOString().slice(0, 10)
    if (range && typeof range === 'object' && range.from && range.to) {
      const fromD = new Date(range.from + 'T00:00:00Z')
      const toD   = new Date(range.to   + 'T00:00:00Z')
      const lenMs = Math.max(0, toD - fromD)
      const prevTo   = new Date(fromD.getTime() - 86400000)
      const prevFrom = new Date(prevTo.getTime() - lenMs)
      return { from: toDateStr(prevFrom), to: toDateStr(prevTo) }
    }
    if (range === 'mtd') {
      const today = new Date()
      const firstPrev   = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 1, 1))
      const sameDayPrev = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 1, today.getDate()))
      const lastDayPrev = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 0))
      const cap = Math.min(sameDayPrev.getTime(), lastDayPrev.getTime())
      return { from: toDateStr(firstPrev), to: toDateStr(new Date(cap)) }
    }
    const n = typeof range === 'number' ? range : 30
    const today = new Date()
    const prevTo   = new Date(today.getTime() - n * 86400000)
    const prevFrom = new Date(today.getTime() - 2 * n * 86400000 + 86400000)
    return { from: toDateStr(prevFrom), to: toDateStr(prevTo) }
  }, [range])
  const statsPrev = useMemo(() => applyProspectMetrics(computeMarketingStats(prevEntries), prevRange), [prevEntries, prevRange, prospectMetricsByRange])
  // Hoisted calendar-deduped booking totals — same numbers the live
  // Bookings/Q.Books KPI tiles render. whatIfStats baselines from these so
  // toggling What-If doesn't silently swap data source (EOD self-report
  // had `stats.qualified_bookings=10` while the displayed tile read
  // `bk.qualified=13` from the GHL calendar, making any what-if look like
  // bookings "fell" purely from activating the panel).
  const bk = useMemo(() => sumBookings(range), [sumBookings, range])
  const bk30 = useMemo(() => sumBookings(30), [sumBookings])
  // Lead-cohort booking counts — bookings attributed to the date their
  // LEAD was created. Used for the L→Q% conversion tile so numerator and
  // denominator share a cohort (leads created in window → of those, how
  // many booked). When migration 055 hasn't been applied yet, these
  // collapse to 0 and the L→Q% tile falls back to the booked_at numbers.
  const bkLeadCohort = useMemo(() => sumLeadCohortBookings(range), [sumLeadCohortBookings, range])
  const bkLeadCohort30 = useMemo(() => sumLeadCohortBookings(30), [sumLeadCohortBookings])
  // Possible duplicate prospects in the current window (same person
  // booked under multiple ghl_contact_ids — e.g. "Mike White" + "Michael").
  // Surfaced as a banner above the bookings tiles so Ben can merge in GHL.
  const possibleDupes = useMemo(() => detectDuplicateBookings(range), [detectDuplicateBookings, range])
  const bm = benchmarks

  // What-If state — cascading funnel forecast (debounced to avoid lag)
  const [whatIfActive, setWhatIfActive] = useState(false)
  const [whatIfOverrides, setWhatIfOverrides] = useState({})
  const [whatIfDraft, setWhatIfDraft] = useState({})
  const whatIfTimer = useRef(null)
  const updateWhatIf = useCallback((key, value) => {
    setWhatIfDraft(prev => ({ ...prev, [key]: value }))
    clearTimeout(whatIfTimer.current)
    whatIfTimer.current = setTimeout(() => {
      startTransition(() => {
        setWhatIfOverrides(prev => ({ ...prev, [key]: value }))
      })
    }, 400)
  }, [])
  // Helper: which KPIs should reflect a what-if delta? A what-if overlay
  // on a metric is only meaningful if the user overrode something UPSTREAM
  // of that metric in the funnel. Otherwise it's a phantom delta.
  //
  //   Funnel: adspend → leads → bookings → nc_booked → new_live → offers → closes → ascensions
  //
  // If user only overrides new_live_calls, downstream metrics (offers/
  // closes/ascensions) get the overlay; upstream (bookings/leads/adspend)
  // do not. The KPI render below uses these guards to pass whatIf={null}
  // when the metric shouldn't visually change.
  const hasOverride = (...keys) => keys.some(k => whatIfOverrides[k] != null && whatIfOverrides[k] !== '')
  const upstream = {
    leads:    () => hasOverride('adspend', 'leads', 'cpl'),
    bookings: () => hasOverride('adspend', 'leads', 'qualified_bookings', 'nc_booked', 'cpb', 'lead_to_booking_pct'),
    live:     () => hasOverride('adspend', 'leads', 'qualified_bookings', 'nc_booked', 'show_rate', 'new_live_calls', 'live_calls'),
    offers:   () => upstream.live() || hasOverride('offer_rate', 'offers'),
    closes:   () => upstream.live() || hasOverride('close_rate', 'closes'),
    trial:    () => upstream.closes() || hasOverride('trial_cash', 'trial_revenue'),
    ascend:   () => upstream.closes() || hasOverride('ascend_rate', 'ascensions', 'ascend_cash', 'ascend_revenue'),
  }
  // Convenience: wrap a what-if value so it returns null unless the
  // relevant upstream override is set. Use as `gated(upstream.bookings, wf?.qualified_bookings)`.
  const gated = (gate, val) => gate() ? val : null

  const whatIfStats = useMemo(() => {
    if (!whatIfActive || !Object.keys(whatIfOverrides).length) return null
    const o = whatIfOverrides
    const get = (key) => (o[key] !== '' && o[key] != null) ? parseFloat(o[key]) : null

    // BASELINE source-of-truth alignment — the displayed Bookings / Q.Books
    // KPI tiles read from `bk` (calendar-deduped GHL appointments), NOT from
    // `stats.qualified_bookings` (closer EOD self-report). If whatIfStats
    // baselines from stats.qualified_bookings, toggling What-If swaps the
    // numerator silently and any cascade looks like bookings "fell." We use
    // bk as the universe and keep stats.qualified_bookings only as the
    // EOD-derived show denominator (nc_booked logic below).
    const baseQualifiedBookings = bk?.qualified ?? stats.qualified_bookings
    const baseAllBookings = bk?.all ?? stats.qualified_bookings

    // Funnel driver is `new_live_calls` (NEW only) to match
    // computeMarketingStats: close_rate / show_rate / cost_per_new use the
    // NEW-only denominator; only offer_rate uses Net Live (NEW + FU). Net Live
    // is derived from new_live_calls via the FU ratio so offer_rate stays
    // consistent with stats.
    // Strict denominator: matches computeMarketingStats (uses t.nc_booked
    // only). When nc_booked is 0 the canonical shows 0% — falling back to
    // qualified_bookings here would diverge from the displayed baseline.
    const showDenomCur = stats.nc_booked || 0
    const curShowRate = showDenomCur > 0 ? stats.new_live_calls / showDenomCur : 0.5
    const curOfferRate = stats.live_calls > 0 ? stats.offers / stats.live_calls : 0.8
    const curCloseRate = stats.new_live_calls > 0 ? stats.closes / stats.new_live_calls : 0.25
    const curAscendRate = stats.closes > 0 ? stats.ascensions / stats.closes : 0.5
    const curAvgTrialCash = stats.closes > 0 ? stats.trial_cash / stats.closes : 1000
    const curAvgTrialRev = stats.closes > 0 ? stats.trial_revenue / stats.closes : 1000
    const curAvgAscCash = stats.ascensions > 0 ? stats.ascend_cash / stats.ascensions : 3000
    const curAvgAscRev = stats.ascensions > 0 ? stats.ascend_revenue / stats.ascensions : 9000
    const curFuRatio = stats.new_live_calls > 0 ? stats.live_calls / stats.new_live_calls : 1
    // nc_booked ↔ Q.Books ratio. Calendar-sourced baseQualifiedBookings is
    // the universe; the closer EOD nc_booked is a subset that excludes
    // future-dated bookings. Ratio lets us scale nc_booked if user moves
    // qualified_bookings.
    const curNcToQbRatio = baseQualifiedBookings > 0
      ? (stats.nc_booked || baseQualifiedBookings) / baseQualifiedBookings
      : 1
    // All-bookings ↔ Q.Books ratio for cascading Bookings when only Q.Books
    // is overridden (or vice versa).
    const curAllToQbRatio = baseQualifiedBookings > 0 ? baseAllBookings / baseQualifiedBookings : 1

    // Cascade
    const adspend = get('adspend') ?? stats.adspend
    const leads = get('leads') ?? stats.leads
    const qualified_bookings = get('qualified_bookings') ?? baseQualifiedBookings
    // All bookings (qualified + DQ) — scales with qualified_bookings unless
    // explicitly overridden. Used by the Bookings tile + Cost/Booking.
    const all_bookings = qualified_bookings !== baseQualifiedBookings
      ? Math.round(qualified_bookings * curAllToQbRatio)
      : baseAllBookings

    // Closer-EOD bookings (denominator for show rates). When user overrides
    // qualified_bookings, scale nc_booked proportionally so show-rate math
    // tracks. Direct override also supported.
    const nc_booked = get('nc_booked')
      ?? (get('qualified_bookings') != null
        ? Math.round(qualified_bookings * curNcToQbRatio)
        : (stats.nc_booked || 0))
    const showDenom = nc_booked

    // Show rate: override % or keep current
    const showRateOverride = get('show_rate')
    const showRate = showRateOverride != null ? showRateOverride / 100 : curShowRate

    // New live calls (NEW only): override directly, OR cascade from
    // showDenom * showRate
    const new_live_calls = get('new_live_calls')
      ?? (get('nc_booked') != null || get('qualified_bookings') != null || showRateOverride != null
        ? Math.round(showDenom * showRate)
        : stats.new_live_calls)

    // Net Live (NEW + FU) — derived from new_live_calls using current FU ratio
    // unless user supplies an explicit override
    const live_calls = get('live_calls')
      ?? (new_live_calls !== stats.new_live_calls
        ? Math.round(new_live_calls * curFuRatio)
        : stats.live_calls)

    // Offer rate (denominator = Net Live, matches stats)
    const offerRateOverride = get('offer_rate')
    const offerRate = offerRateOverride != null ? offerRateOverride / 100 : curOfferRate
    const offers = get('offers')
      ?? (live_calls !== stats.live_calls || offerRateOverride != null
        ? Math.round(live_calls * offerRate)
        : stats.offers)

    // Close rate (denominator = New Live, matches stats)
    const closeRateOverride = get('close_rate')
    const closeRate = closeRateOverride != null ? closeRateOverride / 100 : curCloseRate
    const closes = get('closes')
      ?? (new_live_calls !== stats.new_live_calls || closeRateOverride != null
        ? Math.round(new_live_calls * closeRate)
        : stats.closes)

    // Trial financials
    const trial_cash = get('trial_cash') ?? (closes !== stats.closes ? Math.round(closes * curAvgTrialCash) : stats.trial_cash)
    const trial_revenue = get('trial_revenue') ?? (closes !== stats.closes ? Math.round(closes * curAvgTrialRev) : stats.trial_revenue)

    // Ascension
    const ascendRateOverride = get('ascend_rate')
    const ascRate = ascendRateOverride != null ? ascendRateOverride / 100 : curAscendRate
    const ascensions = get('ascensions') ?? (closes !== stats.closes || ascendRateOverride != null
      ? Math.round(closes * ascRate)
      : stats.ascensions)
    const ascend_cash = get('ascend_cash') ?? (ascensions !== stats.ascensions ? Math.round(ascensions * curAvgAscCash) : stats.ascend_cash)
    const ascend_revenue = get('ascend_revenue') ?? (ascensions !== stats.ascensions ? Math.round(ascensions * curAvgAscRev) : stats.ascend_revenue)

    // Non-cascading
    const reschedules = stats.reschedules
    const cancels = stats.cancels || 0
    const ar_collected = stats.ar_collected
    const ar_defaulted = stats.ar_defaulted
    const auto_bookings = get('auto_bookings') ?? stats.auto_bookings
    const finance_offers = stats.finance_offers
    const finance_accepted = stats.finance_accepted

    const all_cash = trial_cash + ascend_cash + ar_collected
    return {
      adspend, leads, auto_bookings, qualified_bookings, nc_booked, new_live_calls, live_calls, offers, closes,
      // Bookings ALL (qualified + DQ) — the Bookings KPI tile renders bk.all,
      // not stats.qualified_bookings. Returning all_bookings as a dedicated
      // field lets the tile compare like-for-like.
      bookings_all: all_bookings,
      trial_cash, trial_revenue, ascensions, ascend_cash, ascend_revenue,
      reschedules, cancels, ar_collected, ar_defaulted,
      cancelled_dtf: stats.cancelled_dtf || 0, cancelled_by_prospect: stats.cancelled_by_prospect || 0,
      finance_offers, finance_accepted,
      // Derived — formulas mirror computeMarketingStats so equal inputs ⇒ equal outputs
      cpl: leads > 0 ? adspend / leads : 0,
      lead_to_booking_pct: leads > 0 ? (qualified_bookings / leads) * 100 : 0,
      // Cost/Booking divides by ALL bookings (matches the live Cost/Booking
      // tile which uses bk.all). Cost/Q.Book divides by qualified.
      cpb_all: all_bookings > 0 ? adspend / all_bookings : 0,
      cpb: qualified_bookings > 0 ? adspend / qualified_bookings : 0,
      cost_per_auto_booking: auto_bookings > 0 ? adspend / auto_bookings : 0,
      gross_show_rate: showDenom > 0 ? Math.min(100, (new_live_calls / showDenom) * 100) : 0,
      net_show_rate: (() => {
        const net = showDenom - cancels - reschedules
        return net > 0 ? Math.min(100, (new_live_calls / net) * 100) : 0
      })(),
      no_shows: (stats.no_shows > 0 && new_live_calls === stats.new_live_calls && showDenom === showDenomCur)
        ? stats.no_shows
        : Math.max(0, showDenom - new_live_calls - cancels - reschedules),
      reschedule_rate: qualified_bookings > 0 ? (reschedules / qualified_bookings) * 100 : 0,
      cost_per_live_call: live_calls > 0 ? adspend / live_calls : 0,
      cost_per_new_live_call: new_live_calls > 0 ? adspend / new_live_calls : 0,
      offer_rate: live_calls > 0 ? (offers / live_calls) * 100 : 0,
      cost_per_offer: offers > 0 ? adspend / offers : 0,
      close_rate: new_live_calls > 0 ? (closes / new_live_calls) * 100 : 0,
      cpa_trial: closes > 0 ? adspend / closes : 0,
      trial_cash_pct: trial_revenue > 0 ? (trial_cash / trial_revenue) * 100 : 0,
      trial_fe_roas: adspend > 0 ? trial_cash / adspend : 0,
      ascend_rate: closes > 0 ? (ascensions / closes) * 100 : 0,
      cpa_ascend: ascensions > 0 ? adspend / ascensions : 0,
      ascend_cash_pct: ascend_revenue > 0 ? (ascend_cash / ascend_revenue) * 100 : 0,
      finance_pct: ascensions > 0 ? (finance_accepted / ascensions) * 100 : 0,
      net_fe_roas: adspend > 0 ? (trial_cash + ascend_cash) / adspend : 0,
      revenue_roas: adspend > 0 ? (trial_revenue + ascend_revenue) / adspend : 0,
      ar_success_rate: (ar_collected + ar_defaulted) > 0 ? (ar_collected / (ar_collected + ar_defaulted)) * 100 : 0,
      all_cash,
      all_cash_roas: adspend > 0 ? all_cash / adspend : 0,
    }
  }, [whatIfActive, whatIfOverrides, stats, bk])
  const wf = whatIfStats // shorthand
  const sp = statsPrev // shorthand for prev period

  const handleCSV = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportStatus('Parsing...')
    try {
      const rows = parseCSV(await file.text())
      if (!rows.length) { setImportStatus('No valid rows'); return }
      setImportStatus(`Importing ${rows.length} rows...`)
      await upsertMany(rows)
      setImportStatus(`Imported ${rows.length} entries`)
    } catch (err) { setImportStatus('Failed: ' + err.message) }
    if (fileRef.current) fileRef.current.value = ''
    setTimeout(() => setImportStatus(null), 3000)
  }

  const handleModalImport = async (rows) => {
    setShowImportModal(false)
    setImportStatus(`Importing ${rows.length} rows...`)
    try {
      await upsertMany(rows)
      setImportStatus(`Imported ${rows.length} entries`)
      await reload()
    } catch (err) { setImportStatus('Failed: ' + err.message) }
    setTimeout(() => setImportStatus(null), 4000)
  }

  // Reload on sync-completion notifications so fresh data lands on screen without a button click
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', onVis)
    // Listen for auto-sync completions via our subscriber API
    let unsub = () => {}
    ;(async () => {
      const { subscribeSyncStatus } = await import('../services/autoSync')
      unsub = subscribeSyncStatus(() => { reload().catch(() => {}) })
    })()
    return () => { document.removeEventListener('visibilitychange', onVis); unsub() }
  }, [reload])

  // Fresh-EOD-on-mount: when Marketing opens, immediately pull any closer EOD
  // updates into marketing_tracker. Previously this only ran on the 1-hour
  // auto-sync timer, so a closer filing an EOD 20 min ago would show blank
  // live_calls/closes columns until the next cycle. Runs in the background
  // (non-blocking) so the page renders immediately; reload fires when done.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { syncEODToTracker } = await import('../hooks/useMarketingTracker')
        const count = await syncEODToTracker()
        if (cancelled) return
        if (count > 0) {
          await reload()
          toast.info(`Refreshed ${count} day${count === 1 ? '' : 's'} of closer EOD data`, { duration: 3000 })
        }
      } catch (e) {
        if (!cancelled) console.warn('EOD→tracker refresh on mount failed:', e.message)
      }
    })()
    return () => { cancelled = true }
  }, [reload, toast])

  const handleDelete = useCallback(async (date) => {
    if (!confirm(`Delete ${date}?`)) return
    try {
      await deleteEntry(date)
      toast.success(`Deleted ${date}`)
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`)
    }
  }, [deleteEntry, toast])

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-text-primary" /></div>

  return (
    <div className="max-w-[1600px] mx-auto">
      {/* Header — editorial */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Marketing</span>
          <h1 className="h2 mt-2">The <em>state</em> of acquisition.</h1>
          <p
            className="mt-2"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
            }}
          >
            {entries.length} entries · daily attribution
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SyncStatusIndicator />
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* Out-of-window banner — fires when the selected range starts
          earlier than the closer_calls hook's 730-day fetch window.
          Without this, Net Live / Closes / Close Rate silently show 0
          because pm.liveProspects = 0 by definition outside the window. */}
      {prospectWindow?.outOfWindow && (
        <div className="mb-5 px-4 py-3 rounded-sm" style={{ background: 'rgba(180,135,20,0.08)', border: '1px solid #b88714' }}>
          <p className="text-sm" style={{ color: 'var(--ink)', fontFamily: 'var(--serif)' }}>
            <strong>Range extends past our closer-call window.</strong>{' '}
            <span style={{ color: 'var(--ink-3)' }}>
              Closer-deduped metrics (Net Live, Closes, Close Rate, Cost/New, CPA)
              are computed from closer_calls fetched since <code style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{prospectWindow.fetchedSince}</code>.
              Anything earlier reads as 0 — widen the fetch window in
              useCloserCallProspectMetrics if you need to compare deeper history.
            </span>
          </p>
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <button
          onClick={() => setShowImportModal(true)}
          className="flex items-center gap-2 tile tile-feedback px-3 py-2 hover:bg-bg-card-hover transition-colors min-h-[40px]"
        >
          <Upload size={14} className="text-text-400" />
          <span className="text-xs text-text-secondary">Import CSV</span>
        </button>
        {importStatus && <span className="text-xs text-text-primary">{importStatus}</span>}
        <div className="sm:ml-auto flex gap-2">
          <button
            onClick={() => { startTransition(() => { setWhatIfActive(!whatIfActive); if (whatIfActive) { setWhatIfOverrides({}); setWhatIfDraft({}) } }) }}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs border rounded-sm transition-colors ${whatIfActive ? 'bg-opt-yellow/15 border-opt-yellow/40 text-text-primary' : 'text-text-secondary border-border-default hover:bg-bg-card-hover'}`}
          >
            <Edit3 size={14} /> What-If
          </button>
          <button onClick={() => setShowBenchmarks(true)} className="flex items-center gap-1.5 px-3 py-2 text-xs text-text-secondary border border-border-default rounded-sm hover:bg-bg-card-hover transition-colors">
            <SlidersHorizontal size={14} /> Benchmarks
          </button>
          <button onClick={() => setShowAddEntry(true)} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-opt-yellow text-text-primary rounded-sm hover:bg-opt-yellow/80 transition-colors">
            <Plus size={14} /> Add Entry
          </button>
        </div>
      </div>

      {/* ═══ What-If Input Bar ═══
          Each input shows the ACTUAL current value as a small "now: X" caption
          beneath it that stays visible after typing — and a live Δ% so the
          user can see whether their typed value is a delta UP or DOWN from
          the current baseline. Without this, a typed adspend of "3300" reads
          as "an increase" mentally even if the real current spend is higher,
          which is exactly the trap Ben hit on 2026-05-14. */}
      {(() => {
        const renderInput = ([key, label, prefix, current]) => {
          const draftRaw = whatIfDraft[key]
          const draftVal = draftRaw === '' || draftRaw == null ? null : parseFloat(draftRaw)
          const curRound = prefix === '%' ? Number((current || 0).toFixed(0)) : Math.round(current || 0)
          const delta = draftVal != null && current > 0 ? ((draftVal - current) / current) * 100 : null
          const sign = delta == null ? null : delta > 0.5 ? '▲' : delta < -0.5 ? '▼' : null
          return (
            <div key={key} className="flex flex-col gap-0.5">
              <label className="text-[8px] uppercase text-text-400 truncate">{label}</label>
              <input
                type="number"
                placeholder={curRound}
                value={whatIfDraft[key] ?? ''}
                onChange={e => updateWhatIf(key, e.target.value)}
                className={`bg-bg-primary border rounded-lg px-2 py-1 text-xs text-text-primary w-full [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${prefix === '%' ? 'border-opt-yellow/20' : 'border-border-default'}`}
              />
              <div className="flex items-center justify-between text-[9px] leading-tight">
                <span className="text-text-400/70">
                  now: {prefix === '$' ? '$' : ''}{curRound.toLocaleString()}{prefix === '%' ? '%' : ''}
                </span>
                {sign && (
                  <span className={`font-medium ${sign === '▲' ? 'text-success' : 'text-danger'}`}>
                    {sign}{Math.abs(delta).toFixed(0)}%
                  </span>
                )}
              </div>
            </div>
          )
        }
        return whatIfActive && (
          <div className="bg-bg-card border border-opt-yellow/30 rounded-sm p-3 mb-2">
            <div className="flex items-center gap-2 mb-2">
              <Edit3 size={14} className="text-text-primary" />
              <span className="text-xs font-medium text-text-primary">What-If Forecast</span>
              <span className="text-[10px] text-text-400 ml-1">Type the absolute value you want to simulate (the "now:" caption below each input is the current actual)</span>
              <button onClick={() => { setWhatIfOverrides({}); setWhatIfDraft({}) }} className="ml-auto text-[10px] text-text-400 hover:text-text-secondary">Reset</button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-2">
              {[
                ['adspend', 'Adspend', '$', stats.adspend],
                ['leads', 'Leads', '#', stats.leads],
                // Q.Books baseline = bk.qualified (calendar-deduped) so the
                // "now: X" caption matches the live KPI tile. Using
                // stats.qualified_bookings here would show 10 while the tile
                // reads 13 — the exact mismatch that hid the bug on 2026-05-14.
                ['qualified_bookings', 'Q.Books', '#', bk?.qualified ?? stats.qualified_bookings],
                ['new_live_calls', 'New Live', '#', stats.new_live_calls],
                ['offers', 'Offers', '#', stats.offers],
                ['closes', 'Closes', '#', stats.closes],
                ['ascensions', 'Ascensions', '#', stats.ascensions],
              ].map(renderInput)}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              {[
                ['show_rate', 'Show Rate %', '%', stats.gross_show_rate],
                ['offer_rate', 'Offer Rate %', '%', stats.offer_rate],
                ['close_rate', 'Close Rate %', '%', stats.close_rate],
                ['ascend_rate', 'Ascend Rate %', '%', stats.ascend_rate],
                ['trial_cash', 'Trial Cash', '$', stats.trial_cash],
                ['ascend_cash', 'Asc Cash', '$', stats.ascend_cash],
                ['trial_revenue', 'Trial Rev', '$', stats.trial_revenue],
              ].map(renderInput)}
            </div>
          </div>
        )
      })()}

      {/* ═══ KPI Sections ═══ */}

      {/* Possible duplicate bookings banner.
          The bk.qualified count dedupes by ghl_contact_id. The same person
          can have multiple ghl_contact_ids (e.g. one created by webhook
          as "Mike White", a second by Calendly as "Michael" — both count
          as separate bookings). We can't auto-merge safely (real
          different people share names), but we surface the candidates
          so Ben can merge them in GHL. */}
      {possibleDupes.length > 0 && (
        <div style={{
          marginBottom: 16,
          padding: '12px 16px',
          background: 'var(--paper-2)',
          border: '1px solid var(--rule)',
          borderLeft: '3px solid #c08a3a',
          borderRadius: 2,
          fontFamily: 'var(--sans)',
          fontSize: 13,
          color: 'var(--ink-2)',
        }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#c08a3a', marginBottom: 6 }}>
            Possible duplicate bookings — {possibleDupes.length} pair{possibleDupes.length === 1 ? '' : 's'} in this window
          </div>
          <div style={{ color: 'var(--ink-3)', fontSize: 12, marginBottom: 8 }}>
            Same person may have booked under multiple GHL contact records (e.g. via webhook AND Calendly).
            The Q.Books count below treats each contact_id as a separate prospect.
            Merging these in GHL will collapse them on the next sync.
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-2)' }}>
            {possibleDupes.map((g) => (
              <li key={g.key} style={{ marginBottom: 4 }}>
                {g.members.map(m => `"${(m.name || '(no name)').trim()}"`).join('  vs  ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Spend & Lead Acquisition.
          Auto-bookings (the legacy "intro call" calendars) are no longer
          tracked here per request — replaced with Bookings (all strategy)
          and Cost/Booking. Q.Books now means strategy bookings EXCLUDING the
          DQ Calendly calendar; values come from the live `bookingTotals30/r`
          computed from ghl_appointments so they stay aligned with the new
          Lead → Bookings table at the top. */}
      {(() => {
        // bk + bk30 are hoisted to component scope so whatIfStats and these
        // tiles read from the same source. Cost/Booking and Cost/Q.Book
        // remain calendar-divisor; what-if exposes wf.cpb_all (matches
        // Cost/Booking) and wf.cpb (matches Cost/Q.Book).
        const cpb = bk.all > 0 ? stats.adspend / bk.all : 0
        const cpb30 = bk30.all > 0 ? stats30.adspend / bk30.all : 0
        const cpqb = bk.qualified > 0 ? stats.adspend / bk.qualified : 0
        const cpqb30 = bk30.qualified > 0 ? stats30.adspend / bk30.qualified : 0
        // L→Q% — cohort-true conversion rate.
        //
        // Numerator + denominator both bucketed by LEAD createdAt: of the
        // X opportunities created in the window, how many of those leads
        // have booked a strategy call (any time after entering the
        // pipeline). bkLeadCohort.qualified is filled by joining
        // ghl_appointments → ghl_opportunities via ghl_contact_id (see
        // migration 055 + fetchGHLLeadsByDate mirror).
        //
        // Fallback path: if migration 055 hasn't been applied yet (or
        // the mirror hasn't synced), bkLeadCohort is empty and we fall
        // back to the legacy booked_at-bucketed bk.qualified with a
        // hard 100% cap. The tooltip surfaces which path is active so
        // operators can tell when the mirror needs to sync.
        const cohortAvailable = bkLeadCohort.qualified > 0 || bkLeadCohort.all > 0
        const numerator = cohortAvailable ? bkLeadCohort.qualified : bk.qualified
        const rawLeadToQ = stats.leads > 0 ? (numerator / stats.leads) * 100 : 0
        const leadToQDrift = !cohortAvailable && rawLeadToQ > 100
        const leadToQ = leadToQDrift ? 100 : Math.min(100, rawLeadToQ)
        const numerator30 = bkLeadCohort30.qualified > 0 ? bkLeadCohort30.qualified : bk30.qualified
        const rawLeadToQ30 = stats30.leads > 0 ? (numerator30 / stats30.leads) * 100 : 0
        const leadToQ30 = Math.min(100, rawLeadToQ30)
        return (
          <Section title="Spend & Lead Acquisition" cols={8}>
            <KPI label="Adspend" value={stats.adspend} format="$" trailing={stats30.adspend} prev={sp.adspend} whatIf={hasOverride('adspend') ? wf?.adspend : null} tip="Total Meta Ads spend (converted to USD)" />
            <KPI label="Leads" value={stats.leads} format="n" trailing={stats30.leads} prev={sp.leads} whatIf={gated(upstream.leads, wf?.leads)} tip="New opportunities created in SCIO USA pipeline. Click to view." onClick={() => setDrilldown('leads')} />
            <KPI label="CPL" value={stats.cpl} format="$" benchmark={bm.cpl} trailing={stats30.cpl} prev={sp.cpl} whatIf={gated(upstream.leads, wf?.cpl)} tip="Cost Per Lead = Adspend / Leads" />
            <KPI label="Bookings" value={bk.all} format="n" trailing={bk30.all} whatIf={gated(upstream.bookings, wf?.bookings_all)} tip="All strategy-calendar bookings (qualified + DQ Calendly), bucketed by booked_at. Click to view." onClick={() => setDrilldown('bookings')} />
            <KPI label="Cost/Booking" value={cpb} format="$" trailing={cpb30} whatIf={gated(upstream.bookings, wf?.cpb_all)} tip="Adspend ÷ Bookings (all)" />
            <KPI label="Q.Books" value={cohortAvailable ? bkLeadCohort.qualified : bk.qualified} format="n" trailing={bkLeadCohort30.qualified > 0 ? bkLeadCohort30.qualified : bk30.qualified} whatIf={gated(upstream.bookings, wf?.qualified_bookings)} tip={cohortAvailable
              ? `Of the ${stats.leads} leads created in this window, ${bkLeadCohort.qualified} have booked a qualified strategy call (cohort-true conversion). Click to view bookings activity (booked_at-bucketed: ${bk.qualified} unique prospects).`
              : `Unique prospects who BOOKED a strategy call (excl. DQ Calendly) in this window, bucketed by booked_at. Cohort-true math will activate after ghl_opportunities mirror first syncs (migration 055). ${bk.dq ? `${bk.dq} routed to DQ in this window. ` : ''}Click to view.`} onClick={() => setDrilldown('bookings')} />
            <KPI label="L→Q%" value={leadToQ} format="%" benchmark={bm.lead_to_booking} trailing={leadToQ30} whatIf={gated(upstream.bookings, wf?.lead_to_booking_pct)} tip={cohortAvailable
              ? `True conversion rate: of the ${stats.leads} leads created in window, ${bkLeadCohort.qualified} booked a qualified strategy call. Cohort-aligned — denominator and numerator share the same lead-create window.`
              : leadToQDrift
                ? `Capped at 100%. Raw ratio = ${rawLeadToQ.toFixed(0)}% because Q.Book counts prospects who booked in this window — some of those leads were created BEFORE the window. Cohort-true math will activate once the ghl_opportunities mirror first syncs.`
                : 'Qualified Bookings ÷ Leads (cohort-true math will activate once the ghl_opportunities mirror syncs).'} />
            <KPI label="Cost/Q.Book" value={cpqb} format="$" benchmark={bm.cpb} trailing={cpqb30} whatIf={gated(upstream.bookings, wf?.cpb)} tip="Adspend ÷ Qualified Bookings (excludes DQ)" />
          </Section>
        )
      })()}

      {/* Calls & Show Rates.
          Reschedules + Cancels collapsed into one "Resch+Cancel" KPI per
          spec — the net_show_rate formula already excludes both from the
          denominator (live ÷ (booked − cancels − reschedules)), so combining
          the display matches the math the formula uses. */}
      {(() => {
        // All rates now use bk.qualified (calendar source of truth, deduped
        // by prospect) as the denominator instead of stats.qualified_bookings
        // (closer-reported EOD count). The two used to disagree by ~3-4 in
        // a 7-day window because closers don't reliably log every booking.
        // Calendar is automated; closer EOD is manual self-report. Removed
        // the "Booked" tile that displayed the EOD count separately — it's
        // already shown in the Spend section above as "Q.Books".
        //
        // bk + bk30 are hoisted at component scope. Locally bound for
        // brevity inside this IIFE.
        const denom    = bk.qualified || 0
        const denom30  = bk30.qualified || 0
        const denomPrev = sp.qualified_bookings || 0  // prev period stays on EOD until we have bk for it
        const rate = (num, d) => d > 0 ? Math.min(100, (num / d) * 100) : 0
        const reschedRate    = rate(stats.reschedules || 0, denom)
        const reschedRate30  = rate(stats30.reschedules || 0, denom30)
        const reschedRatePrev= rate(sp.reschedules || 0, denomPrev)
        const cancelRate     = rate(stats.cancels || 0, denom)
        const cancelRate30   = rate(stats30.cancels || 0, denom30)
        const cancelRatePrev = rate(sp.cancels || 0, denomPrev)
        // Show rates recomputed with calendar denominator. Net Show% subtracts
        // closer-reported cancels + reschedules from the calendar count — best
        // available approximation of "confirmed bookings."
        const grossShowRate = rate(stats.new_live_calls || 0, denom)
        const grossShowRate30 = rate(stats30.new_live_calls || 0, denom30)
        const netDenom    = Math.max(0, denom    - (stats.cancels || 0)   - (stats.reschedules || 0))
        const netDenom30  = Math.max(0, denom30  - (stats30.cancels || 0) - (stats30.reschedules || 0))
        const netShowRate   = rate(stats.new_live_calls || 0, netDenom)
        const netShowRate30 = rate(stats30.new_live_calls || 0, netDenom30)
        return (
          <Section title="Calls & Show Rates" cols={7}>
            <KPI label="Net New Live" value={stats.new_live_calls} format="n" prev={sp.new_live_calls} whatIf={gated(upstream.live, wf?.new_live_calls)} tip={`NEW calls that showed up live — excludes follow-ups, no-shows, ascensions. Denominator for show rates uses Qualified Bookings (${denom}) from the calendar, not the closer's EOD count. Click to view.`} onClick={() => setDrilldown('live')} />
            <KPI label="No Shows" value={stats.no_shows} format="n" prev={sp.no_shows} whatIf={gated(upstream.live, wf?.no_shows)} tip="From closer EOD reports (NC + FU no-shows). Excludes cancels — those are tracked separately." />
            <KPI label="Reschedule%" value={reschedRate} format="%" trailing={reschedRate30} prev={reschedRatePrev} tip={`Reschedules ÷ Qualified Bookings. ${stats.reschedules || 0} reschedules out of ${denom} qualified bookings (calendar). Click to view.`} onClick={() => setDrilldown('rc')} />
            <KPI label="Cancel%" value={cancelRate} format="%" trailing={cancelRate30} prev={cancelRatePrev} tip={`Cancellations ÷ Qualified Bookings. ${stats.cancels || 0} cancels out of ${denom} qualified bookings (calendar). Click to view.`} onClick={() => setDrilldown('rc')} />
            <KPI label="Gross Show%" value={grossShowRate} format="%" trailing={grossShowRate30} tip={`Live shows ÷ ALL qualified bookings (includes calls that later cancelled or rescheduled). ${stats.new_live_calls || 0} live ÷ ${denom} booked. Calendar-sourced denominator.`} />
            <KPI label="Net Show%" value={netShowRate} format="%" benchmark={bm.show_rate_new} trailing={netShowRate30} tip={`Live shows ÷ CONFIRMED bookings (Qualified Bookings minus cancels and reschedules). ${stats.new_live_calls || 0} live ÷ ${netDenom} confirmed = ${netShowRate.toFixed(1)}%. Use this for forecasting.`} />
            <KPI label="Cost/New" value={stats.cost_per_new_live_call} format="$" benchmark={bm.cost_per_live_call} trailing={stats30.cost_per_new_live_call} prev={sp.cost_per_new_live_call} whatIf={gated(upstream.live, wf?.cost_per_new_live_call)} tip="Adspend ÷ Net New" />
          </Section>
        )
      })()}

      {/* Offers & Closes */}
      <Section title="Offers & Closes" cols={6}>
        <KPI label="Offers Made" value={stats.offers} format="n" prev={sp.offers} whatIf={gated(upstream.offers, wf?.offers)} tip="Number of offers made on live calls" />
        <KPI label="Offer Rate" value={stats.offer_rate} format="%" benchmark={bm.offer_rate} trailing={stats30.offer_rate} prev={sp.offer_rate} whatIf={gated(upstream.offers, wf?.offer_rate)} tip="Offers / Net Live (NC + FU)" />
        <KPI label="Cost Per Offer" value={stats.cost_per_offer} format="$" prev={sp.cost_per_offer} whatIf={gated(upstream.offers, wf?.cost_per_offer)} tip="Adspend / Offers" />
        <KPI label="Total Closes" value={stats.closes} format="n" prev={sp.closes} whatIf={gated(upstream.closes, wf?.closes)} tip="Deals closed (trial sign-ups). Click to view." onClick={() => setDrilldown('closes')} />
        <KPI label="Close Rate" value={stats.close_rate} format="%" benchmark={bm.close_rate} trailing={stats30.close_rate} prev={sp.close_rate} whatIf={gated(upstream.closes, wf?.close_rate)} tip="Closes ÷ Live New Calls. Follow-ups and ascensions excluded from denominator." />
        <KPI label="CPA (Trial)" value={stats.cpa_trial} format="$" benchmark={bm.cpa_trial} trailing={stats30.cpa_trial} prev={sp.cpa_trial} whatIf={gated(upstream.closes, wf?.cpa_trial)} tip="Cost Per Acquisition = Adspend / Closes" />
      </Section>

      {/* Trial Financials */}
      <Section title="Trial Financials" cols={4}>
        <KPI label="Trial Cash Collected" value={stats.trial_cash} format="$" prev={sp.trial_cash} whatIf={gated(upstream.trial, wf?.trial_cash)} tip="Cash collected upfront from trial closes" />
        <KPI label="Trial Contracted Rev" value={stats.trial_revenue} format="$" prev={sp.trial_revenue} whatIf={gated(upstream.trial, wf?.trial_revenue)} tip="Total contracted revenue from trial closes" />
        <KPI label="Cash Collected %" value={stats.trial_cash_pct} format="%" benchmark={bm.trial_uf_cash_pct} trailing={stats30.trial_cash_pct} prev={sp.trial_cash_pct} whatIf={gated(upstream.trial, wf?.trial_cash_pct)} tip="Trial Cash / Trial Revenue" />
        <KPI label="Trial FE Cash ROAS" value={stats.trial_fe_roas} format="x" benchmark={bm.trial_fe_roas} trailing={stats30.trial_fe_roas} prev={sp.trial_fe_roas} whatIf={gated(upstream.trial, wf?.trial_fe_roas)} tip="Trial Cash / Adspend" />
      </Section>

      {/* Ascension */}
      <Section title="Ascension" cols={8}>
        <KPI label="Total Ascensions" value={stats.ascensions} format="n" prev={sp.ascensions} whatIf={gated(upstream.ascend, wf?.ascensions)} tip="Trial clients who ascended to full package. Click to view." onClick={() => setDrilldown('ascensions')} />
        <KPI label="Ascension Rate" value={stats.ascend_rate} format="%" benchmark={bm.ascend_rate} trailing={stats30.ascend_rate} prev={sp.ascend_rate} whatIf={gated(upstream.ascend, wf?.ascend_rate)} tip="Ascensions / Trial Closes" />
        <KPI label="CPA (Ascend)" value={stats.cpa_ascend} format="$" benchmark={bm.cpa_ascend} prev={sp.cpa_ascend} whatIf={gated(upstream.ascend, wf?.cpa_ascend)} tip="Adspend / Ascensions" />
        <KPI label="Ascend Cash" value={stats.ascend_cash} format="$" prev={sp.ascend_cash} whatIf={gated(upstream.ascend, wf?.ascend_cash)} tip="Cash collected from ascension deals" />
        <KPI label="Ascend Revenue" value={stats.ascend_revenue} format="$" prev={sp.ascend_revenue} whatIf={gated(upstream.ascend, wf?.ascend_revenue)} tip="Contracted revenue from ascension deals" />
        <KPI label="% Cash Collected" value={stats.ascend_cash_pct} format="%" benchmark={bm.ascend_uf_cash_pct} trailing={stats30.ascend_cash_pct} prev={sp.ascend_cash_pct} whatIf={gated(upstream.ascend, wf?.ascend_cash_pct)} tip="Ascend Cash / Ascend Revenue" />
        <KPI label="Finance Offers" value={stats.finance_offers} format="n" prev={sp.finance_offers} tip="Ascension clients offered finance" />
        <KPI label="Finance %" value={stats.finance_pct} format="%" prev={sp.finance_pct} tip="Finance Accepted / Ascensions" />
      </Section>

      {/* ROAS Overview */}
      <Section title="ROAS Overview" cols={4}>
        <KPI label="All Cash Collected" value={stats.all_cash} format="$" prev={sp.all_cash} whatIf={gated(upstream.trial, wf?.all_cash)} tip="Trial Cash + Ascend Cash + AR Collected" />
        <KPI label="Net FE Cash ROAS" value={stats.net_fe_roas} format="x" benchmark={bm.net_fe_roas} trailing={stats30.net_fe_roas} prev={sp.net_fe_roas} whatIf={gated(upstream.trial, wf?.net_fe_roas)} tip="(Trial Cash + Ascend Cash) / Adspend" />
        <KPI label="Revenue ROAS" value={stats.revenue_roas} format="x" benchmark={bm.revenue_roas} trailing={stats30.revenue_roas} prev={sp.revenue_roas} whatIf={gated(upstream.trial, wf?.revenue_roas)} tip="(Trial Rev + Ascend Rev) / Adspend" />
        <KPI label="All Cash ROAS" value={stats.all_cash_roas} format="x" benchmark={bm.all_cash_roas} trailing={stats30.all_cash_roas} prev={sp.all_cash_roas} whatIf={gated(upstream.trial, wf?.all_cash_roas)} tip="(Trial + Ascend + AR Cash) / Adspend" />
      </Section>

      {/* AR & Refunds */}
      <Section title="AR & Refunds" cols={6}>
        <KPI label="AR Collected" value={stats.ar_collected} format="$" prev={sp.ar_collected} tip="Accounts receivable payments collected" />
        <KPI label="AR Defaulted" value={stats.ar_defaulted} format="$" prev={sp.ar_defaulted} tip="Accounts receivable payments defaulted" />
        <KPI label="AR Success Rate" value={stats.ar_success_rate} format="%" benchmark={bm.ar_success_rate} prev={sp.ar_success_rate} tip="AR Collected / (AR Collected + AR Defaulted)" />
        <KPI label="Refunds/Disputes (#)" value={stats.refund_count} format="n" prev={sp.refund_count} tip="Number of refunds or disputes" />
        <KPI label="Refunds Amount" value={stats.refund_amount} format="$" prev={sp.refund_amount} tip="Total dollar amount refunded" />
        <KPI label="All Cash Collected" value={stats.all_cash} format="$" prev={sp.all_cash} />
      </Section>

      {/* MTD Funnel */}
      <div className="mb-5">
        <MTDFunnel stats={statsMTD} />
      </div>

      {/* Trailing Period Summary */}
      <div className="mb-5">
        <TrailingTable entries={entries} applyProspectMetrics={applyProspectMetrics} />
      </div>

      {/* Daily Tracker */}
      <div className="mb-5">
        <DailyTracker entries={entries} onDelete={handleDelete} onSave={upsertEntry} />
      </div>

      {/* Modals */}
      {showAddEntry && <AddEntryModal onSave={upsertEntry} onClose={() => setShowAddEntry(false)} />}
      {showBenchmarks && <BenchmarksModal benchmarks={benchmarks} onSave={updateBenchmark} onClose={() => setShowBenchmarks(false)} />}
      {showImportModal && <CSVImportModal onImport={handleModalImport} onClose={() => setShowImportModal(false)} />}
      {drilldown && <DrilldownModal kind={drilldown} range={range} onClose={() => setDrilldown(null)} />}
    </div>
  )
}
