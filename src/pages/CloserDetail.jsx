import { useParams, useNavigate } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import { AlertTriangle, Loader, ExternalLink, Edit3 } from 'lucide-react'
import LeaderTable, { Card } from '../components/house/LeaderTable'
import Modal from '../components/editorial/Modal'
import { useBenchmarks } from '../hooks/useBenchmarks'
import { supabase } from '../lib/supabase'
import { useCloserStats, useCloserEODs, useCloserTranscripts, useObjectionAnalysis, useCloserCallBreakdown } from '../hooks/useCloserData'
import { analyzeObjections } from '../services/objectionAnalysis'
import { syncFathomTranscripts } from '../services/fathomSync'
import { rangeToDays } from '../lib/dateUtils'

export default function CloserDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const [member, setMember] = useState(null)
  const [freshObjections, setFreshObjections] = useState(null)
  const [allCalls, setAllCalls] = useState([])
  const [selectedDate, setSelectedDate] = useState(null)
  const [showCalls, setShowCalls] = useState(null) // 'show' | 'close' | null
  const { bm } = useBenchmarks()
  const syncedRef = useRef(false)
  const stats = useCloserStats(id, days)
  const { reports: myReports } = useCloserEODs(id, days)
  const { reports: allReports } = useCloserEODs(null, days)
  const { breakdown: myBreak } = useCloserCallBreakdown(id, days)
  const { breakdown: allBreak } = useCloserCallBreakdown(null, days)
  const { transcripts, loading: loadingTranscripts } = useCloserTranscripts(id)
  const { objections: storedObjections, loading: loadingObjections } = useObjectionAnalysis(id, days)

  const rawObjections = freshObjections || storedObjections
  const [objections, setObjections] = useState([])
  // Map of lowercased prospect name → outcome ('closed' | 'ascended' | 'not_closed' | 'no_show' | ...)
  // Used both to recompute the aggregate win_rate AND to color individual
  // call-reference chips green/red per prospect in the render.
  const [callOutcomes, setCallOutcomes] = useState({})

  // Fetch full closer_calls once — used both by the Calls Calendar (everything)
  // and by the objection win-rate recalculation (prospect_name → outcome map).
  useEffect(() => {
    if (!myReports.length) { setAllCalls([]); setCallOutcomes({}); return }
    let active = true
    async function fetchCalls() {
      const reportToDate = {}
      for (const r of myReports) reportToDate[r.id] = r.report_date
      const { data } = await supabase
        .from('closer_calls')
        .select('id, prospect_name, outcome, call_type, revenue, cash_collected, notes, ghl_event_id, created_at, eod_report_id')
        .in('eod_report_id', myReports.map(r => r.id))
        .order('created_at', { ascending: true })
      if (!active) return
      const enriched = (data || []).map(c => ({ ...c, report_date: reportToDate[c.eod_report_id] }))
      setAllCalls(enriched)
      const map = {}
      for (const c of enriched) {
        if (c.prospect_name) map[c.prospect_name.toLowerCase().trim()] = c.outcome
      }
      setCallOutcomes(map)
    }
    fetchCalls()
    return () => { active = false }
  }, [myReports])

  // Default-select the most recent date that has calls so the day-detail
  // panel is populated on first paint. Also auto-corrects when the date range
  // changes and the previously-selected date falls outside the new window.
  useEffect(() => {
    if (allCalls.length === 0) return
    const dates = [...new Set(allCalls.map(c => c.report_date).filter(Boolean))].sort()
    if (!dates.length) return
    if (!selectedDate || !dates.includes(selectedDate)) {
      setSelectedDate(dates[dates.length - 1])
    }
  }, [allCalls, selectedDate])

  // Recalculate win rates from actual closer_calls outcomes
  useEffect(() => {
    if (!rawObjections.length) { setObjections([]); return }
    async function recalcWinRates() {
      const callMap = callOutcomes
      const resolveOutcome = (ref) => {
        const name = (ref.prospect || '').toLowerCase().trim()
        if (callMap[name] !== undefined) return callMap[name]
        const firstName = name.split(' ')[0]
        const match = Object.entries(callMap).find(([k]) => k.split(' ')[0] === firstName)
        return match ? match[1] : undefined
      }
      // Recalculate win rate for each objection + dedupe refs by prospect:date.
      // The same Adam Burrell appearing twice in one objection comes from the
      // AI returning duplicate call_numbers or legacy data that wasn't deduped
      // at write time — strip on read so legacy rows look clean too.
      const enriched = rawObjections.map(obj => {
        const rawRefs = Array.isArray(obj.call_references) ? obj.call_references : []
        const seen = new Set()
        const dedupedRefs = []
        for (const ref of rawRefs) {
          const key = `${(ref.prospect || '').toLowerCase().trim()}|${ref.date || ''}`
          if (seen.has(key)) continue
          seen.add(key)
          dedupedRefs.push(ref)
        }

        let wins = 0, total = 0
        for (const ref of dedupedRefs) {
          const outcome = resolveOutcome(ref)
          if (outcome !== undefined) {
            total++
            if (outcome === 'closed' || outcome === 'ascended') wins++
          }
        }
        return {
          ...obj,
          call_references: dedupedRefs,
          occurrence_count: dedupedRefs.length || obj.occurrence_count,
          win_rate: total > 0 ? Math.round((wins / total) * 100) : obj.win_rate,
        }
      })
      setObjections(enriched)
    }
    recalcWinRates()
  }, [rawObjections, callOutcomes])

  useEffect(() => {
    supabase.from('team_members').select('*').eq('id', id).single()
      .then(({ data }) => setMember(data))
  }, [id])

  // Auto-sync Fathom transcripts on mount (once)
  useEffect(() => {
    if (syncedRef.current) return
    syncedRef.current = true
    syncFathomTranscripts().catch(() => {})
  }, [])

  // Auto-analyze objections when transcripts exist but objections don't
  useEffect(() => {
    if (loadingObjections || loadingTranscripts) return
    if (transcripts.length > 0 && storedObjections.length === 0) {
      analyzeObjections(id, days)
        .then(() => {
          supabase
            .from('objection_analysis')
            .select('*')
            .eq('closer_id', id)
            .order('occurrence_count', { ascending: false })
            .then(({ data }) => { if (data?.length) setFreshObjections(data) })
        })
        .catch(() => {})
    }
  }, [id, days, loadingObjections, loadingTranscripts, transcripts.length, storedObjections.length])

  // Company-wide averages from all closer EODs
  const companyTotals = allReports.reduce((acc, r) => ({
    booked: acc.booked + (r.nc_booked || 0) + (r.fu_booked || 0),
    ncBooked: acc.ncBooked + (r.nc_booked || 0),
    liveCalls: acc.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
    liveNC: acc.liveNC + (r.live_nc_calls || 0),
    offers: acc.offers + (r.offers || 0),
    closes: acc.closes + (r.closes || 0),
    reschedules: acc.reschedules + (r.reschedules || 0),
  }), { booked: 0, ncBooked: 0, liveCalls: 0, liveNC: 0, offers: 0, closes: 0, reschedules: 0 })

  // Company-wide and per-closer close rates are prospect-level: unique
  // closed prospects / unique live prospects, dedup-by prospect_name.
  // See useCloserCallBreakdown and scripts/close-rate-audit.mjs.
  const companyProspects = Object.values(allBreak || {}).reduce((a, b) => ({
    live:   a.live   + (b.liveProspects   || 0),
    closed: a.closed + (b.closedProspects || 0),
  }), { live: 0, closed: 0 })
  const companyCloseRate = companyProspects.live > 0
    ? parseFloat(((companyProspects.closed / companyProspects.live) * 100).toFixed(1))
    : 0

  const mb = myBreak?.[id] || { liveProspects: 0, closedProspects: 0 }
  const myCloseRate = mb.liveProspects > 0
    ? parseFloat(((mb.closedProspects / mb.liveProspects) * 100).toFixed(1))
    : 0
  // Closes + Net New tiles use the prospect-deduped per-call truth (same
  // source as the Close Rate gauge below). Surfaces EOD self-reported
  // count in the subtitle for reconciliation when the closer logged a
  // different number than the prospect rows they entered.
  const myClosesDeduped = mb.closedProspects || 0
  const myLiveDeduped   = mb.liveProspects   || 0

  const companyRates = {
    // Show rate: new-call only (denominator = nc_booked, numerator = live_nc_calls)
    showRate: companyTotals.ncBooked > 0 ? parseFloat(((companyTotals.liveNC / companyTotals.ncBooked) * 100).toFixed(1)) : 0,
    closeRate: companyCloseRate,
    offerRate: companyTotals.liveCalls > 0 ? parseFloat(((companyTotals.offers / companyTotals.liveCalls) * 100).toFixed(1)) : 0,
    offerCloseRate: companyTotals.offers > 0 ? parseFloat(((companyTotals.closes / companyTotals.offers) * 100).toFixed(1)) : 0,
    rescheduleRate: companyTotals.booked > 0 ? parseFloat(((companyTotals.reschedules / companyTotals.booked) * 100).toFixed(1)) : 0,
  }

  const myShowRate = parseFloat(stats.showRate) || 0
  const myOfferRate = parseFloat(stats.offerRate) || 0
  const myOfferCloseRate = stats.offers > 0 ? parseFloat(((myClosesDeduped / stats.offers) * 100).toFixed(1)) : 0
  const myRescheduleRate = parseFloat(stats.rescheduleRate) || 0
  const avgDealSize = myClosesDeduped > 0 ? parseFloat((stats.revenue / myClosesDeduped).toFixed(0)) : 0
  const totalCash = stats.cash + stats.ascendCash
  const totalRevenue = stats.revenue + stats.ascendRevenue
  const cashCollRate = totalRevenue > 0 ? parseFloat(((totalCash / totalRevenue) * 100).toFixed(1)) : 0
  const companyCashCollRate = (() => { const t = allReports.reduce((a, r) => ({ rev: a.rev + parseFloat(r.total_revenue || 0) + parseFloat(r.ascend_revenue || 0), cash: a.cash + parseFloat(r.total_cash_collected || 0) + parseFloat(r.ascend_cash || 0) }), { rev: 0, cash: 0 }); return t.rev > 0 ? parseFloat(((t.cash / t.rev) * 100).toFixed(1)) : 0 })()
  const avgFathomDuration = transcripts.length > 0 ? Math.round(transcripts.reduce((s, t) => s + (t.duration_seconds || 0), 0) / transcripts.length) : 0

  if (!member) {
    return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-text-primary" /></div>
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Closer detail</span>
          <h1 className="h2 mt-2">{member.name}</h1>
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
            Closer · performance
          </p>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 mb-6">
        <KPICard label="Booked" value={stats.totalBooked} subtitle={`${stats.ncBooked} NC / ${stats.fuBooked} FU`} />
        <KPICard label="Net New" value={myLiveDeduped} subtitle={`${stats.liveNC} EOD-reported · ${stats.liveCalls - stats.liveNC} FU separately`} />
        <KPICard label="No Shows" value={stats.noShows} />
        <KPICard label="Offers" value={stats.offers} />
        <KPICard label="Closes" value={myClosesDeduped} subtitle={myClosesDeduped !== stats.closes ? `${stats.closes} EOD-reported` : null} />
        <KPICard label="Trial Cash" value={`$${stats.cash.toLocaleString()}`} subtitle={`$${stats.revenue.toLocaleString()} rev`} />
        <KPICard label="Ascension Cash" value={`$${stats.ascendCash.toLocaleString()}`} subtitle={`${stats.ascensions} ascensions`} />
        <KPICard label="Total Cash" value={`$${totalCash.toLocaleString()}`} subtitle={`$${totalRevenue.toLocaleString()} total rev`} />
        <KPICard label="Avg Deal" value={`$${avgDealSize.toLocaleString()}`} />
        {avgFathomDuration > 0 && <KPICard label="Avg Talk Time" value={`${Math.round(avgFathomDuration / 60)}m`} subtitle={`${transcripts.length} calls`} />}
      </div>

      {/* Conversion Gauges — Net Close removed; close rate is prospect-level
          so a separate "net" version (NC denominator + FU closes counted)
          no longer represents anything meaningful. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Gauge label="Show Rate" value={myShowRate} target={bm('show_rate_new', 70)} onClick={() => setShowCalls('show')} hint="See which booked calls showed and which did not" delta={parseFloat((myShowRate - companyRates.showRate).toFixed(1))} avgLabel={companyRates.showRate} />
        <Gauge label="Close Rate" value={myCloseRate} target={bm('close_rate', 25)} onClick={() => setShowCalls('close')} hint="See which live calls closed" delta={parseFloat((myCloseRate - companyRates.closeRate).toFixed(1))} avgLabel={companyRates.closeRate} />
        <Gauge label="Offer Rate" value={myOfferRate} target={bm('offer_rate', 80)} delta={parseFloat((myOfferRate - companyRates.offerRate).toFixed(1))} avgLabel={companyRates.offerRate} />
        <Gauge label="Offer → Close" value={myOfferCloseRate} target={30} max={100} delta={parseFloat((myOfferCloseRate - companyRates.offerCloseRate).toFixed(1))} avgLabel={companyRates.offerCloseRate} />
        <Gauge label="Reschedule %" value={myRescheduleRate} target={15} max={50} delta={parseFloat((myRescheduleRate - companyRates.rescheduleRate).toFixed(1))} avgLabel={companyRates.rescheduleRate} />
        <Gauge label="Cash Collect %" value={cashCollRate} target={50} delta={parseFloat((cashCollRate - companyCashCollRate).toFixed(1))} avgLabel={companyCashCollRate} />
        <Gauge label="No Show %" value={stats.totalBooked > 0 ? parseFloat(((stats.noShows / stats.totalBooked) * 100).toFixed(1)) : 0} target={20} max={50} />
        <Gauge label="Avg call length" value={avgFathomDuration > 0 ? Math.round(avgFathomDuration / 60) : 0} target={30} max={90} suffix=" min" />
      </div>

      {/* Calls Calendar — replaces the old EOD-aggregate table.
          Day strip across the top, click a day to see that day's calls below. */}
      <CallsCalendar
        calls={allCalls}
        selectedDate={selectedDate}
        onSelectDate={(d) => setSelectedDate(d)}
        onEditEod={(d) => navigate(`/sales/eod/submit?tab=closer&member=${id}&date=${d}`)}
        days={days}
      />

      {/* Show rate / close rate drilldown: the calls behind the number */}
      <CallsModal kind={showCalls} onClose={() => setShowCalls(null)} calls={allCalls} days={days} name={member?.name} />

      {/* Objection Analysis */}
      <div className="tile tile-feedback p-5">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle size={16} className="text-warning" />
          <h2 className="text-sm font-medium">Most Common Objections</h2>
          <span className="text-xs text-text-400 ml-auto">Last {days} days &middot; Auto-analyzed from Fathom</span>
        </div>
        {loadingObjections ? (
          <p className="text-text-400 text-sm py-4 text-center">Loading...</p>
        ) : objections.length > 0 ? (
          <div className="space-y-3">
            {objections.map((obj, i) => {
              const refs = Array.isArray(obj.call_references) ? obj.call_references : []
              const legacyQuotes = Array.isArray(obj.example_quotes) ? obj.example_quotes : []
              // Resolve per-ref outcome — same first-name fallback the win-rate
              // reducer uses, so the chip color agrees with the badge.
              const outcomeFor = (ref) => {
                const name = (ref.prospect || '').toLowerCase().trim()
                if (callOutcomes[name] !== undefined) return callOutcomes[name]
                const firstName = name.split(' ')[0]
                const match = Object.entries(callOutcomes).find(([k]) => k.split(' ')[0] === firstName)
                return match ? match[1] : undefined
              }
              const refClass = (outcome) => {
                if (outcome === 'closed' || outcome === 'ascended') return 'bg-success/15 text-success border border-success/40 hover:bg-success/25'
                if (outcome === 'no_show' || outcome === 'not_closed') return 'bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25'
                return 'bg-bg-card-hover border border-border-default hover:bg-opt-yellow/10 hover:text-text-primary'
              }
              return (
                <div key={i} className="border border-border-default rounded-sm p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-sm">{obj.objection_category}</span>
                      <span className="text-xs bg-text-400/15 text-text-400 px-2 py-0.5 rounded">
                        {obj.occurrence_count}x
                      </span>
                    </div>
                    {obj.win_rate != null && (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                        obj.win_rate >= 50 ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'
                      }`}>
                        {obj.win_rate}% win rate
                      </span>
                    )}
                  </div>

                  {refs.length > 0 ? (
                    <div className="space-y-1.5">
                      {refs.map((ref, j) => {
                        const outcome = outcomeFor(ref)
                        const quote = ref.quote || legacyQuotes[j] || legacyQuotes[0]
                        return (
                          <div key={j} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                            <a
                              href={ref.url || '#'}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors shrink-0 ${refClass(outcome)}`}
                              title={outcome === 'closed' || outcome === 'ascended' ? 'Closed / won'
                                : outcome === 'no_show' ? 'No-show'
                                : outcome === 'not_closed' ? 'Not closed'
                                : outcome ? `Outcome: ${outcome}` : 'Outcome unknown'}
                            >
                              <span className="font-medium">{ref.prospect}</span>
                              <span className="opacity-70">({ref.date})</span>
                              {ref.url && <ExternalLink size={10} />}
                            </a>
                            {quote && (
                              <p className="text-xs text-text-400 italic min-w-0 flex-1">&ldquo;{quote}&rdquo;</p>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : legacyQuotes.length > 0 ? (
                    <p className="text-xs text-text-400 italic">&ldquo;{legacyQuotes[0]}&rdquo;</p>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : transcripts.length > 0 ? (
          <div className="flex items-center justify-center gap-2 py-6">
            <Loader size={14} className="animate-spin text-text-primary" />
            <span className="text-text-400 text-sm">Analyzing {transcripts.length} transcripts...</span>
          </div>
        ) : (
          <p className="text-text-400 text-sm py-4 text-center">No transcripts available yet — Fathom meetings sync automatically.</p>
        )}
      </div>
    </div>
  )
}

// ---------- Calls Calendar ----------
// Outcome → { label, ring, dot } — colors mirror the EODReview chip palette so
// a call looks the same wherever it appears in the app.
const OUTCOME_META = {
  closed:       { label: 'Closed',       color: 'var(--house-good)' },
  ascended:     { label: 'Ascended',     color: 'var(--ink-2)' },
  not_closed:   { label: 'Not closed',   color: 'var(--ink-4)' },
  not_ascended: { label: 'Not ascended', color: 'var(--ink-4)' },
  no_show:      { label: 'No show',      color: 'var(--house-bad)' },
  rescheduled:  { label: 'Rescheduled',  color: 'var(--house-warn)' },
  cancelled:    { label: 'Cancelled',    color: 'var(--house-warn)' },
  canceled:     { label: 'Cancelled',    color: 'var(--house-warn)' },
}

const TYPE_META = {
  new_call:  { label: 'New call' },
  follow_up: { label: 'Follow-up' },
  ascension: { label: 'Ascension' },
}

function fmtDayShort(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()]
  return `${wd} ${m}/${d}`
}

function fmtDayLong(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const wd = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()]
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]
  return `${wd}, ${mo} ${d}, ${y}`
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function CallsCalendar({ calls, selectedDate, onSelectDate, onEditEod, days }) {
  const byDate = new Map()
  for (const c of calls) {
    if (!c.report_date) continue
    if (!byDate.has(c.report_date)) byDate.set(c.report_date, [])
    byDate.get(c.report_date).push(c)
  }
  const sortedDates = [...byDate.keys()].sort()
  const dayCalls = selectedDate ? (byDate.get(selectedDate) || []) : []
  const dayTotals = dayCalls.reduce((a, c) => {
    a.calls++
    if (c.outcome === 'closed') a.closes++
    if (c.outcome === 'ascended') a.ascensions++
    if (c.outcome === 'no_show') a.noShows++
    a.cash += parseFloat(c.cash_collected || 0)
    return a
  }, { calls: 0, closes: 0, ascensions: 0, noShows: 0, cash: 0 })

  return (
    <Card
      title="Calls"
      count={calls.length}
      right={selectedDate && (
        <button type="button" className="editorial-btn-ghost" style={{ height: 34, padding: '0 14px', fontSize: 12.5 }} onClick={() => onEditEod(selectedDate)}>
          <Edit3 size={12} /> Edit this day&apos;s EOD
        </button>
      )}
    >
      {sortedDates.length === 0 ? (
        <p style={{ margin: 0, padding: '28px 20px', fontSize: 13.5, color: 'var(--ink-4)', textAlign: 'center' }}>No calls in the last {days} days.</p>
      ) : (
        <>
          {/* Day strip: one chip per day with calls, newest on the right */}
          <div className="overflow-x-auto no-scrollbar" style={{ padding: '16px 20px 6px', borderBottom: '1px solid var(--rule)' }}>
            <div className="flex gap-2" style={{ minWidth: 'min-content' }}>
              {sortedDates.map(date => <DayChip key={date} date={date} calls={byDate.get(date)} selected={date === selectedDate} onClick={() => onSelectDate(date)} />)}
            </div>
            <div className="flex flex-wrap gap-4 mt-3" style={{ fontSize: 11.5, color: 'var(--ink-4)', fontWeight: 600 }}>
              {Object.entries(OUTCOME_META).filter(([k]) => k !== 'not_ascended').map(([k, meta]) => (
                <span key={k} className="inline-flex items-center gap-1.5"><span style={{ width: 8, height: 8, borderRadius: 999, background: meta.color }} />{meta.label}</span>
              ))}
            </div>
          </div>

          {selectedDate && (
            <>
              <div className="flex flex-wrap items-center gap-3 px-5 py-3" style={{ borderBottom: '1px solid var(--rule)', background: '#fbfbf9' }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{fmtDayLong(selectedDate)}</span>
                <span style={{ fontSize: 12.5, color: 'var(--ink-4)', fontWeight: 500 }}>
                  {dayTotals.calls} {dayTotals.calls === 1 ? 'call' : 'calls'}
                  {dayTotals.closes > 0 && <span style={{ color: 'var(--house-good)' }}> · {dayTotals.closes} closed</span>}
                  {dayTotals.ascensions > 0 && <span style={{ color: 'var(--ink-2)' }}> · {dayTotals.ascensions} ascended</span>}
                  {dayTotals.noShows > 0 && <span style={{ color: 'var(--house-bad)' }}> · {dayTotals.noShows} no-show</span>}
                  {dayTotals.cash > 0 && <span style={{ color: 'var(--ink)' }}> · ${dayTotals.cash.toLocaleString()} cash</span>}
                </span>
              </div>
              <LeaderTable
                rows={[...dayCalls].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))}
                highlightFirst={false}
                empty="No calls recorded for this day."
                columns={[
                  { key: 'created_at', label: 'Time', width: 80, render: r => fmtTime(r.created_at) || '—' },
                  { key: 'prospect_name', label: 'Prospect', render: r => <span style={{ fontWeight: 600 }}>{(r.prospect_name || '—').split(' - ')[0]}</span> },
                  { key: 'call_type', label: 'Type', width: 90, render: r => <span className="pill">{TYPE_META[r.call_type]?.label || 'NC'}</span> },
                  { key: 'outcome', label: 'Outcome', width: 130, render: r => <OutcomePill outcome={r.outcome} /> },
                  { key: 'notes', label: 'Notes', render: r => r.notes ? <span title={r.notes} style={{ color: 'var(--ink-2)', fontWeight: 400, display: 'inline-block', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>{r.notes}</span> : <span style={{ color: 'var(--ink-5)' }}>—</span> },
                  { key: 'revenue', label: 'Revenue', align: 'right', render: r => parseFloat(r.revenue || 0) > 0 ? `$${parseFloat(r.revenue).toLocaleString()}` : '—' },
                  { key: 'cash_collected', label: 'Cash', align: 'right', strong: true, render: r => parseFloat(r.cash_collected || 0) > 0 ? `$${parseFloat(r.cash_collected).toLocaleString()}` : '—' },
                ]}
              />
            </>
          )}
        </>
      )}
    </Card>
  )
}

function DayChip({ date, calls, selected, onClick }) {
  const counts = {}
  for (const c of calls) counts[c.outcome || 'unknown'] = (counts[c.outcome || 'unknown'] || 0) + 1
  const total = calls.length
  const wins = (counts.closed || 0) + (counts.ascended || 0)
  const noShows = counts.no_show || 0
  const segs = ['closed', 'ascended', 'not_closed', 'not_ascended', 'rescheduled', 'no_show'].filter(k => counts[k]).map(k => ({ k, pct: (counts[k] / total) * 100 }))
  return (
    <button type="button" onClick={onClick} className="house-plain" style={{
      display: 'flex', flexDirection: 'column', gap: 8, minWidth: 104, textAlign: 'left',
      padding: '10px 12px', borderRadius: 14,
      background: selected ? 'var(--accent)' : '#ffffff',
      border: `1px solid ${selected ? 'var(--accent)' : 'var(--house-line-strong)'}`,
      boxShadow: selected ? '0 8px 20px -10px rgba(244,197,24,.9)' : 'var(--house-shadow-input)',
      color: 'var(--ink)',
    }}>
      <span className="flex items-baseline justify-between gap-2">
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{fmtDayShort(date)}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: selected ? 'rgba(26,23,0,.7)' : 'var(--ink-4)' }}>{total}</span>
      </span>
      <span className="flex overflow-hidden" style={{ height: 6, borderRadius: 999, background: selected ? 'rgba(26,23,0,.12)' : '#f1efe3' }}>
        {segs.map(s => <span key={s.k} style={{ width: `${s.pct}%`, background: OUTCOME_META[s.k]?.color || 'var(--ink-4)' }} />)}
      </span>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: selected ? 'rgba(26,23,0,.75)' : 'var(--ink-4)' }}>
        {wins > 0 && <span style={{ color: selected ? '#1a1700' : 'var(--house-good)' }}>{wins} won</span>}
        {wins > 0 && noShows > 0 && ' · '}
        {noShows > 0 && <span style={{ color: selected ? '#1a1700' : 'var(--house-bad)' }}>{noShows} no-show</span>}
        {wins === 0 && noShows === 0 && 'no result yet'}
      </span>
    </button>
  )
}

function OutcomePill({ outcome }) {
  const meta = OUTCOME_META[outcome] || { label: outcome || '—', color: 'var(--ink-4)' }
  return (
    <span className="pill" style={{ color: meta.color === 'var(--ink-4)' ? 'var(--ink-2)' : meta.color, borderColor: meta.color === 'var(--ink-4)' ? 'var(--rule)' : meta.color.replace(')', ',.35)').replace('var(--house-good)', 'rgba(22,163,74,.35)').replace('var(--house-bad)', 'rgba(224,86,30,.35)').replace('var(--ink-2)', 'var(--rule)').replace('var(--house-warn)', 'rgba(184,134,11,.35)') }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: meta.color }} />{meta.label}
    </span>
  )
}

/*
  The calls behind Show rate and Close rate. Show rate is live new calls over
  new calls booked, so the modal lists every NEW call in the window with what
  happened to it. Close rate is closed prospects over live prospects.
*/
function CallsModal({ kind, onClose, calls, days, name }) {
  if (!kind) return null
  const isShow = kind === 'show'
  const nc = calls.filter(c => c.call_type === 'new_call')
  const live = nc.filter(c => ['closed', 'not_closed'].includes(c.outcome))
  const noShow = nc.filter(c => c.outcome === 'no_show')
  const moved = nc.filter(c => ['rescheduled', 'cancelled', 'canceled'].includes(c.outcome))
  const liveAll = calls.filter(c => ['new_call', 'follow_up'].includes(c.call_type) && ['closed', 'not_closed'].includes(c.outcome))
  const closed = liveAll.filter(c => c.outcome === 'closed')
  const rows = (isShow ? nc : liveAll).slice().sort((a, b) => (b.report_date || '').localeCompare(a.report_date || ''))
  const pct = (n, d) => d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—'
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={name ? `${name} · last ${days} days` : `Last ${days} days`}
      title={isShow ? 'Show rate: every new call booked' : 'Close rate: every live call'}
      subtitle={isShow ? 'Booked new calls and what happened to each one. Live means the prospect turned up.' : 'Live calls (new and follow-up) and which ones closed.'}
      size="lg"
    >
      <div className="kpi-grid" style={{ padding: '18px 24px 6px' }}>
        {isShow ? (<>
          <KPICard label="New calls booked" value={nc.length} />
          <KPICard label="Showed" value={live.length} subtitle={pct(live.length, nc.length)} />
          <KPICard label="No show" value={noShow.length} subtitle={pct(noShow.length, nc.length)} />
          <KPICard label="Rescheduled / cancelled" value={moved.length} subtitle={pct(moved.length, nc.length)} />
        </>) : (<>
          <KPICard label="Live calls" value={liveAll.length} />
          <KPICard label="Closed" value={closed.length} subtitle={pct(closed.length, liveAll.length)} />
          <KPICard label="Not closed" value={liveAll.length - closed.length} subtitle={pct(liveAll.length - closed.length, liveAll.length)} />
          <KPICard label="Cash" value={`$${Math.round(closed.reduce((t, c) => t + parseFloat(c.cash_collected || 0), 0)).toLocaleString()}`} />
        </>)}
      </div>
      <LeaderTable
        rows={rows}
        highlightFirst={false}
        empty="No calls in this window."
        columns={[
          { key: 'report_date', label: 'Date', width: 120, render: r => fmtDayShort(r.report_date) },
          { key: 'prospect_name', label: 'Prospect', render: r => <span style={{ fontWeight: 600 }}>{(r.prospect_name || '—').split(' - ')[0]}</span> },
          { key: 'call_type', label: 'Type', width: 80, render: r => <span className="pill">{TYPE_META[r.call_type]?.label || 'NC'}</span> },
          { key: 'outcome', label: isShow ? 'Showed?' : 'Result', width: 150, render: r => <OutcomePill outcome={r.outcome} /> },
          { key: 'cash_collected', label: 'Cash', align: 'right', strong: true, render: r => parseFloat(r.cash_collected || 0) > 0 ? `$${parseFloat(r.cash_collected).toLocaleString()}` : '—' },
        ]}
      />
    </Modal>
  )
}
