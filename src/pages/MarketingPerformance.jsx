import { useState, useRef, useEffect, useMemo, memo, useCallback, startTransition } from 'react'
import { Link } from 'react-router-dom'
import { useMarketingTracker, computeMarketingStats } from '../hooks/useMarketingTracker'
import { useCloserCallProspectMetrics } from '../hooks/useCloserCallProspectMetrics'
import { useAudiences } from '../hooks/useAudiences'
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

// Meta bills the OPT ad account in NZD. The sync-meta-ads-full edge function
// (supabase/functions/sync-meta-ads-full/index.ts:112) writes Meta's raw
// `spend` straight into ad_daily_stats.spend with NO conversion — so the
// numbers in lib_marketing_by_audience_daily.adspend are NZD. The Ads pages
// (AdsList, AdDetail, ComponentDetail) convert at display time using this
// rate; do the same here so the Marketing page shows USD consistently.
//
// closer_calls.revenue / cash_collected are entered by the closer in USD
// (deals are with US customers, Stripe/Fanbasis denominate USD), so
// trial_revenue / trial_cash in the audience view do NOT need conversion.
const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')

// ── Audience parsing + filter (Ben 2026-05-31) ──────────────────────
// Campaign names follow a "BRAND - VERTICAL - description" convention
// (e.g. "SCIO - Electricians - VSL - #1 Electrician 5/24 - Relaunch",
// "OPT - Restoration - Winners Historic"). Parse the second token after
// the brand prefix to get the audience. Manual overrides live in
// campaign_audience_overrides (migration 110) and take precedence.

const BRAND_PREFIXES = new Set(['OPT', 'SCIO', 'CBO'])

export function audienceFromCampaignName(name) {
  if (!name || typeof name !== 'string') return 'Unknown'
  // Split on " - " (with optional spaces around the dash) — campaigns have
  // an inconsistent number of spaces so the regex tolerates both.
  const tokens = name.split(/\s*-\s*/).map(t => t.trim()).filter(Boolean)
  if (tokens.length === 0) return 'Unknown'
  // Drop the brand prefix if present
  const candidates = tokens.filter(t => !BRAND_PREFIXES.has(t.toUpperCase()))
  const first = candidates[0]
  if (!first) return 'Unknown'
  // Normalize casing: "Restoration", "Electricians", "Accounting", etc.
  // Already title-cased in practice so we just return as-is.
  return first
}

// Returns the audience for a single entry, consulting overrides first.
export function audienceForEntry(entry, overrideMap) {
  if (!entry) return 'Unknown'
  if (overrideMap && entry.campaign_id && overrideMap[entry.campaign_id]) {
    return overrideMap[entry.campaign_id]
  }
  return audienceFromCampaignName(entry.campaign_name)
}

// Apply the audience multiselect filter. selectedAudiences is a Set of
// audience strings. Empty set = no filter (show all). Returns a NEW
// array — does NOT mutate.
export function filterByAudience(entries, selectedAudiences, overrideMap) {
  if (!selectedAudiences || selectedAudiences.size === 0) return entries
  return entries.filter(e => selectedAudiences.has(audienceForEntry(e, overrideMap)))
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

// Helper: build a Set<string> of LOWER(prospect_name) that belong to the
// requested audiences. Used by fetchLiveCalls / fetchCloses / fetchAscensions
// to filter their closer_calls rows by audience (closer_calls has no
// native audience column — the only way to attribute is via the resolved
// booking chain).
async function prospectNamesInAudience(audiences, { from, to }) {
  if (!audiences || audiences.size === 0) return null  // no filter active
  // Window the booking lookup to ±90d around the call window so a call
  // attributed via an earlier booking still matches.
  const start = new Date(from); start.setUTCDate(start.getUTCDate() - 90)
  const end = new Date(to); end.setUTCDate(end.getUTCDate() + 30)
  const { data } = await supabase
    .from('lib_strategy_booking_resolved')
    .select('contact_name, audience')
    .in('audience', [...audiences])
    .gte('booked_at', start.toISOString().slice(0, 10))
    .lte('booked_at', end.toISOString().slice(0, 10))
  const set = new Set()
  for (const r of (data || [])) {
    if (!r.contact_name) continue
    // Strip the closer suffix "X and Daniel Gomez De Le Vega" → "X"
    const prospect = r.contact_name.split(' and ')[0].trim().toLowerCase()
    if (prospect) set.add(prospect)
  }
  return set
}

function prospectMatches(prospectName, allowedSet) {
  if (!allowedSet) return true
  if (!prospectName) return false
  // closer_calls.prospect_name may be "Hector  - RestorationConnect Strategy
  // Call" — extract the part before any ' - ' or ' and '.
  const cleaned = prospectName.split(/ - | and /)[0].trim().toLowerCase()
  if (!cleaned) return false
  return allowedSet.has(cleaned)
}

async function fetchLiveCalls({ from, to, audiences } = {}) {
  const allowed = await prospectNamesInAudience(audiences, { from, to })
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
  const rows = (callRows || [])
    .filter(c => prospectMatches(c.prospect_name, allowed))
    .map(c => ({
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

async function fetchCloses({ from, to, audiences } = {}) {
  // Every closed deal in window. Source of truth: lib_close_audience —
  // the same close-resolver chain lib_marketing_by_audience_daily uses for
  // the tile count. Drilldown count now matches the tile.
  //
  // Previously this used closer_calls + prospect_name → strategy_booking
  // matching. That missed every close whose prospect never booked a
  // strategy call (e.g. typeform-resolved closes like George Sidhom). The
  // drilldown showed 2 closes while the tile read 4 — same window, two
  // methodologies. Fixed by reading from the resolved-close view directly
  // and JOINing closer_calls only for closer name + call_type.
  const sinceTs = `${from}T00:00:00Z`
  const untilTs = `${to}T23:59:59Z`

  let q = supabase
    .from('lib_close_audience')
    .select('closer_call_id, prospect_name, revenue, cash_collected, created_at, audience')
    .gte('created_at', sinceTs).lte('created_at', untilTs)
  if (audiences && audiences.size > 0) {
    q = q.in('audience', [...audiences])
  } else {
    // No audience filter active = ALL view. Marketing tile reads
    // lib_marketing_by_audience_daily.closes which excludes Referral closes
    // (close_d CTE filters resolved_campaign <> 'REFERRAL'). Match the tile
    // by excluding Referral here too. Without this the All-view tile shows
    // 4 closes but the drilldown lists 5 (#1 in code-review 2026-06-01).
    q = q.neq('audience', 'Referral')
  }
  const { data: closeRows } = await q
  if (!closeRows?.length) return []

  // Look up closer name + call_type via closer_call_id. Some lib_close_audience
  // rows have null closer_call_id (GHL-attributed closes with no EOD entry).
  const callIds = closeRows.map(r => r.closer_call_id).filter(Boolean)
  let closerById = {}
  if (callIds.length) {
    const { data: calls } = await supabase
      .from('closer_calls')
      .select('id, call_type, eod_report_id')
      .in('id', callIds)
    const reportIds = [...new Set((calls || []).map(c => c.eod_report_id).filter(Boolean))]
    let reportMap = {}
    if (reportIds.length) {
      const { data: reports } = await supabase
        .from('closer_eod_reports')
        .select('id, report_date, closer:team_members!closer_eod_reports_closer_id_fkey(name)')
        .in('id', reportIds)
      reportMap = Object.fromEntries((reports || []).map(r => [r.id, r]))
    }
    closerById = Object.fromEntries((calls || []).map(c => [c.id, {
      call_type: c.call_type,
      closer: reportMap[c.eod_report_id]?.closer?.name || '—',
    }]))
  }

  return closeRows.map(r => {
    const ci = closerById[r.closer_call_id] || {}
    return {
      date: String(r.created_at || '').split('T')[0],
      closer: ci.closer || '—',
      type: ci.call_type || '—',
      prospect: r.prospect_name || '—',
      revenue: r.revenue,
      cash: r.cash_collected,
      audience: r.audience,
      finance: 'no',
    }
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

async function fetchAscensions({ from, to, audiences } = {}) {
  // Every ascension in window — call_type = 'ascension'. Includes both ascended
  // and not-ascended outcomes so the user can see the full ascension funnel.
  const allowed = await prospectNamesInAudience(audiences, { from, to })
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
  return (callRows || [])
    .filter(c => prospectMatches(c.prospect_name, allowed))
    .map(c => ({
      date: reportMap[c.eod_report_id]?.report_date,
      closer: reportMap[c.eod_report_id]?.closer?.name || '—',
      prospect: c.prospect_name || '—',
      outcome: c.outcome,
      revenue: c.revenue,
      cash: c.cash_collected,
      finance: c.offered_finance ? 'yes' : 'no',
    })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

async function fetchBookings({ from, to, audiences } = {}) {
  // Every non-cancelled strategy-call booking in window, audience-resolved
  // via lib_strategy_booking_resolved (migration 130). Resolution ladder:
  //   typeform email → typeform phone → typeform first_name → calendar hint
  // Achieves ~96% coverage for the 55 active bookings in the last 30d.
  //
  // When called from an audience-filtered Marketing tab, `audiences` is a
  // Set of Title-Case names (e.g. {'Restoration'}) and we drop rows whose
  // resolved audience isn't in the set. Without that filter, this used to
  // bleed Electrician bookings (Hector) into the Restoration drilldown.
  const wanted = (audiences && audiences.size > 0) ? audiences : null
  // booked_at is a date in this view, but PostgREST treats `to` ('YYYY-MM-DD')
  // as the start-of-day UTC. With .lte('booked_at', to) we clip every
  // booking made on the `to` day after 00:00. Append ' 23:59:59' so the
  // window includes the full day (#6/#22 in code-review 2026-06-01).
  let q = supabase
    .from('lib_strategy_booking_resolved')
    .select('contact_name, contact_email, calendar_name, booked_at, appointment_date, revenue_tier, is_dq, is_spam, audience, audience_source')
    .eq('is_spam', false)
    .gte('booked_at', from).lte('booked_at', `${to} 23:59:59`)
  if (wanted) q = q.in('audience', [...wanted])
  const { data } = await q
  return (data || []).map(r => ({
    booked: String(r.booked_at).split('T')[0],
    prospect: r.contact_name,
    revenue_tier: r.revenue_tier,
    appt_date: r.appointment_date,
    is_dq: r.is_dq || (r.revenue_tier ? isDQRevenueTier(r.revenue_tier) : false),
    audience: r.audience,
    audience_source: r.audience_source,
  })).sort((a, b) => (b.booked || '').localeCompare(a.booked || ''))
}

async function fetchNoShows({ from, to, audiences } = {}) {
  const allowed = await prospectNamesInAudience(audiences, { from, to })
  // NC no-shows only — follow-up no-shows happen on different funnel
  // events and shouldn't pollute the "did this booking happen" metric.
  // Matches the no_show_rate calculation in useMarketingTracker.js.
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
    .eq('outcome', 'no_show')
    .eq('call_type', 'new_call')
  return (callRows || [])
    .filter(c => prospectMatches(c.prospect_name, allowed))
    .map(c => ({
      date: reportMap[c.eod_report_id]?.report_date,
      closer: reportMap[c.eod_report_id]?.closer?.name || '—',
      prospect: c.prospect_name || '—',
    })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

async function fetchShowRate({ from, to }) {
  // Per-day show rate from marketing_tracker. One row per day with
  // bookings, lives, no_shows, gross + net show% pre-computed.
  const { data } = await supabase
    .from('marketing_tracker')
    .select('date, nc_booked, new_live_calls, no_shows, cancelled_dtf, cancelled_by_prospect, reschedules, qualified_bookings')
    .gte('date', from).lte('date', to)
    .order('date', { ascending: false })
  return (data || [])
    .filter(r => (r.nc_booked || 0) > 0)
    .map(r => {
      const nc = r.nc_booked || 0
      const lives = r.new_live_calls || 0
      const cancels = (r.cancelled_dtf || 0) + (r.cancelled_by_prospect || 0)
      const reschedules = r.reschedules || 0
      const noShows = r.no_shows || 0
      const grossDenom = nc
      const netDenom = Math.max(0, nc - cancels - reschedules)
      const grossShow = grossDenom > 0 ? (lives / grossDenom) * 100 : 0
      const netShow   = netDenom   > 0 ? Math.min(100, (lives / netDenom) * 100) : 0
      return {
        date: r.date,
        nc_booked: nc,
        lives,
        no_shows: noShows,
        cancels,
        reschedules,
        grossShow,
        netShow,
      }
    })
}

async function fetchCpNew({ from, to, audiences } = {}) {
  // Daily Cost/New Live Call — spend / new_live_calls per day.
  if (audiences && audiences.size > 0) {
    const { data } = await supabase
      .from('lib_marketing_by_audience_daily')
      .select('date, audience, adspend, live_calls')
      .in('audience', [...audiences])
      .gte('date', from).lte('date', to)
    const byDate = {}
    for (const r of (data || [])) {
      const d = r.date
      if (!byDate[d]) byDate[d] = { date: d, adspend: 0, new_live_calls: 0 }
      byDate[d].adspend         += Number(r.adspend) || 0
      byDate[d].new_live_calls  += Number(r.live_calls) || 0
    }
    return Object.values(byDate)
      .filter(r => r.adspend > 0 || r.new_live_calls > 0)
      .map(r => ({
        date: r.date,
        adspend: r.adspend * NZD_TO_USD,
        new_live_calls: r.new_live_calls,
        live_calls: r.new_live_calls,
        cpn: r.new_live_calls > 0 ? (r.adspend * NZD_TO_USD) / r.new_live_calls : null,
      }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }
  const { data } = await supabase
    .from('marketing_tracker')
    .select('date, adspend, new_live_calls, live_calls')
    .gte('date', from).lte('date', to)
    .order('date', { ascending: false })
  return (data || [])
    .filter(r => (r.adspend || 0) > 0 || (r.new_live_calls || 0) > 0)
    .map(r => ({
      date: r.date,
      adspend: r.adspend,
      new_live_calls: r.new_live_calls,
      live_calls: r.live_calls,
      cpn: (r.new_live_calls || 0) > 0 ? r.adspend / r.new_live_calls : null,
    }))
}

async function fetchCpaTrial({ from, to, audiences } = {}) {
  // Daily CPA (Trial) — spend / closes per day.
  if (audiences && audiences.size > 0) {
    const { data } = await supabase
      .from('lib_marketing_by_audience_daily')
      .select('date, audience, adspend, closes')
      .in('audience', [...audiences])
      .gte('date', from).lte('date', to)
    const byDate = {}
    for (const r of (data || [])) {
      const d = r.date
      if (!byDate[d]) byDate[d] = { date: d, adspend: 0, closes: 0 }
      byDate[d].adspend += Number(r.adspend) || 0
      byDate[d].closes  += Number(r.closes) || 0
    }
    return Object.values(byDate)
      .filter(r => r.adspend > 0 || r.closes > 0)
      .map(r => ({
        date: r.date,
        adspend: r.adspend * NZD_TO_USD,
        closes: r.closes,
        cpa: r.closes > 0 ? (r.adspend * NZD_TO_USD) / r.closes : null,
      }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }
  const { data: tracker } = await supabase
    .from('marketing_tracker')
    .select('date, adspend, closes')
    .gte('date', from).lte('date', to)
    .order('date', { ascending: false })
  return (tracker || [])
    .filter(r => (r.adspend || 0) > 0 || (r.closes || 0) > 0)
    .map(r => ({
      date: r.date,
      adspend: r.adspend,
      closes: r.closes,
      cpa: (r.closes || 0) > 0 ? r.adspend / r.closes : null,
    }))
}

async function fetchReschCancel({ from, to, audiences } = {}) {
  const allowed = await prospectNamesInAudience(audiences, { from, to })
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
  return (callRows || [])
    .filter(c => prospectMatches(c.prospect_name, allowed))
    .map(c => ({
      date: reportMap[c.eod_report_id]?.report_date,
      closer: reportMap[c.eod_report_id]?.closer?.name || '—',
      type: c.call_type,
      prospect: c.prospect_name || '—',
      outcome: c.outcome,
    })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

async function fetchLeads({ from, to, audiences } = {}) {
  // When an audience filter is active, source leads from typeform_responses
  // (which carries the ad_id → audience chain) instead of the GHL
  // opportunities mirror. This is the only path that lets us attribute a
  // lead to Restoration / Electricians / Australia correctly. Without
  // this branch the drilldown showed ALL leads regardless of tab.
  if (audiences && audiences.size > 0) {
    const sinceTs = `${from}T00:00:00Z`
    const untilTs = `${to}T23:59:59Z`
    // Pull every typeform_responses row in the window joined to lib_ad_audience
    // via ad_id (so we know each lead's audience). Then filter by the picked set.
    const { data } = await supabase
      .from('typeform_responses')
      .select('submitted_at, first_name, last_name, email, phone, form_name, utm_campaign, ad_id')
      .gte('submitted_at', sinceTs).lte('submitted_at', untilTs)
      .order('submitted_at', { ascending: false })
    if (!data?.length) return []
    // Resolve each ad_id → audience by fetching lib_ad_audience for the unique set.
    const adIds = [...new Set(data.map(r => r.ad_id).filter(Boolean))]
    const audMap = {}
    if (adIds.length) {
      const { data: aaRows } = await supabase
        .from('lib_ad_audience')
        .select('ad_id, audience')
        .in('ad_id', adIds)
      for (const r of (aaRows || [])) audMap[r.ad_id] = r.audience
    }
    const wanted = audiences
    return data
      .map(r => ({
        created: (r.submitted_at || '').split('T')[0],
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || '—',
        email: r.email || '—',
        phone: r.phone || '—',
        source: r.form_name || r.utm_campaign || 'Typeform',
        audience: audMap[r.ad_id] || 'Unknown',
      }))
      .filter(r => wanted.has(r.audience))
      .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
  }

  // Query the local ghl_opportunities mirror — instant (~100ms) vs the
  // 10-15s live GHL fetch. The mirror is populated by
  // fetchGHLLeadsByDate (auto-sync) so this stays current. The opportunity
  // table doesn't carry contact name/email/phone — we join to ghl_contacts.
  //
  // Fallback: if the mirror is empty (e.g. first deploy before sync),
  // fall through to the live GHL fetch so the drilldown still works.
  const sinceTs = `${from}T00:00:00`
  const untilTs = `${to}T23:59:59`
  const opps = []
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('ghl_opportunities')
      .select('id, ghl_contact_id, created_at, source, stage_id, name')
      .gte('created_at', sinceTs).lte('created_at', untilTs)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE - 1)
    if (error) { console.warn('local opps query failed, falling back to GHL:', error.message); break }
    if (!data?.length) break
    opps.push(...data)
    if (data.length < PAGE) break
    offset += PAGE
  }

  if (opps.length) {
    // Join contacts in one query for speed
    const contactIds = [...new Set(opps.map(o => o.ghl_contact_id).filter(Boolean))]
    const byId = {}
    const C_PAGE = 500
    for (let i = 0; i < contactIds.length; i += C_PAGE) {
      const slice = contactIds.slice(i, i + C_PAGE)
      const { data } = await supabase
        .from('ghl_contacts')
        .select('ghl_contact_id, full_name, first_name, last_name, email, phone')
        .in('ghl_contact_id', slice)
      for (const c of (data || [])) byId[c.ghl_contact_id] = c
    }
    return opps.map(o => {
      const c = byId[o.ghl_contact_id] || {}
      const name = c.full_name
        || [c.first_name, c.last_name].filter(Boolean).join(' ')
        || o.name
        || '—'
      return {
        created: (o.created_at || '').split('T')[0],
        name,
        email: c.email || '—',
        phone: c.phone || '—',
        source: o.source || '—',
        stage: o.stage_id || '—',
      }
    }).sort((a, b) => (b.created || '').localeCompare(a.created || ''))
  }

  // Fallback: live GHL fetch — slow but correct when local mirror is empty.
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

async function fetchAdspend({ from, to, audiences } = {}) {
  // When audience filter is active, source from lib_marketing_by_audience_daily
  // (NZD pre-multiplied by the JS view aggregator). Otherwise read from
  // marketing_tracker (closer EOD self-report — USD).
  if (audiences && audiences.size > 0) {
    const { data } = await supabase
      .from('lib_marketing_by_audience_daily')
      .select('date, audience, adspend, leads, qualified_bookings')
      .in('audience', [...audiences])
      .gte('date', from).lte('date', to)
    // Aggregate per-day across the picked audiences. adspend here is still
    // NZD (the page applies × NZD_TO_USD elsewhere); convert at display time.
    const byDate = {}
    for (const r of (data || [])) {
      const d = r.date
      if (!byDate[d]) byDate[d] = { date: d, adspend: 0, leads: 0, bookings: 0 }
      byDate[d].adspend  += Number(r.adspend) || 0
      byDate[d].leads    += Number(r.leads) || 0
      byDate[d].bookings += Number(r.qualified_bookings) || 0
    }
    return Object.values(byDate)
      .filter(r => r.adspend > 0 || r.leads > 0)
      .map(r => ({
        date: r.date,
        // Convert NZD → USD so the drilldown agrees with the All-view USD totals.
        adspend: r.adspend * NZD_TO_USD,
        leads: r.leads,
        cpl: r.leads > 0 ? (r.adspend * NZD_TO_USD) / r.leads : null,
        bookings: r.bookings,
      }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }

  // Daily adspend from marketing_tracker — used by the Adspend drilldown.
  const { data } = await supabase
    .from('marketing_tracker')
    .select('date, adspend, leads, qualified_bookings, auto_bookings')
    .gte('date', from).lte('date', to)
    .order('date', { ascending: false })
  return (data || [])
    .filter(r => (r.adspend || 0) > 0 || (r.leads || 0) > 0)
    .map(r => ({
      date: r.date,
      adspend: r.adspend,
      leads: r.leads,
      cpl: (r.leads || 0) > 0 ? r.adspend / r.leads : null,
      bookings: (r.qualified_bookings || 0) + (r.auto_bookings || 0),
    }))
}

const DRILLDOWN_CONFIG = {
  live: {
    title: 'Net New Calls',
    subtitle: 'Closer EOD reports · NEW calls only (no follow-ups, no ascensions) · outcome = not_closed or closed',
    fetcher: fetchLiveCalls,
    chart: { dateKey: 'date', label: 'Net new calls per day' },
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
    chart: { dateKey: 'booked', label: 'Bookings per day' },
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
  qbookings: {
    title: 'Qualified Bookings',
    subtitle: 'Strategy bookings excluding the DQ Calendly calendar',
    fetcher: async (range) => (await fetchBookings(range)).filter(r => !r.is_dq),
    chart: { dateKey: 'booked', label: 'Qualified bookings per day' },
    columns: [
      { key: 'booked', label: 'Booked', cls: 'tabular-nums' },
      { key: 'prospect', label: 'Prospect', cls: 'text-text-primary' },
      { key: 'revenue_tier', label: 'Revenue', render: r => r.revenue_tier || '—' },
      { key: 'appt_date', label: 'Call Date', cls: 'tabular-nums text-text-400' },
    ],
    emptyMsg: 'No qualified bookings in this window.',
  },
  cpl: {
    title: 'Cost Per Lead',
    subtitle: 'Daily Meta adspend ÷ leads created that day',
    fetcher: fetchLeads,
    chart: { dateKey: 'created', mode: 'cost', label: 'CPL per day', fmtValue: v => `$${Math.round(v)}` },
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
  cpb: {
    title: 'Cost Per Booking',
    subtitle: 'Daily Meta adspend ÷ all strategy bookings made that day',
    fetcher: fetchBookings,
    chart: { dateKey: 'booked', mode: 'cost', label: 'Cost per booking per day', fmtValue: v => `$${Math.round(v)}` },
    columns: [
      { key: 'booked', label: 'Booked', cls: 'tabular-nums' },
      { key: 'prospect', label: 'Prospect', cls: 'text-text-primary' },
      { key: 'appt_date', label: 'Call Date', cls: 'tabular-nums text-text-400' },
      { key: 'is_dq', label: 'Type', render: r => r.is_dq
        ? <span className="text-orange-400 text-[10px] uppercase">DQ</span>
        : <span className="text-success text-[10px] uppercase">Qual</span> },
    ],
    emptyMsg: 'No bookings in this window.',
  },
  cpqb: {
    title: 'Cost Per Qualified Booking',
    subtitle: 'Daily Meta adspend ÷ qualified bookings made that day',
    fetcher: async (range) => (await fetchBookings(range)).filter(r => !r.is_dq),
    chart: { dateKey: 'booked', mode: 'cost', label: 'Cost per Q.Book per day', fmtValue: v => `$${Math.round(v)}` },
    columns: [
      { key: 'booked', label: 'Booked', cls: 'tabular-nums' },
      { key: 'prospect', label: 'Prospect', cls: 'text-text-primary' },
      { key: 'appt_date', label: 'Call Date', cls: 'tabular-nums text-text-400' },
    ],
    emptyMsg: 'No qualified bookings in this window.',
  },
  rc: {
    title: 'Reschedules + Cancellations',
    subtitle: 'Closer EOD reports · outcome = rescheduled or canceled',
    fetcher: fetchReschCancel,
    chart: { dateKey: 'date', label: 'R+C events per day' },
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
  noshows: {
    title: 'No-shows',
    subtitle: 'NC bookings that didn\'t show (closer EOD · call_type=new_call · outcome=no_show)',
    fetcher: fetchNoShows,
    chart: { dateKey: 'date', label: 'No-shows per day' },
    columns: [
      { key: 'date', label: 'Date', cls: 'tabular-nums' },
      { key: 'closer', label: 'Closer', cls: 'text-text-primary' },
      { key: 'prospect', label: 'Prospect', cls: 'text-text-primary' },
    ],
    emptyMsg: 'No no-shows logged in this window.',
  },
  showrate: {
    title: 'Show Rate (Gross + Net)',
    subtitle: 'Daily show rate. Gross = lives/booked. Net = lives/(booked-cancels-reschedules).',
    fetcher: fetchShowRate,
    // Chart Gross Show% = sum(lives) / sum(nc_booked) bucketed correctly.
    // Net Show% needs (lives) / (nc_booked - cancels - reschedules) which
    // can't be expressed as a single ratio of two fields; the table below
    // still shows both per row. Using Gross here is the safer aggregate.
    chart: { dateKey: 'date', mode: 'ratio', numeratorKey: 'lives', denominatorKey: 'nc_booked', label: 'Gross Show % (lives ÷ booked)', fmtValue: v => `${(v * 100).toFixed(0)}%` },
    columns: [
      { key: 'date', label: 'Date', cls: 'tabular-nums' },
      { key: 'nc_booked', label: 'NC Booked', align: 'right', cls: 'tabular-nums' },
      { key: 'lives', label: 'Lives', align: 'right', cls: 'tabular-nums' },
      { key: 'no_shows', label: 'No Shows', align: 'right', cls: 'tabular-nums' },
      { key: 'cancels', label: 'Cancels', align: 'right', cls: 'tabular-nums' },
      { key: 'reschedules', label: 'Resch', align: 'right', cls: 'tabular-nums' },
      { key: 'grossShow', label: 'Gross %', align: 'right', render: r => `${r.grossShow.toFixed(0)}%` },
      { key: 'netShow', label: 'Net %', align: 'right', render: r => `${r.netShow.toFixed(0)}%` },
    ],
    emptyMsg: 'No bookings in this window to compute show rate.',
  },
  cpnew: {
    title: 'Cost Per New Live Call',
    subtitle: 'Daily adspend ÷ new live calls that day',
    fetcher: fetchCpNew,
    chart: { dateKey: 'date', mode: 'ratio', numeratorKey: 'adspend', denominatorKey: 'new_live_calls', label: 'Cost per new live ($)', fmtValue: v => `$${Math.round(v).toLocaleString()}` },
    columns: [
      { key: 'date', label: 'Date', cls: 'tabular-nums' },
      { key: 'adspend', label: 'Spend', align: 'right', render: r => r.adspend ? `$${Math.round(r.adspend).toLocaleString()}` : '—' },
      { key: 'new_live_calls', label: 'New Live', align: 'right', cls: 'tabular-nums' },
      { key: 'cpn', label: 'Cost/New', align: 'right', render: r => r.cpn ? `$${Math.round(r.cpn).toLocaleString()}` : '—' },
    ],
    emptyMsg: 'No adspend or new live calls in this window.',
  },
  cpaTrial: {
    title: 'CPA (Trial)',
    subtitle: 'Daily adspend ÷ closes that day',
    fetcher: fetchCpaTrial,
    chart: { dateKey: 'date', mode: 'ratio', numeratorKey: 'adspend', denominatorKey: 'closes', label: 'CPA ($)', fmtValue: v => `$${Math.round(v).toLocaleString()}` },
    columns: [
      { key: 'date', label: 'Date', cls: 'tabular-nums' },
      { key: 'adspend', label: 'Spend', align: 'right', render: r => r.adspend ? `$${Math.round(r.adspend).toLocaleString()}` : '—' },
      { key: 'closes', label: 'Closes', align: 'right', cls: 'tabular-nums' },
      { key: 'cpa', label: 'CPA', align: 'right', render: r => r.cpa ? `$${Math.round(r.cpa).toLocaleString()}` : '—' },
    ],
    emptyMsg: 'No adspend or closes in this window.',
  },
  leads: {
    title: 'Leads',
    subtitle: 'New opportunities in SCIO USA pipeline (created in this window)',
    fetcher: fetchLeads,
    chart: { dateKey: 'created', label: 'Leads per day' },
    columns: [
      { key: 'created', label: 'Date', cls: 'tabular-nums' },
      { key: 'name', label: 'Name', cls: 'text-text-primary' },
      { key: 'email', label: 'Email', cls: 'text-text-400 text-[10px]' },
      { key: 'phone', label: 'Phone', cls: 'text-text-400 text-[10px]' },
      { key: 'source', label: 'Source', cls: 'text-text-400 text-[10px]' },
    ],
    emptyMsg: 'No leads in this window.',
  },
  adspend: {
    title: 'Adspend',
    subtitle: 'Daily Meta adspend in this window',
    fetcher: fetchAdspend,
    chart: { dateKey: 'date', mode: 'value', valueKey: 'adspend', label: 'Adspend per day ($)', fmtValue: v => `$${Math.round(v).toLocaleString()}` },
    columns: [
      { key: 'date', label: 'Date', cls: 'tabular-nums' },
      { key: 'adspend', label: 'Spend', align: 'right', render: r => r.adspend ? `$${Math.round(r.adspend).toLocaleString()}` : '—' },
      { key: 'leads', label: 'Leads', align: 'right', cls: 'tabular-nums' },
      { key: 'cpl', label: 'CPL', align: 'right', render: r => r.cpl ? `$${Math.round(r.cpl)}` : '—' },
      { key: 'bookings', label: 'Bookings', align: 'right', cls: 'tabular-nums' },
    ],
    emptyMsg: 'No adspend in this window.',
  },
  closes: {
    title: 'Closes',
    subtitle: 'Closer EOD reports · outcome = closed · ascensions excluded',
    fetcher: fetchCloses,
    chart: { dateKey: 'date', label: 'Closes per day' },
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

// Daily trend chart for the drilldown modals. Renders a bar chart of
// per-day values across the selected window so Ben can see trend
// shape, not just a row list.
//
//   mode = 'count'  — bars = number of rows per day (default)
//   mode = 'cost'   — bars = totalSpendOnDay / countOnDay (cost-per-X per day)
//
// Bars colored by direction relative to window-period average: lighter
// than avg = below, darker = above. This makes "ramping up" vs "tailing
// off" patterns readable at a glance.
function DailyTrendChart({ rows, dateKey, range, mode = 'count', spendByDate = null, label, fmtValue, valueKey = null, numeratorKey = null, denominatorKey = null }) {
  const { from, to } = resolveRange(range)
  // Build day list inclusive
  const days = []
  let cursor = new Date(from + 'T00:00:00')
  const end = new Date(to + 'T00:00:00')
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setDate(cursor.getDate() + 1)
  }
  // Per-day counts + per-day value sums (for mode='value') + per-day
  // ratio numerator/denominator sums (for mode='ratio'). Ratio mode is
  // the correct way to chart cost-per-X / show-rate / etc. since
  // bucketing weekly/monthly needs sum(num)/sum(denom), NOT a sum of
  // daily ratios — summing $200/lead and $400/lead doesn't give a
  // weekly $/lead, it gives a meaningless $600.
  const counts = Object.fromEntries(days.map(d => [d, 0]))
  const valueSum = Object.fromEntries(days.map(d => [d, 0]))
  const numSum = Object.fromEntries(days.map(d => [d, 0]))
  const denSum = Object.fromEntries(days.map(d => [d, 0]))
  // Safe numeric: Postgres numeric columns come over the wire as strings
  // (e.g. "413.66"). Number() handles both string and numeric input;
  // falls back to 0 for null/undefined/NaN.
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  for (const r of (rows || [])) {
    const d = String(r[dateKey] || '').slice(0, 10)
    if (counts[d] !== undefined) {
      counts[d]++
      if (valueKey) valueSum[d] += num(r[valueKey])
      if (numeratorKey) numSum[d] += num(r[numeratorKey])
      if (denominatorKey) denSum[d] += num(r[denominatorKey])
    }
  }
  // Build series — { day, value, count }
  const series = days.map(d => {
    if (mode === 'ratio' && numeratorKey && denominatorKey) {
      const n = numSum[d], dn = denSum[d]
      const v = dn > 0 ? n / dn : (n > 0 ? null : 0)
      return { day: d, value: v, count: counts[d], num: n, den: dn }
    }
    if (mode === 'value' && valueKey) {
      return { day: d, value: valueSum[d], count: counts[d] }
    }
    if (mode === 'cost') {
      const spend = spendByDate?.[d] || 0
      const ct = counts[d]
      const v = ct > 0 ? spend / ct : (spend > 0 ? null : 0)
      return { day: d, value: v, count: ct, spend }
    }
    return { day: d, value: counts[d], count: counts[d] }
  })
  const validValues = series.map(s => s.value).filter(v => v != null && !isNaN(v) && v > 0)
  const maxV = validValues.length ? Math.max(...validValues) : 0
  const avgV = validValues.length ? validValues.reduce((s, v) => s + v, 0) / validValues.length : 0
  const totalCount = series.reduce((s, p) => s + (p.count || 0), 0)
  const totalSpend = series.reduce((s, p) => s + (p.spend || 0), 0)

  // Layout
  const W = 760
  const H = 110
  const PAD_L = 36
  const PAD_R = 12
  const PAD_T = 14
  const PAD_B = 22
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const barW = Math.max(2, (innerW / series.length) - 2)

  const fmt = fmtValue || ((v) => mode === 'cost' ? `$${Math.round(v)}` : v)
  const [hoverIdx, setHoverIdx] = useState(null)
  const [chartType, setChartType] = useState('bar') // 'bar' | 'line'
  const [granularity, setGranularity] = useState('day') // 'day' | 'week' | 'month'

  // Roll the daily series into weekly or monthly buckets when granularity
  // toggle is on. For count-mode and value-mode we sum across the bucket.
  // For cost-mode we re-divide (totalSpend / totalCount) across the bucket
  // so the bar shows true period CPL, not a misleading average of dailies.
  const bucketed = useMemo(() => {
    if (granularity === 'day') return series
    const bucketKey = (day) => {
      if (granularity === 'month') return day.slice(0, 7) // YYYY-MM
      // ISO week — get Monday of that week
      const dt = new Date(day + 'T00:00:00')
      const dow = (dt.getUTCDay() + 6) % 7 // Mon=0
      dt.setUTCDate(dt.getUTCDate() - dow)
      return dt.toISOString().slice(0, 10) // Monday-of-week date
    }
    const buckets = new Map()
    for (const p of series) {
      const k = bucketKey(p.day)
      if (!buckets.has(k)) buckets.set(k, { day: k, count: 0, spend: 0, valueSum: 0, valueHasData: false, num: 0, den: 0 })
      const b = buckets.get(k)
      b.count += p.count || 0
      b.spend += p.spend || 0
      b.num += p.num || 0
      b.den += p.den || 0
      if (p.value != null) { b.valueSum += p.value; b.valueHasData = true }
    }
    return [...buckets.values()].map(b => {
      if (mode === 'ratio') {
        const v = b.den > 0 ? b.num / b.den : (b.num > 0 ? null : 0)
        return { day: b.day, value: v, count: b.count, num: b.num, den: b.den }
      }
      if (mode === 'cost') {
        const v = b.count > 0 ? b.spend / b.count : (b.spend > 0 ? null : 0)
        return { day: b.day, value: v, count: b.count, spend: b.spend }
      }
      if (mode === 'value' && valueKey) {
        // Value mode = a raw quantity that ADDS UP across days (e.g. spend).
        // Use SUM for the bucket since 'weekly spend = sum of daily spend'.
        // For ratios, callers should use mode='ratio' so the bucket
        // re-divides num/den correctly.
        return { day: b.day, value: b.valueHasData ? b.valueSum : null, count: b.count }
      }
      return { day: b.day, value: b.count, count: b.count }
    })
  }, [series, granularity, mode, valueKey])

  // Recompute max/avg from the bucketed view so axes scale to it.
  const bValid = bucketed.map(s => s.value).filter(v => v != null && !isNaN(v) && v > 0)
  const maxB = bValid.length ? Math.max(...bValid) : 0
  const avgB = bValid.length ? bValid.reduce((s, v) => s + v, 0) / bValid.length : 0

  if (maxV === 0 && totalCount === 0) {
    return (
      <div style={{ padding: 12, color: 'var(--ink-4)', fontSize: 11, fontStyle: 'italic', textAlign: 'center' }}>
        No daily data in this window.
      </div>
    )
  }

  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 12 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-4)' }}>
          {label || (mode === 'cost' ? 'Daily cost-per' : 'Daily volume')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
            {mode === 'cost'
              ? `Avg ${fmt(avgB)}/${granularity} · Total spend ${'$' + Math.round(totalSpend).toLocaleString()}`
              : `Avg ${avgB.toFixed(1)}/${granularity} · Total ${totalCount}`}
          </div>
          {/* Granularity toggle */}
          <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', borderRadius: 2, overflow: 'hidden' }}>
            {[['day','D'],['week','W'],['month','M']].map(([g, lbl]) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                style={{
                  padding: '3px 8px',
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  background: granularity === g ? 'var(--ink)' : 'transparent',
                  color: granularity === g ? 'var(--paper)' : 'var(--ink-3)',
                  border: 'none',
                  cursor: 'pointer',
                  minWidth: 22,
                }}
                title={`${g} buckets`}
              >
                {lbl}
              </button>
            ))}
          </div>
          {/* Bar / Line toggle */}
          <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', borderRadius: 2, overflow: 'hidden' }}>
            {['bar', 'line'].map(t => (
              <button
                key={t}
                onClick={() => setChartType(t)}
                style={{
                  padding: '3px 8px',
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  background: chartType === t ? 'var(--ink)' : 'transparent',
                  color: chartType === t ? 'var(--paper)' : 'var(--ink-3)',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
        {/* Y axis line */}
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + innerH} stroke="var(--rule)" strokeWidth="1" />
        {/* X axis line */}
        <line x1={PAD_L} y1={PAD_T + innerH} x2={W - PAD_R} y2={PAD_T + innerH} stroke="var(--rule)" strokeWidth="1" />
        {/* Avg line */}
        {avgB > 0 && (() => {
          const y = PAD_T + innerH * (1 - avgB / maxB)
          return (
            <g>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="var(--ink-4)" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
              <text x={W - PAD_R - 4} y={y - 3} fontSize="9" fontFamily="var(--mono)" fill="var(--ink-4)" textAnchor="end">avg {fmt(avgB)}</text>
            </g>
          )
        })()}
        {/* BAR view */}
        {chartType === 'bar' && bucketed.map((p, i) => {
          const colX = PAD_L + (i * (innerW / bucketed.length))
          const colW = innerW / bucketed.length
          const h = (p.value != null && p.value > 0 && maxB > 0) ? (p.value / maxB) * innerH : 0
          const barX = colX + 1
          const barY = PAD_T + innerH - h
          const aboveAvg = p.value != null && p.value > avgB
          const isHover = hoverIdx === i
          return (
            <g key={p.day}>
              {h > 0 && (
                <rect
                  x={barX}
                  y={barY}
                  width={barW}
                  height={h}
                  fill={aboveAvg ? 'var(--accent)' : 'var(--ink-3)'}
                  opacity={isHover ? 1 : (aboveAvg ? 0.9 : 0.55)}
                  stroke={isHover ? 'var(--ink)' : 'none'}
                  strokeWidth={isHover ? 1 : 0}
                />
              )}
              <rect
                x={colX}
                y={PAD_T}
                width={colW}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(curr => curr === i ? null : curr)}
                style={{ cursor: 'pointer' }}
              />
            </g>
          )
        })}
        {/* LINE view — polyline with area fill + per-day dot + hover hit-area */}
        {chartType === 'line' && (() => {
          const colW = innerW / bucketed.length
          // Build coordinate list — skip null gaps
          const pts = bucketed.map((p, i) => {
            const x = PAD_L + (i * colW) + colW / 2
            const y = p.value != null && maxB > 0
              ? PAD_T + innerH - (p.value / maxB) * innerH
              : null
            return { ...p, x, y, i }
          })
          // Polyline path string, breaking on nulls
          let path = ''
          let inSeg = false
          for (const pt of pts) {
            if (pt.y == null) { inSeg = false; continue }
            path += (inSeg ? ' L ' : ' M ') + pt.x + ' ' + pt.y
            inSeg = true
          }
          // Area path (close to baseline)
          const baselineY = PAD_T + innerH
          let area = ''
          let segStart = null
          let lastX = null
          for (const pt of pts) {
            if (pt.y == null) {
              if (segStart != null && lastX != null) {
                area += ` L ${lastX} ${baselineY} Z`
              }
              segStart = null
              continue
            }
            if (segStart == null) {
              area += ` M ${pt.x} ${baselineY} L ${pt.x} ${pt.y}`
              segStart = pt.x
            } else {
              area += ` L ${pt.x} ${pt.y}`
            }
            lastX = pt.x
          }
          if (segStart != null && lastX != null) area += ` L ${lastX} ${baselineY} Z`

          return (
            <g>
              <path d={area} fill="var(--accent)" opacity="0.18" />
              <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {pts.map(pt => pt.y != null && (
                <circle
                  key={pt.day}
                  cx={pt.x}
                  cy={pt.y}
                  r={hoverIdx === pt.i ? 4 : 2.5}
                  fill="var(--accent)"
                  stroke="var(--ink)"
                  strokeWidth={hoverIdx === pt.i ? 1 : 0}
                />
              ))}
              {/* Invisible hit areas for hover */}
              {pts.map(pt => (
                <rect
                  key={'h-' + pt.day}
                  x={PAD_L + (pt.i * colW)}
                  y={PAD_T}
                  width={colW}
                  height={innerH}
                  fill="transparent"
                  onMouseEnter={() => setHoverIdx(pt.i)}
                  onMouseLeave={() => setHoverIdx(curr => curr === pt.i ? null : curr)}
                  style={{ cursor: 'pointer' }}
                />
              ))}
            </g>
          )
        })()}
        {/* Hover tooltip — positioned near hovered bar */}
        {hoverIdx != null && bucketed[hoverIdx] && (() => {
          const p = bucketed[hoverIdx]
          const colX = PAD_L + (hoverIdx * (innerW / bucketed.length))
          const colW = innerW / bucketed.length
          const cx = colX + colW / 2
          // Position tooltip above bar if there's room, else inside
          const tipW = 130
          const tipH = mode === 'cost' || mode === 'value' ? 42 : 30
          let tipX = cx - tipW / 2
          if (tipX < PAD_L) tipX = PAD_L
          if (tipX + tipW > W - PAD_R) tipX = W - PAD_R - tipW
          const tipY = Math.max(PAD_T, PAD_T + 4)
          return (
            <g pointerEvents="none">
              <rect x={tipX} y={tipY} width={tipW} height={tipH} fill="var(--paper)" stroke="var(--ink)" strokeWidth="1" rx="2" />
              <text x={tipX + 6} y={tipY + 12} fontSize="10" fontFamily="var(--mono)" fill="var(--ink-3)">{p.day}</text>
              <text x={tipX + 6} y={tipY + 25} fontSize="11" fontFamily="var(--mono)" fill="var(--ink)" fontWeight="600">
                {p.value != null ? fmt(p.value) : 'no data'}
              </text>
              {mode === 'cost' && p.value != null && (
                <text x={tipX + 6} y={tipY + 37} fontSize="9" fontFamily="var(--mono)" fill="var(--ink-4)">
                  {p.count} × ${Math.round(p.spend || 0).toLocaleString()}
                </text>
              )}
              {mode === 'value' && (
                <text x={tipX + 6} y={tipY + 37} fontSize="9" fontFamily="var(--mono)" fill="var(--ink-4)">
                  {p.count} {p.count === 1 ? 'entry' : 'entries'}
                </text>
              )}
            </g>
          )
        })()}
        {/* X axis labels — first, middle, last */}
        {[0, Math.floor(bucketed.length / 2), bucketed.length - 1].map(i => {
          if (i < 0 || i >= bucketed.length) return null
          const x = PAD_L + (i * (innerW / bucketed.length)) + (innerW / bucketed.length) / 2
          const lbl = granularity === 'month' ? bucketed[i].day : bucketed[i].day.slice(5)
          return (
            <text key={i} x={x} y={H - 6} fontSize="9" fontFamily="var(--mono)" fill="var(--ink-4)" textAnchor="middle">
              {lbl}
            </text>
          )
        })}
        {/* Y axis labels */}
        <text x={PAD_L - 4} y={PAD_T + 4} fontSize="9" fontFamily="var(--mono)" fill="var(--ink-4)" textAnchor="end">{fmt(maxB)}</text>
        <text x={PAD_L - 4} y={PAD_T + innerH + 2} fontSize="9" fontFamily="var(--mono)" fill="var(--ink-4)" textAnchor="end">0</text>
      </svg>
    </div>
  )
}

function DrilldownModal({ kind, range, onClose, spendByDate, selectedAudiences }) {
  const config = DRILLDOWN_CONFIG[kind]
  const [rows, setRows] = useState(null)
  // Stable key for the audience set so the effect re-runs when filter changes.
  const audKey = selectedAudiences ? [...selectedAudiences].sort().join('|') : ''
  useEffect(() => {
    if (!config) return
    let cancelled = false
    setRows(null)
    const args = { ...resolveRange(range), audiences: selectedAudiences }
    config.fetcher(args)
      .then(r => { if (!cancelled) setRows(r) })
      .catch(e => { if (!cancelled) { console.warn(`${kind} drilldown failed:`, e); setRows([]) } })
    return () => { cancelled = true }
  }, [kind, range, audKey, config])

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
          {rows != null && rows.length > 0 && config.chart && (
            <DailyTrendChart
              rows={rows}
              dateKey={config.chart.dateKey}
              range={range}
              mode={config.chart.mode || 'count'}
              valueKey={config.chart.valueKey}
              numeratorKey={config.chart.numeratorKey}
              denominatorKey={config.chart.denominatorKey}
              spendByDate={spendByDate}
              label={config.chart.label}
              fmtValue={config.chart.fmtValue}
            />
          )}
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

// ── Resolve Duplicate Modal ────────────────────────────────────────
// Click a possible-duplicate pair in the marketing dashboard banner →
// this modal lets Ben confirm or dismiss the suggestion. Writes to
// public.prospect_dupe_resolutions (migration 057).
//
// "Same person" = merge: secondary contact_id collapses into primary
// in all sum* helpers, so Q.Books / Live / Closes counts drop by one.
// "Different people" = not_duplicate: pair drops off the suggestion
// list forever, but counts stay intact.
function ResolveDupeModal({ group, onClose, onResolved }) {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [primaryIdx, setPrimaryIdx] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function loadDetails() {
      setLoading(true); setError(null)
      try {
        const ids = group.members.map(m => m.contactKey)
        // Pull each contact's appointment history + GHL contact details
        // so the user can eyeball them before deciding.
        const [{ data: contacts }, { data: appts }] = await Promise.all([
          supabase
            .from('ghl_contacts')
            .select('ghl_contact_id, full_name, first_name, last_name, email, phone, company_name, date_added')
            .in('ghl_contact_id', ids),
          supabase
            .from('ghl_appointments')
            .select('ghl_contact_id, contact_name, calendar_name, booked_at, appointment_date, appointment_status')
            .in('ghl_contact_id', ids)
            .order('booked_at', { ascending: false })
        ])
        if (cancelled) return
        const byId = {}
        for (const c of (contacts || [])) byId[c.ghl_contact_id] = c
        const apptsBy = {}
        for (const a of (appts || [])) {
          if (!apptsBy[a.ghl_contact_id]) apptsBy[a.ghl_contact_id] = []
          apptsBy[a.ghl_contact_id].push(a)
        }
        const rich = group.members.map(m => ({
          contactKey: m.contactKey,
          rawName: m.name,
          contact: byId[m.contactKey] || null,
          appts: apptsBy[m.contactKey] || [],
        }))
        setMembers(rich)
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadDetails()
    return () => { cancelled = true }
  }, [group])

  const saveResolution = async (action) => {
    setSaving(true); setError(null)
    try {
      const ids = members.map(m => m.contactKey)
      const primary = ids[primaryIdx]
      // Write a resolution for every other member paired with the primary.
      const rows = ids
        .filter(id => id !== primary)
        .map(secondary => {
          const [a, b] = primary < secondary ? [primary, secondary] : [secondary, primary]
          return {
            primary_contact_id: a,
            secondary_contact_id: b,
            action,
          }
        })
      if (rows.length === 0) throw new Error('Need at least 2 contacts to resolve')
      const { error: upErr } = await supabase
        .from('prospect_dupe_resolutions')
        .upsert(rows, { onConflict: 'primary_contact_id,secondary_contact_id' })
      if (upErr) throw new Error(upErr.message)
      await onResolved()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)', zIndex: 200, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: 60 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '92%', maxWidth: 880, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, padding: '24px 28px', maxHeight: '85vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--rule)' }}>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-4)' }}>Resolve duplicate</div>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 22, margin: '4px 0 0', fontWeight: 500 }}>Are these the same person?</h2>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--rule)', padding: '6px 10px', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em' }}>CLOSE ✕</button>
        </div>

        {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-4)' }}>Loading prospect history...</div>}
        {error && <div style={{ padding: 12, color: '#c44', background: '#fee', borderRadius: 3, marginBottom: 12 }}>{error}</div>}

        {!loading && members.length > 0 && (
          <>
            <div style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 14 }}>
              If yes, pick which contact is the canonical record (the others merge into it). The bookings / lives / closes counts collapse to one prospect on the next page load.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${members.length}, 1fr)`, gap: 12, marginBottom: 18 }}>
              {members.map((m, idx) => (
                <div
                  key={m.contactKey}
                  onClick={() => setPrimaryIdx(idx)}
                  style={{
                    border: idx === primaryIdx ? '2px solid var(--accent)' : '1px solid var(--rule)',
                    padding: 14,
                    borderRadius: 3,
                    cursor: 'pointer',
                    background: idx === primaryIdx ? 'var(--accent-soft)' : 'var(--paper-2)',
                  }}
                >
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: idx === primaryIdx ? 'var(--ink)' : 'var(--ink-4)' }}>
                    {idx === primaryIdx ? '★ Keep as primary' : 'Click to make primary'}
                  </div>
                  <div style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 500, margin: '4px 0 8px', color: 'var(--ink)' }}>
                    {m.contact?.full_name || `${m.contact?.first_name || ''} ${m.contact?.last_name || ''}`.trim() || m.rawName || '(no name)'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.6 }}>
                    <div>{m.contact?.email || <span style={{ color: 'var(--ink-4)' }}>no email</span>}</div>
                    <div>{m.contact?.phone || <span style={{ color: 'var(--ink-4)' }}>no phone</span>}</div>
                    {m.contact?.company_name && <div style={{ color: 'var(--ink-2)' }}>{m.contact.company_name}</div>}
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', marginTop: 6 }}>
                      Created {m.contact?.date_added?.slice(0, 10) || '?'} · {m.appts.length} appointment{m.appts.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  {m.appts.length > 0 && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dotted var(--rule)', fontSize: 11, color: 'var(--ink-3)' }}>
                      {m.appts.slice(0, 4).map(a => (
                        <div key={`${m.contactKey}-${a.booked_at || a.appointment_date}`} style={{ marginBottom: 2 }}>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)' }}>
                            {(a.booked_at || a.appointment_date || '').slice(0, 10)}
                          </span>{' '}
                          {a.calendar_name?.slice(0, 18) || '?'} {a.appointment_status && `(${a.appointment_status})`}
                        </div>
                      ))}
                      {m.appts.length > 4 && <div style={{ color: 'var(--ink-4)', fontStyle: 'italic' }}>+ {m.appts.length - 4} more</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 14, borderTop: '1px solid var(--rule)' }}>
              <button
                disabled={saving}
                onClick={() => saveResolution('not_duplicate')}
                style={{ padding: '10px 18px', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 3, cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', color: 'var(--ink-2)' }}
              >
                Different people — dismiss
              </button>
              <button
                disabled={saving}
                onClick={() => saveResolution('merge')}
                style={{ padding: '10px 18px', background: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 3, cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', color: 'var(--ink)', fontWeight: 600 }}
              >
                Same person — merge into primary
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────
export default function MarketingPerformance() {
  const { entries, benchmarks, loading, upsertEntry, upsertMany, updateBenchmark, deleteEntry, reload } = useMarketingTracker()
  // Self-service audiences (audience_definitions table). Adding "Dentists"
  // in Settings → Audiences makes a Dentists tab appear here automatically;
  // the whole resolution chain (lib_ad_audience, lib_strategy_booking_resolved,
  // lib_closer_call_audience, lib_close_audience, lib_marketing_by_audience_daily)
  // already buckets by audience name, so tiles + drilldowns light up with
  // zero code changes per audience.
  const { audiences: audienceDefs } = useAudiences()
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

  // Audience filter (multi-select). Hoisted above sumBookings et al because
  // those useCallbacks include selectedAudiences in their dependency arrays —
  // a TDZ violation if declared later in the function body. The actual
  // setSelectedAudiences UI binds further down where the rest of the audience
  // panel state lives. The two declarations stay in sync because they are
  // the same `useState` call.
  const [selectedAudiences, setSelectedAudiences] = useState(() => new Set())

  // Duplicate-pair resolutions (migration 057). Ben clicks a "possible
  // duplicate" pair and either merges them (secondary contact_id starts
  // collapsing into the primary in all counts) or marks them "not
  // duplicate" (pair drops off the suggestion list forever).
  //
  // dupeResolutions: { 'A|B': { action: 'merge'|'not_duplicate', primary, secondary } }
  //   key is the lexicographically-ordered pair so lookup is symmetric.
  // mergeMap: { secondaryContactId -> primaryContactId } — used by
  //   sumBookings et al. to collapse secondary into primary at count time.
  const [dupeResolutions, setDupeResolutions] = useState({})
  const [resolvingDupe, setResolvingDupe] = useState(null) // pair object or null
  const reloadDupeResolutions = useCallback(async () => {
    const { data, error } = await supabase
      .from('prospect_dupe_resolutions')
      .select('primary_contact_id, secondary_contact_id, action')
    if (error) { console.warn('dupe resolutions load failed:', error.message); return }
    const map = {}
    for (const r of (data || [])) {
      map[`${r.primary_contact_id}|${r.secondary_contact_id}`] = r
    }
    setDupeResolutions(map)
  }, [])
  useEffect(() => { reloadDupeResolutions() }, [reloadDupeResolutions])

  // contact_id → primary it merges into (only for action='merge' rows).
  // Used by all sum* helpers below to collapse the secondary into the
  // primary so the counts truly reflect unique prospects.
  const mergeMap = useMemo(() => {
    const m = {}
    for (const r of Object.values(dupeResolutions)) {
      if (r.action === 'merge') m[r.secondary_contact_id] = r.primary_contact_id
    }
    return m
  }, [dupeResolutions])
  const canonicalKey = useCallback((contactKey) => {
    // Resolve transitively in case A→B→C (rare but possible). Cap at 4
    // hops as a safety net.
    let k = contactKey
    for (let i = 0; i < 4 && mergeMap[k]; i++) k = mergeMap[k]
    return k
  }, [mergeMap])
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
      // Source bookings from lib_strategy_booking_resolved so each row carries
      // its audience tag. The view already filters to non-cancelled strategy-
      // calendar bookings, deduped by contact, and flags is_spam (123, J,
      // Tj, dsd etc.) which we exclude here so spam never enters any
      // booking-derived count.
      const [{ data, error }, { data: oppRows, error: oppErr }] = await Promise.all([
        supabase
          .from('lib_strategy_booking_resolved')
          .select('booked_at, appointment_date, calendar_name, revenue_tier, ghl_contact_id, contact_name, is_dq, is_spam, audience')
          .eq('is_spam', false)
          .gte('booked_at', sinceStr),
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
        // is_dq comes from the view (calendar-based); also honor revenue-tier
        // overrides so manual revenue_tier flags still work.
        const dqByTier = a.revenue_tier ? isDQRevenueTier(a.revenue_tier) : null
        const isDq = dqByTier !== null ? dqByTier : !!a.is_dq
        const contactKey = a.ghl_contact_id || `name:${a.contact_name || 'unknown'}`
        const contactName = a.contact_name || ''
        const audience = a.audience || 'Unknown'

        // booked_at-bucketed
        const rawBooked = a.booked_at || a.appointment_date
        if (rawBooked) {
          const d = String(rawBooked).split(' ')[0].split('T')[0]
          if (d >= sinceStr && d <= todayStr) {
            if (!map[d]) map[d] = []
            map[d].push({ contactKey, isDq, contactName, audience })
          }
        }

        // appointment_date-bucketed (cap at today — exclude future calls)
        const rawApt = a.appointment_date
        if (rawApt) {
          const d = String(rawApt).split(' ')[0].split('T')[0]
          if (d >= sinceStr && d <= todayStr) {
            if (!cohortMap[d]) cohortMap[d] = []
            cohortMap[d].push({ contactKey, isDq, contactName, audience })
          }
        }

        // Lead-cohort-bucketed (booking attributed to its LEAD's createdAt).
        // Falls back to booked_at when no opportunity is known for the contact.
        const leadDate = leadDateByContact[a.ghl_contact_id]
        const cohortDate = leadDate || (rawBooked ? String(rawBooked).split(' ')[0].split('T')[0] : null)
        if (cohortDate && cohortDate >= sinceStr && cohortDate <= todayStr) {
          if (!leadCohortMap[cohortDate]) leadCohortMap[cohortDate] = []
          leadCohortMap[cohortDate].push({ contactKey, isDq, contactName, audience })
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
    // Hide pairs that have already been resolved (either merged or
    // marked "not duplicate"). For groups with >2 members we still
    // surface the unresolved pair-combinations.
    return dupes.filter(g => {
      if (g.members.length === 2) {
        const ids = g.members.map(m => m.contactKey).sort()
        return !dupeResolutions[`${ids[0]}|${ids[1]}`]
      }
      // For 3+ member groups, hide only if EVERY pair has a resolution.
      const ids = g.members.map(m => m.contactKey)
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i] < ids[j] ? ids[i] : ids[j]
          const b = ids[i] < ids[j] ? ids[j] : ids[i]
          if (!dupeResolutions[`${a}|${b}`]) return true
        }
      }
      return false
    })
  }, [bookingsByDate, dupeResolutions])

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
    const wantedAud = (selectedAudiences && selectedAudiences.size > 0) ? selectedAudiences : null
    const seen = new Map()
    for (const [d, list] of Object.entries(bookingsByDate)) {
      if (!filterDate(d)) continue
      for (const b of list) {
        if (wantedAud && !wantedAud.has(b.audience)) continue
        const key = canonicalKey(b.contactKey)
        const existing = seen.get(key)
        if (!existing) seen.set(key, { isDq: b.isDq })
        else if (existing.isDq && !b.isDq) seen.set(key, { isDq: false })
      }
    }
    let all = 0, qualified = 0, dq = 0
    for (const v of seen.values()) {
      all++
      if (v.isDq) dq++
      else qualified++
    }
    return { all, qualified, dq }
  }, [bookingsByDate, canonicalKey, selectedAudiences])

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
    const wantedAud = (selectedAudiences && selectedAudiences.size > 0) ? selectedAudiences : null
    const seen = new Map()
    for (const [d, list] of Object.entries(cohortBookingsByDate)) {
      if (!filterDate(d)) continue
      for (const b of list) {
        if (wantedAud && !wantedAud.has(b.audience)) continue
        const key = canonicalKey(b.contactKey)
        const existing = seen.get(key)
        if (!existing) seen.set(key, { isDq: b.isDq })
        else if (existing.isDq && !b.isDq) seen.set(key, { isDq: false })
      }
    }
    let all = 0, qualified = 0, dq = 0
    for (const v of seen.values()) {
      all++
      if (v.isDq) dq++
      else qualified++
    }
    return { all, qualified, dq }
  }, [cohortBookingsByDate, canonicalKey, selectedAudiences])

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
    const wantedAud = (selectedAudiences && selectedAudiences.size > 0) ? selectedAudiences : null
    const seen = new Map()
    for (const [d, list] of Object.entries(leadCohortBookingsByDate)) {
      if (!filterDate(d)) continue
      for (const b of list) {
        if (wantedAud && !wantedAud.has(b.audience)) continue
        const key = canonicalKey(b.contactKey)
        const existing = seen.get(key)
        if (!existing) seen.set(key, { isDq: b.isDq })
        else if (existing.isDq && !b.isDq) seen.set(key, { isDq: false })
      }
    }
    let all = 0, qualified = 0, dq = 0
    for (const v of seen.values()) {
      all++
      if (v.isDq) dq++
      else qualified++
    }
    return { all, qualified, dq }
  }, [leadCohortBookingsByDate, canonicalKey, selectedAudiences])

  // Audience filter (Ben 2026-05-31). Multiselect via chips next to the
  // date range. Empty Set = show all. Overrides loaded from
  // campaign_audience_overrides table (migration 110).
  // (selectedAudiences itself is hoisted further up — see comment near
  // leadCohortBookingsByDate. Keep these sibling states here.)
  const [audienceOverrides, setAudienceOverrides] = useState({})   // campaign_id → audience_slug
  const [overrideModal, setOverrideModal] = useState(null)         // { campaign_id, campaign_name, current_audience }

  useEffect(() => {
    let alive = true
    supabase.from('campaign_audience_overrides').select('campaign_id,audience_slug')
      .then(({ data, error }) => {
        if (!alive || error || !data) return
        const map = {}
        data.forEach(r => { map[r.campaign_id] = r.audience_slug })
        setAudienceOverrides(map)
      })
    return () => { alive = false }
  }, [])

  // Per-audience daily rollup. Source: lib_marketing_by_audience_daily view
  // (migration 123). One row per (date, audience). We aggregate by audience
  // selection back into a marketing_tracker-shaped daily array, so all the
  // downstream code (KPIs, trailing comparison, charts) just sees daily rows
  // — same shape, same fields, different math when audience is filtered.
  // (Ben 2026-06-01: "When I click Restoration it says I have zero ad spend
  // for restoration. That just factually is not correct.")
  const [audienceDaily, setAudienceDaily] = useState([])
  useEffect(() => {
    let alive = true
    supabase.from('lib_marketing_by_audience_daily').select('*').limit(2000)
      .then(({ data, error }) => {
        if (!alive || error || !data) return
        setAudienceDaily(data)
      })
    return () => { alive = false }
  }, [])

  // All distinct audiences present in the dataset, sorted by total spend
  // so the chip strip shows the heaviest audiences first. Includes
  // "Unknown" so the operator can see misparses.
  //
  // Canonical audiences (Restoration, Electricians, etc.) are pinned even
  // when zero entries match in the current window — Ben wants them always
  // visible/clickable as filters, not popping in and out by date range
  // (request 2026-05-31).
  // Audience list = every active row in audience_definitions, sorted by
  // spend desc within the current window. Any audience added via Settings
  // → Audiences appears here on next render — no hardcoded list to maintain.
  const audienceList = useMemo(() => {
    const fromTable = (audienceDefs || []).filter(a => a.is_active !== false).map(a => a.display_name)
    const totals = {}
    for (const name of fromTable) totals[name] = 0
    for (const e of entries || []) {
      const a = audienceForEntry(e, audienceOverrides)
      if (a in totals) totals[a] += Number(e.adspend || 0)
      else totals[a] = Number(e.adspend || 0)  // catch any audience that exists in data but not in table
    }
    return Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([a]) => a)
  }, [entries, audienceOverrides, audienceDefs])

  // Single source of truth: audienceDaily (= lib_marketing_by_audience_daily
  // aggregating ad_daily_stats truth + typeform attribution chain). Used
  // for BOTH the All view (sum across all audiences) AND filtered views
  // (sum across selected audiences).
  //
  // Ben caught the bug (2026-06-01): previously "All" used marketing_tracker
  // (closer-EOD self-report = ~$16k spend last 30d), while filtered views
  // used the audience view (= $29k Meta truth). Numbers didn't reconcile.
  //
  // Now: All math is consistent. Restoration + Electricians + ... ==
  // All. EOD-only fields (offers, ascensions, refunds — closer-self-reported
  // numbers not derivable from attribution) are layered in from
  // marketing_tracker for the All view only. Those don't apply at the
  // per-audience level because closers don't tag their EOD report by
  // audience.
  const audienceFilteredEntries = useMemo(() => {
    if (!audienceDaily.length) return entries  // wait for the view to load
    const wanted = (selectedAudiences && selectedAudiences.size > 0) ? selectedAudiences : null
    const byDate = {}
    const emptyRow = (d) => ({
      date: d,
      adspend: 0, leads: 0, qualified_bookings: 0,
      live_calls: 0, new_live_calls: 0, net_live_calls: 0,
      net_new_calls: 0, net_fu_calls: 0,
      auto_bookings: 0, calls_on_calendar: 0,
      offers: 0, closes: 0,
      trial_cash: 0, trial_revenue: 0,
      ascensions: 0, ascend_cash: 0, ascend_revenue: 0,
      ar_collected: 0, ar_defaulted: 0,
      refund_count: 0, refund_amount: 0,
      finance_offers: 0, finance_accepted: 0,
      monthly_offers: 0, monthly_accepted: 0,
      reschedules: 0, no_shows: 0,
      cancelled_dtf: 0, cancelled_by_prospect: 0,
    })
    for (const row of audienceDaily) {
      if (wanted && !wanted.has(row.audience)) continue
      const d = row.date
      if (!byDate[d]) byDate[d] = emptyRow(d)
      const r = byDate[d]
      // adspend is NZD from ad_daily_stats — convert to USD for display.
      // trial_revenue / trial_cash are already USD (closer EOD entry).
      r.adspend            += (Number(row.adspend) || 0) * NZD_TO_USD
      r.leads              += Number(row.leads) || 0
      r.qualified_bookings += Number(row.qualified_bookings) || 0
      // live_calls is now sourced from lib_closer_call_audience NC count
      // (matches the fetchLiveCalls drilldown one-for-one). When a filter
      // is active this gives Electrician-only NC count = 2 instead of
      // global EOD 4. When no filter, it gives the total across audiences.
      r.live_calls         += Number(row.live_calls) || 0
      r.new_live_calls     += Number(row.live_calls) || 0
      // closes from the view (sourced via lib_close_audience with booking
      // fallback so closes inherit their booking's audience when the
      // typeform attribution missed).
      r.closes             += Number(row.closes) || 0
      r.trial_revenue      += Number(row.trial_revenue) || 0
      r.trial_cash         += Number(row.trial_cash) || 0
      // Ascensions now from lib_closer_call_audience too (was global
      // marketing_tracker.ascensions = 1 even when filtered to Electricians;
      // John & Hector are Electricians but the lone ascension belonged to
      // an Unknown-audience prospect, so Electricians filter shows 0).
      r.ascensions         += Number(row.ascensions) || 0
    }
    // Layer in EOD-only KPIs from marketing_tracker — offers, ascensions,
    // refunds, no_shows, reschedules, etc. These are closer-self-reported
    // daily aggregates with no per-event row + no audience column, so they
    // can't be split. Layer them in for BOTH the All view AND audience-
    // filtered views (Ben 2026-06-01: prior code zeroed these when a filter
    // was active, which made "No Shows 6 → 0" and "Offers 3 → 0" the moment
    // you clicked Restoration — looked like the page broke).
    //
    // Caveat: these counts stay global. When filtered they don't reflect
    // "no-shows for Restoration leads specifically" — they reflect "no-shows
    // for everyone in the window". Tooltips on the affected tiles call this
    // out so the operator isn't surprised.
    const mtByDate = {}
    for (const e of entries) mtByDate[e.date] = e
    for (const d in byDate) {
      const mt = mtByDate[d]; if (!mt) continue
      // When an audience filter is active, prefer the audience-bucketed
      // ascensions count we already computed from lib_closer_call_audience.
      // marketing_tracker.ascensions is a global daily counter that doesn't
      // know which audience the ascending prospect belonged to.
      if (!wanted) byDate[d].ascensions = Number(mt.ascensions) || 0
      byDate[d].offers              = Number(mt.offers) || 0
      byDate[d].ascend_cash         = Number(mt.ascend_cash) || 0
      byDate[d].ascend_revenue      = Number(mt.ascend_revenue) || 0
      byDate[d].ar_collected        = Number(mt.ar_collected) || 0
      byDate[d].ar_defaulted        = Number(mt.ar_defaulted) || 0
      byDate[d].refund_count        = Number(mt.refund_count) || 0
      byDate[d].refund_amount       = Number(mt.refund_amount) || 0
      byDate[d].finance_offers      = Number(mt.finance_offers) || 0
      byDate[d].finance_accepted    = Number(mt.finance_accepted) || 0
      byDate[d].monthly_offers      = Number(mt.monthly_offers) || 0
      byDate[d].monthly_accepted    = Number(mt.monthly_accepted) || 0
      byDate[d].reschedules         = Number(mt.reschedules) || 0
      byDate[d].no_shows            = Number(mt.no_shows) || 0
      byDate[d].cancelled_dtf       = Number(mt.cancelled_dtf) || 0
      byDate[d].cancelled_by_prospect = Number(mt.cancelled_by_prospect) || 0
      byDate[d].net_new_calls       = Number(mt.net_new_calls) || 0
      byDate[d].net_fu_calls        = Number(mt.net_fu_calls) || 0
      byDate[d].net_live_calls      = Number(mt.net_live_calls) || 0
      // new_live_calls when there's NO audience filter — use closer-EOD's
      // NC count (= 25 for 30d). When filter IS active, keep the audience-
      // bucketed count from lib_marketing_by_audience_daily.live_calls
      // (which now sources lib_closer_call_audience).
      if (!wanted) byDate[d].new_live_calls = Number(mt.new_live_calls) || 0
      byDate[d].auto_bookings       = Number(mt.auto_bookings) || 0
      byDate[d].calls_on_calendar   = Number(mt.calls_on_calendar) || 0
    }
    return Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date))
  }, [entries, audienceDaily, selectedAudiences])

  const rangeEntries = useMemo(() => filterByDays(audienceFilteredEntries, range), [audienceFilteredEntries, range])
  const mtdEntries = useMemo(() => filterByDays(audienceFilteredEntries, 'mtd'), [audienceFilteredEntries])
  const prevEntries = useMemo(() => filterPreviousPeriod(audienceFilteredEntries, range), [audienceFilteredEntries, range])

  // Per-audience comparison rollup — one row per audience in the
  // currently-selected DATE range. Used by the AudienceComparisonTable
  // below the headline KPIs. Always uses the date-filtered entries
  // (so the comparison respects the date range) but ignores the
  // audience filter so all audiences show side-by-side.
  const rangeAllAudiences = useMemo(() => filterByDays(entries, range), [entries, range])
  const audienceComparison = useMemo(() => {
    const byAudience = {}
    for (const e of rangeAllAudiences) {
      const a = audienceForEntry(e, audienceOverrides)
      if (!byAudience[a]) byAudience[a] = []
      byAudience[a].push(e)
    }
    return Object.entries(byAudience)
      .map(([audience, rows]) => ({ audience, stats: computeMarketingStats(rows), spend: rows.reduce((s, e) => s + Number(e.adspend || 0), 0), days: new Set(rows.map(r => r.date)).size }))
      .sort((a, b) => b.spend - a.spend)
  }, [rangeAllAudiences, audienceOverrides])

  const toggleAudience = useCallback((aud) => {
    setSelectedAudiences(prev => {
      const next = new Set(prev)
      if (next.has(aud)) next.delete(aud); else next.add(aud)
      return next
    })
  }, [])

  const saveAudienceOverride = useCallback(async (campaign_id, campaign_name, audience_slug) => {
    if (!campaign_id) return
    const { error } = await supabase.from('campaign_audience_overrides')
      .upsert({ campaign_id, campaign_name: campaign_name || null, audience_slug }, { onConflict: 'campaign_id' })
    if (error) { console.error('audience override save:', error); return }
    setAudienceOverrides(prev => ({ ...prev, [campaign_id]: audience_slug }))
  }, [])

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
  //
  // SKIP override when an audience filter is active (Ben 2026-06-01).
  // prospectMetricsByRange counts ALL closer_calls in the window — it has no
  // audience filter. When the user clicks Electricians, the audience-aware
  // view sources (lib_marketing_by_audience_daily) correctly report 0 closes
  // for that audience, but this override stomps that with the global closed
  // count (4) — leaving Ben staring at "Electricians has 4 closes" when only
  // Restoration actually closed anything. Audience-filtered stats are
  // already correct from the view; don't second-guess them.
  // Disabled (Ben 2026-06-01). This override used to swap view-sourced
  // live_calls / closes with closer_calls-deduped prospect counts. Two
  // problems:
  //   1. It only ran on the All view (audience filter skipped it), which
  //      meant clicking Restoration+Electricians flipped Net New Live
  //      3 → 5 — same data, two different sources, different numbers,
  //      no explanation visible to the operator.
  //   2. closer_calls deduped counts couldn't be split by audience, so
  //      keeping them only on All meant the All ↔ filtered split used
  //      different methodologies.
  //
  // Single source of truth now: lib_marketing_by_audience_daily (view) for
  // both All and audience-filtered states. Equal apples in every tile.
  // The original closer_calls drift-protection that motivated this function
  // is now handled at the view layer (lib_close_resolved, lib_ghl_lives_detail).
  // Keeping the function signature so call sites don't have to change.
  const applyProspectMetrics = (statsBundle /* , rangeOrDays */) => statsBundle

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
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to="/sales/marketing/coverage"
            style={{
              fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 500,
              padding: '7px 12px', border: '1px solid var(--ink-3)',
              color: 'var(--ink)', textDecoration: 'none', borderRadius: 2,
              background: 'transparent',
            }}
            title="Attribution coverage report — how much of the chain is actually traced">
            Coverage report →
          </Link>
          <SyncStatusIndicator />
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* Audience filter chip strip — multiselect, empty = show all.
          Sorted by total ad spend so the heaviest audiences sit first.
          Click "All" to clear. Includes "Unknown" so the operator sees
          campaigns that didn't parse cleanly and can override them. */}
      {audienceList.length > 0 && (
        <div style={{
          marginBottom: 18, padding: '10px 14px',
          background: 'var(--paper-2)', border: '1px solid var(--rule)',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
            letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)',
          }}>Audience</span>
          <button onClick={() => setSelectedAudiences(new Set())}
            style={{
              padding: '6px 12px',
              border: `1px solid ${selectedAudiences.size === 0 ? 'var(--ink)' : 'var(--rule)'}`,
              background: selectedAudiences.size === 0 ? 'var(--ink)' : 'var(--paper)',
              color: selectedAudiences.size === 0 ? 'var(--paper)' : 'var(--ink-3)',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              cursor: 'pointer', borderRadius: 2,
            }}>All</button>
          {audienceList.map(a => {
            const on = selectedAudiences.has(a)
            const isUnknown = a === 'Unknown'
            return (
              <button key={a} onClick={() => toggleAudience(a)}
                style={{
                  padding: '6px 12px',
                  border: `1px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                  background: on ? 'var(--ink)' : 'var(--paper)',
                  color: on ? 'var(--paper)' : (isUnknown ? '#b53e3e' : 'var(--ink-3)'),
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  cursor: 'pointer', borderRadius: 2,
                  fontStyle: isUnknown ? 'italic' : 'normal',
                }}>
                {a}
              </button>
            )
          })}
          <span style={{ flex: 1 }} />
          {selectedAudiences.size > 0 && (
            <span style={{ fontFamily: 'var(--serif)', fontSize: 12, fontStyle: 'italic', color: 'var(--ink-4)', marginRight: 8 }}>
              Showing {selectedAudiences.size} of {audienceList.length} audiences
            </span>
          )}
          <button onClick={() => setOverrideModal({ audience: null, campaign_id: null })}
            title="Tag a campaign with the correct audience"
            style={{
              padding: '6px 12px',
              border: '1px solid var(--rule)',
              background: 'var(--paper)',
              color: 'var(--ink-3)',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              cursor: 'pointer', borderRadius: 2,
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
            <Edit3 size={11} />
            Tag campaigns
          </button>
        </div>
      )}

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
                <button
                  onClick={() => setResolvingDupe(g)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    color: 'var(--ink-2)',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    textDecorationStyle: 'dotted',
                    textUnderlineOffset: 3,
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                    textAlign: 'left',
                  }}
                  title="Click to resolve — mark as same person or different people"
                >
                  {g.members.map(m => `"${(m.name || '(no name)').trim()}"`).join('  vs  ')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {resolvingDupe && (
        <ResolveDupeModal
          group={resolvingDupe}
          onClose={() => setResolvingDupe(null)}
          onResolved={async () => { await reloadDupeResolutions(); setResolvingDupe(null) }}
        />
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
            <KPI label="Adspend" value={stats.adspend} format="$" trailing={stats30.adspend} prev={sp.adspend} whatIf={hasOverride('adspend') ? wf?.adspend : null} tip="Total Meta Ads spend (converted to USD). Click for daily breakdown." onClick={() => setDrilldown('adspend')} />
            <KPI label="Leads" value={stats.leads} format="n" trailing={stats30.leads} prev={sp.leads} whatIf={gated(upstream.leads, wf?.leads)} tip="New opportunities created in SCIO USA pipeline. Click to view." onClick={() => setDrilldown('leads')} />
            <KPI label="CPL" value={stats.cpl} format="$" benchmark={bm.cpl} trailing={stats30.cpl} prev={sp.cpl} whatIf={gated(upstream.leads, wf?.cpl)} tip="Cost Per Lead = Adspend / Leads. Click to see daily CPL trend." onClick={() => setDrilldown('cpl')} />
            <KPI label="Bookings" value={bk.all} format="n" trailing={bk30.all} whatIf={gated(upstream.bookings, wf?.bookings_all)} tip="All strategy-calendar bookings (qualified + DQ Calendly), bucketed by booked_at. Click to view." onClick={() => setDrilldown('bookings')} />
            <KPI label="Cost/Booking" value={cpb} format="$" trailing={cpb30} whatIf={gated(upstream.bookings, wf?.cpb_all)} tip="Adspend ÷ Bookings (all). Click to see daily cost-per-booking trend." onClick={() => setDrilldown('cpb')} />
            <KPI label="Q.Books" value={cohortAvailable ? bkLeadCohort.qualified : bk.qualified} format="n" trailing={bkLeadCohort30.qualified > 0 ? bkLeadCohort30.qualified : bk30.qualified} whatIf={gated(upstream.bookings, wf?.qualified_bookings)} tip={cohortAvailable
              ? `Of the ${stats.leads} leads created in this window, ${bkLeadCohort.qualified} have booked a qualified strategy call (cohort-true conversion). Click to view bookings activity (booked_at-bucketed: ${bk.qualified} unique prospects).`
              : `Unique prospects who BOOKED a strategy call (excl. DQ Calendly) in this window, bucketed by booked_at. Cohort-true math will activate after ghl_opportunities mirror first syncs (migration 055). ${bk.dq ? `${bk.dq} routed to DQ in this window. ` : ''}Click to view.`} onClick={() => setDrilldown('bookings')} />
            <KPI label="L→Q%" value={leadToQ} format="%" benchmark={bm.lead_to_booking} trailing={leadToQ30} whatIf={gated(upstream.bookings, wf?.lead_to_booking_pct)} tip={cohortAvailable
              ? `True conversion rate: of the ${stats.leads} leads created in window, ${bkLeadCohort.qualified} booked a qualified strategy call. Cohort-aligned — denominator and numerator share the same lead-create window.`
              : leadToQDrift
                ? `Capped at 100%. Raw ratio = ${rawLeadToQ.toFixed(0)}% because Q.Book counts prospects who booked in this window — some of those leads were created BEFORE the window. Cohort-true math will activate once the ghl_opportunities mirror first syncs.`
                : 'Qualified Bookings ÷ Leads (cohort-true math will activate once the ghl_opportunities mirror syncs).'} />
            <KPI label="Cost/Q.Book" value={cpqb} format="$" benchmark={bm.cpb} trailing={cpqb30} whatIf={gated(upstream.bookings, wf?.cpb)} tip="Adspend ÷ Qualified Bookings (excludes DQ). Click to see daily trend." onClick={() => setDrilldown('cpqb')} />
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
            <KPI label="No Shows" value={stats.no_shows} format="n" prev={sp.no_shows} whatIf={gated(upstream.live, wf?.no_shows)} tip="NC no-shows from closer EOD. Click for daily trend + prospects." onClick={() => setDrilldown('noshows')} />
            <KPI label="Reschedule%" value={reschedRate} format="%" trailing={reschedRate30} prev={reschedRatePrev} tip={`Reschedules ÷ Qualified Bookings. ${stats.reschedules || 0} reschedules out of ${denom} qualified bookings (calendar). Click to view.`} onClick={() => setDrilldown('rc')} />
            <KPI label="Cancel%" value={cancelRate} format="%" trailing={cancelRate30} prev={cancelRatePrev} tip={`Cancellations ÷ Qualified Bookings. ${stats.cancels || 0} cancels out of ${denom} qualified bookings (calendar). Click to view.`} onClick={() => setDrilldown('rc')} />
            <KPI label="Gross Show%" value={grossShowRate} format="%" trailing={grossShowRate30} tip={`Live shows ÷ ALL qualified bookings (includes calls that later cancelled or rescheduled). ${stats.new_live_calls || 0} live ÷ ${denom} booked. Click for daily show-rate trend.`} onClick={() => setDrilldown('showrate')} />
            <KPI label="Net Show%" value={netShowRate} format="%" benchmark={bm.show_rate_new} trailing={netShowRate30} tip={`Live shows ÷ CONFIRMED bookings (Qualified Bookings minus cancels and reschedules). ${stats.new_live_calls || 0} live ÷ ${netDenom} confirmed = ${netShowRate.toFixed(1)}%. Click for daily show-rate trend.`} onClick={() => setDrilldown('showrate')} />
            <KPI label="Cost/New" value={stats.cost_per_new_live_call} format="$" benchmark={bm.cost_per_live_call} trailing={stats30.cost_per_new_live_call} prev={sp.cost_per_new_live_call} whatIf={gated(upstream.live, wf?.cost_per_new_live_call)} tip="Adspend ÷ Net New Live calls. Click for daily trend." onClick={() => setDrilldown('cpnew')} />
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
        <KPI label="CPA (Trial)" value={stats.cpa_trial} format="$" benchmark={bm.cpa_trial} trailing={stats30.cpa_trial} prev={sp.cpa_trial} whatIf={gated(upstream.closes, wf?.cpa_trial)} tip="Cost Per Acquisition = Adspend / Closes. Click for daily CPA trend." onClick={() => setDrilldown('cpaTrial')} />
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

      {/* Audience comparison table — answers "is there a losing
          audience?" by rolling up the current date range per audience
          side-by-side. Ignores the audience FILTER chip strip (so all
          audiences show), but RESPECTS the date range. Click a row to
          drill into a single audience. Ben 2026-05-31. */}
      {audienceComparison.length > 1 && (
        <div className="mb-5">
          <AudienceComparisonTable
            rows={audienceComparison}
            selected={selectedAudiences}
            onSelect={(aud) => {
              setSelectedAudiences(new Set([aud]))
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }}
            onOverride={(row) => {
              // Open override modal pre-filled with this row's campaigns.
              // For audience-level rows we let the operator pick a campaign
              // to override from the breakdown below.
              setOverrideModal({ audience: row.audience, campaign_id: null, campaign_name: null })
            }}
          />
        </div>
      )}

      {/* Trailing Period Summary — uses the AUDIENCE-FILTERED entries
          so trailing periods reflect the chip selection too. Empty
          selection (default) = same behavior as before. */}
      <div className="mb-5">
        <TrailingTable entries={audienceFilteredEntries} applyProspectMetrics={applyProspectMetrics} />
      </div>

      {/* Daily Tracker — audience-filtered too. */}
      <div className="mb-5">
        <DailyTracker entries={audienceFilteredEntries} onDelete={handleDelete} onSave={upsertEntry} />
      </div>

      {/* Audience override modal */}
      {overrideModal && (
        <AudienceOverrideModal
          modal={overrideModal}
          entries={entries}
          audienceList={audienceList}
          overrides={audienceOverrides}
          onClose={() => setOverrideModal(null)}
          onSave={async (campaign_id, campaign_name, audience_slug) => {
            await saveAudienceOverride(campaign_id, campaign_name, audience_slug)
            setOverrideModal(null)
          }}
        />
      )}

      {/* Modals */}
      {showAddEntry && <AddEntryModal onSave={upsertEntry} onClose={() => setShowAddEntry(false)} />}
      {showBenchmarks && <BenchmarksModal benchmarks={benchmarks} onSave={updateBenchmark} onClose={() => setShowBenchmarks(false)} />}
      {showImportModal && <CSVImportModal onImport={handleModalImport} onClose={() => setShowImportModal(false)} />}
      {drilldown && (() => {
        // Build a date → adspend map from marketing_tracker so cost-per
        // drilldown charts can compute CPL / Cost-per-Booking per day.
        const spendByDate = {}
        for (const e of (entries || [])) {
          if (e.date) spendByDate[e.date] = parseFloat(e.adspend || 0)
        }
        return <DrilldownModal kind={drilldown} range={range} onClose={() => setDrilldown(null)} spendByDate={spendByDate} selectedAudiences={selectedAudiences} />
      })()}
    </div>
  )
}

// ── Audience comparison table — Ben 2026-05-31 ──────────────────────
// Side-by-side rollup per audience within the selected date range.
// Each row = one audience. Columns = the headline KPIs. Click a row to
// filter the whole page to that audience. Sort defaults to spend desc.
function AudienceComparisonTable({ rows, selected, onSelect, onOverride }) {
  const [sortKey, setSortKey] = useState('spend')
  const [sortDir, setSortDir] = useState('desc')
  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      const va = sortKey === 'audience' ? a.audience : (sortKey === 'spend' ? a.spend : (a.stats?.[sortKey] || 0))
      const vb = sortKey === 'audience' ? b.audience : (sortKey === 'spend' ? b.spend : (b.stats?.[sortKey] || 0))
      if (va === vb) return 0
      const d = va > vb ? 1 : -1
      return sortDir === 'desc' ? -d : d
    })
    return arr
  }, [rows, sortKey, sortDir])
  const toggleSort = (k) => {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(k); setSortDir('desc') }
  }
  const Th = ({ k, label, align = 'right' }) => (
    <th onClick={() => toggleSort(k)}
      style={{
        padding: '10px 12px', textAlign: align, cursor: 'pointer',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.12em', textTransform: 'uppercase',
        color: 'var(--ink-3)', borderBottom: '1px solid var(--rule)',
        whiteSpace: 'nowrap', userSelect: 'none',
      }}>
      {label}{sortKey === k ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  )
  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{
        padding: '14px 18px', borderBottom: '1px solid var(--rule)',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16,
      }}>
        <div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)',
          }}>By audience · current date range</div>
          <h3 style={{
            margin: '4px 0 0', fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500, color: 'var(--ink)',
          }}>Audience comparison</h3>
        </div>
        <span style={{ fontFamily: 'var(--serif)', fontSize: 12, fontStyle: 'italic', color: 'var(--ink-4)' }}>
          Click a row to filter the whole page to that audience
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <Th k="audience" label="Audience" align="left" />
              <Th k="spend" label="Spend" />
              <Th k="leads" label="Leads" />
              <Th k="cpl" label="CPL" />
              <Th k="qualified_bookings" label="Booked" />
              <Th k="new_live_calls" label="Net Live" />
              <Th k="show_rate" label="Show%" />
              <Th k="closes" label="Closes" />
              <Th k="close_rate" label="Cl%" />
              <Th k="cpa_trial" label="CPA" />
              <Th k="trial_fe_roas" label="FE ROAS" />
              <Th k="all_cash_roas" label="NET ROAS" />
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => {
              const s = row.stats || {}
              const isSelected = selected && selected.has && selected.has(row.audience)
              const isUnknown = row.audience === 'Unknown'
              const cellStyle = {
                padding: '10px 12px', textAlign: 'right',
                fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink)',
                fontVariantNumeric: 'tabular-nums',
                borderBottom: '1px solid var(--rule)',
              }
              return (
                <tr key={row.audience}
                  onClick={() => onSelect?.(row.audience)}
                  style={{
                    cursor: 'pointer',
                    background: isSelected ? 'var(--paper-2)' : 'transparent',
                    borderLeft: isSelected ? '4px solid var(--ink)' : '4px solid transparent',
                    transition: 'background 120ms ease',
                  }}>
                  <td style={{
                    padding: '10px 12px', textAlign: 'left',
                    fontFamily: 'var(--sans)', fontSize: 14, fontWeight: isSelected ? 700 : 600,
                    color: isUnknown ? '#b53e3e' : 'var(--ink)',
                    borderBottom: '1px solid var(--rule)',
                    fontStyle: isUnknown ? 'italic' : 'normal',
                  }}>
                    {row.audience}
                    {isUnknown && (
                      <span style={{
                        marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                        letterSpacing: '0.08em', textTransform: 'uppercase', color: '#b53e3e',
                      }}>(unparsed — override below)</span>
                    )}
                  </td>
                  <td style={cellStyle}>{f$(row.spend)}</td>
                  <td style={cellStyle}>{fN(s.leads)}</td>
                  <td style={cellStyle}>{f$(s.cpl)}</td>
                  <td style={cellStyle}>{fN(s.qualified_bookings)}</td>
                  <td style={cellStyle}>{fN(s.new_live_calls)}</td>
                  <td style={cellStyle}>{fP(s.show_rate)}</td>
                  <td style={cellStyle}>{fN(s.closes)}</td>
                  <td style={cellStyle}>{fP(s.close_rate)}</td>
                  <td style={cellStyle}>{f$(s.cpa_trial)}</td>
                  <td style={cellStyle}>{fX(s.trial_fe_roas)}</td>
                  <td style={cellStyle}>{fX(s.all_cash_roas)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Audience override modal — Ben 2026-05-31 ────────────────────────
// Lets the operator manually tag a campaign with an audience when the
// parser got it wrong (or when the campaign name doesn't follow the
// "BRAND - VERTICAL" convention). Lists every campaign in the dataset
// optionally filtered by current parsed audience. Saves to
// campaign_audience_overrides.
function AudienceOverrideModal({ modal, entries, audienceList, overrides, onClose, onSave }) {
  const [search, setSearch] = useState('')
  const [audChoice, setAudChoice] = useState('')
  const [newAudience, setNewAudience] = useState('')
  const [picked, setPicked] = useState(modal?.campaign_id ? { campaign_id: modal.campaign_id, campaign_name: modal.campaign_name } : null)
  // Distinct campaigns in the dataset
  const campaigns = useMemo(() => {
    const seen = new Map()
    for (const e of entries || []) {
      if (!e.campaign_id) continue
      if (!seen.has(e.campaign_id)) {
        const currentAud = overrides[e.campaign_id] || audienceFromCampaignName(e.campaign_name)
        seen.set(e.campaign_id, { campaign_id: e.campaign_id, campaign_name: e.campaign_name, current_audience: currentAud })
      }
    }
    let rows = Array.from(seen.values())
    if (modal?.audience) rows = rows.filter(c => c.current_audience === modal.audience)
    if (search) rows = rows.filter(c => (c.campaign_name || '').toLowerCase().includes(search.toLowerCase()))
    return rows.sort((a, b) => (a.campaign_name || '').localeCompare(b.campaign_name || ''))
  }, [entries, overrides, modal, search])

  const audienceOptions = useMemo(() => {
    const set = new Set(audienceList.filter(a => a !== 'Unknown'))
    return Array.from(set).sort()
  }, [audienceList])

  const handleSave = () => {
    const aud = (newAudience.trim() || audChoice).trim()
    if (!picked || !aud) return
    onSave(picked.campaign_id, picked.campaign_name, aud)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--paper)', width: '100%', maxWidth: 760, maxHeight: '90vh',
          overflow: 'auto', border: '1px solid var(--rule)', borderTop: '3px solid var(--accent)',
          borderRadius: 2, boxShadow: '0 24px 60px rgba(10,10,10,0.18)',
        }}>
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--rule)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        }}>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                          letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              Audience override
            </div>
            <h2 style={{ margin: '6px 0 0', fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 400 }}>
              {modal?.audience ? `Re-tag campaigns in "${modal.audience}"` : 'Tag a campaign'}
            </h2>
          </div>
          <button onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', padding: 4 }}>
            <X size={20} />
          </button>
        </div>
        <div style={{ padding: 24 }}>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Filter campaigns by name…"
            style={{
              width: '100%', padding: '10px 12px', marginBottom: 16,
              fontFamily: 'var(--sans)', fontSize: 14,
              border: '1px solid var(--rule)', background: 'var(--paper)',
              borderRadius: 2,
            }} />
          <div style={{
            maxHeight: 280, overflowY: 'auto', border: '1px solid var(--rule)',
            background: 'var(--paper-2)', marginBottom: 16,
          }}>
            {campaigns.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', fontFamily: 'var(--serif)',
                            fontStyle: 'italic', color: 'var(--ink-4)' }}>
                No campaigns match.
              </div>
            ) : campaigns.map(c => {
              const on = picked?.campaign_id === c.campaign_id
              return (
                <div key={c.campaign_id} onClick={() => setPicked(c)}
                  style={{
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--rule)',
                    background: on ? 'var(--paper)' : 'transparent',
                    borderLeft: on ? '4px solid var(--ink)' : '4px solid transparent',
                    cursor: 'pointer',
                  }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)' }}>
                    {c.campaign_name || '(no name)'}
                  </div>
                  <div style={{ marginTop: 3, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                                letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    Currently: {c.current_audience}
                  </div>
                </div>
              )
            })}
          </div>
          {picked && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                            letterSpacing: '0.12em', textTransform: 'uppercase',
                            color: 'var(--ink-3)', marginBottom: 8 }}>
                Set audience for "{picked.campaign_name?.slice(0, 60)}{(picked.campaign_name?.length || 0) > 60 ? '…' : ''}"
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {audienceOptions.map(a => (
                  <button key={a} onClick={() => { setAudChoice(a); setNewAudience('') }}
                    style={{
                      padding: '6px 12px',
                      border: `1px solid ${audChoice === a ? 'var(--ink)' : 'var(--rule)'}`,
                      background: audChoice === a ? 'var(--ink)' : 'var(--paper)',
                      color: audChoice === a ? 'var(--paper)' : 'var(--ink-3)',
                      fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      cursor: 'pointer', borderRadius: 2,
                    }}>{a}</button>
                ))}
              </div>
              <input type="text" value={newAudience} onChange={e => { setNewAudience(e.target.value); setAudChoice('') }}
                placeholder="Or type a new audience name"
                style={{
                  width: '100%', padding: '8px 10px', fontFamily: 'var(--sans)', fontSize: 13,
                  border: '1px solid var(--rule)', background: 'var(--paper)',
                  borderRadius: 2,
                }} />
            </div>
          )}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--rule)',
                      display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11,
                    letterSpacing: '0.12em', textTransform: 'uppercase',
                    border: '1px solid var(--rule)', background: 'transparent',
                    color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 2 }}>
            Cancel
          </button>
          <button onClick={handleSave}
            disabled={!picked || (!newAudience.trim() && !audChoice)}
            style={{ padding: '10px 22px', fontFamily: 'var(--mono)', fontSize: 11,
                    letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
                    border: '2px solid var(--ink)', background: 'var(--ink)',
                    color: 'var(--paper)', cursor: 'pointer', borderRadius: 2,
                    boxShadow: '3px 3px 0 var(--accent)',
                    opacity: (!picked || (!newAudience.trim() && !audChoice)) ? 0.4 : 1 }}>
            <Check size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
            Save override
          </button>
        </div>
      </div>
    </div>
  )
}
