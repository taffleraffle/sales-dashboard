import { useState, useRef, useEffect, useMemo, memo, useCallback, startTransition } from 'react'
import { useMarketingTracker, computeMarketingStats } from '../hooks/useMarketingTracker'
import DateRangeSelector from '../components/DateRangeSelector'
import SyncStatusIndicator from '../components/SyncStatusIndicator'
import { Loader, Upload, Plus, SlidersHorizontal, Trash2, X, Edit3, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../hooks/useToast'

import { todayET } from '../lib/dateUtils'

const toLocalDateStr = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function filterByDays(entries, days) {
  const now = new Date()
  if (days === 'mtd') {
    const start = toLocalDateStr(new Date(now.getFullYear(), now.getMonth(), 1))
    return entries.filter(e => e.date >= start)
  }
  // Custom range: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
  if (days && typeof days === 'object' && days.from) {
    return entries.filter(e => e.date >= days.from && e.date <= days.to)
  }
  const since = new Date()
  since.setDate(since.getDate() - days)
  return entries.filter(e => e.date >= toLocalDateStr(since))
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
const KPI = memo(function KPI({ label, value, format, benchmark, trailing, prev, tip, whatIf }) {
  // Cost metrics where lower = better (CPL, CPB, CPA, Cost/Live, Cost Per Offer)
  const costLabels = ['CPL', 'Cost/', 'CPA', 'Resch%']
  const lowerIsBetter = costLabels.some(c => label.includes(c))
  // Only color red/green if there's a benchmark to compare against
  const isGood = benchmark != null && value !== 0 && (lowerIsBetter ? value <= benchmark : value >= benchmark)
  const isBad = benchmark != null && value !== 0 && !isGood

  // Period-over-period arrow
  let arrow = null
  if (prev != null && prev !== 0 && value !== 0) {
    const pctChange = ((value - prev) / prev) * 100
    const improved = lowerIsBetter ? value < prev : value > prev
    const worsened = lowerIsBetter ? value > prev : value < prev
    if (Math.abs(pctChange) >= 0.5) {
      arrow = (
        <span className={`inline-flex items-center gap-0.5 text-[9px] font-medium ${improved ? 'text-success' : worsened ? 'text-danger' : 'text-text-400'}`}>
          {improved ? '▲' : worsened ? '▼' : '—'}
          {Math.abs(pctChange).toFixed(0)}%
        </span>
      )
    }
  }

  // What-if delta
  const displayValue = whatIf != null ? whatIf : value
  const hasWhatIfDelta = whatIf != null && Math.abs(whatIf - value) > 0.01

  return (
    <div className={`bg-bg-card border rounded-2xl p-3 relative group ${hasWhatIfDelta ? 'border-opt-yellow/40' : 'border-border-default'}`}>
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
        {trailing != null && <span className="text-[9px] text-text-400">30d: {fmt(trailing, format)}</span>}
        {benchmark != null && <span className="text-[9px] text-text-400">BM: {fmt(benchmark, format)}</span>}
      </div>
    </div>
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
    { label: 'Live Calls', value: stats.live_calls },
    { label: 'Offers', value: stats.offers },
    { label: 'Closes', value: stats.closes },
    { label: 'Ascensions', value: stats.ascensions },
  ]
  const maxVal = Math.max(...steps.map(s => s.value), 1)

  return (
    <div className="tile tile-feedback p-5">
      <h2 className="text-sm font-medium mb-4 flex items-center gap-2">
        <span className="text-opt-yellow">&#9660;</span> MTD Funnel
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
function TrailingTable({ entries }) {
  const periods = [
    { label: '4 Days', days: 4 },
    { label: '7 Days', days: 7 },
    { label: '30 Days', days: 30 },
    { label: 'MTD', days: 'mtd' },
  ]
  const rows = periods.map(p => ({ ...p, s: computeMarketingStats(filterByDays(entries, p.days)) }))

  const cols = [
    { label: 'Spend', k: 'adspend', f: f$ },
    { label: 'Leads', k: 'leads', f: fN },
    { label: 'CPL', k: 'cpl', f: f$ },
    { label: 'Booked', k: 'qualified_bookings', f: fN },
    { label: 'L→B%', k: 'lead_to_booking_pct', f: fP },
    { label: 'Live', k: 'live_calls', f: fN },
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
    if (k === 'show_rate') return v >= 70 ? 'text-success' : v >= 50 ? 'text-opt-yellow' : 'text-danger'
    if (k === 'close_rate') return v >= 25 ? 'text-success' : v >= 15 ? 'text-opt-yellow' : 'text-danger'
    if (k === 'offer_rate') return v >= 80 ? 'text-success' : v >= 60 ? 'text-opt-yellow' : 'text-danger'
    if (k.includes('roas')) return v >= 2 ? 'text-success' : v >= 1 ? 'text-opt-yellow' : 'text-danger'
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
    <th className="px-2 py-1.5 text-right cursor-pointer hover:text-opt-yellow select-none whitespace-nowrap" onClick={() => toggleSort(k)}>
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
      { k: 'live_calls', l: 'Live Calls' }, { k: 'reschedules', l: 'Reschedules' },
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

  const getCalls = e => e.qualified_bookings || e.calls_on_calendar || ((e.net_new_calls || 0) + (e.net_fu_calls || 0))
  const getLive = e => e.live_calls || e.net_live_calls || 0

  // Color helpers for table cells
  const clrRate = (v, good, ok) => v >= good ? 'text-success' : v >= ok ? 'text-opt-yellow' : 'text-danger'
  const clrRoas = v => v >= 2 ? 'text-success' : v >= 1 ? 'text-opt-yellow' : 'text-danger'
  const clrCash = v => v > 0 ? 'text-success' : ''

  const dataCols = [
    { k: 'adspend', label: 'Spend', fmt: f$ },
    { k: 'leads', label: 'Leads', fmt: fN },
    { k: null, label: 'CPL', calc: e => e.leads > 0 ? f$(parseFloat(e.adspend || 0) / e.leads) : '-' },
    { k: 'auto_bookings', label: 'A.Book', fmt: fN },
    { k: 'qualified_bookings', label: 'Q.Book', fmt: fN },
    { k: null, label: 'L→Q%', calc: e => fmtP(e.qualified_bookings, e.leads),
      color: e => e.leads > 0 ? clrRate((e.qualified_bookings || 0) / e.leads * 100, 15, 8) : '' },
    { k: 'live_calls', label: 'Live', fmt: fN },
    { k: null, label: 'Gr.Show%', calc: e => { const cal = getCalls(e); return cal > 0 ? fmtP(getLive(e), cal) : '-' },
      color: e => { const cal = getCalls(e); return cal > 0 ? clrRate(getLive(e) / cal * 100, 70, 50) : '' } },
    { k: null, label: 'Net Show%', calc: e => { const net = getCalls(e) - (e.cancelled_dtf || 0) - (e.cancelled_by_prospect || 0) - (e.reschedules || 0); return net > 0 ? fmtP(getLive(e), net) : '-' },
      color: e => { const net = getCalls(e) - (e.cancelled_dtf || 0) - (e.cancelled_by_prospect || 0) - (e.reschedules || 0); return net > 0 ? clrRate(getLive(e) / net * 100, 80, 60) : '' } },
    { k: 'reschedules', label: 'Resch', fmt: fN, color: e => (e.reschedules || 0) > 0 ? 'text-blue-400' : '' },
    { k: null, label: 'R%', calc: e => { const cal = getCalls(e); return cal > 0 ? fmtP(e.reschedules, cal) : '-' },
      color: e => { const cal = getCalls(e); return cal > 0 && (e.reschedules || 0) > 0 ? 'text-blue-400' : '' } },
    { k: 'offers', label: 'Offer', fmt: fN },
    { k: null, label: 'Ofr%', calc: e => getLive(e) > 0 ? fmtP(e.offers, getLive(e)) : '-',
      color: e => getLive(e) > 0 ? clrRate((e.offers || 0) / getLive(e) * 100, 80, 60) : '' },
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
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="bg-bg-primary border border-border-default rounded px-2 py-1 text-xs text-text-primary" />
          <span className="text-text-400 text-xs">to</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="bg-bg-primary border border-border-default rounded px-2 py-1 text-xs text-text-primary" />
          <button onClick={() => { setFromDate(''); setToDate('') }} className="px-3 py-1 rounded text-xs font-medium bg-opt-yellow text-bg-primary">FILTER</button>
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
                  <td className={`px-2 py-1 font-medium whitespace-nowrap sticky left-0 z-10 ${isEd ? 'text-opt-yellow bg-opt-yellow/5' : 'text-text-primary bg-bg-card group-hover:bg-bg-card-hover/50'}`}>{e.date}</td>
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
                      <button onClick={() => startEdit(e)} className="w-6 h-6 rounded-md text-text-400 hover:text-opt-yellow hover:bg-opt-yellow/10 flex items-center justify-center transition-colors"><Edit3 size={11} /></button>
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
                <Edit3 size={14} className="text-opt-yellow" />
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
              <button onClick={saveEdit} disabled={saving} className="px-5 py-1.5 text-xs font-semibold bg-opt-yellow text-bg-primary rounded-lg hover:brightness-110 disabled:opacity-50 transition-all">
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
                  {showGroup && <p className="col-span-2 text-[10px] uppercase tracking-widest text-opt-yellow font-medium mt-2 mb-1 border-t border-border-default pt-2">{f.group}</p>}
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
            <button type="submit" disabled={saving} className="px-4 py-1.5 text-xs font-medium bg-opt-yellow text-bg-primary rounded disabled:opacity-50">
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
          <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-xs font-medium bg-opt-yellow text-bg-primary rounded disabled:opacity-50">
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
    live_calls: 'Live', new_live_calls: 'New Live', net_live_calls: 'Net Live', reschedules: 'Resch',
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
            <Upload size={16} className="text-opt-yellow" />
            <h3 className="text-sm font-semibold">Import Historical Data</h3>
          </div>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary"><X size={14} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto max-h-[calc(85vh-60px)]">
          {/* Upload area */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-border-default rounded-xl p-6 text-center cursor-pointer hover:border-opt-yellow/40 transition-colors"
          >
            <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt" onChange={handleFile} className="hidden" />
            <Upload size={24} className="mx-auto text-text-400 mb-2" />
            <p className="text-sm text-text-secondary">{preview ? 'Upload a different file' : 'Click to upload a CSV file'}</p>
            <p className="text-[10px] text-text-400 mt-1">Supports .csv and .tsv — dates, spend, leads, live calls, closes, ascensions, etc.</p>
          </div>

          {/* Template download */}
          <button onClick={downloadTemplate} className="text-[11px] text-opt-yellow hover:underline">
            Download CSV template with all supported columns
          </button>

          {loading && <div className="flex items-center justify-center py-4"><Loader size={16} className="animate-spin text-opt-yellow" /><span className="text-xs text-text-400 ml-2">Comparing with existing data...</span></div>}

          {error && <p className="text-xs text-danger bg-danger/10 rounded-lg px-3 py-2">{error}</p>}

          {/* Preview with diff */}
          {preview && (
            <div className="space-y-3">
              {/* Summary */}
              <div className="bg-bg-primary rounded-xl p-3">
                <h4 className="text-xs font-semibold text-opt-yellow mb-2">Import Summary</h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <div><span className="text-text-400">Rows:</span> <strong>{preview.rows.length}</strong></div>
                  <div><span className="text-text-400">Date range:</span> <strong>{preview.dateRange[0]} → {preview.dateRange[1]}</strong></div>
                  <div><span className="text-text-400">New entries:</span> <strong className="text-success">{preview.newCount}</strong></div>
                  <div><span className="text-text-400">Will overwrite:</span> <strong className={preview.overwriteCount > 0 ? 'text-opt-yellow' : ''}>{preview.overwriteCount}</strong></div>
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
                <div className="bg-bg-primary rounded-xl p-3">
                  <h4 className="text-xs font-semibold text-opt-yellow mb-2">Values Being Overwritten</h4>
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
                <div className="bg-bg-primary rounded-xl p-3">
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
                <strong className="text-opt-yellow">CSV data takes priority.</strong>
                <span className="text-text-400"> Non-empty CSV values will override existing data. Empty cells and zeros in the CSV are skipped — they won't wipe existing data.</span>
              </div>

              <button
                onClick={handleImport}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-opt-yellow text-bg-primary font-semibold text-sm hover:brightness-110 transition-all"
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

// ── Main Page ──────────────────────────────────────────────────────
export default function MarketingPerformance() {
  const { entries, benchmarks, loading, upsertEntry, upsertMany, updateBenchmark, deleteEntry, reload } = useMarketingTracker()
  const [range, setRange] = useState(30)
  const [showAddEntry, setShowAddEntry] = useState(false)
  const [showBenchmarks, setShowBenchmarks] = useState(false)
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

  const rangeEntries = useMemo(() => filterByDays(entries, range), [entries, range])
  const mtdEntries = useMemo(() => filterByDays(entries, 'mtd'), [entries])
  const prevEntries = useMemo(() => filterPreviousPeriod(entries, range), [entries, range])
  const stats = useMemo(() => computeMarketingStats(rangeEntries), [rangeEntries])
  const stats30 = useMemo(() => computeMarketingStats(filterByDays(entries, 30)), [entries])
  const statsMTD = useMemo(() => computeMarketingStats(mtdEntries), [mtdEntries])
  const statsPrev = useMemo(() => computeMarketingStats(prevEntries), [prevEntries])
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
  const whatIfStats = useMemo(() => {
    if (!whatIfActive || !Object.keys(whatIfOverrides).length) return null
    const o = whatIfOverrides
    const get = (key) => (o[key] !== '' && o[key] != null) ? parseFloat(o[key]) : null

    // Current rates from actual data (used as defaults for cascading)
    const curShowRate = stats.qualified_bookings > 0 ? stats.live_calls / stats.qualified_bookings : 0.5
    const curOfferRate = stats.live_calls > 0 ? stats.offers / stats.live_calls : 0.8
    const curCloseRate = stats.live_calls > 0 ? stats.closes / stats.live_calls : 0.25
    const curAscendRate = stats.closes > 0 ? stats.ascensions / stats.closes : 0.5
    const curAvgTrialCash = stats.closes > 0 ? stats.trial_cash / stats.closes : 1000
    const curAvgTrialRev = stats.closes > 0 ? stats.trial_revenue / stats.closes : 1000
    const curAvgAscCash = stats.ascensions > 0 ? stats.ascend_cash / stats.ascensions : 3000
    const curAvgAscRev = stats.ascensions > 0 ? stats.ascend_revenue / stats.ascensions : 9000

    // Cascade: each level uses override if provided, else derives from upstream
    const adspend = get('adspend') ?? stats.adspend
    const leads = get('leads') ?? stats.leads
    const qualified_bookings = get('qualified_bookings') ?? stats.qualified_bookings

    // Show rate: override percentage or keep current
    const showRateOverride = get('show_rate')
    const showRate = showRateOverride != null ? showRateOverride / 100 : curShowRate

    // Live calls: override directly, OR cascade from bookings * show rate
    const live_calls = get('live_calls') ?? (get('qualified_bookings') != null || showRateOverride != null
      ? Math.round(qualified_bookings * showRate)
      : stats.live_calls)

    // Offer rate
    const offerRateOverride = get('offer_rate')
    const offerRate = offerRateOverride != null ? offerRateOverride / 100 : curOfferRate
    const offers = get('offers') ?? (get('live_calls') != null || get('qualified_bookings') != null || offerRateOverride != null
      ? Math.round(live_calls * offerRate)
      : stats.offers)

    // Close rate
    const closeRateOverride = get('close_rate')
    const closeRate = closeRateOverride != null ? closeRateOverride / 100 : curCloseRate
    const closes = get('closes') ?? (get('live_calls') != null || get('qualified_bookings') != null || closeRateOverride != null
      ? Math.round(live_calls * closeRate)
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

    // Non-cascading fields
    const reschedules = stats.reschedules
    const cancels = stats.cancels || 0
    const ar_collected = stats.ar_collected
    const ar_defaulted = stats.ar_defaulted
    const auto_bookings = get('auto_bookings') ?? stats.auto_bookings

    const all_cash = trial_cash + ascend_cash + ar_collected
    return {
      adspend, leads, auto_bookings, qualified_bookings, live_calls, offers, closes,
      trial_cash, trial_revenue, ascensions, ascend_cash, ascend_revenue,
      reschedules, cancels, ar_collected, ar_defaulted,
      cancelled_dtf: stats.cancelled_dtf || 0, cancelled_by_prospect: stats.cancelled_by_prospect || 0,
      finance_offers: stats.finance_offers, finance_accepted: stats.finance_accepted,
      // Derived
      cpl: leads > 0 ? adspend / leads : 0,
      lead_to_booking_pct: leads > 0 ? (qualified_bookings / leads) * 100 : 0,
      cpb: qualified_bookings > 0 ? adspend / qualified_bookings : 0,
      cost_per_auto_booking: auto_bookings > 0 ? adspend / auto_bookings : 0,
      gross_show_rate: qualified_bookings > 0 ? (live_calls / qualified_bookings) * 100 : 0,
      net_show_rate: (() => { const net = qualified_bookings - cancels - reschedules; return net > 0 ? (live_calls / net) * 100 : 0 })(),
      no_shows: (stats.no_shows > 0 && qualified_bookings === stats.qualified_bookings) ? stats.no_shows : Math.max(0, qualified_bookings - live_calls - cancels - reschedules),
      reschedule_rate: qualified_bookings > 0 ? (reschedules / qualified_bookings) * 100 : 0,
      cost_per_live_call: live_calls > 0 ? adspend / live_calls : 0,
      offer_rate: live_calls > 0 ? (offers / live_calls) * 100 : 0,
      cost_per_offer: offers > 0 ? adspend / offers : 0,
      close_rate: live_calls > 0 ? (closes / live_calls) * 100 : 0,
      cpa_trial: closes > 0 ? adspend / closes : 0,
      trial_cash_pct: trial_revenue > 0 ? (trial_cash / trial_revenue) * 100 : 0,
      trial_fe_roas: adspend > 0 ? trial_cash / adspend : 0,
      ascend_rate: closes > 0 ? (ascensions / closes) * 100 : 0,
      cpa_ascend: ascensions > 0 ? adspend / ascensions : 0,
      ascend_cash_pct: ascend_revenue > 0 ? (ascend_cash / ascend_revenue) * 100 : 0,
      finance_pct: ascensions > 0 ? (stats.finance_accepted / ascensions) * 100 : 0,
      net_fe_roas: adspend > 0 ? (trial_cash + ascend_cash) / adspend : 0,
      revenue_roas: adspend > 0 ? (trial_revenue + ascend_revenue) / adspend : 0,
      ar_success_rate: (ar_collected + ar_defaulted) > 0 ? (ar_collected / (ar_collected + ar_defaulted)) * 100 : 0,
      all_cash,
      all_cash_roas: adspend > 0 ? all_cash / adspend : 0,
    }
  }, [whatIfActive, whatIfOverrides, stats])
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

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>

  return (
    <div className="max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Marketing Performance</h1>
          <p className="text-xs text-text-400">{entries.length} entries</p>
        </div>
        <div className="flex items-center gap-2">
          <SyncStatusIndicator />
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <button
          onClick={() => setShowImportModal(true)}
          className="flex items-center gap-2 tile tile-feedback px-3 py-2 hover:bg-bg-card-hover transition-colors min-h-[40px]"
        >
          <Upload size={14} className="text-text-400" />
          <span className="text-xs text-text-secondary">Import CSV</span>
        </button>
        {importStatus && <span className="text-xs text-opt-yellow">{importStatus}</span>}
        <div className="sm:ml-auto flex gap-2">
          <button
            onClick={() => { startTransition(() => { setWhatIfActive(!whatIfActive); if (whatIfActive) { setWhatIfOverrides({}); setWhatIfDraft({}) } }) }}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs border rounded-2xl transition-colors ${whatIfActive ? 'bg-opt-yellow/15 border-opt-yellow/40 text-opt-yellow' : 'text-text-secondary border-border-default hover:bg-bg-card-hover'}`}
          >
            <Edit3 size={14} /> What-If
          </button>
          <button onClick={() => setShowBenchmarks(true)} className="flex items-center gap-1.5 px-3 py-2 text-xs text-text-secondary border border-border-default rounded-2xl hover:bg-bg-card-hover transition-colors">
            <SlidersHorizontal size={14} /> Benchmarks
          </button>
          <button onClick={() => setShowAddEntry(true)} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-opt-yellow text-bg-primary rounded-2xl hover:bg-opt-yellow/80 transition-colors">
            <Plus size={14} /> Add Entry
          </button>
        </div>
      </div>

      {/* ═══ What-If Input Bar ═══ */}
      {whatIfActive && (
        <div className="bg-bg-card border border-opt-yellow/30 rounded-2xl p-3 mb-2">
          <div className="flex items-center gap-2 mb-2">
            <Edit3 size={14} className="text-opt-yellow" />
            <span className="text-xs font-medium text-opt-yellow">What-If Forecast</span>
            <span className="text-[10px] text-text-400 ml-1">Adjust any value — changes cascade through the funnel automatically</span>
            <button onClick={() => { setWhatIfOverrides({}); setWhatIfDraft({}) }} className="ml-auto text-[10px] text-text-400 hover:text-text-secondary">Reset</button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-2">
            {[
              ['adspend', 'Adspend', '$', stats.adspend],
              ['leads', 'Leads', '#', stats.leads],
              ['qualified_bookings', 'Q.Books', '#', stats.qualified_bookings],
              ['live_calls', 'Live Calls', '#', stats.live_calls],
              ['offers', 'Offers', '#', stats.offers],
              ['closes', 'Closes', '#', stats.closes],
              ['ascensions', 'Ascensions', '#', stats.ascensions],
            ].map(([key, label, prefix, current]) => (
              <div key={key} className="flex flex-col gap-0.5">
                <label className="text-[8px] uppercase text-text-400">{label}</label>
                <input
                  type="number"
                  placeholder={Math.round(current || 0)}
                  value={whatIfDraft[key] ?? ''}
                  onChange={e => updateWhatIf(key, e.target.value)}
                  className="bg-bg-primary border border-border-default rounded-lg px-2 py-1 text-xs text-text-primary w-full [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>
            ))}
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
            ].map(([key, label, prefix, current]) => (
              <div key={key} className="flex flex-col gap-0.5">
                <label className="text-[8px] uppercase text-text-400">{label} <span className="text-text-400/50">{prefix === '%' ? `(${(current || 0).toFixed(0)}%)` : ''}</span></label>
                <input
                  type="number"
                  placeholder={prefix === '%' ? (current || 0).toFixed(0) : Math.round(current || 0)}
                  value={whatIfDraft[key] ?? ''}
                  onChange={e => updateWhatIf(key, e.target.value)}
                  className={`bg-bg-primary border rounded-lg px-2 py-1 text-xs text-text-primary w-full [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${prefix === '%' ? 'border-opt-yellow/20' : 'border-border-default'}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ KPI Sections ═══ */}

      {/* Spend & Lead Acquisition */}
      <Section title="Spend & Lead Acquisition" cols={8}>
        <KPI label="Adspend" value={stats.adspend} format="$" trailing={stats30.adspend} prev={sp.adspend} whatIf={wf?.adspend} tip="Total Meta Ads spend (converted to USD)" />
        <KPI label="Leads" value={stats.leads} format="n" trailing={stats30.leads} prev={sp.leads} whatIf={wf?.leads} tip="New leads from GHL pipeline" />
        <KPI label="CPL" value={stats.cpl} format="$" benchmark={bm.cpl} trailing={stats30.cpl} prev={sp.cpl} whatIf={wf?.cpl} tip="Cost Per Lead = Adspend / Leads" />
        <KPI label="A.Books" value={stats.auto_bookings} format="n" trailing={stats30.auto_bookings} prev={sp.auto_bookings} whatIf={wf?.auto_bookings} tip="Auto bookings from Intro Call calendars" />
        <KPI label="Cost/A.Book" value={stats.cost_per_auto_booking} format="$" trailing={stats30.cost_per_auto_booking} prev={sp.cost_per_auto_booking} whatIf={wf?.cost_per_auto_booking} tip="Cost Per Auto Booking = Adspend / Auto Bookings" />
        <KPI label="Q.Books" value={stats.qualified_bookings} format="n" trailing={stats30.qualified_bookings} prev={sp.qualified_bookings} whatIf={wf?.qualified_bookings} tip="Strategy Call bookings (deduped per contact)" />
        <KPI label="L→Q%" value={stats.lead_to_booking_pct} format="%" benchmark={bm.lead_to_booking} trailing={stats30.lead_to_booking_pct} prev={sp.lead_to_booking_pct} whatIf={wf?.lead_to_booking_pct} tip="Lead to Qual Booking % = Q.Books / Leads" />
        <KPI label="Cost/Q.Book" value={stats.cpb} format="$" benchmark={bm.cpb} trailing={stats30.cpb} prev={sp.cpb} whatIf={wf?.cpb} tip="Cost Per Qual Booking = Adspend / Q.Books" />
      </Section>

      {/* Calls & Show Rates */}
      <Section title="Calls & Show Rates" cols={9}>
        <KPI label="Booked" value={stats.qualified_bookings} format="n" prev={sp.qualified_bookings} whatIf={wf?.qualified_bookings} tip="Total calls booked on calendar" />
        <KPI label="Live" value={stats.live_calls} format="n" prev={sp.live_calls} whatIf={wf?.live_calls} tip="Calls that actually happened (showed)" />
        <KPI label="No Shows" value={stats.no_shows} format="n" prev={sp.no_shows} whatIf={wf?.no_shows} tip="From closer EOD reports (NC + FU no-shows)" />
        <KPI label="Cancelled" value={stats.cancels} format="n" prev={sp.cancels} tip="Cancelled DTF + Cancelled by Prospect" />
        <KPI label="Resch" value={stats.reschedules} format="n" prev={sp.reschedules} tip="Calls rescheduled to another date" />
        <KPI label="Gross Show%" value={stats.gross_show_rate} format="%" trailing={stats30.gross_show_rate} prev={sp.gross_show_rate} whatIf={wf?.gross_show_rate} tip="Live / Booked (includes all no-shows)" />
        <KPI label="Net Show%" value={stats.net_show_rate} format="%" benchmark={bm.show_rate_new} trailing={stats30.net_show_rate} prev={sp.net_show_rate} whatIf={wf?.net_show_rate} tip="Live / (Booked - Cancels - Reschedules)" />
        <KPI label="Resch%" value={stats.reschedule_rate} format="%" prev={sp.reschedule_rate} tip="Reschedules / Booked" />
        <KPI label="Cost/Live" value={stats.cost_per_live_call} format="$" benchmark={bm.cost_per_live_call} trailing={stats30.cost_per_live_call} prev={sp.cost_per_live_call} whatIf={wf?.cost_per_live_call} tip="Adspend / Live Calls" />
      </Section>

      {/* Offers & Closes */}
      <Section title="Offers & Closes" cols={6}>
        <KPI label="Offers Made" value={stats.offers} format="n" prev={sp.offers} whatIf={wf?.offers} tip="Number of offers made on live calls" />
        <KPI label="Offer Rate" value={stats.offer_rate} format="%" benchmark={bm.offer_rate} trailing={stats30.offer_rate} prev={sp.offer_rate} whatIf={wf?.offer_rate} tip="Offers / Live Calls" />
        <KPI label="Cost Per Offer" value={stats.cost_per_offer} format="$" prev={sp.cost_per_offer} whatIf={wf?.cost_per_offer} tip="Adspend / Offers" />
        <KPI label="Total Closes" value={stats.closes} format="n" prev={sp.closes} whatIf={wf?.closes} tip="Deals closed (trial sign-ups)" />
        <KPI label="Close Rate" value={stats.close_rate} format="%" benchmark={bm.close_rate} trailing={stats30.close_rate} prev={sp.close_rate} whatIf={wf?.close_rate} tip="Closes / Live New Calls (FU calls excluded from denominator)" />
        <KPI label="CPA (Trial)" value={stats.cpa_trial} format="$" benchmark={bm.cpa_trial} trailing={stats30.cpa_trial} prev={sp.cpa_trial} whatIf={wf?.cpa_trial} tip="Cost Per Acquisition = Adspend / Closes" />
      </Section>

      {/* Trial Financials */}
      <Section title="Trial Financials" cols={4}>
        <KPI label="Trial Cash Collected" value={stats.trial_cash} format="$" prev={sp.trial_cash} whatIf={wf?.trial_cash} tip="Cash collected upfront from trial closes" />
        <KPI label="Trial Contracted Rev" value={stats.trial_revenue} format="$" prev={sp.trial_revenue} whatIf={wf?.trial_revenue} tip="Total contracted revenue from trial closes" />
        <KPI label="Cash Collected %" value={stats.trial_cash_pct} format="%" benchmark={bm.trial_uf_cash_pct} trailing={stats30.trial_cash_pct} prev={sp.trial_cash_pct} whatIf={wf?.trial_cash_pct} tip="Trial Cash / Trial Revenue" />
        <KPI label="Trial FE Cash ROAS" value={stats.trial_fe_roas} format="x" benchmark={bm.trial_fe_roas} trailing={stats30.trial_fe_roas} prev={sp.trial_fe_roas} whatIf={wf?.trial_fe_roas} tip="Trial Cash / Adspend" />
      </Section>

      {/* Ascension */}
      <Section title="Ascension" cols={8}>
        <KPI label="Total Ascensions" value={stats.ascensions} format="n" prev={sp.ascensions} whatIf={wf?.ascensions} tip="Trial clients who ascended to full package" />
        <KPI label="Ascension Rate" value={stats.ascend_rate} format="%" benchmark={bm.ascend_rate} trailing={stats30.ascend_rate} prev={sp.ascend_rate} whatIf={wf?.ascend_rate} tip="Ascensions / Trial Closes" />
        <KPI label="CPA (Ascend)" value={stats.cpa_ascend} format="$" benchmark={bm.cpa_ascend} prev={sp.cpa_ascend} whatIf={wf?.cpa_ascend} tip="Adspend / Ascensions" />
        <KPI label="Ascend Cash" value={stats.ascend_cash} format="$" prev={sp.ascend_cash} whatIf={wf?.ascend_cash} tip="Cash collected from ascension deals" />
        <KPI label="Ascend Revenue" value={stats.ascend_revenue} format="$" prev={sp.ascend_revenue} whatIf={wf?.ascend_revenue} tip="Contracted revenue from ascension deals" />
        <KPI label="% Cash Collected" value={stats.ascend_cash_pct} format="%" benchmark={bm.ascend_uf_cash_pct} trailing={stats30.ascend_cash_pct} prev={sp.ascend_cash_pct} whatIf={wf?.ascend_cash_pct} tip="Ascend Cash / Ascend Revenue" />
        <KPI label="Finance Offers" value={stats.finance_offers} format="n" prev={sp.finance_offers} tip="Ascension clients offered finance" />
        <KPI label="Finance %" value={stats.finance_pct} format="%" prev={sp.finance_pct} tip="Finance Accepted / Ascensions" />
      </Section>

      {/* ROAS Overview */}
      <Section title="ROAS Overview" cols={4}>
        <KPI label="All Cash Collected" value={stats.all_cash} format="$" prev={sp.all_cash} whatIf={wf?.all_cash} tip="Trial Cash + Ascend Cash + AR Collected" />
        <KPI label="Net FE Cash ROAS" value={stats.net_fe_roas} format="x" benchmark={bm.net_fe_roas} trailing={stats30.net_fe_roas} prev={sp.net_fe_roas} whatIf={wf?.net_fe_roas} tip="(Trial Cash + Ascend Cash) / Adspend" />
        <KPI label="Revenue ROAS" value={stats.revenue_roas} format="x" benchmark={bm.revenue_roas} trailing={stats30.revenue_roas} prev={sp.revenue_roas} whatIf={wf?.revenue_roas} tip="(Trial Rev + Ascend Rev) / Adspend" />
        <KPI label="All Cash ROAS" value={stats.all_cash_roas} format="x" benchmark={bm.all_cash_roas} trailing={stats30.all_cash_roas} prev={sp.all_cash_roas} whatIf={wf?.all_cash_roas} tip="(Trial + Ascend + AR Cash) / Adspend" />
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
        <TrailingTable entries={entries} />
      </div>

      {/* Daily Tracker */}
      <div className="mb-5">
        <DailyTracker entries={entries} onDelete={handleDelete} onSave={upsertEntry} />
      </div>

      {/* Modals */}
      {showAddEntry && <AddEntryModal onSave={upsertEntry} onClose={() => setShowAddEntry(false)} />}
      {showBenchmarks && <BenchmarksModal benchmarks={benchmarks} onSave={updateBenchmark} onClose={() => setShowBenchmarks(false)} />}
      {showImportModal && <CSVImportModal onImport={handleModalImport} onClose={() => setShowImportModal(false)} />}
    </div>
  )
}
