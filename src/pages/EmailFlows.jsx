import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Loader, Mail, AlertCircle, ArrowUp, ArrowDown, Plus, Trash2, X, ChevronRight, ChevronDown, ChevronUp, Pencil } from 'lucide-react'
import KPICard from '../components/KPICard'
import ConfirmModal from '../components/ConfirmModal'
import EditFlowModal from '../components/EditFlowModal'
import FlowPicker from '../components/FlowPicker'
import DateRangeSelector from '../components/DateRangeSelector'
import { sinceDate } from '../lib/dateUtils'
import { getLastSyncTime } from '../services/autoSync'
import { useToast } from '../hooks/useToast'
import {
  loadEmailStats, loadSubjectMeta,
  loadFlowGroups, createFlowGroup, deleteFlowGroup, updateFlowGroup,
  assignSubjectsToFlow, removeSubjectFromFlow, loadEmailRecipients,
  prewarmRecipientNameCache,
} from '../services/ghlEmailFlows'

export default function EmailFlows() {
  const [range, setRange] = useState(30)
  const [stats, setStats] = useState([])
  const [flowGroups, setFlowGroups] = useState([])
  const [subjectMeta, setSubjectMeta] = useState({})
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('flows') // 'flows' | 'all'
  const [minSends, setMinSends] = useState(1)
  const [flowFilter, setFlowFilter] = useState('all') // 'all' | 'unassigned' | flow_group_id
  const [sortKey, setSortKey] = useState('sent')
  const [sortDir, setSortDir] = useState('desc')
  const [newFlowName, setNewFlowName] = useState('')
  const [showCreateFlow, setShowCreateFlow] = useState(false)
  const [expandedEmail, setExpandedEmail] = useState(null)
  const [emailRecipients, setEmailRecipients] = useState([])
  const [loadingRecipients, setLoadingRecipients] = useState(false)
  const [error, setError] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [editingFlow, setEditingFlow] = useState(null)
  const toast = useToast()

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

  // Pre-warm the GHL contact-name cache. Without this, every recipient
  // dropdown opens showing "Unknown" for all rows until the background
  // resolver catches up. Kicking it off on page mount means names are
  // populated by the time the user expands their first email.
  useEffect(() => {
    prewarmRecipientNameCache(30)
      .then(r => {
        if (r?.resolved > 0) {
          console.log(`[prewarmRecipientNameCache] Resolved ${r.resolved} of ${r.checked} contacts`)
        }
      })
      .catch(() => {})
  }, [])

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const visibleStats = useMemo(() => {
    let filtered = stats.filter(s => s.sent >= minSends)
    if (flowFilter !== 'all') {
      filtered = filtered.filter(s => {
        const fgId = subjectMeta[s.subject]?.flow_group_id
        if (flowFilter === 'unassigned') return !fgId
        return fgId === flowFilter
      })
    }
    return filtered
  }, [stats, minSends, flowFilter, subjectMeta])

  // Sorted version of visibleStats. Previously this was an inline function re-creating
  // the sorted array on every render — with hundreds of emails, that thrashed the UI on
  // every hover, keystroke, or state change. Memoize on the exact inputs.
  const sortedVisibleStats = useMemo(() => {
    return [...visibleStats].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey]
      if (sortKey === 'lastSent') { av = new Date(av || 0).getTime(); bv = new Date(bv || 0).getTime() }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [visibleStats, sortKey, sortDir])

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
    }
  }

  const handleDeleteFlow = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      const ok = await deleteFlowGroup(deleteTarget)
      if (!ok) throw new Error('Delete returned false')
      const flowName = flowGroups.find(fg => fg.id === deleteTarget)?.name || 'Flow'
      setFlowGroups(prev => prev.filter(fg => fg.id !== deleteTarget))
      const updated = { ...subjectMeta }
      for (const [k, v] of Object.entries(updated)) {
        if (v.flow_group_id === deleteTarget) updated[k] = { ...v, flow_group_id: null }
      }
      setSubjectMeta(updated)
      toast.success(`Deleted "${flowName}"`)
      setDeleteTarget(null)
    } catch (e) {
      toast.error(`Failed to delete flow: ${e.message || e}`)
    }
    setDeleting(false)
  }

  const handleSaveFlowEdit = async (updates) => {
    if (!editingFlow) return
    const updated = await updateFlowGroup(editingFlow.id, updates)
    if (!updated) throw new Error('Update failed — check console for details')
    setFlowGroups(prev => prev.map(fg => fg.id === editingFlow.id ? { ...fg, ...updates } : fg))
    toast.success(`Updated "${updates.name}"`)
  }

  const handleAddEmailToFlow = async (subject, flowGroupId) => {
    await assignSubjectsToFlow([subject], flowGroupId)
    setSubjectMeta(prev => ({ ...prev, [subject]: { ...(prev[subject] || {}), subject, flow_group_id: flowGroupId } }))
  }

  const toggleEmailDetail = async (subject) => {
    if (expandedEmail === subject) { setExpandedEmail(null); return }
    setExpandedEmail(subject)
    setLoadingRecipients(true)
    setEmailRecipients([])
    try {
      // 15s timeout so the UI never hangs forever. onNamesResolved re-fires
      // setEmailRecipients once the background GHL fetch completes so the
      // open dropdown updates in-place from "Unknown" to the real names.
      const recipients = await Promise.race([
        loadEmailRecipients(subject, fromDate, toDate, (refreshed) => {
          // Only apply the refresh if the same row is still open.
          setExpandedEmail(current => {
            if (current === subject) setEmailRecipients(refreshed)
            return current
          })
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Loading recipients timed out after 15s')), 15000)),
      ])
      setEmailRecipients(recipients)
    } catch (e) {
      toast.error(`Couldn't load recipients: ${e.message || e}`)
      setEmailRecipients([])
    }
    setLoadingRecipients(false)
  }

  const rateColor = (v, good, ok) => v >= good ? 'text-success' : v >= ok ? 'text-opt-yellow' : 'text-danger'
  const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'

  // Last sync display
  const lastSync = getLastSyncTime('emailFlows')
  const lastSyncLabel = lastSync
    ? `Auto-synced ${Math.round((Date.now() - lastSync) / 60000)}m ago`
    : 'Awaiting first sync'

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-lg sm:text-xl font-bold flex items-center gap-2">
            <Mail size={20} className="text-opt-yellow" /> Email Flows
          </h1>
          <p className="text-xs text-text-400">{lastSyncLabel}</p>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {error && (
        <div className="mb-4 px-4 py-2 bg-danger/10 border border-danger/30 rounded-xl text-xs text-danger flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* KPIs */}
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
              <Plus size={14} /> New Flow
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
              {showCreateFlow && (
                <div className="bg-bg-card border-2 border-opt-yellow/40 rounded-2xl p-4 flex items-center gap-3">
                  <input
                    autoFocus value={newFlowName} onChange={e => setNewFlowName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreateFlow()}
                    placeholder="Flow name (e.g. Restoration Cold Outreach)"
                    className="flex-1 bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary focus:border-opt-yellow/50 outline-none"
                  />
                  <button onClick={handleCreateFlow} className="px-4 py-2 rounded-xl text-xs font-semibold bg-opt-yellow text-bg-primary hover:brightness-110">Create</button>
                  <button onClick={() => { setShowCreateFlow(false); setNewFlowName('') }} className="p-1.5 text-text-400 hover:text-text-primary"><X size={16} /></button>
                </div>
              )}

              {flowGroupStats.length === 0 && !showCreateFlow && (
                <div className="tile tile-feedback p-8 text-center">
                  <Mail size={32} className="text-text-400/30 mx-auto mb-3" />
                  <p className="text-text-primary font-medium mb-1">No flows yet</p>
                  <p className="text-xs text-text-400 mb-4">Create a flow to group and monitor your email automations.</p>
                  <button onClick={() => setShowCreateFlow(true)} className="px-4 py-2 rounded-xl text-xs font-medium bg-opt-yellow text-bg-primary hover:brightness-110">
                    <Plus size={14} className="inline mr-1.5" /> Create First Flow
                  </button>
                </div>
              )}

              {flowGroupStats.map(fg => (
                <div key={fg.id} className="tile tile-feedback overflow-hidden hover:border-opt-yellow/30 transition-colors group">
                  <div className="flex items-center justify-between px-4 py-4">
                    <Link to={`/sales/email-flows/${fg.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="w-2 h-10 rounded-full" style={{ backgroundColor: fg.color || '#f0e050' }} />
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-text-primary truncate group-hover:text-opt-yellow transition-colors">{fg.name}</h3>
                        {fg.description && <p className="text-[11px] text-text-400 truncate">{fg.description}</p>}
                      </div>
                      <span className="text-[11px] px-2.5 py-1 rounded-full bg-opt-yellow/20 text-opt-yellow font-semibold shrink-0">
                        {fg.emails.length} email{fg.emails.length === 1 ? '' : 's'}
                      </span>
                    </Link>
                    <div className="flex items-center gap-4 ml-4 text-xs shrink-0">
                      <div className="text-right hidden sm:block"><div className="text-[10px] text-text-400 uppercase">Sent</div><div className="font-bold">{fg.sent.toLocaleString()}</div></div>
                      <div className="text-right min-w-[50px]"><div className="text-[10px] text-text-400 uppercase">Open</div><div className={`font-bold ${rateColor(fg.openRate, 40, 20)}`}>{fg.openRate}%</div></div>
                      <div className="text-right min-w-[50px]"><div className="text-[10px] text-text-400 uppercase">Click</div><div className={`font-bold ${rateColor(fg.clickRate, 5, 2)}`}>{fg.clickRate}%</div></div>
                      <div className="text-right min-w-[50px]"><div className="text-[10px] text-text-400 uppercase">Reply</div><div className={`font-bold ${rateColor(fg.replyRate, 10, 3)}`}>{fg.replyRate}%</div></div>
                      <button
                        onClick={(e) => { e.preventDefault(); setEditingFlow(fg) }}
                        className="p-1.5 text-text-400/50 hover:text-opt-yellow transition-colors"
                        title="Edit flow"
                      >
                        <Pencil size={14} />
                      </button>
                      <button onClick={(e) => { e.preventDefault(); setDeleteTarget(fg.id) }} className="p-1.5 text-text-400/30 hover:text-danger transition-colors" title="Delete flow">
                        <Trash2 size={14} />
                      </button>
                      <Link to={`/sales/email-flows/${fg.id}`} className="p-1.5 text-text-400 group-hover:text-opt-yellow transition-colors">
                        <ChevronRight size={16} />
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ═══ ALL EMAILS VIEW ═══ */}
          {view === 'all' && (
            <div className="tile tile-feedback overflow-hidden">
              <div className="px-4 py-3 border-b border-border-default flex flex-wrap items-center gap-3">
                <h3 className="text-[11px] text-opt-yellow uppercase font-medium">All Emails ({visibleStats.length})</h3>
                <select
                  value={flowFilter}
                  onChange={e => setFlowFilter(e.target.value)}
                  className="select-input text-[11px] py-1 px-2"
                  aria-label="Filter by flow"
                  title="Filter by flow"
                >
                  <option value="all">All flows</option>
                  <option value="unassigned">Unassigned</option>
                  {flowGroups.map(fg => (
                    <option key={fg.id} value={fg.id}>{fg.name}</option>
                  ))}
                </select>
                <span className="text-[10px] text-text-400 ml-auto">{visibleStats.length} of {stats.length} (min {minSends} sends)</span>
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
                    {sortedVisibleStats.map((s, i) => {
                      const meta = subjectMeta[s.subject]
                      const assignedFlow = meta?.flow_group_id ? flowGroups.find(fg => fg.id === meta.flow_group_id) : null
                      const isExp = expandedEmail === s.subject
                      return [
                        <tr key={s.subject} className={`border-b border-border-default/50 ${i % 2 ? 'bg-bg-primary/30' : ''} hover:bg-bg-card-hover cursor-pointer`} onClick={() => toggleEmailDetail(s.subject)}>
                          <td className="px-4 py-2.5 text-text-primary truncate max-w-md" title={s.subject}>
                            <span className="inline-flex items-center gap-1.5">
                              {isExp ? <ChevronUp size={14} className="text-opt-yellow shrink-0" /> : <ChevronDown size={14} className="text-text-400 shrink-0" />}
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
                              <FlowPicker
                                flowGroups={flowGroups}
                                onPick={(flowId) => handleAddEmailToFlow(s.subject, flowId)}
                              />
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
                      <tr><td colSpan={7} className="px-4 py-8 text-center text-text-400 text-xs">No emails above {minSends} sends. Data syncs automatically every 30 minutes.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Delete confirmation modal */}
      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteFlow}
        loading={deleting}
        title="Delete Flow"
        message="Are you sure you want to delete this flow? All emails will be unassigned from it. This cannot be undone."
        confirmLabel="Delete Flow"
        variant="danger"
      />

      {/* Edit flow modal */}
      <EditFlowModal
        flow={editingFlow}
        onClose={() => setEditingFlow(null)}
        onSave={handleSaveFlowEdit}
      />
    </div>
  )
}

function RecipientDetail({ recipients, loading }) {
  const [statusFilter, setStatusFilter] = useState('all')

  if (loading) return <div className="flex items-center justify-center py-4"><Loader size={16} className="animate-spin text-opt-yellow" /></div>
  if (!recipients?.length) return <p className="text-xs text-text-400 text-center py-3">No recipient data available.</p>

  const counts = {
    all: recipients.length,
    delivered: recipients.filter(r => r.status === 'delivered').length,
    opened: recipients.filter(r => r.status === 'opened' || r.status === 'clicked').length,
    clicked: recipients.filter(r => r.status === 'clicked').length,
    replied: recipients.filter(r => r.replied).length,
    failed: recipients.filter(r => r.status === 'failed').length,
  }

  const filtered = statusFilter === 'all' ? recipients : recipients.filter(r => {
    if (statusFilter === 'replied') return r.replied
    if (statusFilter === 'opened') return r.status === 'opened' || r.status === 'clicked'
    return r.status === statusFilter
  })

  const filters = [
    { key: 'all', label: 'All', color: 'text-text-primary' },
    { key: 'delivered', label: 'Delivered', color: 'text-text-400' },
    { key: 'opened', label: 'Opened', color: 'text-opt-yellow' },
    { key: 'clicked', label: 'Clicked', color: 'text-success' },
    { key: 'replied', label: 'Replied', color: 'text-blue-400' },
    { key: 'failed', label: 'Failed', color: 'text-danger' },
  ]

  const statusBadge = (status, replied) => {
    if (replied) return <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-semibold">Replied</span>
    if (status === 'clicked') return <span className="text-[10px] px-2 py-0.5 rounded-full bg-success/20 text-success font-semibold">Clicked</span>
    if (status === 'opened') return <span className="text-[10px] px-2 py-0.5 rounded-full bg-opt-yellow/20 text-opt-yellow font-semibold">Opened</span>
    if (status === 'delivered') return <span className="text-[10px] px-2 py-0.5 rounded-full bg-text-400/15 text-text-400 font-semibold">Delivered</span>
    if (status === 'failed') return <span className="text-[10px] px-2 py-0.5 rounded-full bg-danger/20 text-danger font-semibold">Failed</span>
    return <span className="text-[10px] text-text-400">{status || '—'}</span>
  }

  return (
    <div>
      {/* Status filter pills */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        {filters.map(f => (
          <button
            key={f.key}
            onClick={() => setStatusFilter(f.key)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
              statusFilter === f.key
                ? 'bg-opt-yellow/20 text-opt-yellow'
                : 'bg-bg-primary text-text-400 hover:text-text-primary'
            }`}
          >
            {f.label} ({counts[f.key]})
          </button>
        ))}
      </div>

      <div className="max-h-56 overflow-y-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[10px] text-text-400 uppercase border-b border-border-default/30">
              <th className="text-left px-2 py-1.5 font-medium">Contact</th>
              <th className="text-left px-2 py-1.5 font-medium">Subject Sent</th>
              <th className="text-left px-2 py-1.5 font-medium">Status</th>
              <th className="text-right px-2 py-1.5 font-medium">Date</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={r.id || i} className="border-b border-border-default/15 hover:bg-bg-card-hover/30">
                <td className="px-2 py-1.5 text-text-primary font-medium">{r.contactName}</td>
                <td className="px-2 py-1.5 text-text-400 truncate max-w-[250px]">{r.rawSubject}</td>
                <td className="px-2 py-1.5">{statusBadge(r.status, r.replied)}</td>
                <td className="text-right px-2 py-1.5 text-text-400 whitespace-nowrap">{r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={4} className="px-2 py-4 text-center text-text-400 text-xs">No recipients match this filter.</td></tr>
            )}
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
        {active && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </span>
    </th>
  )
}
