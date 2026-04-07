import { useState, useEffect, useMemo } from 'react'
import { Loader, RefreshCw, Mail, AlertCircle, Star, ArrowUp, ArrowDown } from 'lucide-react'
import KPICard from '../components/KPICard'
import DateRangeSelector from '../components/DateRangeSelector'
import { sinceDate, rangeToDays } from '../lib/dateUtils'
import { fetchWorkflows, syncEmailMessages, refreshRecentEmailStatuses, loadEmailStats, loadCachedWorkflows, loadSubjectMeta, updateSubjectMeta } from '../services/ghlEmailFlows'

export default function EmailFlows() {
  const [range, setRange] = useState(30)
  const [stats, setStats] = useState([])
  const [workflows, setWorkflows] = useState([])
  const [subjectMeta, setSubjectMeta] = useState({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState('')
  const [selectedSubjects, setSelectedSubjects] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('email_flows_selected') || '[]')) }
    catch { return new Set() }
  })
  const [workflowFilter, setWorkflowFilter] = useState('all') // 'all' | workflow_id | 'unassigned' | 'monitored'
  const [sortKey, setSortKey] = useState('sent') // 'subject', 'sent', 'opened', 'clicked', 'openRate', 'clickRate', 'lastSent'
  const [sortDir, setSortDir] = useState('desc')
  const [editingSubject, setEditingSubject] = useState(null)
  const [error, setError] = useState(null)

  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const fromDate = sinceDate(range)
  const toDate = (typeof range === 'object' && range.to) ? range.to : new Date().toLocaleDateString('en-CA')

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, w, meta] = await Promise.all([
        loadEmailStats(fromDate, toDate),
        loadCachedWorkflows(),
        loadSubjectMeta(),
      ])
      setStats(s)
      setWorkflows(w)
      setSubjectMeta(meta)
      // Auto-select all subjects on first load if none selected
      if (selectedSubjects.size === 0 && s.length > 0) {
        const all = new Set(s.map(x => x.subject))
        setSelectedSubjects(all)
        localStorage.setItem('email_flows_selected', JSON.stringify([...all]))
      }
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  const setMeta = async (subject, updates) => {
    const optimistic = { ...subjectMeta, [subject]: { ...(subjectMeta[subject] || {}), subject, ...updates } }
    setSubjectMeta(optimistic)
    await updateSubjectMeta(subject, updates)
  }

  const toggleMonitored = (subject) => {
    const current = subjectMeta[subject]?.monitored || false
    setMeta(subject, { monitored: !current })
  }

  const assignWorkflow = (subject, workflowId) => {
    const wf = workflows.find(w => w.id === workflowId)
    setMeta(subject, { workflow_id: workflowId || null, workflow_name: wf?.name || null })
    setEditingSubject(null)
  }

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  useEffect(() => { loadData() }, [range])

  const runSync = async () => {
    setSyncing(true)
    setError(null)
    setSyncProgress('Fetching workflows...')
    try {
      await fetchWorkflows()
      setSyncProgress('Syncing email messages...')
      const result = await syncEmailMessages(days, (current, total) => {
        setSyncProgress(`Scanning conversations: ${current}/${total}`)
      })
      setSyncProgress(`Refreshing statuses...`)
      await refreshRecentEmailStatuses(7)
      setSyncProgress(`Synced ${result.synced} new emails (${result.skipped} cached)`)
      await loadData()
    } catch (e) {
      setError(e.message)
    }
    setSyncing(false)
    setTimeout(() => setSyncProgress(''), 6000)
  }

  const toggleSubject = (subject) => {
    const next = new Set(selectedSubjects)
    if (next.has(subject)) next.delete(subject)
    else next.add(subject)
    setSelectedSubjects(next)
    localStorage.setItem('email_flows_selected', JSON.stringify([...next]))
  }

  const filteredStats = useMemo(() => {
    let result = selectedSubjects.size === 0 ? stats : stats.filter(s => selectedSubjects.has(s.subject))

    // Apply workflow filter
    if (workflowFilter === 'unassigned') {
      result = result.filter(s => !subjectMeta[s.subject]?.workflow_id)
    } else if (workflowFilter === 'monitored') {
      result = result.filter(s => subjectMeta[s.subject]?.monitored)
    } else if (workflowFilter !== 'all') {
      result = result.filter(s => subjectMeta[s.subject]?.workflow_id === workflowFilter)
    }

    // Sort
    const sorted = [...result].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey]
      if (sortKey === 'subject') { av = av || ''; bv = bv || '' }
      if (sortKey === 'lastSent') { av = new Date(av || 0).getTime(); bv = new Date(bv || 0).getTime() }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return sorted
  }, [stats, selectedSubjects, subjectMeta, workflowFilter, sortKey, sortDir])

  const totals = useMemo(() => {
    const t = filteredStats.reduce((a, s) => ({
      sent: a.sent + s.sent,
      delivered: a.delivered + s.delivered,
      opened: a.opened + s.opened,
      clicked: a.clicked + s.clicked,
      failed: a.failed + s.failed,
    }), { sent: 0, delivered: 0, opened: 0, clicked: 0, failed: 0 })
    return {
      ...t,
      deliveryRate: t.sent > 0 ? ((t.delivered / t.sent) * 100).toFixed(1) : 0,
      openRate: t.delivered > 0 ? ((t.opened / t.delivered) * 100).toFixed(1) : 0,
      clickRate: t.delivered > 0 ? ((t.clicked / t.delivered) * 100).toFixed(1) : 0,
    }
  }, [filteredStats])

  const rateColor = (v, good, ok) => v >= good ? 'text-success' : v >= ok ? 'text-opt-yellow' : 'text-danger'
  const fmtDate = d => {
    if (!d) return '—'
    const dt = new Date(d)
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-lg sm:text-xl font-bold flex items-center gap-2">
            <Mail size={20} className="text-opt-yellow" /> Email Flows
          </h1>
          <p className="text-xs sm:text-sm text-text-400">GHL email automation performance</p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangeSelector selected={range} onChange={setRange} />
          <button
            onClick={runSync}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-opt-yellow text-bg-primary hover:brightness-110 disabled:opacity-50 transition-all"
          >
            {syncing ? <><Loader size={12} className="animate-spin" /> Syncing...</> : <><RefreshCw size={12} /> Sync Now</>}
          </button>
        </div>
      </div>

      {syncProgress && (
        <div className="mb-4 px-4 py-2 bg-opt-yellow/10 border border-opt-yellow/30 rounded-xl text-xs text-opt-yellow flex items-center gap-2">
          {syncing && <Loader size={12} className="animate-spin" />}
          {syncProgress}
        </div>
      )}

      {error && (
        <div className="mb-4 px-4 py-2 bg-danger/10 border border-danger/30 rounded-xl text-xs text-danger flex items-center gap-2">
          <AlertCircle size={12} /> {error}
          {error.includes('email_message_cache') && (
            <span className="ml-2 text-text-400">(Run migration 016 in Supabase SQL Editor first)</span>
          )}
        </div>
      )}

      {/* Top KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KPICard label="Total Sent" value={totals.sent.toLocaleString()} subtitle={`${filteredStats.length} unique subjects`} />
        <KPICard label="Delivered" value={`${totals.deliveryRate}%`} subtitle={`${totals.delivered.toLocaleString()} of ${totals.sent.toLocaleString()}`} />
        <KPICard label="Open Rate" value={`${totals.openRate}%`} subtitle={`${totals.opened.toLocaleString()} opens`} highlight />
        <KPICard label="Click Rate" value={`${totals.clickRate}%`} subtitle={`${totals.clicked.toLocaleString()} clicks`} />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader className="animate-spin text-opt-yellow" size={24} />
        </div>
      ) : stats.length === 0 ? (
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center">
          <Mail size={32} className="text-text-400/30 mx-auto mb-3" />
          <p className="text-text-primary font-medium mb-1">No email data yet</p>
          <p className="text-xs text-text-400 mb-4">Click "Sync Now" to pull email automation data from GHL.</p>
          <button onClick={runSync} disabled={syncing} className="px-4 py-2 rounded-xl text-xs font-medium bg-opt-yellow text-bg-primary hover:brightness-110 disabled:opacity-50">
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
      ) : (
        <>
          {/* Subject toggle chips */}
          <div className="bg-bg-card border border-border-default rounded-2xl p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] text-opt-yellow uppercase font-medium">Selected Automations ({selectedSubjects.size}/{stats.length})</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const all = new Set(stats.map(s => s.subject))
                    setSelectedSubjects(all)
                    localStorage.setItem('email_flows_selected', JSON.stringify([...all]))
                  }}
                  className="text-[10px] text-text-400 hover:text-opt-yellow"
                >
                  Select all
                </button>
                <span className="text-text-400">·</span>
                <button
                  onClick={() => {
                    setSelectedSubjects(new Set())
                    localStorage.setItem('email_flows_selected', '[]')
                  }}
                  className="text-[10px] text-text-400 hover:text-opt-yellow"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
              {stats.map(s => {
                const active = selectedSubjects.has(s.subject)
                return (
                  <button
                    key={s.subject}
                    onClick={() => toggleSubject(s.subject)}
                    className={`text-[10px] px-2 py-1 rounded-full border transition-all ${
                      active
                        ? 'bg-opt-yellow/20 border-opt-yellow/40 text-opt-yellow'
                        : 'bg-bg-primary border-border-default text-text-400 hover:border-text-400'
                    }`}
                    title={s.subject}
                  >
                    {s.subject.length > 40 ? s.subject.slice(0, 40) + '...' : s.subject}
                    <span className="ml-1.5 opacity-70">({s.sent})</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Stats table */}
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-border-default flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-[11px] text-opt-yellow uppercase font-medium">Email Performance</h3>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-text-400">Filter:</span>
                <select
                  value={workflowFilter}
                  onChange={e => setWorkflowFilter(e.target.value)}
                  className="bg-bg-primary border border-border-default rounded-lg px-2 py-1 text-[11px] text-text-primary"
                >
                  <option value="all">All emails</option>
                  <option value="monitored">★ Monitored only</option>
                  <option value="unassigned">Unassigned</option>
                  <optgroup label="Workflows">
                    {workflows.filter(w => w.status === 'published').map(w => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </optgroup>
                </select>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-text-400 uppercase border-b border-border-default">
                    <th className="px-2 py-2.5 w-8"></th>
                    <Th label="Subject" k="subject" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="left" />
                    <th className="text-left px-2 py-2.5 font-medium">Workflow</th>
                    <Th label="Sent" k="sent" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Delivered" k="delivered" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Opened" k="opened" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Clicked" k="clicked" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Open %" k="openRate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Click %" k="clickRate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Last Sent" k="lastSent" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  </tr>
                </thead>
                <tbody>
                  {filteredStats.map((s, i) => {
                    const meta = subjectMeta[s.subject] || {}
                    const isMonitored = meta.monitored
                    const rowBg = isMonitored
                      ? 'bg-blue-500/10 hover:bg-blue-500/15 border-l-2 border-blue-400'
                      : i % 2 === 0 ? 'hover:bg-bg-card-hover' : 'bg-bg-primary/30 hover:bg-bg-card-hover'
                    return (
                    <tr key={s.subject} className={`border-b border-border-default/50 transition-colors ${rowBg}`}>
                      <td className="px-2 py-2.5 text-center">
                        <button
                          onClick={() => toggleMonitored(s.subject)}
                          className={`transition-all ${isMonitored ? 'text-blue-400' : 'text-text-400/30 hover:text-text-400'}`}
                          title={isMonitored ? 'Stop monitoring' : 'Monitor this email'}
                        >
                          <Star size={13} fill={isMonitored ? 'currentColor' : 'none'} />
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-text-primary max-w-md truncate" title={s.subject}>
                        {s.subject}
                        {s.variants > 1 && <span className="ml-1.5 text-[9px] text-text-400">({s.variants} variants)</span>}
                      </td>
                      <td className="px-2 py-2.5 text-[10px]">
                        {editingSubject === s.subject ? (
                          <select
                            autoFocus
                            value={meta.workflow_id || ''}
                            onChange={e => assignWorkflow(s.subject, e.target.value)}
                            onBlur={() => setEditingSubject(null)}
                            className="bg-bg-primary border border-opt-yellow/40 rounded px-1.5 py-0.5 text-[10px] text-text-primary max-w-[180px]"
                          >
                            <option value="">— Unassigned —</option>
                            {workflows.filter(w => w.status === 'published').map(w => (
                              <option key={w.id} value={w.id}>{w.name}</option>
                            ))}
                          </select>
                        ) : (
                          <button
                            onClick={() => setEditingSubject(s.subject)}
                            className={`text-left max-w-[180px] truncate hover:text-opt-yellow transition-colors ${meta.workflow_name ? 'text-text-primary' : 'text-text-400/50 italic'}`}
                            title={meta.workflow_name || 'Click to assign'}
                          >
                            {meta.workflow_name || 'Assign...'}
                          </button>
                        )}
                      </td>
                      <td className="text-right px-3 py-2.5 font-semibold">{s.sent}</td>
                      <td className="text-right px-3 py-2.5 text-text-400">{s.delivered}</td>
                      <td className="text-right px-3 py-2.5 text-text-400">{s.opened}</td>
                      <td className="text-right px-3 py-2.5 text-text-400">{s.clicked}</td>
                      <td className={`text-right px-3 py-2.5 font-semibold ${rateColor(s.openRate, 40, 20)}`}>{s.openRate}%</td>
                      <td className={`text-right px-3 py-2.5 font-semibold ${rateColor(s.clickRate, 5, 2)}`}>{s.clickRate}%</td>
                      <td className="text-right px-4 py-2.5 text-text-400 whitespace-nowrap">{fmtDate(s.lastSent)}</td>
                    </tr>
                    )
                  })}
                  {filteredStats.length === 0 && (
                    <tr><td colSpan={10} className="px-4 py-8 text-center text-text-400 text-xs">No emails match this filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* GHL Workflow reference */}
          {workflows.length > 0 && (
            <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border-default">
                <h3 className="text-[11px] text-opt-yellow uppercase font-medium">GHL Workflows ({workflows.length}) <span className="text-text-400 font-normal normal-case">— reference list</span></h3>
              </div>
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-bg-card">
                    <tr className="text-[10px] text-text-400 uppercase border-b border-border-default">
                      <th className="text-left px-4 py-2 font-medium">Name</th>
                      <th className="text-right px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workflows.map((w, i) => (
                      <tr key={w.id} className={`border-b border-border-default/30 ${i % 2 === 0 ? '' : 'bg-bg-primary/30'}`}>
                        <td className="px-4 py-1.5 text-text-primary">{w.name}</td>
                        <td className="text-right px-3 py-1.5">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                            w.status === 'published' ? 'bg-success/20 text-success' : 'bg-text-400/20 text-text-400'
                          }`}>
                            {w.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Th({ label, k, sortKey, sortDir, onSort, align = 'right' }) {
  const active = sortKey === k
  return (
    <th
      onClick={() => onSort(k)}
      className={`px-3 py-2.5 font-medium cursor-pointer select-none hover:text-opt-yellow transition-colors text-${align}`}
    >
      <span className={`inline-flex items-center gap-1 ${active ? 'text-opt-yellow' : ''}`}>
        {label}
        {active && (sortDir === 'asc' ? <ArrowUp size={9} /> : <ArrowDown size={9} />)}
      </span>
    </th>
  )
}
