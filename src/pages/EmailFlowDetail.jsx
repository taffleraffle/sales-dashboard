import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Loader, ArrowLeft, Mail, Trash2, Plus, X, Search, ChevronDown, ChevronUp, ArrowUp, ArrowDown, Pencil, GripVertical } from 'lucide-react'
import KPICard from '../components/KPICard'
import ConfirmModal from '../components/ConfirmModal'
import EditFlowModal from '../components/EditFlowModal'
import DateRangeSelector from '../components/DateRangeSelector'
import { sinceDate } from '../lib/dateUtils'
import { useToast } from '../hooks/useToast'
import {
  loadEmailStats, loadSubjectMeta, loadFlowGroups,
  deleteFlowGroup, assignSubjectsToFlow, removeSubjectFromFlow,
  loadEmailRecipients, updateFlowGroup,
} from '../services/ghlEmailFlows'
import { supabase } from '../lib/supabase'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

export default function EmailFlowDetail() {
  const { flowId } = useParams()
  const navigate = useNavigate()

  const [range, setRange] = useState(30)
  const [flow, setFlow] = useState(null)
  const [stats, setStats] = useState([])
  const [subjectMeta, setSubjectMeta] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showDelete, setShowDelete] = useState(false)
  const [showAddEmails, setShowAddEmails] = useState(false)
  const [emailSearch, setEmailSearch] = useState('')
  const [expandedEmail, setExpandedEmail] = useState(null)
  const [emailRecipients, setEmailRecipients] = useState([])
  const [loadingRecipients, setLoadingRecipients] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const toast = useToast()

  const fromDate = sinceDate(range)
  const toDate = (typeof range === 'object' && range.to) ? range.to : new Date().toLocaleDateString('en-CA')

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [allStats, allMeta, flowGroups] = await Promise.all([
        loadEmailStats(fromDate, toDate),
        loadSubjectMeta(),
        loadFlowGroups(),
      ])
      const thisFlow = flowGroups.find(fg => fg.id === flowId)
      if (!thisFlow) { setError('Flow not found'); setLoading(false); return }
      setFlow(thisFlow)
      setStats(allStats)
      setSubjectMeta(allMeta)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  useEffect(() => { loadData() }, [range, flowId])

  // Emails in this flow, sorted by sort_order
  const flowEmails = useMemo(() => {
    if (!flow) return []
    return stats
      .filter(s => subjectMeta[s.subject]?.flow_group_id === flowId)
      .map(s => ({ ...s, sort_order: subjectMeta[s.subject]?.sort_order || 0 }))
      .sort((a, b) => a.sort_order - b.sort_order)
  }, [stats, subjectMeta, flow, flowId])

  // Aggregated stats for side panel
  const totals = useMemo(() => {
    const t = flowEmails.reduce((a, s) => ({
      sent: a.sent + s.sent, delivered: a.delivered + s.delivered,
      opened: a.opened + s.opened, clicked: a.clicked + s.clicked, replied: a.replied + (s.replied || 0),
    }), { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0 })
    return {
      ...t,
      deliveryRate: t.sent > 0 ? ((t.delivered / t.sent) * 100).toFixed(1) : 0,
      openRate: t.delivered > 0 ? ((t.opened / t.delivered) * 100).toFixed(1) : 0,
      clickRate: t.delivered > 0 ? ((t.clicked / t.delivered) * 100).toFixed(1) : 0,
      replyRate: t.delivered > 0 ? ((t.replied / t.delivered) * 100).toFixed(1) : 0,
    }
  }, [flowEmails])

  // Available emails to add (not in any flow)
  const availableEmails = useMemo(() => {
    return stats.filter(s => {
      const meta = subjectMeta[s.subject]
      return !meta?.flow_group_id && s.sent >= 1
    })
  }, [stats, subjectMeta])

  const filteredAvailable = emailSearch.length >= 2
    ? availableEmails.filter(s => s.subject.toLowerCase().includes(emailSearch.toLowerCase()))
    : availableEmails.slice(0, 30)

  const handleDelete = async () => {
    if (deleting) return
    setDeleting(true)
    try {
      const ok = await deleteFlowGroup(flowId)
      if (!ok) throw new Error('Delete returned false')
      toast.success(`Deleted "${flow.name}"`)
      navigate('/sales/email-flows')
    } catch (e) {
      toast.error(`Failed to delete: ${e.message || e}`)
      setDeleting(false)
    }
  }

  const handleSaveEdit = async (updates) => {
    const updated = await updateFlowGroup(flowId, updates)
    if (!updated) throw new Error('Update failed')
    setFlow(prev => ({ ...prev, ...updates }))
    toast.success('Flow updated')
  }

  const handleAddEmail = async (subject) => {
    const maxOrder = flowEmails.reduce((max, e) => Math.max(max, e.sort_order), 0)
    // Optimistic update — remove from available list immediately
    setSubjectMeta(prev => ({
      ...prev,
      [subject]: { ...(prev[subject] || {}), subject, flow_group_id: flowId, sort_order: maxOrder + 1 }
    }))
    await assignSubjectsToFlow([subject], flowId)
    await supabase.from('email_subject_meta')
      .update({ sort_order: maxOrder + 1, updated_at: new Date().toISOString() })
      .eq('subject', subject)
  }

  const handleRemoveEmail = async (subject) => {
    await removeSubjectFromFlow(subject)
    setSubjectMeta(prev => ({ ...prev, [subject]: { ...(prev[subject] || {}), flow_group_id: null } }))
  }

  // Shared reorder helper — dnd handler and arrow buttons both call this.
  // Accepts the full ordered array of emails, computes new sort_orders, persists.
  const persistEmailOrder = async (newEmails) => {
    setReordering(true)
    const now = new Date().toISOString()
    const updates = newEmails.map((e, i) => ({ subject: e.subject, sort_order: i + 1 }))
    const updatedMeta = { ...subjectMeta }
    for (const u of updates) {
      updatedMeta[u.subject] = { ...(updatedMeta[u.subject] || {}), sort_order: u.sort_order }
    }
    setSubjectMeta(updatedMeta)
    const { error } = await supabase.from('email_subject_meta')
      .upsert(
        updates.map(u => ({ ...subjectMeta[u.subject], subject: u.subject, sort_order: u.sort_order, updated_at: now })),
        { onConflict: 'subject' }
      )
    setReordering(false)
    if (error) toast.error(`Reorder failed: ${error.message}`)
  }

  const handleMoveEmail = async (index, direction) => {
    if (reordering) return
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= flowEmails.length) return
    const newEmails = [...flowEmails]
    ;[newEmails[index], newEmails[targetIndex]] = [newEmails[targetIndex], newEmails[index]]
    await persistEmailOrder(newEmails)
  }

  const handleDragEnd = async (event) => {
    const { active, over } = event
    if (!over || active.id === over.id || reordering) return
    const oldIndex = flowEmails.findIndex(e => e.subject === active.id)
    const newIndex = flowEmails.findIndex(e => e.subject === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    await persistEmailOrder(arrayMove(flowEmails, oldIndex, newIndex))
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const toggleEmailDetail = async (subject) => {
    if (expandedEmail === subject) { setExpandedEmail(null); return }
    setEmailRecipients([])
    setExpandedEmail(subject)
    setLoadingRecipients(true)
    try {
      const recipients = await Promise.race([
        loadEmailRecipients(subject, fromDate, toDate, (refreshed) => {
          // onNamesResolved: swap the "Unknown" names for real ones
          // once the background GHL resolver finishes, if the dropdown
          // for this subject is still open.
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

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader className="animate-spin text-opt-yellow" size={24} /></div>
  }

  if (error || !flow) {
    return (
      <div className="py-20 text-center">
        <p className="text-danger text-sm mb-4">{error || 'Flow not found'}</p>
        <Link to="/sales/email-flows" className="text-opt-yellow text-xs hover:underline">← Back to Email Flows</Link>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/sales/email-flows')} className="p-2 rounded-xl hover:bg-bg-card text-text-400 hover:text-text-primary transition-colors">
            <ArrowLeft size={18} />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-2 h-8 rounded-full" style={{ backgroundColor: flow.color || '#f0e050' }} />
            <div>
              <h1 className="text-lg font-bold text-text-primary">{flow.name}</h1>
              <p className="text-xs text-text-400">
                Email Flows / <span className="text-text-primary">{flow.name}</span>
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <DateRangeSelector selected={range} onChange={setRange} />
          <button onClick={() => setShowEdit(true)} className="p-2 rounded-xl text-text-400 hover:text-opt-yellow hover:bg-opt-yellow-subtle transition-all" title="Edit flow">
            <Pencil size={16} />
          </button>
          <button onClick={() => setShowDelete(true)} className="p-2 rounded-xl text-text-400 hover:text-danger hover:bg-danger/10 transition-all" title="Delete flow">
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {/* Main layout: content + side panel */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Left: Email list */}
        <div className="flex-1 min-w-0">
          {/* Action bar */}
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs text-text-400 uppercase font-medium">
              Emails in Sequence ({flowEmails.length})
            </h2>
            <button onClick={() => setShowAddEmails(!showAddEmails)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-opt-yellow text-bg-primary hover:brightness-110">
              <Plus size={14} /> Add Emails
            </button>
          </div>

          {/* Add emails picker */}
          {showAddEmails && (
            <div className="mb-4 bg-bg-card border border-opt-yellow/30 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Search size={14} className="text-text-400" />
                <input
                  autoFocus value={emailSearch} onChange={e => setEmailSearch(e.target.value)}
                  placeholder="Search email subjects to add..."
                  className="flex-1 bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-xs text-text-primary outline-none focus:border-opt-yellow/40"
                />
                <button onClick={() => { setShowAddEmails(false); setEmailSearch('') }} className="p-1.5 text-text-400 hover:text-text-primary">
                  <X size={16} />
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {filteredAvailable.length === 0 && (
                  <p className="text-xs text-text-400 py-2 text-center">{emailSearch.length >= 2 ? 'No matching emails' : 'All emails are already assigned to flows'}</p>
                )}
                {filteredAvailable.map(s => (
                  <button
                    key={s.subject}
                    onClick={() => handleAddEmail(s.subject)}
                    className="w-full text-left flex items-center justify-between px-3 py-2 rounded-xl hover:bg-opt-yellow/10 transition-colors"
                  >
                    <span className="text-xs text-text-primary truncate flex-1 mr-3">{s.subject}</span>
                    <span className="text-[11px] text-text-400 shrink-0">{s.sent} sent · {s.openRate}% open</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Ordered email list */}
          {flowEmails.length === 0 ? (
            <div className="tile tile-feedback p-8 text-center">
              <Mail size={28} className="text-text-400/30 mx-auto mb-3" />
              <p className="text-text-primary font-medium mb-1">No emails in this flow</p>
              <p className="text-xs text-text-400 mb-4">Add emails to track their performance in sequence.</p>
              <button onClick={() => setShowAddEmails(true)} className="px-4 py-2 rounded-xl text-xs font-medium bg-opt-yellow text-bg-primary hover:brightness-110">
                <Plus size={14} className="inline mr-1.5" /> Add First Email
              </button>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={flowEmails.map(e => e.subject)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-2">
                  {flowEmails.map((email, index) => (
                    <SortableEmailRow
                      key={email.subject}
                      email={email}
                      index={index}
                      isExpanded={expandedEmail === email.subject}
                      isLast={index === flowEmails.length - 1}
                      reordering={reordering}
                      onToggleDetail={() => toggleEmailDetail(email.subject)}
                      onMoveUp={() => handleMoveEmail(index, -1)}
                      onMoveDown={() => handleMoveEmail(index, 1)}
                      onRemove={() => handleRemoveEmail(email.subject)}
                      rateColor={rateColor}
                      recipients={emailRecipients}
                      loadingRecipients={loadingRecipients}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* Right: Stats side panel */}
        <div className="lg:w-72 shrink-0">
          <div className="tile tile-feedback p-4 space-y-3 lg:sticky lg:top-4">
            <h3 className="text-[11px] text-text-400 uppercase font-medium mb-2">Flow Performance</h3>
            <div className="space-y-3">
              <StatRow label="Total Sent" value={totals.sent.toLocaleString()} />
              <StatRow label="Delivered" value={`${totals.deliveryRate}%`} sub={`${totals.delivered.toLocaleString()} emails`} />
              <StatRow label="Open Rate" value={`${totals.openRate}%`} sub={`${totals.opened.toLocaleString()} opens`} color={rateColor(parseFloat(totals.openRate), 40, 20)} />
              <StatRow label="Click Rate" value={`${totals.clickRate}%`} sub={`${totals.clicked.toLocaleString()} clicks`} color={rateColor(parseFloat(totals.clickRate), 5, 2)} />
              <StatRow label="Reply Rate" value={`${totals.replyRate}%`} sub={`${totals.replied.toLocaleString()} replies`} color={rateColor(parseFloat(totals.replyRate), 10, 3)} />
            </div>

            {/* Drop-off visualization */}
            {flowEmails.length >= 2 && (
              <div className="pt-3 border-t border-border-default">
                <h4 className="text-[10px] text-text-400 uppercase font-medium mb-2">Open Rate Drop-off</h4>
                <div className="space-y-1.5">
                  {flowEmails.map((e, i) => {
                    const barWidth = e.openRate > 0 ? Math.max(8, (e.openRate / Math.max(...flowEmails.map(x => x.openRate || 1))) * 100) : 8
                    return (
                      <div key={e.subject} className="flex items-center gap-2">
                        <span className="text-[10px] text-opt-yellow font-bold w-4 shrink-0">{i + 1}</span>
                        <div className="flex-1 bg-bg-primary rounded-full h-4 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-opt-yellow/40 flex items-center px-2"
                            style={{ width: `${barWidth}%` }}
                          >
                            <span className="text-[9px] font-bold text-text-primary whitespace-nowrap">{e.openRate}%</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Delete modal */}
      <ConfirmModal
        open={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete Flow"
        message={`Are you sure you want to delete "${flow.name}"? All emails will be unassigned. This cannot be undone.`}
        confirmLabel="Delete Flow"
        variant="danger"
      />

      {/* Edit modal */}
      <EditFlowModal
        flow={showEdit ? flow : null}
        onClose={() => setShowEdit(false)}
        onSave={handleSaveEdit}
      />
    </div>
  )
}

function SortableEmailRow({ email, index, isExpanded, isLast, reordering, onToggleDetail, onMoveUp, onMoveDown, onRemove, rateColor, recipients, loadingRecipients }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: email.subject })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="tile tile-feedback overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 hover:bg-bg-card-hover transition-colors">
        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          className="p-1 text-text-400/40 hover:text-opt-yellow cursor-grab active:cursor-grabbing touch-none"
          title="Drag to reorder"
          aria-label="Drag to reorder email"
        >
          <GripVertical size={14} />
        </button>

        {/* Position + up/down fallback */}
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          <button
            onClick={onMoveUp}
            disabled={index === 0 || reordering}
            className="p-0.5 text-text-400 hover:text-opt-yellow disabled:opacity-20 disabled:hover:text-text-400 transition-colors"
            aria-label="Move up"
          >
            <ArrowUp size={12} />
          </button>
          <span className="text-[11px] font-bold text-opt-yellow w-5 text-center">{index + 1}</span>
          <button
            onClick={onMoveDown}
            disabled={isLast || reordering}
            className="p-0.5 text-text-400 hover:text-opt-yellow disabled:opacity-20 disabled:hover:text-text-400 transition-colors"
            aria-label="Move down"
          >
            <ArrowDown size={12} />
          </button>
        </div>

        {/* Subject */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onToggleDetail}>
          <div className="flex items-center gap-2">
            {isExpanded ? <ChevronUp size={14} className="text-opt-yellow shrink-0" /> : <ChevronDown size={14} className="text-text-400 shrink-0" />}
            <span className="text-sm text-text-primary truncate">{email.subject}</span>
            {email.variants > 1 && <span className="text-[10px] text-text-400">({email.variants}v)</span>}
          </div>
        </div>

        {/* Quick stats */}
        <div className="flex items-center gap-3 text-xs shrink-0">
          <div className="text-right hidden sm:block">
            <div className="text-[9px] text-text-400 uppercase">Sent</div>
            <div className="font-bold">{email.sent}</div>
          </div>
          <div className="text-right">
            <div className="text-[9px] text-text-400 uppercase">Open</div>
            <div className={`font-bold ${rateColor(email.openRate, 40, 20)}`}>{email.openRate}%</div>
          </div>
          <div className="text-right">
            <div className="text-[9px] text-text-400 uppercase">Click</div>
            <div className={`font-bold ${rateColor(email.clickRate, 5, 2)}`}>{email.clickRate}%</div>
          </div>
          <div className="text-right">
            <div className="text-[9px] text-text-400 uppercase">Reply</div>
            <div className={`font-bold ${rateColor(email.replyRate || 0, 10, 3)}`}>{email.replyRate || 0}%</div>
          </div>
          <button onClick={onRemove} className="p-1.5 text-text-400/30 hover:text-danger transition-colors" title="Remove from flow">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Expanded: recipients */}
      {isExpanded && (
        <div className="border-t border-border-default px-4 py-3 bg-bg-primary/30">
          <RecipientDetail recipients={recipients} loading={loadingRecipients} />
        </div>
      )}
    </div>
  )
}

function StatRow({ label, value, sub, color = 'text-text-primary' }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-400">{label}</span>
      <div className="text-right">
        <span className={`text-sm font-bold ${color}`}>{value}</span>
        {sub && <p className="text-[10px] text-text-400">{sub}</p>}
      </div>
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
