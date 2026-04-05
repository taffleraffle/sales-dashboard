import { useParams, Link } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { ArrowLeft, Loader, TrendingUp, Target, CheckCircle } from 'lucide-react'
import DateRangeSelector from '../components/DateRangeSelector'
import { supabase } from '../lib/supabase'
import { sinceDate } from '../lib/dateUtils'

const KPI_DEFAULTS = { leads_day: 70, sets_day: 3, stl_pct: 80 }

export default function SetterKPIHistory() {
  const { id } = useParams()
  const [range, setRange] = useState(30)
  const [member, setMember] = useState(null)
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)

  const kpiTargets = (() => {
    try { return { ...KPI_DEFAULTS, ...JSON.parse(localStorage.getItem('setter_kpi_targets')) } }
    catch { return KPI_DEFAULTS }
  })()

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

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader className="animate-spin text-opt-yellow" size={24} />
    </div>
  )

  // Build daily rows
  const rows = reports.map(r => {
    const leads = r.total_leads || 0
    const sets = r.sets || 0
    const dials = r.outbound_calls || 0
    const pickups = r.pickups || 0
    const mcs = r.meaningful_conversations || 0

    const leadsPct = kpiTargets.leads_day > 0 ? Math.min((leads / kpiTargets.leads_day) * 100, 100) : 0
    const setsPct = kpiTargets.sets_day > 0 ? Math.min((sets / kpiTargets.sets_day) * 100, 100) : 0

    const leadsHit = leads >= kpiTargets.leads_day
    const setsHit = sets >= kpiTargets.sets_day
    const kpisHit = (leadsHit ? 1 : 0) + (setsHit ? 1 : 0)

    return { date: r.report_date, leads, sets, dials, pickups, mcs, leadsPct, setsPct, leadsHit, setsHit, kpisHit, selfRating: r.self_rating }
  })

  const totalDays = rows.length
  const allHitDays = rows.filter(r => r.kpisHit === 2).length
  const hitPct = totalDays > 0 ? ((allHitDays / totalDays) * 100).toFixed(0) : 0

  const avgLeads = totalDays > 0 ? (rows.reduce((s, r) => s + r.leads, 0) / totalDays).toFixed(1) : 0
  const avgSets = totalDays > 0 ? (rows.reduce((s, r) => s + r.sets, 0) / totalDays).toFixed(1) : 0

  const cellColor = (hit, pct) => hit ? 'text-success' : pct >= 70 ? 'text-opt-yellow' : 'text-danger'
  const barColor = (hit, pct) => hit ? 'bg-success' : pct >= 70 ? 'bg-opt-yellow' : 'bg-danger'
  const hitBadge = n => n === 2 ? 'bg-success/20 text-success' : n === 1 ? 'bg-opt-yellow/20 text-opt-yellow' : 'bg-danger/20 text-danger'

  const fmtDate = d => {
    const dt = new Date(d + 'T00:00:00')
    return dt.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' })
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
            <p className="text-xs text-text-400">KPI & Target History</p>
          </div>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="bg-bg-card border border-border-default rounded-2xl p-4">
          <p className="text-[10px] text-text-400 uppercase mb-1">Days Reported</p>
          <p className="text-xl font-bold">{totalDays}</p>
        </div>
        <div className="bg-bg-card border border-border-default rounded-2xl p-4">
          <p className="text-[10px] text-text-400 uppercase mb-1">All Targets Hit</p>
          <p className="text-xl font-bold text-success">{allHitDays} <span className="text-sm text-text-400">/ {totalDays}</span></p>
        </div>
        <div className="bg-bg-card border border-border-default rounded-2xl p-4">
          <p className="text-[10px] text-text-400 uppercase mb-1">Avg Leads/Day</p>
          <p className={`text-xl font-bold ${parseFloat(avgLeads) >= kpiTargets.leads_day ? 'text-success' : 'text-danger'}`}>{avgLeads}</p>
          <p className="text-[9px] text-text-400">Target: {kpiTargets.leads_day}</p>
        </div>
        <div className="bg-bg-card border border-border-default rounded-2xl p-4">
          <p className="text-[10px] text-text-400 uppercase mb-1">Avg Sets/Day</p>
          <p className={`text-xl font-bold ${parseFloat(avgSets) >= kpiTargets.sets_day ? 'text-success' : 'text-danger'}`}>{avgSets}</p>
          <p className="text-[9px] text-text-400">Target: {kpiTargets.sets_day}</p>
        </div>
      </div>

      {/* Hit rate bar */}
      <div className="bg-bg-card border border-border-default rounded-2xl p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-opt-yellow uppercase font-medium flex items-center gap-1.5">
            <Target size={12} /> Target Hit Rate
          </span>
          <span className="text-sm font-bold">{hitPct}%</span>
        </div>
        <div className="h-3 bg-bg-primary rounded-full overflow-hidden">
          <div className="h-full bg-success rounded-full transition-all" style={{ width: `${hitPct}%` }} />
        </div>
        <p className="text-[9px] text-text-400 mt-1">{allHitDays} of {totalDays} days with all KPI targets met</p>
      </div>

      {/* Daily table */}
      <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default">
          <h3 className="text-[11px] text-opt-yellow uppercase font-medium flex items-center gap-1.5">
            <TrendingUp size={12} /> Daily Breakdown
          </h3>
        </div>

        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-text-400 text-sm">No EOD reports found for this period.</div>
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
                  <tr key={r.date} className={`border-b border-border-default/50 ${i % 2 === 0 ? '' : 'bg-bg-primary/30'} hover:bg-bg-card-hover transition-colors`}>
                    <td className="px-4 py-2.5 text-text-primary font-medium whitespace-nowrap">{fmtDate(r.date)}</td>
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
                        {r.kpisHit === 2 && <CheckCircle size={10} />}
                        {r.kpisHit}/2
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
