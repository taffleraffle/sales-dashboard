import { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { supabase } from '../lib/supabase'
import { sinceDate, rangeToDays } from '../lib/dateUtils'
import { fetchAllPipelineSummaries, computeSpeedToLead, buildSetterSchedules } from '../services/ghlPipeline'
import { fetchWavvAggregates, fetchWavvCallsForSTL } from '../services/wavvService'
import { syncGHLAppointments } from '../services/ghlCalendar'
import { Loader, ChevronDown, ChevronUp, AlertTriangle, RefreshCw } from 'lucide-react'
import { clearPipelineCache } from '../services/ghlPipeline'

export default function PipelinePerformance() {
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const { members: setters } = useTeamMembers('setter')
  const { members: closers } = useTeamMembers('closer')

  const [pipelineData, setPipelineData] = useState([])
  const [loadingPipeline, setLoadingPipeline] = useState(true)
  const [pipelineProgress, setPipelineProgress] = useState('')
  const [pipelineError, setPipelineError] = useState(null)
  const [retryKey, setRetryKey] = useState(0)
  const [wavvAgg, setWavvAgg] = useState({ totals: { dials: 0, pickups: 0, mcs: 0 }, byUser: {}, uniqueContacts: 0 })
  const [stlCalls, setStlCalls] = useState(null)
  const [stlOpen, setStlOpen] = useState(false)
  const [allAppointments, setAllAppointments] = useState([])
  const [totalSets, setTotalSets] = useState(0)
  const [showAllLeads, setShowAllLeads] = useState(false)

  // Fetch appointments (needed for STL auto-booked marker)
  useEffect(() => {
    async function run() {
      const { data } = await supabase
        .from('ghl_appointments')
        .select('ghl_event_id, closer_id, ghl_user_id, ghl_contact_id, contact_name, contact_phone, appointment_date, booked_at, calendar_name, appointment_status, start_time, created_at')
        .gte('booked_at', `${sinceDate(range)} 00:00:00`)
        .neq('appointment_status', 'cancelled')
      setAllAppointments(data || [])

      const newest = (data || []).reduce((latest, r) => {
        const t = new Date(r.created_at || 0).getTime()
        return t > latest ? t : latest
      }, 0)
      const isStale = !data?.length || (Date.now() - newest) > 60 * 60 * 1000
      if (isStale) {
        const today = new Date().toISOString().split('T')[0]
        syncGHLAppointments(sinceDate(range), today)
          .then(async () => {
            const { data: fresh } = await supabase
              .from('ghl_appointments')
              .select('ghl_event_id, closer_id, ghl_user_id, ghl_contact_id, contact_name, contact_phone, appointment_date, booked_at, calendar_name, appointment_status, start_time, created_at')
              .gte('booked_at', `${sinceDate(range)} 00:00:00`)
              .neq('appointment_status', 'cancelled')
            setAllAppointments(fresh || [])
          })
          .catch(err => console.warn('Auto GHL sync failed:', err.message))
      }
    }
    run()
  }, [range])

  // Pipelines. Errors are surfaced in the UI (not silent "no data") — Ben was
  // seeing "no data available" when the real cause was a 429 storm eating the
  // promise. Now the banner shows the actual error and offers a retry that
  // bypasses the 5-min memo cache.
  useEffect(() => {
    setLoadingPipeline(true)
    setPipelineError(null)
    setPipelineData([])
    fetchAllPipelineSummaries((name, loaded, total) => {
      setPipelineProgress(`${name}: ${loaded}/${total}`)
    }).then(data => {
      setPipelineData(data || [])
      setLoadingPipeline(false)
    }).catch(err => {
      console.error('Failed to fetch GHL pipelines:', err)
      setPipelineError(err?.message || String(err))
      setPipelineData([])
      setLoadingPipeline(false)
    })
  }, [range, retryKey])

  const handleRetry = () => {
    clearPipelineCache()
    setRetryKey(k => k + 1)
  }

  // WAVV aggregate totals
  useEffect(() => {
    fetchWavvAggregates(days).then(setWavvAgg).catch(() => {})
  }, [range])

  // STL calls
  useEffect(() => {
    setStlCalls(null)
    fetchWavvCallsForSTL(days).then(setStlCalls).catch(() => setStlCalls([]))
  }, [range])

  // Total sets in range — used as denominator in pipeline-row rates
  useEffect(() => {
    supabase
      .from('setter_leads')
      .select('id', { count: 'exact', head: true })
      .gte('date_set', sinceDate(range))
      .then(({ count }) => setTotalSets(count || 0))
  }, [range])

  const hasWavv = wavvAgg.totals.dials > 0
  const stlSchedules = buildSetterSchedules(setters)
  const allOpps = pipelineData.flatMap(p => p.summary.opportunities || [])
  const stl = allOpps.length > 0 && stlCalls && stlCalls.length > 0
    ? computeSpeedToLead(allOpps, stlCalls, allAppointments, stlSchedules)
    : null

  const totalLeads = pipelineData.reduce((s, p) => s + (p.summary.total || 0), 0)

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Pipeline Performance</h1>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      <div className="max-w-[1600px] mx-auto space-y-6">

        {/* Error banner — visible whenever pipeline fetch failed. Without
            this, Ben saw "no data available" with no indication of WHY. */}
        {pipelineError && (
          <div className="tile border border-danger/40 bg-danger/5 px-4 py-3 flex items-start gap-3">
            <AlertTriangle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-danger">Couldn't load pipeline data from GHL</p>
              <p className="text-xs text-text-400 mt-1 break-words">{pipelineError}</p>
              <p className="text-[11px] text-text-400 mt-1">If this is a 429 rate-limit, wait ~30 seconds and retry. Other errors usually mean GHL credentials need refreshing.</p>
            </div>
            <button
              onClick={handleRetry}
              disabled={loadingPipeline}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-opt-yellow border border-opt-yellow/30 hover:bg-opt-yellow/10 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={loadingPipeline ? 'animate-spin' : ''} />
              Retry
            </button>
          </div>
        )}

        {/* Top KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3">
          <KPICard label="Pipeline Leads" value={totalLeads.toLocaleString()} subtitle={`${pipelineData.length} pipelines`} />
          <KPICard label="Avg Speed to Lead" value={stl ? stl.avgDisplay : '—'} subtitle={stl ? `${stl.worked} responded` : ''} />
          <KPICard label="< 5 min Response" value={stl ? `${stl.pctUnder5m}%` : '—'} subtitle={stl ? `${stl.under5m} of ${stl.worked}` : ''} />
          <KPICard label="Not Called" value={stl?.notCalled ?? '—'} subtitle={stl?.notCalled > 0 ? 'needs follow-up' : ''} />
        </div>

        {/* Speed to Lead — full width */}
        <section>
          <h2 className="text-sm font-medium text-text-secondary mb-4">Speed to Lead</h2>
          {stl ? (
            stl.allLeads.length > 0 && (
              <div className="tile tile-feedback overflow-hidden">
                <button onClick={() => setStlOpen(!stlOpen)} className="w-full px-4 py-2 border-b border-border-default flex items-center justify-between hover:bg-bg-card-hover/50 transition-colors">
                  <span className="text-xs font-medium text-text-secondary">
                    Recent Leads — Response Times ({stl.allLeads.length})
                    {stl.notCalled > 0 && <span className="ml-2 text-danger">{stl.notCalled} not called</span>}
                  </span>
                  <ChevronDown size={14} className={`text-text-400 transition-transform ${stlOpen ? 'rotate-180' : ''}`} />
                </button>
                {stlOpen && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                          <th className="px-3 py-2 text-left">Lead</th>
                          <th className="px-3 py-2 text-left">Setter</th>
                          <th className="px-3 py-2 text-left">Entered Pipeline</th>
                          <th className="px-3 py-2 text-left">Called At</th>
                          <th className="px-3 py-2 text-right">Talk Time</th>
                          <th className="px-3 py-2 text-right">Response Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stl.allLeads.slice(0, 50).map((l, i) => {
                          const tzOpts = { timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
                          const setterName = l.setterId ? (setters.find(s => s.wavv_user_id === l.setterId)?.name || '—') : '—'
                          const closerName = l.bookingCloserId ? (closers.find(c => c.id === l.bookingCloserId || c.ghl_user_id === l.bookingCloserId)?.name || null) : null
                          return (
                            <tr key={i} className={`border-b border-border-default/30 ${l.uncalled ? 'bg-danger/5' : ''} ${l.hasBooking ? 'bg-cyan-500/5' : ''}`}>
                              <td className="px-3 py-1.5">
                                <span className="font-medium text-text-primary">{l.name}</span>
                                {l.isAutoBooking && (
                                  <span className="ml-2 text-[9px] font-medium px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400">
                                    AUTO BOOKED{l.bookingDate ? ` · ${l.bookingDate}` : ''}{closerName ? ` · ${closerName}` : ''}
                                  </span>
                                )}
                                {l.isStrategyBooking && (
                                  <span className="ml-2 text-[9px] font-medium px-1.5 py-0.5 rounded bg-success/15 text-success">
                                    SET CALL{l.bookingDate ? ` · ${l.bookingDate}` : ''}{closerName ? ` · ${closerName}` : ''}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 text-opt-yellow">{setterName}</td>
                              <td className="px-3 py-1.5 text-text-400">{new Date(l.created).toLocaleString('en-US', tzOpts)}</td>
                              <td className="px-3 py-1.5 text-text-400">{l.calledAt ? new Date(l.calledAt).toLocaleString('en-US', tzOpts) : <span className="text-danger text-[10px] font-medium px-1.5 py-0.5 rounded bg-danger/10">NOT CALLED</span>}</td>
                              <td className={`px-3 py-1.5 text-right ${l.talkTime > 60 ? 'text-success' : 'text-text-400'}`}>
                                {l.talkTime > 0 ? <><span className="font-medium">{l.talkTimeDisplay}</span>{l.callCount > 1 && <span className="text-[9px] text-text-400 ml-1">({l.callCount})</span>}</> : '—'}
                              </td>
                              <td className={`px-3 py-1.5 text-right font-medium ${l.uncalled ? 'text-danger' : l.responseSecs < 300 ? 'text-success' : l.responseSecs < 3600 ? 'text-opt-yellow' : 'text-danger'}`}>
                                {l.responseDisplay}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          ) : (
            <div className="tile tile-feedback p-6 text-center min-h-[180px] flex items-center justify-center">
              {loadingPipeline || !stlCalls ? (
                <div><Loader className="animate-spin text-opt-yellow mx-auto mb-2 h-4 w-4" /><span className="text-xs text-text-400">Loading speed to lead data...</span></div>
              ) : !hasWavv ? (
                <span className="text-xs text-text-400">No WAVV call data yet — publish your Zapier zap to start tracking speed to lead</span>
              ) : (
                <span className="text-xs text-text-400">No GHL opportunities with matching phone numbers found</span>
              )}
            </div>
          )}
        </section>

        {/* GHL Pipeline Performance — full width */}
        <section>
          <h2 className="text-sm font-medium text-text-secondary mb-4">GHL Pipeline Performance</h2>
          {loadingPipeline ? (
            <div className="tile tile-feedback overflow-hidden animate-pulse min-h-[360px]">
              <div className="h-10 border-b border-border-default flex items-center justify-between px-4">
                <div className="h-3 w-32 bg-bg-primary/60 rounded" />
                <div className="h-3 w-20 bg-bg-primary/40 rounded" />
              </div>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="h-10 border-b border-border-default/40 flex items-center gap-3 px-4">
                  <div className="h-3 w-24 bg-bg-primary/40 rounded" />
                  <div className="h-3 w-12 bg-bg-primary/40 rounded ml-auto" />
                  <div className="h-3 w-12 bg-bg-primary/40 rounded" />
                  <div className="h-3 w-12 bg-bg-primary/40 rounded" />
                </div>
              ))}
              <div className="px-4 py-2 text-[10px] text-text-400 text-center">Loading pipelines… {pipelineProgress}</div>
            </div>
          ) : pipelineData.length > 0 ? (
            <div className="space-y-4">
              {pipelineData.map(pipe => {
                const s = pipe.summary
                const hasZapier = hasWavv
                const tw = hasZapier ? wavvAgg.totals : (s.totalWavv || { dials: 0, pickups: 0, mcs: 0 })
                const rateColor = (v, good, ok) => v === '—' ? 'text-text-400' : parseFloat(v) >= good ? 'text-success' : parseFloat(v) >= ok ? 'text-opt-yellow' : 'text-danger'
                const fmtRate = (num, den) => den > 0 ? ((num / den) * 100).toFixed(1) : '—'
                return (
                  <div key={pipe.id} className="tile tile-feedback overflow-hidden">
                    <div className="px-3 sm:px-4 py-3 border-b border-border-default flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-0">
                      <h3 className="text-sm font-bold text-text-primary">{pipe.name}</h3>
                      <div className="flex flex-wrap gap-2 sm:gap-4 text-[10px] sm:text-xs text-text-400">
                        <span>{s.total.toLocaleString()} leads</span>
                        <span>{tw.dials.toLocaleString()} dials</span>
                        <span>{tw.pickups} pickups</span>
                        <span>{tw.mcs} MCs</span>
                        <span className="text-cyan-400 font-medium">{totalSets} sets</span>
                        {hasZapier && <span className="text-success text-[10px]">WAVV LIVE</span>}
                        {!hasZapier && tw.dials > 0 && <span className="text-text-400 text-[10px]">GHL TAGS</span>}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                            <th className="px-3 py-2 text-left">Stage</th>
                            <th className="px-3 py-2 text-right">Count</th>
                            <th className="px-3 py-2 text-right">Dials</th>
                            <th className="px-3 py-2 text-right">Pickups</th>
                            <th className="px-3 py-2 text-right">MCs</th>
                            <th className="px-3 py-2 text-right">Pickup %</th>
                            <th className="px-3 py-2 text-right">Lead→Set %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.stageFlow.map(stage => {
                            const w = stage.wavv || { dials: 0, pickups: 0, mcs: 0 }
                            const pickupPct = fmtRate(w.pickups, w.dials)
                            const leadToSet = fmtRate(totalSets, stage.count)
                            return (
                              <tr key={stage.id} className="border-b border-border-default/30 hover:bg-bg-card-hover/50">
                                <td className="px-3 py-2 font-medium text-text-primary">{stage.name}</td>
                                <td className="px-3 py-2 text-right font-medium text-text-primary">{stage.count}</td>
                                <td className="px-3 py-2 text-right text-text-400">{w.dials.toLocaleString()}</td>
                                <td className="px-3 py-2 text-right text-text-400">{w.pickups}</td>
                                <td className="px-3 py-2 text-right text-text-400">{w.mcs}</td>
                                <td className={`px-3 py-2 text-right font-medium ${rateColor(pickupPct, 20, 10)}`}>{pickupPct !== '—' ? `${pickupPct}%` : '—'}</td>
                                <td className={`px-3 py-2 text-right font-medium ${rateColor(leadToSet, 5, 2)}`}>{leadToSet !== '—' ? `${leadToSet}%` : '—'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-border-default bg-bg-card-hover/30 font-medium">
                            <td className="px-3 py-2">Total</td>
                            <td className="px-3 py-2 text-right">{s.total.toLocaleString()}</td>
                            <td className="px-3 py-2 text-right">{tw.dials.toLocaleString()}</td>
                            <td className="px-3 py-2 text-right">{tw.pickups}</td>
                            <td className="px-3 py-2 text-right">{tw.mcs}</td>
                            <td className={`px-3 py-2 text-right ${rateColor(fmtRate(tw.pickups, tw.dials), 20, 10)}`}>{tw.dials > 0 ? `${fmtRate(tw.pickups, tw.dials)}%` : '—'}</td>
                            <td className={`px-3 py-2 text-right ${rateColor(fmtRate(totalSets, s.total), 5, 2)}`}>{s.total > 0 ? `${fmtRate(totalSets, s.total)}%` : '—'}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="tile tile-feedback p-8 text-center text-text-400 min-h-[200px] flex items-center justify-center">
              No GHL pipeline data available
            </div>
          )}
        </section>

        {/* Recent Leads — live from all pipelines */}
        <section>
          {(() => {
            const ghlLeads = pipelineData
              .flatMap(p => (p.summary.opportunities || []).map(o => {
                const stageMap = {}
                ;(p.stages || []).forEach(s => { stageMap[s.id] = s.name })
                return { ...o, stageName: stageMap[o.pipelineStageId] || 'Unknown', pipelineName: p.name }
              }))
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

            const timeAgo = (iso) => {
              if (!iso) return '—'
              const secs = (Date.now() - new Date(iso).getTime()) / 1000
              if (secs < 60) return 'just now'
              if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
              if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
              return `${Math.floor(secs / 86400)}d ago`
            }

            const stageColor = (name) => {
              const n = name.replace(/[\u{1F534}\u{1F535}\u{1F7E0}\u{1F7E1}\u{1F7E2}\u{1F7E3}]/gu, '').trim().toLowerCase()
              if (/closed|ascend|won/.test(n)) return 'bg-success/15 text-success'
              if (/no.show/.test(n)) return 'bg-danger/15 text-danger'
              if (/set.call|proposal|24.hour/.test(n)) return 'bg-cyan-400/15 text-cyan-400'
              if (/triage|auto.booked/.test(n)) return 'bg-purple-400/15 text-purple-400'
              if (/contact/.test(n)) return 'bg-opt-yellow/15 text-opt-yellow'
              if (/follow.up|nurture/.test(n)) return 'bg-orange-400/15 text-orange-400'
              if (/not.interested|unqualified|dead|not.responsive/.test(n)) return 'bg-text-400/15 text-text-400'
              if (/new.lead/.test(n)) return 'bg-blue-400/15 text-blue-400'
              return 'bg-text-400/15 text-text-400'
            }

            return (
              <>
                <h2 className="text-sm font-medium text-text-secondary mb-4">
                  Pipeline Leads — Live from GHL ({ghlLeads.length})
                  {loadingPipeline && <span className="text-[10px] text-text-400 ml-2">loading... {pipelineProgress}</span>}
                </h2>
                <div className="tile tile-feedback overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                          <th className="px-3 py-2 text-left">Lead</th>
                          <th className="px-3 py-2 text-left">Company</th>
                          <th className="px-3 py-2 text-left">Source</th>
                          <th className="px-3 py-2 text-left">Stage</th>
                          <th className="px-3 py-2 text-left">Pipeline</th>
                          <th className="px-3 py-2 text-left">Created</th>
                          <th className="px-3 py-2 text-right">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ghlLeads.slice(0, showAllLeads ? 50 : 10).map(opp => (
                          <tr key={opp.id} className="border-b border-border-default/30 hover:bg-bg-card-hover/50">
                            <td className="px-3 py-1.5 font-medium">{opp.contact?.name || opp.name || '—'}</td>
                            <td className="px-3 py-1.5 text-text-400 truncate max-w-[140px]">{opp.contact?.companyName || '—'}</td>
                            <td className="px-3 py-1.5 text-text-400">{opp.source || '—'}</td>
                            <td className="px-3 py-1.5">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${stageColor(opp.stageName)}`}>
                                {opp.stageName.replace(/[\u{1F534}\u{1F535}\u{1F7E0}\u{1F7E1}\u{1F7E2}\u{1F7E3}]/gu, '').trim()}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-text-400 text-[10px]">{opp.pipelineName}</td>
                            <td className="px-3 py-1.5 text-text-400" title={opp.createdAt}>{timeAgo(opp.createdAt)}</td>
                            <td className="px-3 py-1.5 text-right">
                              {(opp.monetaryValue || 0) > 0 ? (
                                <span className="text-success">${opp.monetaryValue.toLocaleString()}</span>
                              ) : '—'}
                            </td>
                          </tr>
                        ))}
                        {ghlLeads.length === 0 && !loadingPipeline && (
                          <tr><td colSpan={7} className="px-3 py-8 text-center text-text-400">No leads found</td></tr>
                        )}
                        {loadingPipeline && ghlLeads.length === 0 && (
                          <tr><td colSpan={7} className="px-3 py-8 text-center text-text-400">
                            <Loader size={14} className="animate-spin inline mr-2" />Loading pipeline data...
                          </td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {ghlLeads.length > 10 && (
                    <button
                      onClick={() => setShowAllLeads(v => !v)}
                      className="w-full py-3 text-xs font-medium text-opt-yellow hover:bg-bg-card-hover transition-colors flex items-center justify-center gap-1.5 border-t border-border-default"
                    >
                      {showAllLeads ? <><ChevronUp size={14} /> Show less</> : <><ChevronDown size={14} /> Show all {Math.min(ghlLeads.length, 50)} leads</>}
                    </button>
                  )}
                </div>
              </>
            )
          })()}
        </section>

      </div>
    </div>
  )
}
