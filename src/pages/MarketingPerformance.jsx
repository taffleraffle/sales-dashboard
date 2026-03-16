import { useState, useRef, useMemo } from 'react'
import { useMarketingTracker, computeMarketingStats } from '../hooks/useMarketingTracker'
import { syncMetaToTracker } from '../services/metaAdsSync'
import DateRangeSelector from '../components/DateRangeSelector'
import { Loader, Upload, Plus, SlidersHorizontal, Trash2, X, Edit3, Check, RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'

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
  const since = new Date()
  since.setDate(since.getDate() - days)
  return entries.filter(e => e.date >= toLocalDateStr(since))
}

// ── Formatters ─────────────────────────────────────────────────────
const f$ = v => (v == null || isNaN(v)) ? '—' : `$${Math.round(v).toLocaleString()}`
const fP = v => (v == null || isNaN(v)) ? '—' : `${v.toFixed(1)}%`
const fX = v => (v == null || isNaN(v)) ? '—' : `${v.toFixed(2)}x`
const fN = v => (v == null || isNaN(v)) ? '—' : v.toLocaleString()
const fmt = (v, format) => format === '$' ? f$(v) : format === '%' ? fP(v) : format === 'x' ? fX(v) : fN(v)

// ── KPI Card with benchmark ────────────────────────────────────────
function KPI({ label, value, format, benchmark, trailing }) {
  const lowerIsBetter = format === '$' && !label.includes('ROAS') && !label.includes('Cash') && !label.includes('Revenue') && !label.includes('AR')
  const isGood = benchmark != null && value !== 0 && (lowerIsBetter ? value <= benchmark : value >= benchmark)
  const isBad = benchmark != null && value !== 0 && !isGood

  return (
    <div className="bg-bg-card border border-border-default rounded-2xl p-3">
      <p className="text-[9px] uppercase tracking-wider text-text-400 mb-0.5 leading-tight truncate">{label}</p>
      <p className={`text-lg font-bold leading-tight ${value === 0 ? 'text-text-400' : isGood ? 'text-success' : isBad ? 'text-danger' : 'text-text-primary'}`}>
        {fmt(value, format)}
      </p>
      <div className="flex items-center gap-2 mt-0.5">
        {trailing != null && <span className="text-[9px] text-text-400">30d: {fmt(trailing, format)}</span>}
        {benchmark != null && <span className="text-[9px] text-text-400">BM: {fmt(benchmark, format)}</span>}
      </div>
    </div>
  )
}

// ── Section Header ─────────────────────────────────────────────────
const colsMap = {
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-5',
  6: 'lg:grid-cols-6',
  7: 'lg:grid-cols-7',
  8: 'lg:grid-cols-8',
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
    { label: 'Auto Books', value: stats.auto_bookings },
    { label: 'Qual Books', value: stats.qualified_bookings },
    { label: 'Live Calls', value: stats.live_calls },
    { label: 'Offers', value: stats.offers },
    { label: 'Closes', value: stats.closes },
    { label: 'Ascensions', value: stats.ascensions },
  ]
  const maxVal = Math.max(...steps.map(s => s.value), 1)

  return (
    <div className="bg-bg-card border border-border-default rounded-2xl p-5">
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
    { label: 'A.Book', k: 'auto_bookings', f: fN },
    { label: 'Q.Book', k: 'qualified_bookings', f: fN },
    { label: 'L→Q%', k: 'lead_to_booking_pct', f: fP },
    { label: 'Cal', k: 'calls_on_calendar', f: fN },
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
    <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
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
function DailyTracker({ entries, onDelete, onSave }) {
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

  const startEdit = e => { setEditDate(e.date); setEditForm({ ...e }) }
  const saveEdit = async () => { await onSave(editForm); setEditDate(null) }
  const EditCell = ({ field }) => (
    <input type="number" value={editForm[field] ?? ''} onChange={e => setEditForm(p => ({ ...p, [field]: Number(e.target.value || 0) }))}
      className="w-14 bg-bg-primary border border-opt-yellow/50 rounded px-1 py-0.5 text-[11px] text-text-primary text-right" />
  )

  const getCalls = e => e.calls_on_calendar || ((e.net_new_calls || 0) + (e.net_fu_calls || 0))
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
    { k: 'calls_on_calendar', label: 'Booked', fmt: fN, get: getCalls },
    { k: null, label: 'Live', calc: e => fN(getLive(e)) },
    { k: null, label: 'Show%', calc: e => { const cal = getCalls(e); return cal > 0 ? fmtP(getLive(e), cal) : '-' },
      color: e => { const cal = getCalls(e); return cal > 0 ? clrRate(getLive(e) / cal * 100, 70, 50) : '' } },
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
    'calls_on_calendar', 'live_calls', 'offers', 'closes', 'reschedules',
    'trial_cash', 'trial_revenue', 'ascensions', 'ascend_cash', 'ascend_revenue',
    'finance_offers', 'finance_accepted', 'monthly_offers', 'monthly_accepted',
    'ar_collected', 'ar_defaulted', 'refund_count', 'refund_amount']

  return (
    <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
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
              if (isEd) {
                return (
                  <tr key={e.date} className="border-b border-opt-yellow/20 bg-opt-yellow/5">
                    <td className="px-2 py-1 font-medium text-opt-yellow sticky left-0 bg-opt-yellow/5 z-10">{e.date}</td>
                    {dataCols.map((c, i) => (
                      <td key={i} className="px-2 py-1 text-right">
                        {c.k && editableFields.includes(c.k) ? <EditCell field={c.k} /> : <span className="text-text-400">—</span>}
                      </td>
                    ))}
                    <td className="px-2 py-1 text-center">
                      <button onClick={saveEdit} className="text-success hover:text-success/80 mr-1"><Check size={12} /></button>
                      <button onClick={() => setEditDate(null)} className="text-text-400 hover:text-text-primary"><X size={12} /></button>
                    </td>
                  </tr>
                )
              }
              return (
                <tr key={e.date} className="border-b border-border-default/30 hover:bg-bg-card-hover/50 group">
                  <td className="px-2 py-1 font-medium text-text-primary whitespace-nowrap sticky left-0 bg-bg-card group-hover:bg-bg-card-hover/50 z-10">{e.date}</td>
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
                  <td className="px-2 py-1 text-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => startEdit(e)} className="text-text-400 hover:text-opt-yellow mr-1"><Edit3 size={11} /></button>
                    <button onClick={() => onDelete(e.date)} className="text-text-400 hover:text-danger"><Trash2 size={11} /></button>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && <tr><td colSpan={20} className="px-3 py-8 text-center text-text-400">No data</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

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
  const [form, setForm] = useState({ date: toLocalDateStr(new Date()) })
  const [saving, setSaving] = useState(false)
  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try { await onSave(form); onClose() } catch (err) { alert('Failed: ' + err.message) }
    setSaving(false)
  }

  let lastGroup = ''
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
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
  { key: 'cpb', label: 'CPB ($)' }, { key: 'show_rate', label: 'Show Rate %' },
  { key: 'offer_rate', label: 'Offer Rate %' },
  { key: 'close_rate', label: 'Close Rate %' }, { key: 'cpa_trial', label: 'CPA Trial ($)' },
  { key: 'trial_fe_roas', label: 'Trial FE ROAS (x)' },
  { key: 'ascend_rate', label: 'Ascend Rate %' }, { key: 'cpa_ascend', label: 'CPA Ascend ($)' },
  { key: 'net_fe_roas', label: 'Net FE ROAS (x)' },
  { key: 'revenue_roas', label: 'Revenue ROAS (x)' }, { key: 'all_cash_roas', label: 'All Cash ROAS (x)' },
  { key: 'ar_success_rate', label: 'AR Success Rate %' },
]

function BenchmarksModal({ benchmarks, onSave, onClose }) {
  const [form, setForm] = useState({ ...benchmarks })
  const [saving, setSaving] = useState(false)
  const handleSave = async () => {
    setSaving(true)
    try { for (const d of benchmarkDefs) { if (form[d.key] != null && form[d.key] !== benchmarks[d.key]) await onSave(d.key, form[d.key]) }; onClose() }
    catch (err) { alert('Failed: ' + err.message) }
    setSaving(false)
  }
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
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
          const num = Number(vals[j].replace(/[$,%x"]/g, '')) || 0
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-2xl w-[640px] max-h-[85vh] overflow-hidden" onClick={e => e.stopPropagation()}>
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
                <span className="text-text-400"> All values from the CSV will override existing data for matching dates. Columns not in the CSV will be left unchanged.</span>
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
  const { entries, benchmarks, loading, syncing, upsertEntry, upsertMany, updateBenchmark, deleteEntry, reload } = useMarketingTracker({ autoSync: true })
  const [range, setRange] = useState(30)
  const [showAddEntry, setShowAddEntry] = useState(false)
  const [showBenchmarks, setShowBenchmarks] = useState(false)
  const [importStatus, setImportStatus] = useState(null)
  const [showImportModal, setShowImportModal] = useState(false)
  const [metaSyncing, setMetaSyncing] = useState(false)
  const [metaStatus, setMetaStatus] = useState(null)
  const fileRef = useRef(null)
  const hasMetaCreds = !!(import.meta.env.VITE_META_ADS_ACCESS_TOKEN && import.meta.env.VITE_META_ADS_ACCOUNT_ID)

  const rangeEntries = useMemo(() => filterByDays(entries, range), [entries, range])
  const mtdEntries = useMemo(() => filterByDays(entries, 'mtd'), [entries])
  const stats = useMemo(() => computeMarketingStats(rangeEntries), [rangeEntries])
  const stats30 = useMemo(() => computeMarketingStats(filterByDays(entries, 30)), [entries])
  const statsMTD = useMemo(() => computeMarketingStats(mtdEntries), [mtdEntries])
  const bm = benchmarks

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

  const handleMetaSync = async () => {
    setMetaSyncing(true)
    setMetaStatus('Pulling data from Meta Ads & GHL...')
    try {
      const result = await syncMetaToTracker(range === 'mtd' ? 30 : range)
      setMetaStatus(result.message)
      await reload()
    } catch (err) {
      setMetaStatus('Sync failed: ' + err.message)
    }
    setMetaSyncing(false)
    setTimeout(() => setMetaStatus(null), 4000)
  }

  const handleDelete = async (date) => { if (confirm(`Delete ${date}?`)) await deleteEntry(date) }

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Marketing Performance</h1>
          <p className="text-xs text-text-400">
            {entries.length} entries
            {syncing && <span className="ml-2 text-opt-yellow"><Loader size={10} className="inline animate-spin mr-1" />Syncing APIs...</span>}
          </p>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <button
          onClick={() => setShowImportModal(true)}
          className="flex items-center gap-2 bg-bg-card border border-border-default rounded-2xl px-3 py-2 hover:bg-bg-card-hover transition-colors"
        >
          <Upload size={14} className="text-text-400" />
          <span className="text-xs text-text-secondary">Import CSV</span>
        </button>
        {importStatus && <span className="text-xs text-opt-yellow">{importStatus}</span>}
        <button
          onClick={handleMetaSync}
          disabled={metaSyncing}
          className="flex items-center gap-2 bg-bg-card border border-border-default rounded-2xl px-3 py-2 hover:bg-bg-card-hover transition-colors disabled:opacity-40"
          title="Pull spend from Meta Ads, leads & bookings from GHL"
        >
          <RefreshCw size={14} className={`text-text-400 ${metaSyncing ? 'animate-spin' : ''}`} />
          <span className="text-xs text-text-secondary">{metaSyncing ? 'Syncing...' : 'Sync Data'}</span>
        </button>
        {metaStatus && <span className="text-xs text-opt-yellow">{metaStatus}</span>}
        <div className="sm:ml-auto flex gap-2">
          <button onClick={() => setShowBenchmarks(true)} className="flex items-center gap-1.5 px-3 py-2 text-xs text-text-secondary border border-border-default rounded-2xl hover:bg-bg-card-hover transition-colors">
            <SlidersHorizontal size={14} /> Benchmarks
          </button>
          <button onClick={() => setShowAddEntry(true)} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-opt-yellow text-bg-primary rounded-2xl hover:bg-opt-yellow/80 transition-colors">
            <Plus size={14} /> Add Entry
          </button>
        </div>
      </div>

      {/* ═══ KPI Sections ═══ */}

      {/* Spend & Lead Acquisition */}
      <Section title="Spend & Lead Acquisition" cols={8}>
        <KPI label="Total Adspend" value={stats.adspend} format="$" trailing={stats30.adspend} />
        <KPI label="Total Leads" value={stats.leads} format="n" trailing={stats30.leads} />
        <KPI label="Cost Per Lead" value={stats.cpl} format="$" benchmark={bm.cpl} trailing={stats30.cpl} />
        <KPI label="Auto Bookings" value={stats.auto_bookings} format="n" trailing={stats30.auto_bookings} />
        <KPI label="Cost Per Auto Booking" value={stats.cost_per_auto_booking} format="$" trailing={stats30.cost_per_auto_booking} />
        <KPI label="Qualified Bookings" value={stats.qualified_bookings} format="n" trailing={stats30.qualified_bookings} />
        <KPI label="Lead → Qual Booking %" value={stats.lead_to_booking_pct} format="%" benchmark={bm.lead_to_booking} trailing={stats30.lead_to_booking_pct} />
        <KPI label="Cost Per Qual Booking" value={stats.cpb} format="$" benchmark={bm.cpb} trailing={stats30.cpb} />
      </Section>

      {/* Calls & Show Rates */}
      <Section title="Calls & Show Rates" cols={7}>
        <KPI label="Booked Calls" value={stats.calls_on_calendar} format="n" />
        <KPI label="Live Calls" value={stats.live_calls} format="n" />
        <KPI label="No Shows" value={stats.no_shows} format="n" />
        <KPI label="Rescheduled" value={stats.reschedules} format="n" />
        <KPI label="Show Rate" value={stats.show_rate} format="%" benchmark={bm.show_rate} trailing={stats30.show_rate} />
        <KPI label="Reschedule Rate" value={stats.reschedule_rate} format="%" />
        <KPI label="Cost Per Live Call" value={stats.cost_per_live_call} format="$" />
      </Section>

      {/* Offers & Closes */}
      <Section title="Offers & Closes" cols={6}>
        <KPI label="Offers Made" value={stats.offers} format="n" />
        <KPI label="Offer Rate" value={stats.offer_rate} format="%" benchmark={bm.offer_rate} trailing={stats30.offer_rate} />
        <KPI label="Cost Per Offer" value={stats.cost_per_offer} format="$" />
        <KPI label="Total Closes" value={stats.closes} format="n" />
        <KPI label="Close Rate" value={stats.close_rate} format="%" benchmark={bm.close_rate} trailing={stats30.close_rate} />
        <KPI label="CPA (Trial)" value={stats.cpa_trial} format="$" benchmark={bm.cpa_trial} trailing={stats30.cpa_trial} />
      </Section>

      {/* Trial Financials */}
      <Section title="Trial Financials" cols={3}>
        <KPI label="Trial Cash Collected" value={stats.trial_cash} format="$" />
        <KPI label="Trial Contracted Rev" value={stats.trial_revenue} format="$" />
        <KPI label="Trial FE Cash ROAS" value={stats.trial_fe_roas} format="x" benchmark={bm.trial_fe_roas} trailing={stats30.trial_fe_roas} />
      </Section>

      {/* Ascension */}
      <Section title="Ascension" cols={8}>
        <KPI label="Total Ascensions" value={stats.ascensions} format="n" />
        <KPI label="Ascension Rate" value={stats.ascend_rate} format="%" benchmark={bm.ascend_rate} trailing={stats30.ascend_rate} />
        <KPI label="CPA (Ascend)" value={stats.cpa_ascend} format="$" benchmark={bm.cpa_ascend} />
        <KPI label="Ascend Cash" value={stats.ascend_cash} format="$" />
        <KPI label="Ascend Revenue" value={stats.ascend_revenue} format="$" />
        <KPI label="% Cash Collected" value={stats.ascend_cash_pct} format="%" />
        <KPI label="Finance Offers" value={stats.finance_offers} format="n" />
        <KPI label="Finance %" value={stats.finance_pct} format="%" />
      </Section>

      {/* ROAS Overview */}
      <Section title="ROAS Overview" cols={3}>
        <KPI label="Net FE Cash ROAS" value={stats.net_fe_roas} format="x" benchmark={bm.net_fe_roas} trailing={stats30.net_fe_roas} />
        <KPI label="Revenue ROAS" value={stats.revenue_roas} format="x" benchmark={bm.revenue_roas} trailing={stats30.revenue_roas} />
        <KPI label="All Cash ROAS" value={stats.all_cash_roas} format="x" benchmark={bm.all_cash_roas} trailing={stats30.all_cash_roas} />
      </Section>

      {/* AR & Refunds */}
      <Section title="AR & Refunds" cols={6}>
        <KPI label="AR Collected" value={stats.ar_collected} format="$" />
        <KPI label="AR Defaulted" value={stats.ar_defaulted} format="$" />
        <KPI label="AR Success Rate" value={stats.ar_success_rate} format="%" benchmark={bm.ar_success_rate} />
        <KPI label="Refunds/Disputes (#)" value={stats.refund_count} format="n" />
        <KPI label="Refunds Amount" value={stats.refund_amount} format="$" />
        <KPI label="All Cash Collected" value={stats.all_cash} format="$" />
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
