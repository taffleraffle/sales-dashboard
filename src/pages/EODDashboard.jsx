import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Plus, Calendar } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { todayET, toLocalDateStr } from '../lib/dateUtils'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useAuth } from '../contexts/AuthContext'
import { ICON } from '../utils/constants'

/**
 * EOD Dashboard — the new default landing at /sales/eod.
 *
 * Two tables (Closers | Setters) listing each team member's submission for the
 * selected date. Submitted rows show the key numbers and open the form page
 * when clicked. Pending rows (no submission yet) show a "+ File" button that
 * jumps straight into the form pre-configured for that member + date.
 *
 * The existing EODReview form lives at /sales/eod/submit and handles the
 * actual create/edit interaction — this page just directs traffic to it.
 */
export default function EODDashboard() {
  const navigate = useNavigate()
  const { profile, isAdmin } = useAuth()

  const [selectedDate, setSelectedDate] = useState(todayET())
  const [initialLoad, setInitialLoad] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [closerReports, setCloserReports] = useState([])
  const [setterReports, setSetterReports] = useState([])

  const { members: closers, loading: loadingClosers } = useTeamMembers('closer')
  const { members: setters, loading: loadingSetters } = useTeamMembers('setter')

  useEffect(() => {
    async function load() {
      // First load shows a skeleton; subsequent date changes dim the existing
      // table instead of collapsing the layout into placeholder tiles.
      setRefreshing(true)
      try {
        const [cRes, sRes] = await Promise.all([
          supabase
            .from('closer_eod_reports')
            .select('id, closer_id, report_date, nc_booked, fu_booked, live_nc_calls, live_fu_calls, nc_no_shows, fu_no_shows, offers, closes, total_cash_collected, total_revenue, updated_at, is_confirmed')
            .eq('report_date', selectedDate),
          supabase
            .from('setter_eod_reports')
            .select('id, setter_id, report_date, outbound_calls, pickups, meaningful_conversations, sets, self_rating, updated_at, is_confirmed')
            .eq('report_date', selectedDate),
        ])
        if (cRes.error) console.error('EOD closer reports fetch error:', cRes.error)
        if (sRes.error) console.error('EOD setter reports fetch error:', sRes.error)
        setCloserReports(cRes.data || [])
        setSetterReports(sRes.data || [])
      } catch (err) {
        console.error('EOD dashboard load failed:', err)
      } finally {
        setRefreshing(false)
        setInitialLoad(false)
      }
    }
    load()
  }, [selectedDate])

  // Build lookup: member_id → report. Only count confirmed reports as "submitted"
  // (is_confirmed = true). Drafts stay as pending.
  const closerByMember = useMemo(() => {
    const m = {}
    for (const r of closerReports) if (r.is_confirmed === true) m[r.closer_id] = r
    return m
  }, [closerReports])

  const setterByMember = useMemo(() => {
    const m = {}
    for (const r of setterReports) if (r.is_confirmed === true) m[r.setter_id] = r
    return m
  }, [setterReports])

  const closerRows = useMemo(() => closers.map(c => ({ member: c, report: closerByMember[c.id] || null })), [closers, closerByMember])
  const setterRows = useMemo(() => setters.map(s => ({ member: s, report: setterByMember[s.id] || null })), [setters, setterByMember])

  const submittedClosers = closerRows.filter(r => r.report).length
  const submittedSetters = setterRows.filter(r => r.report).length

  const shiftDate = (days) => {
    const d = new Date(selectedDate + 'T12:00:00')
    d.setDate(d.getDate() + days)
    setSelectedDate(toLocalDateStr(d))
  }

  const openReport = (tab, memberId) => {
    navigate(`/sales/eod/submit?tab=${tab}&member=${memberId}&date=${selectedDate}`)
  }

  const openNewEOD = () => {
    const myRole = profile?.role === 'setter' ? 'setter' : 'closer'
    const params = new URLSearchParams({ tab: myRole, date: selectedDate })
    if (profile?.teamMemberId) params.set('member', profile.teamMemberId)
    navigate(`/sales/eod/submit?${params.toString()}`)
  }

  const showSkeleton = initialLoad && (loadingClosers || loadingSetters || refreshing)

  const formatDateLabel = (d) => {
    if (d === todayET()) return 'Today'
    const dt = new Date(d + 'T12:00:00')
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">End of Day Reports</h1>
          <p className="text-xs text-text-400 mt-0.5">{formatDateLabel(selectedDate)}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-bg-card border border-border-default rounded-xl px-2 py-1 min-h-[40px]">
            <button
              onClick={() => shiftDate(-1)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-text-400 hover:text-opt-yellow hover:bg-bg-card-hover transition-colors"
              aria-label="Previous day"
            >
              <ChevronRight size={ICON.sm} className="rotate-180" />
            </button>
            <div className="flex items-center gap-1.5 px-2">
              <Calendar size={ICON.sm} className="text-text-400" />
              <input
                type="date"
                value={selectedDate}
                max={todayET()}
                onChange={e => setSelectedDate(e.target.value)}
                className="bg-transparent text-sm text-text-primary outline-none"
              />
            </div>
            <button
              onClick={() => shiftDate(1)}
              disabled={selectedDate >= todayET()}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-text-400 hover:text-opt-yellow hover:bg-bg-card-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Next day"
            >
              <ChevronRight size={ICON.sm} />
            </button>
          </div>
          <button
            onClick={openNewEOD}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-opt-yellow text-bg-primary hover:brightness-110 min-h-[40px]"
          >
            <Plus size={ICON.md} /> New EOD
          </button>
        </div>
      </div>

      {showSkeleton ? (
        <div className="space-y-4 animate-pulse">
          <div className="tile tile-feedback h-64" />
          <div className="tile tile-feedback h-64" />
        </div>
      ) : (
        <div className={`space-y-6 transition-opacity duration-150 ${refreshing ? 'opacity-60 pointer-events-none' : 'opacity-100'}`}>
          {/* Closer Reports */}
          <div className="tile tile-feedback overflow-hidden">
            <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
              <h2 className="text-sm font-semibold">Closer Reports</h2>
              <span className="text-xs text-text-400 tabular-nums">
                {submittedClosers} submitted · {closerRows.length - submittedClosers} pending
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                    <th className="px-4 py-2 text-left">Closer</th>
                    <th className="px-4 py-2 text-right">Booked</th>
                    <th className="px-4 py-2 text-right">Live</th>
                    <th className="px-4 py-2 text-right">No Shows</th>
                    <th className="px-4 py-2 text-right">Offers</th>
                    <th className="px-4 py-2 text-right">Closes</th>
                    <th className="px-4 py-2 text-right">Cash</th>
                    <th className="px-4 py-2 text-right">Revenue</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {closerRows.length === 0 && (
                    <tr><td colSpan={9} className="px-4 py-8 text-center text-text-400">No closers in the team yet.</td></tr>
                  )}
                  {closerRows.map(({ member, report }) => (
                    <CloserReportRow
                      key={member.id}
                      member={member}
                      report={report}
                      isMe={profile?.teamMemberId === member.id}
                      canFile={isAdmin || profile?.teamMemberId === member.id}
                      onOpen={() => openReport('closer', member.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Setter Reports */}
          <div className="tile tile-feedback overflow-hidden">
            <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
              <h2 className="text-sm font-semibold">Setter Reports</h2>
              <span className="text-xs text-text-400 tabular-nums">
                {submittedSetters} submitted · {setterRows.length - submittedSetters} pending
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                    <th className="px-4 py-2 text-left">Setter</th>
                    <th className="px-4 py-2 text-right">Dials</th>
                    <th className="px-4 py-2 text-right">Pickups</th>
                    <th className="px-4 py-2 text-right">MCs</th>
                    <th className="px-4 py-2 text-right">Sets</th>
                    <th className="px-4 py-2 text-right">Self-rating</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {setterRows.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-text-400">No setters in the team yet.</td></tr>
                  )}
                  {setterRows.map(({ member, report }) => (
                    <SetterReportRow
                      key={member.id}
                      member={member}
                      report={report}
                      isMe={profile?.teamMemberId === member.id}
                      canFile={isAdmin || profile?.teamMemberId === member.id}
                      onOpen={() => openReport('setter', member.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CloserReportRow({ member, report, isMe, canFile, onOpen }) {
  const submitted = !!report
  if (submitted) {
    const booked = (report.nc_booked || 0) + (report.fu_booked || 0)
    const live = (report.live_nc_calls || 0) + (report.live_fu_calls || 0)
    const noShows = (report.nc_no_shows || 0) + (report.fu_no_shows || 0)
    return (
      <tr
        onClick={onOpen}
        className="border-b border-border-default/30 hover:bg-bg-card-hover cursor-pointer transition-colors"
      >
        <td className="px-4 py-2.5 font-medium text-opt-yellow">
          {member.name}
          {isMe && <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded bg-opt-yellow/15 text-opt-yellow">YOU</span>}
        </td>
        <td className="px-4 py-2.5 text-right tabular-nums">{booked}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">{live}</td>
        <td className="px-4 py-2.5 text-right tabular-nums text-danger">{noShows}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">{report.offers || 0}</td>
        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-success">{report.closes || 0}</td>
        <td className="px-4 py-2.5 text-right tabular-nums text-opt-yellow">${parseFloat(report.total_cash_collected || 0).toLocaleString()}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">${parseFloat(report.total_revenue || 0).toLocaleString()}</td>
        <td className="px-3"><ChevronRight size={ICON.md} className="text-text-400" /></td>
      </tr>
    )
  }
  return (
    <tr className="border-b border-border-default/30 opacity-60 hover:opacity-100 transition-opacity">
      <td className="px-4 py-2.5 font-medium text-text-secondary">
        {member.name}
        {isMe && <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded bg-opt-yellow/15 text-opt-yellow">YOU</span>}
      </td>
      <td colSpan={7} className="px-4 py-2.5 text-center text-[11px] text-text-400 italic">Not submitted</td>
      <td className="px-3">
        {canFile && (
          <button
            onClick={onOpen}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-opt-yellow/10 border border-opt-yellow/30 text-opt-yellow hover:bg-opt-yellow/20 transition-colors"
            aria-label={`File EOD for ${member.name}`}
          >
            <Plus size={ICON.xs} /> File
          </button>
        )}
      </td>
    </tr>
  )
}

function SetterReportRow({ member, report, isMe, canFile, onOpen }) {
  const submitted = !!report
  if (submitted) {
    return (
      <tr
        onClick={onOpen}
        className="border-b border-border-default/30 hover:bg-bg-card-hover cursor-pointer transition-colors"
      >
        <td className="px-4 py-2.5 font-medium text-opt-yellow">
          {member.name}
          {isMe && <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded bg-opt-yellow/15 text-opt-yellow">YOU</span>}
        </td>
        <td className="px-4 py-2.5 text-right tabular-nums">{(report.outbound_calls || 0).toLocaleString()}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">{report.pickups || 0}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">{report.meaningful_conversations || 0}</td>
        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-success">{report.sets || 0}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">
          {report.self_rating ? (
            <span className={report.self_rating >= 7 ? 'text-success' : report.self_rating >= 5 ? 'text-opt-yellow' : 'text-danger'}>
              {report.self_rating}/10
            </span>
          ) : '—'}
        </td>
        <td className="px-3"><ChevronRight size={ICON.md} className="text-text-400" /></td>
      </tr>
    )
  }
  return (
    <tr className="border-b border-border-default/30 opacity-60 hover:opacity-100 transition-opacity">
      <td className="px-4 py-2.5 font-medium text-text-secondary">
        {member.name}
        {isMe && <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded bg-opt-yellow/15 text-opt-yellow">YOU</span>}
      </td>
      <td colSpan={5} className="px-4 py-2.5 text-center text-[11px] text-text-400 italic">Not submitted</td>
      <td className="px-3">
        {canFile && (
          <button
            onClick={onOpen}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-opt-yellow/10 border border-opt-yellow/30 text-opt-yellow hover:bg-opt-yellow/20 transition-colors"
            aria-label={`File EOD for ${member.name}`}
          >
            <Plus size={ICON.xs} /> File
          </button>
        )}
      </td>
    </tr>
  )
}
