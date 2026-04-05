import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader, Check, X, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useEODHistory } from '../hooks/useEODHistory'
import { toLocalDateStr } from '../lib/dateUtils'

function defaultRange() {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 6)
  return { from: toLocalDateStr(from), to: toLocalDateStr(to) }
}

export default function EODHistory() {
  const navigate = useNavigate()
  const [dateRange, setDateRange] = useState(defaultRange)
  const { members, loading: membersLoading } = useTeamMembers()
  const { closerEODs, setterEODs, loading: eodsLoading } = useEODHistory(dateRange.from, dateRange.to)
  const [expandedDates, setExpandedDates] = useState({})

  const loading = membersLoading || eodsLoading

  const closers = useMemo(() => members.filter(m => m.role === 'closer'), [members])
  const setters = useMemo(() => members.filter(m => m.role === 'setter'), [members])

  // Build date list for range
  const dates = useMemo(() => {
    const result = []
    const d = new Date(dateRange.to + 'T00:00:00')
    const end = new Date(dateRange.from + 'T00:00:00')
    while (d >= end) {
      result.push(toLocalDateStr(d))
      d.setDate(d.getDate() - 1)
    }
    return result
  }, [dateRange])

  // Index EODs by date+member
  const closerByDateMember = useMemo(() => {
    const map = {}
    for (const e of closerEODs) {
      map[`${e.report_date}_${e.closer_id}`] = e
    }
    return map
  }, [closerEODs])

  const setterByDateMember = useMemo(() => {
    const map = {}
    for (const e of setterEODs) {
      map[`${e.report_date}_${e.setter_id}`] = e
    }
    return map
  }, [setterEODs])

  const toggleDate = d => setExpandedDates(prev => ({ ...prev, [d]: !prev[d] }))

  const fmtDate = d => {
    const dt = new Date(d + 'T00:00:00')
    return dt.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' })
  }

  const fmtCurrency = v => {
    const n = parseFloat(v || 0)
    return n > 0 ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'
  }

  const goToEOD = (date) => {
    navigate(`/sales/eod?date=${date}`)
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader className="animate-spin text-opt-yellow" size={24} />
    </div>
  )

  const allMembers = [...closers, ...setters]

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-lg sm:text-xl font-bold">EOD History</h1>
          <p className="text-xs text-text-400">Team submission overview & daily details</p>
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </div>

      {/* Submission Matrix */}
      <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-border-default">
          <h3 className="text-[11px] text-opt-yellow uppercase font-medium">Submission Matrix</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-default">
                <th className="text-left px-4 py-2.5 text-[10px] text-text-400 uppercase font-medium sticky left-0 bg-bg-card z-10">Date</th>
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
                const submittedCount = allMembers.filter(m => {
                  const key = `${date}_${m.id}`
                  return m.role === 'closer' ? closerByDateMember[key] : setterByDateMember[key]
                }).length
                const rate = allMembers.length > 0 ? Math.round((submittedCount / allMembers.length) * 100) : 0

                return (
                  <tr
                    key={date}
                    className={`border-b border-border-default/50 hover:bg-bg-card-hover transition-colors cursor-pointer ${i % 2 === 0 ? '' : 'bg-bg-primary/30'}`}
                    onClick={() => toggleDate(date)}
                  >
                    <td className="px-4 py-2 text-text-primary font-medium whitespace-nowrap sticky left-0 bg-inherit z-10">
                      <span className="flex items-center gap-1.5">
                        {expandedDates[date] ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        {fmtDate(date)}
                      </span>
                    </td>
                    {closers.map(m => {
                      const eod = closerByDateMember[`${date}_${m.id}`]
                      return (
                        <td key={m.id} className="px-2 py-2 text-center">
                          {eod ? (
                            <Check size={14} className="text-success mx-auto" />
                          ) : (
                            <X size={14} className="text-danger/50 mx-auto" />
                          )}
                        </td>
                      )
                    })}
                    {setters.map(m => {
                      const eod = setterByDateMember[`${date}_${m.id}`]
                      return (
                        <td key={m.id} className="px-2 py-2 text-center">
                          {eod ? (
                            <Check size={14} className="text-success mx-auto" />
                          ) : (
                            <X size={14} className="text-danger/50 mx-auto" />
                          )}
                        </td>
                      )
                    })}
                    <td className="px-3 py-2 text-center">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        rate === 100 ? 'bg-success/20 text-success' :
                        rate >= 50 ? 'bg-opt-yellow/20 text-opt-yellow' :
                        'bg-danger/20 text-danger'
                      }`}>
                        {rate}%
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Expanded daily details */}
      {dates.filter(d => expandedDates[d]).map(date => {
        const dayCloserEODs = closerEODs.filter(e => e.report_date === date)
        const daySetterEODs = setterEODs.filter(e => e.report_date === date)
        const submittedCloserIds = new Set(dayCloserEODs.map(e => e.closer_id))
        const submittedSetterIds = new Set(daySetterEODs.map(e => e.setter_id))
        const missingClosers = closers.filter(m => !submittedCloserIds.has(m.id))
        const missingSetters = setters.filter(m => !submittedSetterIds.has(m.id))

        return (
          <div key={date} className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-4">
            <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
              <h3 className="text-sm font-bold">{fmtDate(date)}</h3>
              <button
                onClick={() => goToEOD(date)}
                className="text-[10px] text-opt-yellow hover:underline"
              >
                Open EOD Form →
              </button>
            </div>

            {/* Missing members */}
            {(missingClosers.length > 0 || missingSetters.length > 0) && (
              <div className="px-4 py-2 bg-danger/5 border-b border-border-default flex items-center gap-2 flex-wrap">
                <AlertCircle size={12} className="text-danger shrink-0" />
                <span className="text-[10px] text-danger font-medium">Missing:</span>
                {missingClosers.map(m => (
                  <span key={m.id} className="text-[10px] px-2 py-0.5 rounded-full bg-danger/10 text-danger">{m.name} (C)</span>
                ))}
                {missingSetters.map(m => (
                  <span key={m.id} className="text-[10px] px-2 py-0.5 rounded-full bg-danger/10 text-danger">{m.name} (S)</span>
                ))}
              </div>
            )}

            <div className="p-4 space-y-4">
              {/* Closer EODs */}
              {dayCloserEODs.length > 0 && (
                <div>
                  <h4 className="text-[10px] text-blue-400 uppercase font-semibold mb-2">Closers</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[10px] text-text-400 uppercase border-b border-border-default/50">
                          <th className="text-left px-3 py-2 font-medium">Name</th>
                          <th className="text-right px-2 py-2 font-medium">NC Book</th>
                          <th className="text-right px-2 py-2 font-medium">FU Book</th>
                          <th className="text-right px-2 py-2 font-medium">Live NC</th>
                          <th className="text-right px-2 py-2 font-medium">Live FU</th>
                          <th className="text-right px-2 py-2 font-medium">No Shows</th>
                          <th className="text-right px-2 py-2 font-medium">Offers</th>
                          <th className="text-right px-2 py-2 font-medium">Closes</th>
                          <th className="text-right px-2 py-2 font-medium">Cash</th>
                          <th className="text-right px-2 py-2 font-medium">Revenue</th>
                          <th className="text-left px-2 py-2 font-medium">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dayCloserEODs.map(e => (
                          <tr key={e.id} className="border-b border-border-default/30 hover:bg-bg-card-hover transition-colors">
                            <td className="px-3 py-2 text-text-primary font-medium">{e.closer?.name || '—'}</td>
                            <td className="text-right px-2 py-2">{e.nc_booked || 0}</td>
                            <td className="text-right px-2 py-2">{e.fu_booked || 0}</td>
                            <td className="text-right px-2 py-2">{e.live_nc_calls || 0}</td>
                            <td className="text-right px-2 py-2">{e.live_fu_calls || 0}</td>
                            <td className="text-right px-2 py-2 text-danger">{(e.nc_no_shows || 0) + (e.fu_no_shows || 0)}</td>
                            <td className="text-right px-2 py-2">{e.offers || 0}</td>
                            <td className="text-right px-2 py-2 text-success font-semibold">{e.closes || 0}</td>
                            <td className="text-right px-2 py-2">{fmtCurrency(e.total_cash_collected)}</td>
                            <td className="text-right px-2 py-2">{fmtCurrency(e.total_revenue)}</td>
                            <td className="px-2 py-2 text-text-400 max-w-[200px] truncate">{e.notes || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Setter EODs */}
              {daySetterEODs.length > 0 && (
                <div>
                  <h4 className="text-[10px] text-purple-400 uppercase font-semibold mb-2">Setters</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[10px] text-text-400 uppercase border-b border-border-default/50">
                          <th className="text-left px-3 py-2 font-medium">Name</th>
                          <th className="text-right px-2 py-2 font-medium">Dials</th>
                          <th className="text-right px-2 py-2 font-medium">Leads</th>
                          <th className="text-right px-2 py-2 font-medium">Pickups</th>
                          <th className="text-right px-2 py-2 font-medium">MCs</th>
                          <th className="text-right px-2 py-2 font-medium">Sets</th>
                          <th className="text-right px-2 py-2 font-medium">Rating</th>
                          <th className="text-left px-2 py-2 font-medium">Summary</th>
                        </tr>
                      </thead>
                      <tbody>
                        {daySetterEODs.map(e => (
                          <tr key={e.id} className="border-b border-border-default/30 hover:bg-bg-card-hover transition-colors">
                            <td className="px-3 py-2 text-text-primary font-medium">{e.setter?.name || '—'}</td>
                            <td className="text-right px-2 py-2">{e.outbound_calls || 0}</td>
                            <td className="text-right px-2 py-2">{e.total_leads || 0}</td>
                            <td className="text-right px-2 py-2">{e.pickups || 0}</td>
                            <td className="text-right px-2 py-2">{e.meaningful_conversations || 0}</td>
                            <td className="text-right px-2 py-2 text-success font-semibold">{e.sets || 0}</td>
                            <td className="text-right px-2 py-2">
                              {e.self_rating ? (
                                <span className={`font-semibold ${e.self_rating >= 7 ? 'text-success' : e.self_rating >= 5 ? 'text-opt-yellow' : 'text-danger'}`}>
                                  {e.self_rating}/10
                                </span>
                              ) : '—'}
                            </td>
                            <td className="px-2 py-2 text-text-400 max-w-[250px] truncate">{e.daily_summary || e.overall_performance || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {dayCloserEODs.length === 0 && daySetterEODs.length === 0 && (
                <p className="text-text-400 text-sm text-center py-4">No EOD submissions for this date.</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
