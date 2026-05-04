import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Plus, Calendar } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { todayET, toLocalDateStr } from '../lib/dateUtils'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useAuth } from '../contexts/AuthContext'
import { ICON } from '../utils/constants'

/**
 * EOD Dashboard — the default landing at /sales/eod.
 *
 * A single unified team table with a Role pill column so the whole team
 * (closers + setters) is visible at once. Each row shows inline role-
 * specific highlights (booked/live/closes/cash for closers, dials/sets
 * for setters) so you can scan both groups without juggling two tables.
 *
 * Clicking a submitted row opens the existing EODReview form in view/edit
 * mode; pending rows show a "+ File" button that jumps into the form in
 * create mode. Only submitted reports (is_confirmed=true) count as
 * "submitted" — drafts stay as pending.
 */
export default function EODDashboard() {
  const navigate = useNavigate()
  const { profile, isAdmin } = useAuth()

  const [selectedDate, setSelectedDate] = useState(todayET())
  const [initialLoad, setInitialLoad] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [closerReports, setCloserReports] = useState([])
  const [setterReports, setSetterReports] = useState([])
  // Per-closer attention state for the selected date.
  // { [closerId]: { pendingOutcomes: number, newCalls: number } }
  const [closerAttention, setCloserAttention] = useState({})
  const [roleFilter, setRoleFilter] = useState('all') // 'all' | 'closer' | 'setter' | 'pending' | 'attention'

  const { members: closers, loading: loadingClosers } = useTeamMembers('closer')
  const { members: setters, loading: loadingSetters } = useTeamMembers('setter')

  useEffect(() => {
    async function load() {
      setRefreshing(true)
      try {
        // Pull all three sources for the date in parallel:
        //   - closer & setter EOD reports (existing)
        //   - closer_calls for any submitted closer EODs (so we can count
        //     rows still missing an outcome)
        //   - ghl_appointments for the date (so we can flag new bookings
        //     that landed on the calendar after the EOD was submitted)
        const [cRes, sRes, apptsRes] = await Promise.all([
          supabase
            .from('closer_eod_reports')
            .select('id, closer_id, report_date, nc_booked, fu_booked, live_nc_calls, live_fu_calls, nc_no_shows, fu_no_shows, offers, closes, total_cash_collected, total_revenue, updated_at, is_confirmed')
            .eq('report_date', selectedDate),
          supabase
            .from('setter_eod_reports')
            .select('id, setter_id, report_date, outbound_calls, pickups, meaningful_conversations, sets, self_rating, updated_at, is_confirmed')
            .eq('report_date', selectedDate),
          supabase
            .from('ghl_appointments')
            .select('ghl_event_id, closer_id, ghl_user_id, appointment_status, calendar_name')
            .eq('appointment_date', selectedDate)
            .neq('appointment_status', 'cancelled'),
        ])
        if (cRes.error) console.error('EOD closer reports fetch error:', cRes.error)
        if (sRes.error) console.error('EOD setter reports fetch error:', sRes.error)
        if (apptsRes.error) console.error('ghl_appointments fetch error:', apptsRes.error)

        const closerRows = cRes.data || []
        setCloserReports(closerRows)
        setSetterReports(sRes.data || [])

        // Compute per-closer attention. Only meaningful for confirmed reports —
        // a draft/pending EOD already shows as "Pending" and doesn't need an
        // additional review badge.
        const confirmedReports = closerRows.filter(r => r.is_confirmed === true)
        const reportIds = confirmedReports.map(r => r.id)
        let callsByReport = {}
        if (reportIds.length > 0) {
          const { data: callRows } = await supabase
            .from('closer_calls')
            .select('eod_report_id, outcome, ghl_event_id')
            .in('eod_report_id', reportIds)
          for (const c of callRows || []) {
            const list = callsByReport[c.eod_report_id] || (callsByReport[c.eod_report_id] = [])
            list.push(c)
          }
        }

        const apptsByCloser = {}
        for (const a of apptsRes.data || []) {
          if (!a.closer_id) continue
          const list = apptsByCloser[a.closer_id] || (apptsByCloser[a.closer_id] = [])
          list.push(a)
        }

        const attention = {}
        for (const report of confirmedReports) {
          const rowCalls = callsByReport[report.id] || []
          const pendingOutcomes = rowCalls.filter(c => c.outcome == null).length
          const savedEventIds = new Set(rowCalls.map(c => c.ghl_event_id).filter(Boolean))
          const calendarForCloser = apptsByCloser[report.closer_id] || []
          const newCalls = calendarForCloser.filter(a => a.ghl_event_id && !savedEventIds.has(a.ghl_event_id)).length
          if (pendingOutcomes > 0 || newCalls > 0) {
            attention[report.closer_id] = { pendingOutcomes, newCalls }
          }
        }
        setCloserAttention(attention)
      } catch (err) {
        console.error('EOD dashboard load failed:', err)
      } finally {
        setRefreshing(false)
        setInitialLoad(false)
      }
    }
    load()
  }, [selectedDate])

  // Only confirmed reports count as submitted; drafts stay pending.
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

  // Merge both role lists into one team roster. Sorted alphabetically so the
  // whole team shows up in one place — pending first (they're what needs
  // chasing), then submitted, each group alpha-sorted by name.
  const teamRows = useMemo(() => {
    const rows = [
      ...closers.map(c => ({ member: c, role: 'closer', report: closerByMember[c.id] || null, attention: closerAttention[c.id] || null })),
      ...setters.map(s => ({ member: s, role: 'setter', report: setterByMember[s.id] || null, attention: null })),
    ]
    rows.sort((a, b) => {
      // Pending before submitted, then alpha by name.
      const aSubmitted = !!a.report, bSubmitted = !!b.report
      if (aSubmitted !== bSubmitted) return aSubmitted ? 1 : -1
      return (a.member.name || '').localeCompare(b.member.name || '')
    })
    return rows
  }, [closers, setters, closerByMember, setterByMember, closerAttention])

  const filteredRows = useMemo(() => {
    if (roleFilter === 'all') return teamRows
    if (roleFilter === 'pending') return teamRows.filter(r => !r.report)
    if (roleFilter === 'attention') return teamRows.filter(r => r.attention)
    return teamRows.filter(r => r.role === roleFilter)
  }, [teamRows, roleFilter])

  const totalAttention = teamRows.filter(r => r.attention).length

  const totalSubmitted = teamRows.filter(r => r.report).length
  const totalPending = teamRows.length - totalSubmitted
  const closerStats = {
    submitted: teamRows.filter(r => r.role === 'closer' && r.report).length,
    total: closers.length,
  }
  const setterStats = {
    submitted: teamRows.filter(r => r.role === 'setter' && r.report).length,
    total: setters.length,
  }

  const shiftDate = (days) => {
    const d = new Date(selectedDate + 'T12:00:00')
    d.setDate(d.getDate() + days)
    setSelectedDate(toLocalDateStr(d))
  }

  const openReport = (role, memberId) => {
    navigate(`/sales/eod/submit?tab=${role}&member=${memberId}&date=${selectedDate}`)
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
          <div className="tile tile-feedback h-12" />
          <div className="tile tile-feedback h-96" />
        </div>
      ) : (
        <div className={`space-y-4 transition-opacity duration-150 ${refreshing ? 'opacity-60 pointer-events-none' : 'opacity-100'}`}>

          {/* Summary + role filter pills */}
          <div className="tile tile-feedback px-4 py-3 flex flex-wrap items-center gap-3">
            <span className="text-xs text-text-400">
              <span className="font-semibold text-text-primary tabular-nums">{totalSubmitted}</span> of{' '}
              <span className="tabular-nums">{teamRows.length}</span> submitted
              {totalPending > 0 && <span className="text-danger ml-2">· {totalPending} pending</span>}
            </span>
            <div className="flex items-center gap-1 sm:ml-auto">
              <FilterPill label={`All · ${teamRows.length}`} active={roleFilter === 'all'} onClick={() => setRoleFilter('all')} />
              <FilterPill label={`Closers · ${closerStats.submitted}/${closerStats.total}`} active={roleFilter === 'closer'} onClick={() => setRoleFilter('closer')} />
              <FilterPill label={`Setters · ${setterStats.submitted}/${setterStats.total}`} active={roleFilter === 'setter'} onClick={() => setRoleFilter('setter')} />
              {totalPending > 0 && (
                <FilterPill label={`Pending · ${totalPending}`} active={roleFilter === 'pending'} onClick={() => setRoleFilter('pending')} danger />
              )}
              {totalAttention > 0 && (
                <FilterPill label={`Needs review · ${totalAttention}`} active={roleFilter === 'attention'} onClick={() => setRoleFilter('attention')} amber />
              )}
            </div>
          </div>

          {/* Unified team table */}
          <div className="tile tile-feedback overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-default text-text-400 uppercase text-[10px]">
                    <th className="px-4 py-2.5 text-left">Team Member</th>
                    <th className="px-3 py-2.5 text-left">Role</th>
                    <th className="px-4 py-2.5 text-left">Highlights</th>
                    <th className="w-28 px-4 py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-text-400">
                      {teamRows.length === 0
                        ? 'No team members yet.'
                        : roleFilter === 'pending'
                          ? 'Everyone has submitted for this date.'
                          : 'No team members match this filter.'}
                    </td></tr>
                  )}
                  {filteredRows.map(({ member, role, report, attention }) => (
                    <TeamEodRow
                      key={`${role}:${member.id}`}
                      member={member}
                      role={role}
                      report={report}
                      attention={attention}
                      isMe={profile?.teamMemberId === member.id}
                      canFile={isAdmin || profile?.teamMemberId === member.id}
                      onOpen={() => openReport(role, member.id)}
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

function FilterPill({ label, active, onClick, danger = false, amber = false }) {
  const activeCls = danger
    ? 'bg-danger/15 border-danger/40 text-danger'
    : amber
      ? 'bg-amber-400/15 border-amber-400/40 text-amber-300'
      : 'bg-opt-yellow/15 border-opt-yellow/40 text-opt-yellow'
  const inactiveCls = 'border-border-default text-text-secondary hover:bg-bg-card-hover'
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full border text-[11px] font-medium transition-colors ${active ? activeCls : inactiveCls}`}
    >
      {label}
    </button>
  )
}

function RolePill({ role }) {
  const isCloser = role === 'closer'
  const cls = isCloser
    ? 'bg-cyan-400/15 text-cyan-400 border-cyan-400/30'
    : 'bg-purple-400/15 text-purple-400 border-purple-400/30'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium uppercase tracking-wide ${cls}`}>
      {isCloser ? 'Closer' : 'Setter'}
    </span>
  )
}

/**
 * One row per team member. Renders role-specific inline highlights:
 *   Closer → Booked · Live · Closes · Cash · Revenue
 *   Setter → Dials · Pickups · Sets · Self-rating
 *
 * Pending (no confirmed report) rows are dimmed with an italic "Not
 * submitted" marker and a "+ File" button at the end.
 */
function TeamEodRow({ member, role, report, attention, isMe, canFile, onOpen }) {
  const submitted = !!report
  const cls = submitted
    ? 'border-b border-border-default/30 hover:bg-bg-card-hover cursor-pointer transition-colors'
    : 'border-b border-border-default/30 opacity-60 hover:opacity-100 transition-opacity'

  // Concise "needs review" reason text. Both halves shown when both apply, with
  // a middle-dot separator to match the OPT design system.
  const attentionLabel = attention
    ? [
        attention.pendingOutcomes > 0 && `${attention.pendingOutcomes} missing outcome${attention.pendingOutcomes === 1 ? '' : 's'}`,
        attention.newCalls > 0 && `${attention.newCalls} new on calendar`,
      ].filter(Boolean).join(' · ')
    : null

  return (
    <tr onClick={submitted ? onOpen : undefined} className={cls}>
      <td className="px-4 py-2.5 align-middle">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`font-medium ${submitted ? 'text-opt-yellow' : 'text-text-secondary'}`}>{member.name}</span>
          {isMe && <span className="text-[9px] px-1.5 py-0.5 rounded bg-opt-yellow/15 text-opt-yellow">YOU</span>}
          {attentionLabel && (
            <span
              className="text-[9px] px-1.5 py-0.5 rounded border border-amber-400/40 bg-amber-400/10 text-amber-300"
              title={attentionLabel}
            >
              {attentionLabel}
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 align-middle">
        <RolePill role={role} />
      </td>
      <td className="px-4 py-2.5 align-middle text-text-secondary">
        {submitted
          ? (role === 'closer' ? <CloserHighlights report={report} /> : <SetterHighlights report={report} />)
          : <span className="italic text-text-400 text-[11px]">Not submitted</span>}
      </td>
      <td className="px-4 py-2.5 align-middle text-right">
        {submitted ? (
          <ChevronRight size={ICON.md} className="text-text-400 inline" />
        ) : canFile ? (
          <button
            onClick={(e) => { e.stopPropagation(); onOpen() }}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-opt-yellow/10 border border-opt-yellow/30 text-opt-yellow hover:bg-opt-yellow/20 transition-colors"
            aria-label={`File EOD for ${member.name}`}
          >
            <Plus size={ICON.xs} /> File
          </button>
        ) : null}
      </td>
    </tr>
  )
}

function CloserHighlights({ report }) {
  const booked = (report.nc_booked || 0) + (report.fu_booked || 0)
  const live = (report.live_nc_calls || 0) + (report.live_fu_calls || 0)
  const cash = parseFloat(report.total_cash_collected || 0)
  const revenue = parseFloat(report.total_revenue || 0)
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums">
      <Stat label="Booked" value={booked} />
      <Stat label="Net Live" value={live} />
      <Stat label="Closes" value={report.closes || 0} accent="success" />
      <Stat label="Cash" value={`$${cash.toLocaleString()}`} accent="yellow" />
      <Stat label="Rev" value={`$${revenue.toLocaleString()}`} />
    </div>
  )
}

function SetterHighlights({ report }) {
  const rating = report.self_rating
  const ratingColor = rating >= 7 ? 'text-success' : rating >= 5 ? 'text-opt-yellow' : rating > 0 ? 'text-danger' : 'text-text-400'
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums">
      <Stat label="Dials" value={(report.outbound_calls || 0).toLocaleString()} />
      <Stat label="Pickups" value={report.pickups || 0} />
      <Stat label="MCs" value={report.meaningful_conversations || 0} />
      <Stat label="Sets" value={report.sets || 0} accent="success" />
      <span className="text-text-400">Rating <span className={`font-medium ${ratingColor}`}>{rating ? `${rating}/10` : '—'}</span></span>
    </div>
  )
}

function Stat({ label, value, accent }) {
  const color = accent === 'success' ? 'text-success'
    : accent === 'yellow' ? 'text-opt-yellow'
    : 'text-text-primary'
  return (
    <span className="text-text-400">
      {label} <span className={`font-medium ${color}`}>{value}</span>
    </span>
  )
}
