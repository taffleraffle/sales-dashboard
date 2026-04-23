import { useParams, useNavigate } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import CommissionWidget from '../components/CommissionWidget'
import { AlertTriangle, Loader, ExternalLink, ChevronDown } from 'lucide-react'
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
  const [showEodHistory, setShowEodHistory] = useState(false)
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

  // Recalculate win rates from actual closer_calls outcomes
  useEffect(() => {
    if (!rawObjections.length) { setObjections([]); setCallOutcomes({}); return }
    async function recalcWinRates() {
      // Fetch all closer_calls for this closer in the date range
      const { data: closerCalls } = await supabase
        .from('closer_calls')
        .select('prospect_name, outcome, eod_report_id')
        .in('eod_report_id', myReports.map(r => r.id))
      const callMap = {}
      for (const c of (closerCalls || [])) {
        if (c.prospect_name) {
          const key = c.prospect_name.toLowerCase().trim()
          callMap[key] = c.outcome
        }
      }
      setCallOutcomes(callMap)
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
  }, [rawObjections, myReports])

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

      {/* EOD History */}
      {myReports.length > 0 && (
        <div className="tile tile-feedback overflow-hidden mb-6">
          <button
            onClick={() => setShowEodHistory(!showEodHistory)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-card-hover transition-colors"
          >
            <h2 className="text-sm font-medium">EOD History ({myReports.length})</h2>
            <ChevronDown size={14} className={`text-text-400 transition-transform ${showEodHistory ? 'rotate-180' : ''}`} />
          </button>
          {showEodHistory && (
            <div className="border-t border-border-default overflow-x-auto max-h-[400px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-bg-card z-10">
                  <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-right">Booked</th>
                    <th className="px-3 py-2 text-right">Live</th>
                    <th className="px-3 py-2 text-right">No Shows</th>
                    <th className="px-3 py-2 text-right">Offers</th>
                    <th className="px-3 py-2 text-right">Closes</th>
                    <th className="px-3 py-2 text-right">Asc</th>
                    <th className="px-3 py-2 text-right">Show%</th>
                    <th className="px-3 py-2 text-right">Close%</th>
                    <th className="px-3 py-2 text-right">Cash</th>
                    <th className="px-3 py-2 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {myReports.map(eod => {
                    const booked = (eod.nc_booked || 0) + (eod.fu_booked || 0)
                    const live = (eod.live_nc_calls || 0) + (eod.live_fu_calls || 0)
                    const noShows = (eod.nc_no_shows || 0) + (eod.fu_no_shows || 0)
                    const showPct = booked > 0 ? ((live / booked) * 100).toFixed(0) : '—'
                    const closePct = live > 0 ? (((eod.closes || 0) / live) * 100).toFixed(0) : '—'
                    const cash = parseFloat(eod.total_cash_collected || 0)
                    const rev = parseFloat(eod.total_revenue || 0)
                    return (
                      <tr key={eod.id} className="border-b border-border-default/30 hover:bg-bg-card-hover/50 cursor-pointer" onClick={() => navigate(`/sales/eod/submit?tab=closer&member=${id}&date=${eod.report_date}`)}>
                        <td className="px-3 py-2 font-medium text-opt-yellow hover:underline">{eod.report_date}</td>
                        <td className="px-3 py-2 text-right">{booked}</td>
                        <td className="px-3 py-2 text-right">{live}</td>
                        <td className="px-3 py-2 text-right text-danger">{noShows}</td>
                        <td className="px-3 py-2 text-right">{eod.offers || 0}</td>
                        <td className="px-3 py-2 text-right font-medium">{eod.closes || 0}</td>
                        <td className="px-3 py-2 text-right text-cyan-400">{eod.deposits || 0}</td>
                        <td className={`px-3 py-2 text-right font-medium ${showPct !== '—' && parseFloat(showPct) >= 70 ? 'text-success' : showPct !== '—' && parseFloat(showPct) >= 50 ? 'text-opt-yellow' : 'text-danger'}`}>{showPct !== '—' ? `${showPct}%` : '—'}</td>
                        <td className={`px-3 py-2 text-right font-medium ${closePct !== '—' && parseFloat(closePct) >= 25 ? 'text-success' : closePct !== '—' && parseFloat(closePct) >= 15 ? 'text-opt-yellow' : 'text-danger'}`}>{closePct !== '—' ? `${closePct}%` : '—'}</td>
                        <td className="px-3 py-2 text-right text-opt-yellow">{cash > 0 ? `$${cash.toLocaleString()}` : '—'}</td>
                        <td className="px-3 py-2 text-right text-success">{rev > 0 ? `$${rev.toLocaleString()}` : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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
