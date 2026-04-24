import { useParams, useNavigate } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import CommissionWidget from '../components/CommissionWidget'
import { AlertTriangle, Loader, ExternalLink, ChevronDown, Calendar, Edit3 } from 'lucide-react'
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
  const [expandedCallId, setExpandedCallId] = useState(null)
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

  // Aggregate breakdowns across all closers for company averages
  const companyBreakSum = Object.values(allBreak || {}).reduce((a, b) => ({
    ncCloses: a.ncCloses + b.ncCloses,
    fuCloses: a.fuCloses + b.fuCloses,
    ncLive: a.ncLive + b.ncLive,
  }), { ncCloses: 0, fuCloses: 0, ncLive: 0 })
  const companyCloseRateNew = companyBreakSum.ncLive > 0
    ? parseFloat(((companyBreakSum.ncCloses / companyBreakSum.ncLive) * 100).toFixed(1))
    : 0
  const companyNetCloseRate = companyBreakSum.ncLive > 0
    ? parseFloat((((companyBreakSum.ncCloses + companyBreakSum.fuCloses) / companyBreakSum.ncLive) * 100).toFixed(1))
    : 0

  const mb = myBreak?.[id] || { ncCloses: 0, fuCloses: 0, ncLive: 0 }
  const myCloseRateNew = mb.ncLive > 0 ? parseFloat(((mb.ncCloses / mb.ncLive) * 100).toFixed(1)) : 0
  const myNetCloseRate = mb.ncLive > 0 ? parseFloat((((mb.ncCloses + mb.fuCloses) / mb.ncLive) * 100).toFixed(1)) : 0

  const companyRates = {
    // Show rate: new-call only (denominator = nc_booked, numerator = live_nc_calls)
    showRate: companyTotals.ncBooked > 0 ? parseFloat(((companyTotals.liveNC / companyTotals.ncBooked) * 100).toFixed(1)) : 0,
    closeRate: companyCloseRateNew,
    netCloseRate: companyNetCloseRate,
    offerRate: companyTotals.liveCalls > 0 ? parseFloat(((companyTotals.offers / companyTotals.liveCalls) * 100).toFixed(1)) : 0,
    offerCloseRate: companyTotals.offers > 0 ? parseFloat(((companyTotals.closes / companyTotals.offers) * 100).toFixed(1)) : 0,
    rescheduleRate: companyTotals.booked > 0 ? parseFloat(((companyTotals.reschedules / companyTotals.booked) * 100).toFixed(1)) : 0,
  }

  const myShowRate = parseFloat(stats.showRate) || 0
  const myCloseRate = myCloseRateNew
  const myOfferRate = parseFloat(stats.offerRate) || 0
  const myOfferCloseRate = stats.offers > 0 ? parseFloat(((stats.closes / stats.offers) * 100).toFixed(1)) : 0
  const myRescheduleRate = parseFloat(stats.rescheduleRate) || 0
  const avgDealSize = stats.closes > 0 ? parseFloat((stats.revenue / stats.closes).toFixed(0)) : 0
  const totalCash = stats.cash + stats.ascendCash
  const totalRevenue = stats.revenue + stats.ascendRevenue
  const cashCollRate = totalRevenue > 0 ? parseFloat(((totalCash / totalRevenue) * 100).toFixed(1)) : 0
  const companyCashCollRate = (() => { const t = allReports.reduce((a, r) => ({ rev: a.rev + parseFloat(r.total_revenue || 0) + parseFloat(r.ascend_revenue || 0), cash: a.cash + parseFloat(r.total_cash_collected || 0) + parseFloat(r.ascend_cash || 0) }), { rev: 0, cash: 0 }); return t.rev > 0 ? parseFloat(((t.cash / t.rev) * 100).toFixed(1)) : 0 })()
  const avgFathomDuration = transcripts.length > 0 ? Math.round(transcripts.reduce((s, t) => s + (t.duration_seconds || 0), 0) / transcripts.length) : 0

  if (!member) {
    return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-lg sm:text-xl font-bold">{member.name}</h1>
          <p className="text-xs sm:text-sm text-text-400">Closer Performance</p>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 mb-6">
        <KPICard label="Booked" value={stats.totalBooked} subtitle={`${stats.ncBooked} NC / ${stats.fuBooked} FU`} />
        <KPICard label="Live Calls" value={stats.liveCalls} />
        <KPICard label="No Shows" value={stats.noShows} />
        <KPICard label="Offers" value={stats.offers} />
        <KPICard label="Closes" value={stats.closes} />
        <KPICard label="Trial Cash" value={`$${stats.cash.toLocaleString()}`} subtitle={`$${stats.revenue.toLocaleString()} rev`} />
        <KPICard label="Ascension Cash" value={`$${stats.ascendCash.toLocaleString()}`} subtitle={`${stats.ascensions} ascensions`} />
        <KPICard label="Total Cash" value={`$${totalCash.toLocaleString()}`} subtitle={`$${totalRevenue.toLocaleString()} total rev`} />
        <KPICard label="Avg Deal" value={`$${avgDealSize.toLocaleString()}`} />
        {avgFathomDuration > 0 && <KPICard label="Avg Talk Time" value={`${Math.round(avgFathomDuration / 60)}m`} subtitle={`${transcripts.length} calls`} />}
      </div>

      {/* Commission */}
      <CommissionWidget memberId={id} />

      {/* Conversion Gauges */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Gauge label="Show Rate" value={myShowRate} target={70} delta={parseFloat((myShowRate - companyRates.showRate).toFixed(1))} avgLabel={companyRates.showRate} />
        <Gauge label="Close Rate" value={myCloseRate} target={25} delta={parseFloat((myCloseRate - companyRates.closeRate).toFixed(1))} avgLabel={companyRates.closeRate} />
        <Gauge label="Net Close" value={myNetCloseRate} target={30} delta={parseFloat((myNetCloseRate - companyRates.netCloseRate).toFixed(1))} avgLabel={companyRates.netCloseRate} />
        <Gauge label="Offer Rate" value={myOfferRate} target={80} delta={parseFloat((myOfferRate - companyRates.offerRate).toFixed(1))} avgLabel={companyRates.offerRate} />
        <Gauge label="Offer → Close" value={myOfferCloseRate} target={30} max={100} delta={parseFloat((myOfferCloseRate - companyRates.offerCloseRate).toFixed(1))} avgLabel={companyRates.offerCloseRate} />
        <Gauge label="Reschedule %" value={myRescheduleRate} target={15} max={50} delta={parseFloat((myRescheduleRate - companyRates.rescheduleRate).toFixed(1))} avgLabel={companyRates.rescheduleRate} />
        <Gauge label="Cash Collect %" value={cashCollRate} target={50} delta={parseFloat((cashCollRate - companyCashCollRate).toFixed(1))} avgLabel={companyCashCollRate} />
        <Gauge label="No Show %" value={stats.totalBooked > 0 ? parseFloat(((stats.noShows / stats.totalBooked) * 100).toFixed(1)) : 0} target={20} max={50} />
        <Gauge label="Avg Call" value={avgFathomDuration > 0 ? Math.round(avgFathomDuration / 60) : 0} target={30} max={90} />
      </div>

      {/* Calls Calendar — replaces the old EOD-aggregate table.
          Day strip across the top, click a day to see that day's calls below. */}
      <CallsCalendar
        calls={allCalls}
        selectedDate={selectedDate}
        onSelectDate={(d) => { setSelectedDate(d); setExpandedCallId(null) }}
        expandedCallId={expandedCallId}
        onToggleCall={(cid) => setExpandedCallId(expandedCallId === cid ? null : cid)}
        onEditEod={(d) => navigate(`/sales/eod/submit?tab=closer&member=${id}&date=${d}`)}
        days={days}
      />

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
                return 'bg-bg-card-hover border border-border-default hover:bg-opt-yellow/10 hover:text-opt-yellow'
              }
              return (
                <div key={i} className="border border-border-default rounded-2xl p-4">
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
            <Loader size={14} className="animate-spin text-opt-yellow" />
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
  closed:       { label: 'Closed',      bar: 'bg-success',     chip: 'bg-success/15 text-success border-success/30' },
  ascended:     { label: 'Ascended',    bar: 'bg-cyan-400',    chip: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
  not_closed:   { label: 'Not Closed',  bar: 'bg-text-400',    chip: 'bg-text-400/15 text-text-400 border-border-default' },
  not_ascended: { label: "Didn't Asc",  bar: 'bg-text-400',    chip: 'bg-text-400/15 text-text-400 border-border-default' },
  no_show:      { label: 'No Show',     bar: 'bg-danger',      chip: 'bg-danger/15 text-danger border-danger/30' },
  rescheduled:  { label: 'Rescheduled', bar: 'bg-blue-400',    chip: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
}

const TYPE_META = {
  new_call:  { label: 'NC',  chip: 'bg-opt-yellow/15 text-opt-yellow border-opt-yellow/30' },
  follow_up: { label: 'FU',  chip: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
  ascension: { label: 'ASC', chip: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
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

function CallsCalendar({ calls, selectedDate, onSelectDate, expandedCallId, onToggleCall, onEditEod, days }) {
  // Group calls by report_date
  const byDate = new Map()
  for (const c of calls) {
    if (!c.report_date) continue
    if (!byDate.has(c.report_date)) byDate.set(c.report_date, [])
    byDate.get(c.report_date).push(c)
  }
  const sortedDates = [...byDate.keys()].sort() // ascending → today rightmost

  const dayCalls = selectedDate ? (byDate.get(selectedDate) || []) : []
  const dayTotals = dayCalls.reduce((a, c) => {
    a.calls++
    if (c.outcome === 'closed') a.closes++
    if (c.outcome === 'ascended') a.ascensions++
    if (c.outcome === 'no_show') a.noShows++
    a.cash += parseFloat(c.cash_collected || 0)
    a.revenue += parseFloat(c.revenue || 0)
    return a
  }, { calls: 0, closes: 0, ascensions: 0, noShows: 0, cash: 0, revenue: 0 })

  return (
    <div className="tile tile-feedback p-4 sm:p-5 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Calendar size={16} className="text-opt-yellow" />
        <h2 className="text-sm font-medium">Calls Calendar</h2>
        <span className="text-xs text-text-400 ml-auto">
          {calls.length} calls · last {days} days
        </span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-4 text-[10px] text-text-400">
        {Object.entries(OUTCOME_META).filter(([k]) => k !== 'not_ascended').map(([k, meta]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-sm ${meta.bar}`} />
            {meta.label}
          </span>
        ))}
      </div>

      {sortedDates.length === 0 ? (
        <div className="py-10 text-center text-text-400 text-sm">
          No calls in the last {days} days.
        </div>
      ) : (
        <>
          {/* Day strip */}
          <div className="overflow-x-auto -mx-1 pb-1">
            <div className="flex gap-2 px-1 min-w-min">
              {sortedDates.map(date => (
                <DayCell
                  key={date}
                  date={date}
                  calls={byDate.get(date)}
                  selected={date === selectedDate}
                  onClick={() => onSelectDate(date)}
                />
              ))}
            </div>
          </div>

          {/* Selected day detail */}
          {selectedDate && (
            <div className="mt-5 border-t border-border-default pt-4">
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <h3 className="text-sm font-semibold">{fmtDayLong(selectedDate)}</h3>
                <span className="text-xs text-text-400">
                  {dayTotals.calls} call{dayTotals.calls === 1 ? '' : 's'}
                  {dayTotals.closes > 0 && <span className="text-success"> · {dayTotals.closes} closed</span>}
                  {dayTotals.ascensions > 0 && <span className="text-cyan-400"> · {dayTotals.ascensions} asc</span>}
                  {dayTotals.noShows > 0 && <span className="text-danger"> · {dayTotals.noShows} no-show</span>}
                  {dayTotals.cash > 0 && <span className="text-opt-yellow"> · ${dayTotals.cash.toLocaleString()} cash</span>}
                </span>
                <button
                  onClick={() => onEditEod(selectedDate)}
                  className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-opt-yellow border border-opt-yellow/30 hover:bg-opt-yellow/10 transition-colors"
                >
                  <Edit3 size={12} />
                  Edit EOD
                </button>
              </div>

              {dayCalls.length === 0 ? (
                <p className="text-text-400 text-sm py-4 text-center">No calls recorded for this day.</p>
              ) : (
                <div className="space-y-1.5">
                  {dayCalls.map(call => (
                    <CallRow
                      key={call.id}
                      call={call}
                      expanded={expandedCallId === call.id}
                      onToggle={() => onToggleCall(call.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function DayCell({ date, calls, selected, onClick }) {
  const counts = {}
  for (const c of calls) {
    const key = c.outcome || 'unknown'
    counts[key] = (counts[key] || 0) + 1
  }
  const total = calls.length

  // Render outcome bar segments in a fixed priority order so colors are stable
  const segOrder = ['closed', 'ascended', 'not_closed', 'not_ascended', 'rescheduled', 'no_show']
  const segs = segOrder
    .filter(k => counts[k])
    .map(k => ({ outcome: k, count: counts[k], pct: (counts[k] / total) * 100 }))

  // Top-line stat: closes if any, else live calls, else booked count
  const closes = (counts.closed || 0) + (counts.ascended || 0)
  const noShows = counts.no_show || 0

  return (
    <button
      onClick={onClick}
      className={`flex flex-col gap-1.5 min-w-[78px] sm:min-w-[88px] px-2.5 py-2.5 rounded-2xl border transition-all text-left ${
        selected
          ? 'border-opt-yellow bg-opt-yellow/10'
          : 'border-border-default bg-bg-card hover:bg-bg-card-hover hover:border-border-default'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[10px] uppercase tracking-wider ${selected ? 'text-opt-yellow' : 'text-text-400'}`}>
          {fmtDayShort(date)}
        </span>
        <span className="text-[10px] text-text-400 tabular-nums">{total}</span>
      </div>

      {/* Outcome bar */}
      <div className="flex h-1.5 rounded-full overflow-hidden bg-bg-primary">
        {segs.map((s, i) => (
          <div
            key={i}
            className={OUTCOME_META[s.outcome]?.bar || 'bg-text-400'}
            style={{ width: `${s.pct}%` }}
            title={`${OUTCOME_META[s.outcome]?.label || s.outcome}: ${s.count}`}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 text-[10px] tabular-nums">
        {closes > 0 && <span className="text-success">{closes}W</span>}
        {noShows > 0 && <span className="text-danger">{noShows}NS</span>}
        {closes === 0 && noShows === 0 && total > 0 && (
          <span className="text-text-400">—</span>
        )}
      </div>
    </button>
  )
}

function CallRow({ call, expanded, onToggle }) {
  const outcome = OUTCOME_META[call.outcome] || { label: call.outcome || '—', chip: 'bg-text-400/15 text-text-400 border-border-default' }
  const type = TYPE_META[call.call_type] || TYPE_META.new_call
  const time = fmtTime(call.created_at)
  const cash = parseFloat(call.cash_collected || 0)
  const rev = parseFloat(call.revenue || 0)
  const hasDetail = !!call.notes
  const isWin = call.outcome === 'closed' || call.outcome === 'ascended'
  const isMiss = call.outcome === 'no_show'

  return (
    <div className={`bg-bg-card border rounded-xl overflow-hidden transition-colors ${
      isWin ? 'border-success/30' : isMiss ? 'border-danger/30' : 'border-border-default'
    }`}>
      <button
        onClick={onToggle}
        className="w-full px-3 py-2.5 flex flex-wrap items-center gap-2 sm:gap-3 hover:bg-bg-card-hover/50 transition-colors text-left"
      >
        <ChevronDown size={12} className={`text-text-400 transition-transform flex-shrink-0 ${expanded ? '' : '-rotate-90'}`} />
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${type.chip}`}>{type.label}</span>
        <span className="font-medium text-sm min-w-0 truncate flex-shrink">{call.prospect_name || '—'}</span>
        {time && <span className="text-[11px] text-text-400 font-mono">{time}</span>}
        <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${outcome.chip}`}>{outcome.label}</span>
        <div className="ml-auto flex items-center gap-3 text-xs">
          {cash > 0 && <span className="text-opt-yellow font-medium">${cash.toLocaleString()} cash</span>}
          {rev > 0 && <span className="text-success">${rev.toLocaleString()} rev</span>}
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pl-9 space-y-2 border-t border-border-default/40">
          {(rev > 0 || cash > 0) && (
            <div className="flex gap-4 text-xs pt-2">
              <span className="text-text-400">Revenue: <strong className="text-success">${rev.toLocaleString()}</strong></span>
              <span className="text-text-400">Cash: <strong className="text-opt-yellow">${cash.toLocaleString()}</strong></span>
            </div>
          )}
          {call.notes && (
            <div className="text-xs text-text-400 pt-1">
              <span className="uppercase text-[10px]">Notes: </span>
              <span className="text-text-secondary whitespace-pre-wrap">{call.notes}</span>
            </div>
          )}
          {!hasDetail && rev === 0 && cash === 0 && (
            <p className="text-[10px] text-text-400 italic pt-1">No additional details recorded.</p>
          )}
        </div>
      )}
    </div>
  )
}
