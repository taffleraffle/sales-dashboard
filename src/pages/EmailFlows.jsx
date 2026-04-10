import { useState, useEffect, useMemo } from 'react'
import { Loader, RefreshCw, Mail, AlertCircle, Star, ArrowUp, ArrowDown, Plus, Trash2, X, Search, ChevronDown, ChevronUp } from 'lucide-react'
import KPICard from '../components/KPICard'
import DateRangeSelector from '../components/DateRangeSelector'
import { sinceDate, rangeToDays } from '../lib/dateUtils'
import {
  fetchWorkflows, syncEmailMessages, refreshRecentEmailStatuses,
  loadEmailStats, loadCachedWorkflows, loadSubjectMeta, updateSubjectMeta,
  loadFlowGroups, createFlowGroup, updateFlowGroup, deleteFlowGroup,
  assignSubjectsToFlow, removeSubjectFromFlow, loadEmailRecipients,
} from '../services/ghlEmailFlows'

export default function EmailFlows() {
  const [range, setRange] = useState(30)
  const [stats, setStats] = useState([])
  const [flowGroups, setFlowGroups] = useState([])
  const [subjectMeta, setSubjectMeta] = useState({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState('')
  const [view, setView] = useState('flows') // 'flows' | 'all'
  const [minSends, setMinSends] = useState(1)
  const [sortKey, setSortKey] = useState('sent')
  const [sortDir, setSortDir] = useState('desc')
  const [expandedFlow, setExpandedFlow] = useState(null)
  const [addingToFlow, setAddingToFlow] = useState(null) // flow group id
  const [emailSearch, setEmailSearch] = useState('')
  const [newFlowName, setNewFlowName] = useState('')
  const [showCreateFlow, setShowCreateFlow] = useState(false)
  const [expandedEmail, setExpandedEmail] = useState(null) // normalized subject
  const [emailRecipients, setEmailRecipients] = useState([])
  const [loadingRecipients, setLoadingRecipients] = useState(false)
  const [error, setError] = useState(null)

  const days = typeof range === 'number' || range === 'mtd' ? range : rangeToDays(range)
  const fromDate = sinceDate(range)
  const toDate = (typeof range === 'object' && range.to) ? range.to : new Date().toLocaleDateString('en-CA')

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, fg, meta] = await Promise.all([
        loadEmailStats(fromDate, toDate),
        loadFlowGroups(),
        loadSubjectMeta(),
      ])
      setStats(s)
      setFlowGroups(fg)
      setSubjectMeta(meta)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  useEffect(() => { loadData() }, [range])

  const runSync = async () => {
    setSyncing(true)
    setError(null)
    setSyncProgress('Fetching workflows...')
    try {
      await fetchWorkflows()
      setSyncProgress('Syncing email messages...')
      const result = await syncEmailMessages(days, (cur, tot) => setSyncProgress(`Scanning: ${cur}/${tot}`))
      setSyncProgress('Refreshing statuses...')
      await refreshRecentEmailStatuses(7)
      setSyncProgress(`Synced ${result.synced} new (${result.skipped} cached)`)
      await loadData()
    } catch (e) { setError(e.message) }
    setSyncing(false)
    setTimeout(() => setSyncProgress(''), 6000)
  }

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const visibleStats = useMemo(() => stats.filter(s => s.sent >= minSends), [stats, minSends])

  // Sort helper
  const sortedStats = (list) => [...list].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey]
    if (sortKey === 'lastSent') { av = new Date(av || 0).getTime(); bv = new Date(bv || 0).getTime() }
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ? 1 : -1
    return 0
  })

  // Build flow group aggregations
  const flowGroupStats = useMemo(() => {
    return flowGroups.map(fg => {
      const emails = visibleStats.filter(s => subjectMeta[s.subject]?.flow_group_id === fg.id)
      const t = emails.reduce((a, s) => ({
        sent: a.sent + s.sent, delivered: a.delivered + s.delivered,
        opened: a.opened + s.opened, clicked: a.clicked + s.clicked, replied: a.replied + (s.replied || 0),
      }), { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0 })
      return {
        ...fg, emails,
        ...t,
        openRate: t.delivered > 0 ? parseFloat(((t.opened / t.delivered) * 100).toFixed(1)) : 0,
        clickRate: t.delivered > 0 ? parseFloat(((t.clicked / t.delivered) * 100).toFixed(1)) : 0,
        replyRate: t.delivered > 0 ? parseFloat(((t.replied / t.delivered) * 100).toFixed(1)) : 0,
      }
    })
  }, [flowGroups, visibleStats, subjectMeta])

  // Totals — from tracked flows if any exist, otherwise from all visible emails
  const flowTotals = useMemo(() => {
    const emails = flowGroupStats.length > 0
      ? flowGroupStats.flatMap(fg => fg.emails)
      : visibleStats
    const t = emails.reduce((a, s) => ({
      sent: a.sent + s.sent, delivered: a.delivered + s.delivered,
      opened: a.opened + s.opened, clicked: a.clicked + s.clicked, replied: a.replied + (s.replied || 0),
    }), { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0 })
    return {
      ...t,
      openRate: t.delivered > 0 ? ((t.opened / t.delivered) * 100).toFixed(1) : 0,
      clickRate: t.delivered > 0 ? ((t.clicked / t.delivered) * 100).toFixed(1) : 0,
      replyRate: t.delivered > 0 ? ((t.replied / t.delivered) * 100).toFixed(1) : 0,
    }
  }, [flowGroupStats, visibleStats])

  const handleCreateFlow = async () => {
    if (!newFlowName.trim()) return
    const fg = await createFlowGroup(newFlowName.trim())
    if (fg) {
      setFlowGroups(prev => [...prev, fg])
      setNewFlowName('')
      setShowCreateFlow(false)
      setExpandedFlow(fg.id)
      setAddingToFlow(fg.id)
    }
  }

  const handleDeleteFlow = async (id) => {
    if (!confirm('Delete this flow? Emails will be unassigned.')) return
    await deleteFlowGroup(id)
    setFlowGroups(prev => prev.filter(fg => fg.id !== id))
    // Clear flow_group_id from local subjectMeta
    const updated = { ...subjectMeta }
    for (const [k, v] of Object.entries(updated)) {
      if (v.flow_group_id === id) updated[k] = { ...v, flow_group_id: null }
    }
    setSubjectMeta(updated)
  }

  const handleAddEmailToFlow = async (subject, flowGroupId) => {
    await assignSubjectsToFlow([subject], flowGroupId)
    setSubjectMeta(prev => ({ ...prev, [subject]: { ...(prev[subject] || {}), subject, flow_group_id: flowGroupId } }))
  }

  const handleRemoveFromFlow = async (subject) => {
    await removeSubjectFromFlow(subject)
    setSubjectMeta(prev => ({ ...prev, [subject]: { ...(prev[subject] || {}), flow_group_id: null } }))
  }

  const toggleEmailDetail = async (subject) => {
    if (expandedEmail === subject) { setExpandedEmail(null); return }
    setExpandedEmail(subject)
    setLoadingRecipients(true)
    const recipients = await loadEmailRecipients(subject, fromDate, toDate)
    setEmailRecipients(recipients)
    setLoadingRecipients(false)
  }

  const rateColor = (v, good, ok) => v >= good ? 'text-success' : v >= ok ? 'text-opt-yellow' : 'text-danger'
  const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'

  // Emails available to add to a flow (not already in ANY flow, above min sends)
  const availableEmails = useMemo(() => {
    return visibleStats.filter(s => {
      const meta = subjectMeta[s.subject]
      return !meta?.flow_group_id
    })
  }, [visibleStats, subjectMeta])

  const filteredAvailable = emailSearch.length >= 2
    ? availableEmails.filter(s => s.subject.toLowerCase().includes(emailSearch.toLowerCase()))
    : availableEmails.slice(0, 30)

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-lg sm:text-xl font-bold flex items-center gap-2">
            <Mail size={20} className="text-opt-yellow" /> Email Flows
          </h1>
          <p className="text-xs sm:text-sm text-text-400">Monitor your email automations</p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangeSelector selected={range} onChange={setRange} />
          <button onClick={runSync} disabled={syncing} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-opt-yellow text-bg-primary hover:brightness-110 disabled:opacity-50 transition-all">
            {syncing ? <><Loader size={12} className="animate-spin" /> Syncing...</> : <><RefreshCw size={12} /> Sync</>}
          </button>
        </div>
      </div>

      {syncProgress && (
        <div className="mb-4 px-4 py-2 bg-opt-yellow/10 border border-opt-yellow/30 rounded-xl text-xs text-opt-yellow flex items-center gap-2">
          {syncing && <Loader size={12} className="animate-spin" />} {syncProgress}
        </div>
      )}
      {error && (
        <div className="mb-4 px-4 py-2 bg-danger/10 border border-danger/30 rounded-xl text-xs text-danger flex items-center gap-2">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {/* KPIs — from monitored flows only */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <KPICard label="Tracked Sent" value={flowTotals.sent.toLocaleString()} subtitle={`${flowGroups.length} flows`} />
        <KPICard label="Delivered" value={`${flowTotals.sent > 0 ? ((flowTotals.delivered / flowTotals.sent) * 100).toFixed(1) : 0}%`} subtitle={`${flowTotals.delivered.toLocaleString()}`} />
        <KPICard label="Open Rate" value={`${flowTotals.openRate}%`} subtitle={`${flowTotals.opened.toLocaleString()} opens`} highlight />
        <KPICard label="Click Rate" value={`${flowTotals.clickRate}%`} subtitle={`${flowTotals.clicked.toLocaleString()} clicks`} />
        <KPICard label="Reply Rate" value={`${flowTotals.replyRate}%`} subtitle={`${flowTotals.replied.toLocaleString()} replies`} />
      </div>

      {/* View tabs */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex gap-1 bg-bg-card border border-border-default rounded-xl p-1">
          {[{ k: 'flows', l: 'My Flows' }, { k: 'all', l: 'All Emails' }].map(t => (
            <button key={t.k} onClick={() => setView(t.k)} className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${view === t.k ? 'bg-opt-yellow text-bg-primary shadow-sm' : 'text-text-400 hover:text-text-primary'}`}>
              {t.l}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {view === 'all' && (
            <>
              <span className="text-[10px] text-text-400 uppercase">Min sends:</span>
              <select value={minSends} onChange={e => setMinSends(parseInt(e.target.value))} className="bg-bg-card border border-border-default rounded-lg px-2 py-1 text-[11px] text-text-primary">
                <option value={0}>All</option><option value={5}>5+</option><option value={10}>10+</option><option value={20}>20+</option><option value={50}>50+</option>
              </select>
            </>
          )}
          {view === 'flows' && (
            <button onClick={() => setShowCreateFlow(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-opt-yellow text-bg-primary hover:brightness-110">
              <Plus size={12} /> New Flow
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader className="animate-spin text-opt-yellow" size={24} /></div>
      ) : (
        <>
          {/* ═══ MY FLOWS VIEW ═══ */}
          {view === 'flows' && (
            <div className="space-y-3">
              {/* Create flow inline */}
              {showCreateFlow && (
                <div className="bg-bg-card border-2 border-opt-yellow/40 rounded-2xl p-4 flex items-center gap-3">
                  <input
                    autoFocus value={newFlowName} onChange={e => setNewFlowName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreateFlow()}
                    placeholder="Flow name (e.g. Restoration Cold Outreach)"
                    className="flex-1 bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary focus:border-opt-yellow/50 outline-none"
                  />
                  <button onClick={handleCreateFlow} className="px-4 py-2 rounded-xl text-xs font-semibold bg-opt-yellow text-bg-primary hover:brightness-110">Create</button>
                  <button onClick={() => { setShowCreateFlow(false); setNewFlowName('') }} className="text-text-400 hover:text-text-primary"><X size={16} /></button>
                </div>
              )}

              {flowGroupStats.length === 0 && !showCreateFlow && (
                <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center">
                  <Mail size={32} className="text-text-400/30 mx-auto mb-3" />
                  <p className="text-text-primary font-medium mb-1">No flows yet</p>
                  <p className="text-xs text-text-400 mb-4">Create a flow to group and monitor your email automations.</p>
                  <button onClick={() => setShowCreateFlow(true)} className="px-4 py-2 rounded-xl text-xs font-medium bg-opt-yellow text-bg-primary hover:brightness-110">
                    <Plus size={12} className="inline mr-1.5" /> Create First Flow
                  </button>
                </div>
              )}

              {flowGroupStats.map(fg => {
                const isExpanded = expandedFlow === fg.id
                const isAdding = addingToFlow === fg.id
                return (
                  <div key={fg.id} className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
                    {/* Flow header */}
                    <div className="flex items-center justify-between px-4 py-3 hover:bg-bg-card-hover transition-colors">
                      <button onClick={() => setExpandedFlow(isExpanded ? null : fg.id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                        <div className="w-2 h-8 rounded-full" style={{ backgroundColor: fg.color || '#f0e050' }} />
                        <div className="flex-1 min-w-0">
                          <h3 className="text-sm font-semibold text-text-primary truncate">{fg.name}</h3>
                          {fg.description && <p className="text-[10px] text-text-400 truncate">{fg.description}</p>}
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-opt-yellow/20 text-opt-yellow font-semibold shrink-0">
                          {fg.emails.length} email{fg.emails.length === 1 ? '' : 's'}
                        </span>
                      </button>
                      <div className="flex items-center gap-4 ml-4 text-xs shrink-0">
                        <div className="text-right"><div className="text-[9px] text-text-400 uppercase">Sent</div><div className="font-bold">{fg.sent.toLocaleString()}</div></div>
                        <div className="text-right min-w-[50px]"><div className="text-[9px] text-text-400 uppercase">Open</div><div className={`font-bold ${rateColor(fg.openRate, 40, 20)}`}>{fg.openRate}%</div></div>
                        <div className="text-right min-w-[50px]"><div className="text-[9px] text-text-400 uppercase">Click</div><div className={`font-bold ${rateColor(fg.clickRate, 5, 2)}`}>{fg.clickRate}%</div></div>
                        <div className="text-right min-w-[50px]"><div className="text-[9px] text-text-400 uppercase">Reply</div><div className={`font-bold ${rateColor(fg.replyRate, 10, 3)}`}>{fg.replyRate}%</div></div>
                        <button onClick={() => setExpandedFlow(isExpanded ? null : fg.id)} className="text-text-400">
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                      </div>
                    </div>

                    {/* Expanded: email list + add/remove */}
                    {isExpanded && (
                      <div className="border-t border-border-default">
                        {/* Action bar */}
                        <div className="px-4 py-2 bg-bg-primary/30 flex items-center justify-between">
                          <button onClick={() => setAddingToFlow(isAdding ? null : fg.id)} className="flex items-center gap-1.5 text-xs text-opt-yellow hover:underline">
                            <Plus size={12} /> Add Emails
                          </button>
                          <button onClick={() => handleDeleteFlow(fg.id)} className="flex items-center gap-1 text-[10px] text-danger/60 hover:text-danger">
                            <Trash2 size={10} /> Delete Flow
                          </button>
                        </div>

                        {/* Add emails picker */}
                        {isAdding && (
                          <div className="px-4 py-3 bg-opt-yellow/5 border-b border-opt-yellow/20">
                            <div className="flex items-center gap-2 mb-2">
                              <Search size={12} className="text-text-400" />
                              <input
                                autoFocus value={emailSearch} onChange={e => setEmailSearch(e.target.value)}
                                placeholder="Search email subjects to add..."
                                className="flex-1 bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs text-text-primary outline-none focus:border-opt-yellow/40"
                              />
                              <button onClick={() => { setAddingToFlow(null); setEmailSearch('') }} className="text-text-400 hover:text-text-primary"><X size={14} /></button>
                            </div>
                            <div className="max-h-48 overflow-y-auto space-y-0.5">
                              {filteredAvailable.length === 0 && (
                                <p className="text-[10px] text-text-400 py-2">{emailSearch.length >= 2 ? 'No matching emails' : 'All emails are already assigned to flows'}</p>
                              )}
                              {filteredAvailable.map(s => (
                                <button
                                  key={s.subject}
                                  onClick={() => handleAddEmailToFlow(s.subject, fg.id)}
                                  className="w-full text-left flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-opt-yellow/10 transition-colors"
                                >
                                  <span className="text-xs text-text-primary truncate flex-1 mr-2">{s.subject}</span>
                                  <span className="text-[10px] text-text-400 shrink-0">{s.sent} sent · {s.openRate}% open</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Email subjects in this flow */}
                        {fg.emails.length > 0 ? (
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-[10px] text-text-400 uppercase border-b border-border-default/50 bg-bg-primary/20">
                                  <th className="text-left px-4 py-2 font-medium">Subject</th>
                                  <Th label="Sent" k="sent" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                  <Th label="Opened" k="opened" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                  <Th label="Clicked" k="clicked" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                  <Th label="Open %" k="openRate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                  <Th label="Click %" k="clickRate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                  <Th label="Reply %" k="replyRate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                  <th className="text-right px-3 py-2 font-medium">Last Sent</th>
                                  <th className="w-8"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {sortedStats(fg.emails).map((s, i) => [
                                  <tr key={s.subject} className={`border-b border-border-default/20 ${i % 2 ? 'bg-bg-primary/10' : ''} cursor-pointer hover:bg-opt-yellow/5`} onClick={() => toggleEmailDetail(s.subject)}>
                                    <td className="px-4 py-2 text-text-primary truncate max-w-md" title={s.subject}>
                                      <span className="inline-flex items-center gap-1.5">
                                        {expandedEmail === s.subject ? <ChevronUp size={10} className="text-opt-yellow shrink-0" /> : <ChevronDown size={10} className="text-text-400 shrink-0" />}
                                        {s.subject}
                                      </span>
                                      {s.variants > 1 && <span className="ml-1.5 text-[9px] text-text-400">({s.variants}v)</span>}
                                    </td>
                                    <td className="text-right px-3 py-2 font-semibold">{s.sent}</td>
                                    <td className="text-right px-3 py-2 text-text-400">{s.opened}</td>
                                    <td className="text-right px-3 py-2 text-text-400">{s.clicked}</td>
                                    <td className={`text-right px-3 py-2 font-semibold ${rateColor(s.openRate, 40, 20)}`}>{s.openRate}%</td>
                                    <td className={`text-right px-3 py-2 font-semibold ${rateColor(s.clickRate, 5, 2)}`}>{s.clickRate}%</td>
                                    <td className={`text-right px-3 py-2 font-semibold ${rateColor(s.replyRate || 0, 10, 3)}`}>{s.replyRate || 0}%</td>
                                    <td className="text-right px-3 py-2 text-text-400 whitespace-nowrap">{fmtDate(s.lastSent)}</td>
                                    <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
                                      <button onClick={() => handleRemoveFromFlow(s.subject)} className="text-text-400/30 hover:text-danger" title="Remove from flow"><X size={12} /></button>
                                    </td>
                                  </tr>,
                                  expandedEmail === s.subject && (
                                    <tr key={s.subject + '-detail'}>
                                      <td colSpan={9} className="px-4 py-3 bg-bg-primary/30">
                                        <RecipientDetail recipients={emailRecipients} loading={loadingRecipients} />
                                      </td>
                                    </tr>
                                  )
                                ])}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <p className="px-4 py-4 text-text-400 text-xs text-center">No emails in this flow yet. Click "Add Emails" to get started.</p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ═══ ALL EMAILS VIEW ═══ */}
          {view === 'all' && (
            <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
                <h3 className="text-[11px] text-opt-yellow uppercase font-medium">All Emails ({visibleStats.length})</h3>
                <span className="text-[10px] text-text-400">{visibleStats.length} of {stats.length} (min {minSends} sends)</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-text-400 uppercase border-b border-border-default">
                      <Th label="Subject" k="subject" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="left" />
                      <th className="text-left px-2 py-2.5 font-medium">Flow</th>
                      <Th label="Sent" k="sent" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <Th label="Open %" k="openRate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <Th label="Click %" k="clickRate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <Th label="Reply %" k="replyRate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <th className="text-right px-3 py-2.5 font-medium">Last Sent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedStats(visibleStats).map((s, i) => {
                      const meta = subjectMeta[s.subject]
                      const assignedFlow = meta?.flow_group_id ? flowGroups.find(fg => fg.id === meta.flow_group_id) : null
                      const isExp = expandedEmail === s.subject
                      return [
                        <tr key={s.subject} className={`border-b border-border-default/50 ${i % 2 ? 'bg-bg-primary/30' : ''} hover:bg-bg-card-hover cursor-pointer`} onClick={() => toggleEmailDetail(s.subject)}>
                          <td className="px-4 py-2.5 text-text-primary truncate max-w-md" title={s.subject}>
                            <span className="inline-flex items-center gap-1.5">
                              {isExp ? <ChevronUp size={10} className="text-opt-yellow shrink-0" /> : <ChevronDown size={10} className="text-text-400 shrink-0" />}
                              {s.subject}
                            </span>
                            {s.variants > 1 && <span className="ml-1.5 text-[9px] text-text-400">({s.variants}v)</span>}
                          </td>
                          <td className="px-2 py-2.5" onClick={e => e.stopPropagation()}>
                            {assignedFlow ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: (assignedFlow.color || '#f0e050') + '30', color: assignedFlow.color || '#f0e050' }}>
                                {assignedFlow.name}
                              </span>
                            ) : (
                              <select
                                className="bg-transparent text-[10px] text-text-400 cursor-pointer hover:text-opt-yellow outline-none"
                                value=""
                                onChange={e => e.target.value && handleAddEmailToFlow(s.subject, e.target.value)}
                              >
                                <option value="">Add to…</option>
                                {flowGroups.map(fg => <option key={fg.id} value={fg.id}>{fg.name}</option>)}
                              </select>
                            )}
                          </td>
                          <td className="text-right px-3 py-2.5 font-semibold">{s.sent}</td>
                          <td className={`text-right px-3 py-2.5 font-semibold ${rateColor(s.openRate, 40, 20)}`}>{s.openRate}%</td>
                          <td className={`text-right px-3 py-2.5 font-semibold ${rateColor(s.clickRate, 5, 2)}`}>{s.clickRate}%</td>
                          <td className={`text-right px-3 py-2.5 font-semibold ${rateColor(s.replyRate || 0, 10, 3)}`}>{s.replyRate || 0}%</td>
                          <td className="text-right px-3 py-2.5 text-text-400 whitespace-nowrap">{fmtDate(s.lastSent)}</td>
                        </tr>,
                        isExp && (
                          <tr key={s.subject + '-detail'}>
                            <td colSpan={7} className="px-4 py-3 bg-bg-primary/30 border-b border-border-default/50">
                              <RecipientDetail recipients={emailRecipients} loading={loadingRecipients} />
                            </td>
                          </tr>
                        )
                      ]
                    })}
                    {visibleStats.length === 0 && (
                      <tr><td colSpan={7} className="px-4 py-8 text-center text-text-400 text-xs">No emails above {minSends} sends. Sync data or lower the threshold.</td></tr>
                    )}
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

function RecipientDetail({ recipients, loading }) {
  if (loading) return <div className="flex items-center justify-center py-4"><Loader size={14} className="animate-spin text-opt-yellow" /></div>
  if (!recipients?.length) return <p className="text-[10px] text-text-400 text-center py-3">No recipient data available.</p>

  const statusIcon = (status, replied) => {
    if (replied) return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-semibold">Replied</span>
    if (status === 'clicked') return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-success/20 text-success font-semibold">Clicked</span>
    if (status === 'opened') return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-opt-yellow/20 text-opt-yellow font-semibold">Opened</span>
    if (status === 'delivered') return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-text-400/15 text-text-400 font-semibold">Delivered</span>
    if (status === 'failed') return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-danger/20 text-danger font-semibold">Failed</span>
    return <span className="text-[9px] text-text-400">{status || '—'}</span>
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-2 text-[10px] text-text-400">
        <span>{recipients.length} recipients</span>
        <span className="text-success">{recipients.filter(r => r.status === 'opened' || r.status === 'clicked').length} opened</span>
        <span className="text-blue-400">{recipients.filter(r => r.replied).length} replied</span>
        <span className="text-danger">{recipients.filter(r => r.status === 'failed').length} failed</span>
      </div>
      <div className="max-h-48 overflow-y-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[9px] text-text-400 uppercase border-b border-border-default/30">
              <th className="text-left px-2 py-1 font-medium">Contact</th>
              <th className="text-left px-2 py-1 font-medium">Subject Sent</th>
              <th className="text-left px-2 py-1 font-medium">Status</th>
              <th className="text-right px-2 py-1 font-medium">Date</th>
            </tr>
          </thead>
          <tbody>
            {recipients.map((r, i) => (
              <tr key={r.id || i} className="border-b border-border-default/15">
                <td className="px-2 py-1 text-text-primary font-medium">{r.contactName}</td>
                <td className="px-2 py-1 text-text-400 truncate max-w-[250px]">{r.rawSubject}</td>
                <td className="px-2 py-1">{statusIcon(r.status, r.replied)}</td>
                <td className="text-right px-2 py-1 text-text-400 whitespace-nowrap">{r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Th({ label, k, sortKey, sortDir, onSort, align = 'right' }) {
  const active = sortKey === k
  return (
    <th onClick={() => onSort(k)} className={`px-3 py-2.5 font-medium cursor-pointer select-none hover:text-opt-yellow transition-colors text-${align}`}>
      <span className={`inline-flex items-center gap-1 ${active ? 'text-opt-yellow' : ''}`}>
        {label}
        {active && (sortDir === 'asc' ? <ArrowUp size={9} /> : <ArrowDown size={9} />)}
      </span>
    </th>
  )
}
