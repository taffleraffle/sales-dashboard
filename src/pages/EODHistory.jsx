import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader, Check, X, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useEODHistory } from '../hooks/useEODHistory'

function toETDateStr(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

function isWeekend(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const day = new Date(y, m - 1, d).getDay()
  return day === 0 || day === 6
}

function defaultRange() {
  const now = new Date()
  const to = toETDateStr(now)
  const from = new Date(now)
  from.setDate(from.getDate() - 29)
  return { from: toETDateStr(from), to }
}

export default function EODHistory({ embedded = false }) {
  const navigate = useNavigate()
  const [dateRange, setDateRange] = useState(defaultRange)
  const { members, loading: membersLoading } = useTeamMembers()
  const { closerEODs, setterEODs, loading: eodsLoading } = useEODHistory(dateRange.from, dateRange.to)
  const [expandedDate, setExpandedDate] = useState(null) // only one date expanded at a time

  const loading = membersLoading || eodsLoading

  // Sort members by name in a single consistent order — closers first, then setters
  const closers = useMemo(
    () => [...members].filter(m => m.role === 'closer').sort((a, b) => a.name.localeCompare(b.name)),
    [members]
  )
  const setters = useMemo(
    () => [...members].filter(m => m.role === 'setter').sort((a, b) => a.name.localeCompare(b.name)),
    [members]
  )
  const allMembers = useMemo(() => [...closers, ...setters], [closers, setters])

  // Build date list for range (treat as calendar dates, no timezone shift)
  const dates = useMemo(() => {
    const result = []
    const [ty, tm, td] = dateRange.to.split('-').map(Number)
    const [fy, fm, fd] = dateRange.from.split('-').map(Number)
    const d = new Date(ty, tm - 1, td)
    const end = new Date(fy, fm - 1, fd)
    while (d >= end) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      result.push(dateStr)
      d.setDate(d.getDate() - 1)
    }
    return result
  }, [dateRange])

  // Index EODs by date+member
  const closerByDateMember = useMemo(() => {
    const map = {}
    for (const e of closerEODs) map[`${e.report_date}_${e.closer_id}`] = e
    return map
  }, [closerEODs])

  const setterByDateMember = useMemo(() => {
    const map = {}
    for (const e of setterEODs) map[`${e.report_date}_${e.setter_id}`] = e
    return map
  }, [setterEODs])

  const toggleDate = d => setExpandedDate(prev => prev === d ? null : d)

  const fmtDate = d => {
    const [y, m, day] = d.split('-').map(Number)
    const dt = new Date(y, m - 1, day)
    return dt.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })
  }

  const fmtCurrency = v => {
    const n = parseFloat(v || 0)
    return n > 0 ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'
  }

  // Navigate to specific member's EOD for a specific date
  const goToMemberEOD = (date, member, e) => {
    e?.stopPropagation?.()
    navigate(`/sales/eod/submit?tab=${member.role}&member=${member.id}&date=${date}`)
  }

  const goToDateEOD = (date, e) => {
    e?.stopPropagation?.()
    navigate(`/sales/eod?date=${date}`)
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader className="animate-spin text-opt-yellow" size={24} />
    </div>
  )

  const totalCols = 2 + closers.length + setters.length // chevron + date + members + rate

  return (
    <div>
      {!embedded && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-lg sm:text-xl font-bold">EOD History</h1>
            <p className="text-xs text-text-400">Team submission overview & daily details</p>
          </div>
        </div>
      )}

      {/* Date range selector */}
      <div className="flex items-center gap-2 mb-4">
        <input
          type="date"
          value={dateRange.from}
          onChange={e => setDateRange(prev => ({ ...prev, from: e.target.value }))}
          className="bg-bg-card border border-border-default rounded-xl px-3 py-1.5 text-xs text-text-primary [color-scheme:dark]"
        />
        <span className="text-text-400 text-xs">to</span>
        <input
          type="date"
          value={dateRange.to}
          onChange={e => setDateRange(prev => ({ ...prev, to: e.target.value }))}
          className="bg-bg-card border border-border-default rounded-xl px-3 py-1.5 text-xs text-text-primary [color-scheme:dark]"
        />
        <span className="text-[10px] text-text-400">{dates.length} days</span>
      </div>

      {/* Submission Matrix with inline expand */}
      <div className="tile tile-feedback overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-border-default">
          <h3 className="text-[11px] text-opt-yellow uppercase font-medium">Submission Matrix — click a cell to open that EOD</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-default">
                <th className="w-6 px-2 py-2.5 bg-bg-card"></th>
                <th className="text-left px-3 py-2.5 text-[10px] text-text-400 uppercase font-medium bg-bg-card">Date</th>
                {closers.map(m => (
                  <th key={m.id} className="px-2 py-2.5 text-center min-w-[60px]">
                    <div className="text-[10px] text-text-primary font-medium">{m.name}</div>
                    <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-semibold">C</span>
                  </th>
                ))}
                {setters.map(m => (
                  <th key={m.id} className="px-2 py-2.5 text-center min-w-[60px]">
                    <div className="text-[10px] text-text-primary font-medium">{m.name}</div>
                    <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400 font-semibold">S</span>
                  </th>
                ))}
                <th className="px-3 py-2.5 text-center text-[10px] text-text-400 uppercase font-medium">Rate</th>
              </tr>
            </thead>
            <tbody>
              {dates.map((date, i) => {
                const weekend = isWeekend(date)
                const isExpanded = expandedDate === date
                const submittedCount = allMembers.filter(m => {
                  const key = `${date}_${m.id}`
                  return m.role === 'closer' ? closerByDateMember[key] : setterByDateMember[key]
                }).length
                const rate = weekend ? null : (allMembers.length > 0 ? Math.round((submittedCount / allMembers.length) * 100) : 0)

                const dayCloserEODs = closerEODs.filter(e => e.report_date === date)
                const daySetterEODs = setterEODs.filter(e => e.report_date === date)
                const missingClosers = closers.filter(m => !closerByDateMember[`${date}_${m.id}`])
                const missingSetters = setters.filter(m => !setterByDateMember[`${date}_${m.id}`])

                return [
                  <tr
                    key={date}
                    className={`border-b border-border-default/50 hover:bg-bg-card-hover transition-colors ${weekend ? 'opacity-60' : ''} ${i % 2 === 0 ? '' : 'bg-bg-primary/30'} ${isExpanded ? 'bg-opt-yellow/5' : ''}`}
                  >
                    <td className="px-2 py-2 text-center cursor-pointer" onClick={() => toggleDate(date)}>
                      {isExpanded ? <ChevronUp size={12} className="text-opt-yellow" /> : <ChevronDown size={12} className="text-text-400" />}
                    </td>
                    <td className="px-3 py-2 text-text-primary font-medium whitespace-nowrap cursor-pointer" onClick={() => toggleDate(date)}>
                      <span className="flex items-center gap-1.5">
                        {fmtDate(date)}
                        {weekend && <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-medium">WE</span>}
                      </span>
                    </td>
                    {closers.map(m => {
                      const eod = closerByDateMember[`${date}_${m.id}`]
                      return (
                        <td
                          key={m.id}
                          className="px-2 py-2 text-center cursor-pointer hover:bg-opt-yellow/10"
                          onClick={e => goToMemberEOD(date, m, e)}
                          title={eod ? `${m.name} — click to view EOD` : `${m.name} — not submitted, click to file`}
                        >
                          {eod ? (
                            <Check size={14} className="text-success mx-auto" />
                          ) : weekend ? (
                            <span className="text-blue-400 text-sm font-bold">—</span>
                          ) : (
                            <X size={14} className="text-danger/50 mx-auto" />
                          )}
                        </td>
                      )
                    })}
                    {setters.map(m => {
                      const eod = setterByDateMember[`${date}_${m.id}`]
                      return (
                        <td
                          key={m.id}
                          className="px-2 py-2 text-center cursor-pointer hover:bg-opt-yellow/10"
                          onClick={e => goToMemberEOD(date, m, e)}
                          title={eod ? `${m.name} — click to view EOD` : `${m.name} — not submitted, click to file`}
                        >
                          {eod ? (
                            <Check size={14} className="text-success mx-auto" />
                          ) : weekend ? (
                            <span className="text-blue-400 text-sm font-bold">—</span>
                          ) : (
                            <X size={14} className="text-danger/50 mx-auto" />
                          )}
                        </td>
                      )
                    })}
                    <td className="px-3 py-2 text-center cursor-pointer" onClick={() => toggleDate(date)}>
                      {weekend ? (
                        <span className="text-blue-400 text-[10px] font-medium">—</span>
                      ) : (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          rate === 100 ? 'bg-success/20 text-success' :
                          rate >= 50 ? 'bg-opt-yellow/20 text-opt-yellow' :
                          'bg-danger/20 text-danger'
                        }`}>
                          {rate}%
                        </span>
                      )}
                    </td>
                  </tr>,
                  isExpanded && (
                    <tr key={`${date}-expanded`} className="bg-bg-primary/40">
                      <td colSpan={totalCols} className="px-4 py-3">
                        <div className="flex items-center justify-between mb-3">
                          <h4 className="text-xs font-semibold text-opt-yellow">{fmtDate(date)} — Full Details</h4>
                          <button
                            onClick={e => goToDateEOD(date, e)}
                            className="text-[10px] text-opt-yellow hover:underline"
                          >
                            Open EOD Form for {fmtDate(date)} →
                          </button>
                        </div>

                        {/* Missing members */}
                        {(missingClosers.length > 0 || missingSetters.length > 0) && !weekend && (
                          <div className="px-3 py-2 bg-danger/5 border border-danger/20 rounded-lg mb-3 flex items-center gap-2 flex-wrap">
                            <AlertCircle size={12} className="text-danger shrink-0" />
                            <span className="text-[10px] text-danger font-medium">Missing:</span>
                            {missingClosers.map(m => (
                              <button
                                key={m.id}
                                onClick={e => goToMemberEOD(date, m, e)}
                                className="text-[10px] px-2 py-0.5 rounded-full bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
                              >
                                {m.name} (C)
                              </button>
                            ))}
                            {missingSetters.map(m => (
                              <button
                                key={m.id}
                                onClick={e => goToMemberEOD(date, m, e)}
                                className="text-[10px] px-2 py-0.5 rounded-full bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
                              >
                                {m.name} (S)
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Closer EODs */}
                        {dayCloserEODs.length > 0 && (
                          <div className="mb-3">
                            <h5 className="text-[10px] text-blue-400 uppercase font-semibold mb-1.5">Closers ({dayCloserEODs.length})</h5>
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-[10px] text-text-400 uppercase border-b border-border-default/50">
                                    <th className="text-left px-2 py-1 font-medium">Name</th>
                                    <th className="text-right px-2 py-1 font-medium">NC Book</th>
                                    <th className="text-right px-2 py-1 font-medium">FU Book</th>
                                    <th className="text-right px-2 py-1 font-medium">Live NC</th>
                                    <th className="text-right px-2 py-1 font-medium">Live FU</th>
                                    <th className="text-right px-2 py-1 font-medium">No Shows</th>
                                    <th className="text-right px-2 py-1 font-medium">Offers</th>
                                    <th className="text-right px-2 py-1 font-medium">Closes</th>
                                    <th className="text-right px-2 py-1 font-medium">Cash</th>
                                    <th className="text-right px-2 py-1 font-medium">Revenue</th>
                                    <th className="text-left px-2 py-1 font-medium">Notes</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {dayCloserEODs.map(ed => {
                                    const member = allMembers.find(m => m.id === ed.closer_id)
                                    return (
                                      <tr
                                        key={ed.id}
                                        className="border-b border-border-default/20 hover:bg-opt-yellow/5 cursor-pointer transition-colors"
                                        onClick={e => member && goToMemberEOD(date, member, e)}
                                      >
                                        <td className="px-2 py-1.5 text-text-primary font-medium">{ed.closer?.name || '—'}</td>
                                        <td className="text-right px-2 py-1.5">{ed.nc_booked || 0}</td>
                                        <td className="text-right px-2 py-1.5">{ed.fu_booked || 0}</td>
                                        <td className="text-right px-2 py-1.5">{ed.live_nc_calls || 0}</td>
                                        <td className="text-right px-2 py-1.5">{ed.live_fu_calls || 0}</td>
                                        <td className="text-right px-2 py-1.5 text-danger">{(ed.nc_no_shows || 0) + (ed.fu_no_shows || 0)}</td>
                                        <td className="text-right px-2 py-1.5">{ed.offers || 0}</td>
                                        <td className="text-right px-2 py-1.5 text-success font-semibold">{ed.closes || 0}</td>
                                        <td className="text-right px-2 py-1.5">{fmtCurrency(ed.total_cash_collected)}</td>
                                        <td className="text-right px-2 py-1.5">{fmtCurrency(ed.total_revenue)}</td>
                                        <td className="px-2 py-1.5 text-text-400 max-w-[200px] truncate">{ed.notes || '—'}</td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {/* Setter EODs */}
                        {daySetterEODs.length > 0 && (
                          <div>
                            <h5 className="text-[10px] text-purple-400 uppercase font-semibold mb-1.5">Setters ({daySetterEODs.length})</h5>
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-[10px] text-text-400 uppercase border-b border-border-default/50">
                                    <th className="text-left px-2 py-1 font-medium">Name</th>
                                    <th className="text-right px-2 py-1 font-medium">Dials</th>
                                    <th className="text-right px-2 py-1 font-medium">Leads</th>
                                    <th className="text-right px-2 py-1 font-medium">Pickups</th>
                                    <th className="text-right px-2 py-1 font-medium">MCs</th>
                                    <th className="text-right px-2 py-1 font-medium">Sets</th>
                                    <th className="text-right px-2 py-1 font-medium">Rating</th>
                                    <th className="text-left px-2 py-1 font-medium">Summary</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {daySetterEODs.map(ed => {
                                    const member = allMembers.find(m => m.id === ed.setter_id)
                                    return (
                                      <tr
                                        key={ed.id}
                                        className="border-b border-border-default/20 hover:bg-opt-yellow/5 cursor-pointer transition-colors"
                                        onClick={e => member && goToMemberEOD(date, member, e)}
                                      >
                                        <td className="px-2 py-1.5 text-text-primary font-medium">{ed.setter?.name || '—'}</td>
                                        <td className="text-right px-2 py-1.5">{ed.outbound_calls || 0}</td>
                                        <td className="text-right px-2 py-1.5">{ed.total_leads || 0}</td>
                                        <td className="text-right px-2 py-1.5">{ed.pickups || 0}</td>
                                        <td className="text-right px-2 py-1.5">{ed.meaningful_conversations || 0}</td>
                                        <td className="text-right px-2 py-1.5 text-success font-semibold">{ed.sets || 0}</td>
                                        <td className="text-right px-2 py-1.5">
                                          {ed.self_rating ? (
                                            <span className={`font-semibold ${ed.self_rating >= 7 ? 'text-success' : ed.self_rating >= 5 ? 'text-opt-yellow' : 'text-danger'}`}>
                                              {ed.self_rating}/10
                                            </span>
                                          ) : '—'}
                                        </td>
                                        <td className="px-2 py-1.5 text-text-400 max-w-[250px] truncate">{ed.daily_summary || ed.overall_performance || '—'}</td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {dayCloserEODs.length === 0 && daySetterEODs.length === 0 && (
                          <p className="text-text-400 text-xs text-center py-3">No EOD submissions for this date.</p>
                        )}
                      </td>
                    </tr>
                  )
                ]
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
