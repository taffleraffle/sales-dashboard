import { useParams, Link } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { ArrowLeft, Loader, TrendingUp, Target, CheckCircle, Clock } from 'lucide-react'
import DateRangeSelector from '../components/DateRangeSelector'
import { supabase } from '../lib/supabase'
import { sinceDate, rangeToDays } from '../lib/dateUtils'
import { fetchAllPipelineSummaries, computeSpeedToLead, buildSetterSchedules } from '../services/ghlPipeline'
import { fetchWavvCallsForSTL } from '../services/wavvService'

const KPI_DEFAULTS = { leads_day: 70, sets_day: 3, stl_pct: 80 }

function toETDateStr(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Get day of week from a YYYY-MM-DD string treated as a calendar date (no timezone shift)
function getDayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay() // 0=Sun, 6=Sat
}

function isWeekdayDate(dateStr) {
  const day = getDayOfWeek(dateStr)
  return day !== 0 && day !== 6
}

function getAllWeekdays(fromStr, toStr) {
  const result = []
  // Parse as calendar dates (no timezone shift)
  const [fy, fm, fd] = fromStr.split('-').map(Number)
  const [ty, tm, td] = toStr.split('-').map(Number)
  const d = new Date(ty, tm - 1, td)
  const end = new Date(fy, fm - 1, fd)
  while (d >= end) {
    const day = d.getDay()
    if (day !== 0 && day !== 6) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      result.push(dateStr)
    }
    d.setDate(d.getDate() - 1)
  }
  return result
}

export default function SetterKPIHistory() {
  const { id } = useParams()
  const [range, setRange] = useState(30)
  const [member, setMember] = useState(null)
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [stl, setStl] = useState(null)
  const [stlLoading, setStlLoading] = useState(true)

  const kpiTargets = (() => {
    try { return { ...KPI_DEFAULTS, ...JSON.parse(localStorage.getItem('setter_kpi_targets')) } }
    catch { return KPI_DEFAULTS }
  })()

  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [{ data: m }, { data: eods }] = await Promise.all([
        supabase.from('team_members').select('*').eq('id', id).single(),
        supabase.from('setter_eod_reports')
          .select('*')
          .eq('setter_id', id)
          .gte('report_date', sinceDate(range))
          .order('report_date', { ascending: false }),
      ])
      setMember(m)
      setReports(eods || [])
      setLoading(false)
    }
    load()
  }, [id, range])

  // Fetch STL data
  useEffect(() => {
    if (!member) return
    setStlLoading(true)
    setStl(null)
    ;(async () => {
      try {
        const pipelines = await fetchAllPipelineSummaries()
        const allOpps = (pipelines || []).flatMap(p => p.opportunities || [])
        const cutoff = new Date(Date.now() - days * 86400000).getTime()
        const opps = allOpps.filter(o => o.createdAt && new Date(o.createdAt).getTime() >= cutoff)
        if (!opps.length) { setStlLoading(false); return }

        const hasSchedule = member.stl_start_hour != null && member.stl_end_hour != null
        const schedules = hasSchedule && member.wavv_user_id
          ? { [member.wavv_user_id]: { startHour: member.stl_start_hour, endHour: member.stl_end_hour } }
          : buildSetterSchedules([member])

        const calls = await fetchWavvCallsForSTL(days)
        const result = computeSpeedToLead(opps, calls || [], [], schedules)

        // Filter to this setter's calls
        const myOpps = member.wavv_user_id
          ? opps.filter(o => {
              const matched = (calls || []).find(c => c.phone_number?.replace(/\D/g, '').slice(-10) === o.phone?.replace(/\D/g, '').slice(-10))
              return matched && matched.user_id === member.wavv_user_id
            })
          : opps
        const myCalls = member.wavv_user_id
          ? (calls || []).filter(c => c.user_id === member.wavv_user_id)
          : calls || []

        setStl(myCalls.length > 0 ? computeSpeedToLead(myOpps, myCalls, [], schedules) : result)
      } catch (e) {
        console.warn('STL fetch failed:', e)
      }
      setStlLoading(false)
    })()
  }, [member, days])

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader className="animate-spin text-opt-yellow" size={24} />
    </div>
  )

  // Build index of EOD reports by date
  const eodByDate = {}
  for (const r of reports) eodByDate[r.report_date] = r

  // Generate all weekdays in range, including days without EODs
  const today = toETDateStr(new Date())
  const fromDate = sinceDate(range)
  const toDate = typeof range === 'object' && range.to ? range.to : today
  const allWeekdays = getAllWeekdays(fromDate, toDate)

  // Build daily rows for every weekday
  const rows = allWeekdays.map(date => {
    const r = eodByDate[date]
    const hasEOD = !!r
    const leads = r?.total_leads || 0
    const sets = r?.sets || 0
    const dials = r?.outbound_calls || 0
    const pickups = r?.pickups || 0
    const mcs = r?.meaningful_conversations || 0

    const leadsPct = kpiTargets.leads_day > 0 ? Math.min((leads / kpiTargets.leads_day) * 100, 100) : 0
    const setsPct = kpiTargets.sets_day > 0 ? Math.min((sets / kpiTargets.sets_day) * 100, 100) : 0

    const leadsHit = hasEOD && leads >= kpiTargets.leads_day
    const setsHit = hasEOD && sets >= kpiTargets.sets_day
    const kpisHit = (leadsHit ? 1 : 0) + (setsHit ? 1 : 0)

    return { date, leads, sets, dials, pickups, mcs, leadsPct, setsPct, leadsHit, setsHit, kpisHit, hasEOD, selfRating: r?.self_rating }
  })

  const reportedRows = rows.filter(r => r.hasEOD)
  const totalDays = reportedRows.length
  const allHitDays = reportedRows.filter(r => r.kpisHit === 2).length
  const hitPct = totalDays > 0 ? ((allHitDays / totalDays) * 100).toFixed(0) : 0

  const totalLeads = reportedRows.reduce((s, r) => s + r.leads, 0)
  const totalSets = reportedRows.reduce((s, r) => s + r.sets, 0)
  const totalDials = reportedRows.reduce((s, r) => s + r.dials, 0)
  const totalPickups = reportedRows.reduce((s, r) => s + r.pickups, 0)
  const totalMCs = reportedRows.reduce((s, r) => s + r.mcs, 0)

  const avgLeads = totalDays > 0 ? (totalLeads / totalDays).toFixed(1) : 0
  const avgSets = totalDays > 0 ? (totalSets / totalDays).toFixed(1) : 0
  const avgDials = totalDays > 0 ? (totalDials / totalDays).toFixed(0) : 0
  const avgPickups = totalDays > 0 ? (totalPickups / totalDays).toFixed(0) : 0
  const avgMCs = totalDays > 0 ? (totalMCs / totalDays).toFixed(0) : 0

  // STL target
  const stlPct = stl ? stl.pctUnder5m : null
  const stlHit = stlPct != null && stlPct >= kpiTargets.stl_pct

  const cellColor = (hit, pct) => hit ? 'text-success' : pct >= 70 ? 'text-opt-yellow' : 'text-danger'
  const barColor = (hit, pct) => hit ? 'bg-success' : pct >= 70 ? 'bg-opt-yellow' : 'bg-danger'
  const hitBadge = n => {
    const total = stlPct != null ? 3 : 2
    return n === total ? 'bg-success/20 text-success' : n >= total - 1 ? 'bg-opt-yellow/20 text-opt-yellow' : 'bg-danger/20 text-danger'
  }
  const kpiTotal = stlPct != null ? 3 : 2

  const fmtDate = d => {
    const [y, m, day] = d.split('-').map(Number)
    const dt = new Date(y, m - 1, day)
    return dt.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <Link to={`/sales/setters/${id}`} className="text-text-400 hover:text-opt-yellow transition-colors">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-lg sm:text-xl font-bold">{member?.name || 'Setter'}</h1>
            <p className="text-xs text-text-400">KPI & Target History <span className="text-text-400/60">(Mon–Fri only)</span></p>
          </div>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <div className="tile tile-feedback p-4">
          <p className="text-[10px] text-text-400 uppercase mb-1">Weekdays Reported</p>
          <p className="text-xl font-bold">{totalDays} <span className="text-sm text-text-400">/ {allWeekdays.length}</span></p>
        </div>
        <div className="tile tile-feedback p-4">
          <p className="text-[10px] text-text-400 uppercase mb-1">All Targets Hit</p>
          <p className={`text-xl font-bold ${allHitDays > 0 ? 'text-success' : 'text-danger'}`}>{allHitDays} <span className="text-sm text-text-400">/ {totalDays}</span></p>
        </div>
        <div className="tile tile-feedback p-4">
          <p className="text-[10px] text-text-400 uppercase mb-1">Avg Leads/Day</p>
          <p className={`text-xl font-bold ${parseFloat(avgLeads) >= kpiTargets.leads_day ? 'text-success' : 'text-danger'}`}>{avgLeads}</p>
          <p className="text-[9px] text-text-400">Target: {kpiTargets.leads_day}</p>
        </div>
        <div className="tile tile-feedback p-4">
          <p className="text-[10px] text-text-400 uppercase mb-1">Avg Sets/Day</p>
          <p className={`text-xl font-bold ${parseFloat(avgSets) >= kpiTargets.sets_day ? 'text-success' : 'text-danger'}`}>{avgSets}</p>
          <p className="text-[9px] text-text-400">Target: {kpiTargets.sets_day}</p>
        </div>
        <div className="tile tile-feedback p-4">
          <p className="text-[10px] text-text-400 uppercase mb-1 flex items-center gap-1"><Clock size={10} /> STL &lt; 5min</p>
          {stlLoading ? (
            <p className="text-xl font-bold text-text-400">...</p>
          ) : stlPct != null ? (
            <>
              <p className={`text-xl font-bold ${stlHit ? 'text-success' : 'text-danger'}`}>{Math.round(stlPct)}%</p>
              <p className="text-[9px] text-text-400">Target: {kpiTargets.stl_pct}% · {stl.under5m}/{stl.worked} leads · Avg: {stl.avgDisplay}</p>
            </>
          ) : (
            <p className="text-xl font-bold text-text-400">—</p>
          )}
        </div>
        <div className="tile tile-feedback p-4">
          <p className="text-[10px] text-text-400 uppercase mb-1">Avg Dials / PU / MC</p>
          <p className="text-lg font-bold">{avgDials} <span className="text-text-400 text-sm font-normal">/ {avgPickups} / {avgMCs}</span></p>
        </div>
      </div>

      {/* Hit rate bar */}
      <div className="tile tile-feedback p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-opt-yellow uppercase font-medium flex items-center gap-1.5">
            <Target size={12} /> Target Hit Rate
          </span>
          <span className="text-sm font-bold">{hitPct}%</span>
        </div>
        <div className="h-3 bg-bg-primary rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${parseInt(hitPct) >= 70 ? 'bg-success' : parseInt(hitPct) >= 40 ? 'bg-opt-yellow' : 'bg-danger'}`} style={{ width: `${hitPct}%` }} />
        </div>
        <p className="text-[9px] text-text-400 mt-1">{allHitDays} of {totalDays} weekdays with all KPI targets met (Leads ≥ {kpiTargets.leads_day}, Sets ≥ {kpiTargets.sets_day})</p>
      </div>

      {/* Daily table */}
      <div className="tile tile-feedback overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default">
          <h3 className="text-[11px] text-opt-yellow uppercase font-medium flex items-center gap-1.5">
            <TrendingUp size={12} /> Daily Breakdown <span className="text-text-400 font-normal normal-case">(Mon–Fri)</span>
          </h3>
        </div>

        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-text-400 text-sm">No weekday EOD reports found for this period.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-text-400 uppercase border-b border-border-default">
                  <th className="text-left px-4 py-2.5 font-medium">Date</th>
                  <th className="text-right px-3 py-2.5 font-medium">Leads</th>
                  <th className="px-3 py-2.5 font-medium w-24"></th>
                  <th className="text-right px-3 py-2.5 font-medium">Sets</th>
                  <th className="px-3 py-2.5 font-medium w-24"></th>
                  <th className="text-right px-3 py-2.5 font-medium">Dials</th>
                  <th className="text-right px-3 py-2.5 font-medium">Pickups</th>
                  <th className="text-right px-3 py-2.5 font-medium">MCs</th>
                  <th className="text-center px-3 py-2.5 font-medium">Hit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.date} className={`border-b border-border-default/50 ${!r.hasEOD ? 'opacity-40' : ''} ${i % 2 === 0 ? '' : 'bg-bg-primary/30'} hover:bg-bg-card-hover transition-colors`}>
                    <td className="px-4 py-2.5 text-text-primary font-medium whitespace-nowrap">
                      {fmtDate(r.date)}
                      {!r.hasEOD && <span className="text-[9px] text-danger/70 ml-1.5">No EOD</span>}
                    </td>
                    {r.hasEOD ? (<>
                      <td className={`text-right px-3 py-2.5 font-semibold ${cellColor(r.leadsHit, r.leadsPct)}`}>
                        {r.leads} <span className="text-text-400 font-normal text-[10px]">/ {kpiTargets.leads_day}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="h-1.5 bg-bg-primary rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${barColor(r.leadsHit, r.leadsPct)} transition-all`} style={{ width: `${r.leadsPct}%` }} />
                        </div>
                      </td>
                      <td className={`text-right px-3 py-2.5 font-semibold ${cellColor(r.setsHit, r.setsPct)}`}>
                        {r.sets} <span className="text-text-400 font-normal text-[10px]">/ {kpiTargets.sets_day}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="h-1.5 bg-bg-primary rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${barColor(r.setsHit, r.setsPct)} transition-all`} style={{ width: `${r.setsPct}%` }} />
                        </div>
                      </td>
                      <td className="text-right px-3 py-2.5 text-text-primary">{r.dials}</td>
                      <td className="text-right px-3 py-2.5 text-text-primary">{r.pickups}</td>
                      <td className="text-right px-3 py-2.5 text-text-primary">{r.mcs}</td>
                      <td className="text-center px-3 py-2.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${hitBadge(r.kpisHit)}`}>
                          {r.kpisHit === kpiTotal && <CheckCircle size={10} />}
                          {r.kpisHit}/{kpiTotal}
                        </span>
                      </td>
                    </>) : (
                      <td colSpan={7} className="px-3 py-2.5 text-center text-text-400/50 text-[10px]">—</td>
                    )}
                  </tr>
                ))}
              </tbody>
              {/* Averages footer */}
              <tfoot>
                <tr className="border-t-2 border-border-default bg-bg-primary/50 font-semibold text-text-primary">
                  <td className="px-4 py-2.5 text-[10px] uppercase text-opt-yellow">Avg / Day</td>
                  <td className={`text-right px-3 py-2.5 ${parseFloat(avgLeads) >= kpiTargets.leads_day ? 'text-success' : 'text-danger'}`}>
                    {avgLeads} <span className="text-text-400 font-normal text-[10px]">/ {kpiTargets.leads_day}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="h-1.5 bg-bg-primary rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${parseFloat(avgLeads) >= kpiTargets.leads_day ? 'bg-success' : 'bg-danger'} transition-all`} style={{ width: `${Math.min((parseFloat(avgLeads) / kpiTargets.leads_day) * 100, 100)}%` }} />
                    </div>
                  </td>
                  <td className={`text-right px-3 py-2.5 ${parseFloat(avgSets) >= kpiTargets.sets_day ? 'text-success' : 'text-danger'}`}>
                    {avgSets} <span className="text-text-400 font-normal text-[10px]">/ {kpiTargets.sets_day}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="h-1.5 bg-bg-primary rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${parseFloat(avgSets) >= kpiTargets.sets_day ? 'bg-success' : 'bg-danger'} transition-all`} style={{ width: `${Math.min((parseFloat(avgSets) / kpiTargets.sets_day) * 100, 100)}%` }} />
                    </div>
                  </td>
                  <td className="text-right px-3 py-2.5">{avgDials}</td>
                  <td className="text-right px-3 py-2.5">{avgPickups}</td>
                  <td className="text-right px-3 py-2.5">{avgMCs}</td>
                  <td className="text-center px-3 py-2.5">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${parseInt(hitPct) >= 70 ? 'bg-success/20 text-success' : parseInt(hitPct) >= 40 ? 'bg-opt-yellow/20 text-opt-yellow' : 'bg-danger/20 text-danger'}`}>
                      {hitPct}%
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
