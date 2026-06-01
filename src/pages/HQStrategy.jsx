import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  Sparkles,
  Check,
  X,
  Edit3,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Target,
  AlertTriangle,
  ListChecks,
  FileText,
  Trash2,
  Layers,
} from 'lucide-react'

const KIND_LABELS = {
  content_brief: 'CONTENT BRIEF',
  content_draft: 'CONTENT DRAFT',
  gbp_post: 'GBP POST',
  citation_target: 'CITATION DRIFT',
  weekly_recap_curation: 'WEEKLY RECAP',
  ai_visibility_report: 'AI VISIBILITY',
  roadmap_update: '90-DAY ROADMAP',
  competitor_brief: 'COMPETITOR',
  win_curation: 'WIN CURATION',
  red_flag_review: 'RED FLAG',
  health_check_followup: 'GBP HEALTH',
  handoff_brief: 'HANDOFF BRIEF',
  handoff_review: 'HANDOFF REVIEW',
}

const STRUCTURED_KINDS = new Set([
  'content_brief',
  'roadmap_update',
  'handoff_brief',
  'handoff_review',
])

function isHandoffKind(kind) {
  return typeof kind === 'string' && kind.toLowerCase().includes('handoff')
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function timeUntil(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  if (s < 0) return 'OVERDUE'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function deriveHeadline(item) {
  const p = item.proposed_payload || {}
  return (
    p.headline
    || p.title
    || p.target_keyword
    || p.memo?.headline
    || p.summary
    || p.competitor
    || (typeof p.vision === 'string' ? p.vision.slice(0, 80) : null)
    || 'Untitled item'
  )
}

export default function HQStrategy() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterKind, setFilterKind] = useState('all')
  const [filterClient, setFilterClient] = useState('all')
  const [selected, setSelected] = useState(null)
  const [acting, setActing] = useState(false)
  const [notes, setNotes] = useState('')
  const [overrides, setOverrides] = useState({})
  const [editing, setEditing] = useState(false)
  const [clients, setClients] = useState([])

  useEffect(() => {
    (async () => {
      const { data: c } = await supabase.from('clients').select('id, business_name').order('business_name')
      setClients(c || [])
      await load()
      setLoading(false)
    })()

    const channel = supabase
      .channel('strategy-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'strategist_queue' }, () => load())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  async function load() {
    const { data } = await supabase
      .from('strategist_queue')
      .select('id, kind, priority, status, proposed_payload, strategist_notes, source_function, created_at, expires_at, reviewed_at, client_id, clients(business_name, primary_city, vertical, slug)')
      .in('status', ['pending', 'amended'])
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)
    setItems(data || [])
  }

  const filtered = useMemo(() => {
    return items.filter((i) => {
      if (filterKind !== 'all' && i.kind !== filterKind) return false
      if (filterClient !== 'all' && i.client_id !== filterClient) return false
      return true
    })
  }, [items, filterKind, filterClient])

  const stats = useMemo(() => {
    const overdue = items.filter((i) => new Date(i.expires_at) < new Date()).length
    const urgent = items.filter((i) => {
      const ms = new Date(i.expires_at).getTime() - Date.now()
      return ms > 0 && ms < 12 * 3600e3
    }).length
    const total = items.length
    return { total, overdue, urgent }
  }, [items])

  async function takeAction(action) {
    if (!selected) return
    setActing(true)
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/strategist-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
        body: JSON.stringify({
          queue_id: selected.id,
          action,
          overrides: action === 'amend' ? overrides : undefined,
          notes: notes || null,
          strategist_name: 'Mersad',
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) { alert(`Action failed: ${data.error || res.statusText}`); return }
      setSelected(null)
      setNotes('')
      setOverrides({})
      setEditing(false)
      await load()
    } finally {
      setActing(false)
    }
  }

  return (
    <div className="max-w-[1700px] mx-auto p-6">
      <div className="flex items-baseline justify-between mb-6 pb-4 border-b" style={{ borderColor: 'var(--rom-rule)' }}>
        <div>
          <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            Rank On Maps · Strategy
          </span>
          <h1 className="text-3xl font-display font-black uppercase tracking-tight mt-1" style={{ color: 'var(--rom-ink)' }}>
            Strategist Queue
          </h1>
          <p className="text-xs mt-2" style={{ color: 'var(--rom-ink-2)' }}>
            Every AI output routes here before anything client-facing publishes. Approve, amend, or reject.
          </p>
        </div>
        <div className="flex gap-3">
          <StatTile label="Pending" value={stats.total} />
          <StatTile label="Urgent (<12h)" value={stats.urgent} accent />
          <StatTile label="Overdue" value={stats.overdue} danger={stats.overdue > 0} />
        </div>
      </div>

      <div className="flex gap-3 mb-4">
        <select value={filterKind} onChange={(e) => setFilterKind(e.target.value)}
          className="text-xs px-3 py-2 border bg-white" style={{ fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--rom-rule)' }}>
          <option value="all">ALL KINDS</option>
          {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={filterClient} onChange={(e) => setFilterClient(e.target.value)}
          className="text-xs px-3 py-2 border bg-white" style={{ fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--rom-rule)' }}>
          <option value="all">ALL CLIENTS</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.business_name.toUpperCase()}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 lg:col-span-5">
          <div className="bg-white border" style={{ borderColor: 'var(--rom-rule)' }}>
            {loading && <div className="p-6 text-center text-sm" style={{ color: 'var(--rom-ink-2)' }}>Loading queue…</div>}
            {!loading && filtered.length === 0 && (
              <div className="p-6 text-center text-sm" style={{ color: 'var(--rom-ink-2)' }}>
                Queue empty. Either everything's approved, or the AI pipeline has nothing to surface yet.
              </div>
            )}
            {filtered.map((item) => (
              <QueueRow key={item.id} item={item} selected={selected?.id === item.id}
                onClick={() => { setSelected(item); setNotes(item.strategist_notes || ''); setOverrides({}); setEditing(false) }} />
            ))}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-7">
          {!selected && (
            <div className="bg-white border p-8 text-center" style={{ borderColor: 'var(--rom-rule)' }}>
              <Sparkles size={32} style={{ color: 'var(--rom-sage)', margin: '0 auto 12px' }} />
              <p className="text-sm" style={{ color: 'var(--rom-ink-2)' }}>
                Select an item from the queue to review, amend, approve, or reject.
              </p>
            </div>
          )}
          {selected && (
            <ReviewPanel
              key={selected.id}
              item={selected}
              acting={acting}
              notes={notes}
              onNotesChange={setNotes}
              overrides={overrides}
              onOverridesChange={setOverrides}
              editing={editing}
              onToggleEdit={() => setEditing(!editing)}
              onAction={takeAction}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function StatTile({ label, value, accent, danger }) {
  return (
    <div style={{ padding: '10px 16px', background: danger ? '#FEF3F2' : accent ? 'var(--rom-paper)' : 'white', border: `1px solid ${danger ? '#FECACA' : 'var(--rom-rule)'}`, minWidth: 100 }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: danger ? '#B91C1C' : 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
      <div className="text-2xl font-display font-black tabular-nums" style={{ color: danger ? '#991B1B' : 'var(--rom-ink)' }}>{value}</div>
    </div>
  )
}

function QueueRow({ item, selected, onClick }) {
  const overdue = new Date(item.expires_at) < new Date()
  const urgent = !overdue && (new Date(item.expires_at).getTime() - Date.now()) < 12 * 3600e3
  const label = KIND_LABELS[item.kind] || item.kind.toUpperCase()
  const headline = deriveHeadline(item)

  return (
    <button onClick={onClick}
      className="w-full text-left px-4 py-3 border-b transition-colors"
      style={{
        borderColor: 'var(--rom-rule)',
        background: selected ? 'var(--rom-paper)' : 'white',
        borderLeft: selected ? `3px solid var(--rom-sage)` : '3px solid transparent',
      }}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {overdue && <AlertCircle size={12} style={{ color: '#B91C1C', flexShrink: 0 }} />}
          {urgent && !overdue && <Clock size={12} style={{ color: 'var(--rom-sage)', flexShrink: 0 }} />}
          <span className="text-[10px] uppercase tracking-wider flex-shrink-0" style={{ color: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            {label}
          </span>
        </div>
        <span className="text-[10px] uppercase tracking-wider flex-shrink-0" style={{ color: overdue ? '#B91C1C' : 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
          {overdue ? 'OVERDUE' : timeUntil(item.expires_at)}
        </span>
      </div>
      <div className="text-sm mt-1 font-medium truncate" style={{ color: 'var(--rom-ink)' }}>{headline}</div>
      <div className="text-xs mt-0.5" style={{ color: 'var(--rom-ink-2)' }}>
        {item.clients?.business_name || 'unknown'} {item.clients?.primary_city ? `· ${item.clients.primary_city}` : ''} · priority {item.priority}
      </div>
    </button>
  )
}

function ReviewPanel({ item, acting, notes, onNotesChange, overrides, onOverridesChange, editing, onToggleEdit, onAction }) {
  const label = KIND_LABELS[item.kind] || item.kind.toUpperCase()
  const payload = item.proposed_payload || {}
  const useStructured = STRUCTURED_KINDS.has(item.kind) || isHandoffKind(item.kind)

  return (
    <div className="bg-white border" style={{ borderColor: 'var(--rom-rule)' }}>
      <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--rom-rule)', background: 'var(--rom-paper)' }}>
        <div>
          <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{label}</div>
          <div className="font-display font-black uppercase tracking-tight mt-1" style={{ color: 'var(--rom-ink)' }}>
            {item.clients?.business_name || 'Unknown'}
          </div>
        </div>
        <div className="text-[10px] uppercase tracking-wider text-right" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
          Created {timeAgo(item.created_at)} ago<br />
          Expires {timeUntil(item.expires_at)}
        </div>
      </div>

      <div className="px-5 py-5 max-h-[600px] overflow-auto">
        {useStructured
          ? <StructuredView item={item} payload={payload} />
          : <RawPayload payload={payload} />}
      </div>

      {editing && (
        <div className="px-5 py-4 border-t bg-amber-50" style={{ borderColor: 'var(--rom-rule)' }}>
          <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: '#92400E', fontFamily: 'JetBrains Mono, monospace' }}>AMEND OVERRIDES (JSON)</div>
          <textarea
            value={JSON.stringify(overrides, null, 2)}
            onChange={(e) => { try { onOverridesChange(JSON.parse(e.target.value)) } catch { /* ignore */ } }}
            placeholder='{"field": "new value"}'
            rows={6}
            className="w-full px-3 py-2 border text-xs"
            style={{ fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--rom-rule)' }}
          />
        </div>
      )}

      <div className="px-5 py-4 border-t" style={{ borderColor: 'var(--rom-rule)' }}>
        <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>STRATEGIST NOTES</div>
        <textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="optional notes that ship with the action"
          rows={2}
          className="w-full px-3 py-2 border text-sm"
          style={{ borderColor: 'var(--rom-rule)' }}
        />
      </div>

      <div className="px-5 py-4 border-t flex gap-2 justify-end" style={{ borderColor: 'var(--rom-rule)', background: 'var(--rom-paper)' }}>
        <button onClick={onToggleEdit} disabled={acting}
          className="px-3 py-2 text-xs font-semibold uppercase tracking-wider border"
          style={{ borderColor: 'var(--rom-rule)', color: 'var(--rom-ink)', fontFamily: 'JetBrains Mono, monospace', background: editing ? '#FEF3C7' : 'white' }}>
          <Edit3 size={12} style={{ display: 'inline', marginRight: 4 }} /> {editing ? 'Editing' : 'Amend'}
        </button>
        <button onClick={() => onAction('reject')} disabled={acting}
          className="px-3 py-2 text-xs font-semibold uppercase tracking-wider"
          style={{ background: '#FEE2E2', color: '#991B1B', fontFamily: 'JetBrains Mono, monospace' }}>
          <X size={12} style={{ display: 'inline', marginRight: 4 }} /> Reject
        </button>
        <button onClick={() => onAction(editing ? 'amend' : 'approve')} disabled={acting}
          className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-white"
          style={{ background: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace' }}>
          <Check size={12} style={{ display: 'inline', marginRight: 4 }} /> {editing ? 'Amend & publish' : 'Approve & publish'}
        </button>
      </div>
    </div>
  )
}

// ---------- structured view ----------

function StructuredView({ item, payload }) {
  const headline = deriveHeadline(item)
  const why = payload.why || payload.expected_impact || payload.rationale || payload.impact || null

  // identify linked records
  const handoffBriefId = payload.handoff_brief_id || payload.handoff_id || (isHandoffKind(item.kind) ? payload.brief_id : null) || null
  const fathomRecordingId = payload.fathom_recording_id || payload.recording_id || null
  const contentBriefId = (item.kind === 'content_brief') ? (payload.brief_id || payload.content_brief_id || null) : (payload.content_brief_id || null)

  const [handoffBrief, setHandoffBrief] = useState(null)
  const [handoffLoading, setHandoffLoading] = useState(false)
  const [contentBrief, setContentBrief] = useState(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [promisesLocal, setPromisesLocal] = useState(null)

  // fetch handoff_briefs row
  useEffect(() => {
    let cancelled = false
    async function go() {
      if (!handoffBriefId && !fathomRecordingId) return
      setHandoffLoading(true)
      let query = supabase.from('handoff_briefs').select('*').limit(1)
      if (handoffBriefId) query = query.eq('id', handoffBriefId)
      else if (fathomRecordingId) query = query.eq('fathom_recording_id', fathomRecordingId)
      const { data } = await query.maybeSingle()
      if (!cancelled) {
        setHandoffBrief(data || null)
        setPromisesLocal(Array.isArray(data?.promises_made) ? data.promises_made : null)
        setHandoffLoading(false)
      }
    }
    go()
    return () => { cancelled = true }
  }, [handoffBriefId, fathomRecordingId])

  // fetch content_briefs row
  useEffect(() => {
    let cancelled = false
    async function go() {
      if (!contentBriefId) return
      setContentLoading(true)
      const { data } = await supabase.from('content_briefs').select('*').eq('id', contentBriefId).maybeSingle()
      if (!cancelled) {
        setContentBrief(data || null)
        setContentLoading(false)
      }
    }
    go()
    return () => { cancelled = true }
  }, [contentBriefId])

  async function deletePromise(idx) {
    if (!handoffBrief?.id || !Array.isArray(promisesLocal)) return
    const next = promisesLocal.filter((_, i) => i !== idx)
    setPromisesLocal(next)
    const { error } = await supabase
      .from('handoff_briefs')
      .update({ promises_made: next })
      .eq('id', handoffBrief.id)
    if (error) {
      alert(`Couldn't prune promise: ${error.message}`)
      setPromisesLocal(promisesLocal) // revert
    }
  }

  // pretty proposed fields (skip the noisy stuff)
  const proposedFields = useMemo(() => {
    const skip = new Set([
      'headline', 'title', 'why', 'expected_impact', 'rationale', 'impact',
      'handoff_brief_id', 'handoff_id', 'fathom_recording_id', 'recording_id',
      'brief_id', 'content_brief_id',
    ])
    return Object.entries(payload).filter(([k]) => !skip.has(k))
  }, [payload])

  return (
    <div className="flex flex-col gap-5">
      <HeadlineBlock headline={headline} kind={item.kind} />

      <Section icon={<Target size={12} />} title="What was proposed">
        {proposedFields.length === 0
          ? <Empty>No additional fields beyond the headline.</Empty>
          : <FieldGrid entries={proposedFields} />}
      </Section>

      {why && (
        <Section icon={<Sparkles size={12} />} title="Why this matters" accent>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--rom-ink)' }}>
            {typeof why === 'string' ? why : JSON.stringify(why)}
          </p>
        </Section>
      )}

      {(handoffBriefId || fathomRecordingId) && (
        <HandoffBriefBlock
          loading={handoffLoading}
          brief={handoffBrief}
          promises={promisesLocal}
          onDeletePromise={deletePromise}
        />
      )}

      {contentBriefId && (
        <ContentBriefBlock loading={contentLoading} brief={contentBrief} />
      )}

      <Collapsible title="Raw payload" defaultOpen={false}>
        <RawPayload payload={payload} />
      </Collapsible>
    </div>
  )
}

function HeadlineBlock({ headline, kind }) {
  return (
    <div className="border-l-2 pl-4 py-1" style={{ borderColor: 'var(--rom-sage)' }}>
      <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
        {KIND_LABELS[kind] || kind}
      </div>
      <div className="text-lg font-display font-black tracking-tight" style={{ color: 'var(--rom-ink)', lineHeight: 1.25 }}>
        {headline}
      </div>
    </div>
  )
}

function Section({ icon, title, accent, children }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-[10px] uppercase tracking-wider" style={{ color: accent ? 'var(--rom-sage)' : 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
        {icon}
        <span>{title}</span>
      </div>
      <div className="border bg-white" style={{ borderColor: 'var(--rom-rule)', padding: '12px 14px', background: accent ? 'var(--rom-paper)' : 'white' }}>
        {children}
      </div>
    </div>
  )
}

function Empty({ children }) {
  return <div className="text-xs italic" style={{ color: 'var(--rom-ink-2)' }}>{children}</div>
}

function FieldGrid({ entries }) {
  return (
    <div className="grid grid-cols-1 gap-3">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-12 gap-3 text-xs">
          <div className="col-span-4 uppercase tracking-wider" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            {k.replace(/_/g, ' ')}
          </div>
          <div className="col-span-8" style={{ color: 'var(--rom-ink)' }}>
            <FieldValue value={v} />
          </div>
        </div>
      ))}
    </div>
  )
}

function FieldValue({ value }) {
  if (value === null || value === undefined) return <span style={{ color: 'var(--rom-ink-2)' }}>—</span>
  if (typeof value === 'string') return <span className="whitespace-pre-wrap">{value}</span>
  if (typeof value === 'number' || typeof value === 'boolean') return <span className="tabular-nums">{String(value)}</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <Empty>empty</Empty>
    if (value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return (
        <ul className="list-disc pl-4 space-y-0.5">
          {value.map((v, i) => <li key={i}>{String(v)}</li>)}
        </ul>
      )
    }
    return (
      <pre className="text-[11px] whitespace-pre-wrap" style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--rom-ink-2)' }}>
{JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  if (typeof value === 'object') {
    return (
      <div className="space-y-1">
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <span style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>{k}:</span>
            <span><FieldValue value={v} /></span>
          </div>
        ))}
      </div>
    )
  }
  return <span>{String(value)}</span>
}

// ---------- handoff brief block ----------

function HandoffBriefBlock({ loading, brief, promises, onDeletePromise }) {
  if (loading) {
    return (
      <Section icon={<FileText size={12} />} title="Handoff brief">
        <Empty>Loading handoff brief…</Empty>
      </Section>
    )
  }
  if (!brief) {
    return (
      <Section icon={<FileText size={12} />} title="Handoff brief">
        <Empty>Linked handoff brief not found.</Empty>
      </Section>
    )
  }

  const icp = brief.icp_confirmed || {}
  const redFlags = Array.isArray(brief.red_flags) ? brief.red_flags : []
  const scope = brief.scope_locked

  return (
    <div className="flex flex-col gap-5">
      {brief.summary && (
        <Section icon={<FileText size={12} />} title="Handoff summary">
          <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--rom-ink)' }}>{brief.summary}</p>
        </Section>
      )}

      <Section icon={<ListChecks size={12} />} title="Promises made">
        {(!promises || promises.length === 0)
          ? <Empty>No promises captured. Or you've pruned them all.</Empty>
          : (
            <ul className="space-y-2">
              {promises.map((p, i) => {
                const text = typeof p === 'string' ? p : (p?.promise || p?.text || JSON.stringify(p))
                return (
                  <li key={i} className="flex items-start gap-3 text-sm group">
                    <input type="checkbox" defaultChecked={false} className="mt-1 flex-shrink-0" style={{ accentColor: 'var(--rom-sage)' }} />
                    <span className="flex-1" style={{ color: 'var(--rom-ink)' }}>{text}</span>
                    <button
                      onClick={() => onDeletePromise(i)}
                      title="prune this promise"
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      style={{ color: '#B91C1C' }}>
                      <Trash2 size={14} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
      </Section>

      <Section icon={<Target size={12} />} title="ICP confirmed">
        {Object.keys(icp).length === 0
          ? <Empty>ICP not captured.</Empty>
          : <FieldGrid entries={Object.entries(icp)} />}
      </Section>

      {scope && (
        <Section icon={<Layers size={12} />} title="Scope locked">
          {typeof scope === 'string'
            ? <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--rom-ink)' }}>{scope}</p>
            : <FieldGrid entries={Object.entries(scope)} />}
        </Section>
      )}

      {redFlags.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2 text-[10px] uppercase tracking-wider" style={{ color: '#B91C1C', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            <AlertTriangle size={12} />
            <span>Red flags</span>
          </div>
          <div className="border" style={{ borderColor: '#FECACA', background: '#FEF3F2', padding: '12px 14px' }}>
            <ul className="space-y-2">
              {redFlags.map((f, i) => {
                const text = typeof f === 'string' ? f : (f?.flag || f?.text || JSON.stringify(f))
                return (
                  <li key={i} className="flex items-start gap-2 text-sm" style={{ color: '#991B1B' }}>
                    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>{text}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- content brief block ----------

function ContentBriefBlock({ loading, brief }) {
  if (loading) {
    return (
      <Section icon={<FileText size={12} />} title="Content brief">
        <Empty>Loading content brief…</Empty>
      </Section>
    )
  }
  if (!brief) {
    return (
      <Section icon={<FileText size={12} />} title="Content brief">
        <Empty>Linked content brief not found.</Empty>
      </Section>
    )
  }

  const outline = brief.outline || brief.brief_outline || null
  const entities = brief.entities || null
  const schema = brief.schema_requirements || brief.schema || null

  return (
    <div className="flex flex-col gap-5">
      {outline && (
        <Section icon={<FileText size={12} />} title="Brief outline">
          {Array.isArray(outline)
            ? (
              <ol className="list-decimal pl-5 space-y-1 text-sm" style={{ color: 'var(--rom-ink)' }}>
                {outline.map((o, i) => (
                  <li key={i}>{typeof o === 'string' ? o : (o?.heading || o?.title || JSON.stringify(o))}</li>
                ))}
              </ol>
            )
            : typeof outline === 'string'
              ? <pre className="text-sm whitespace-pre-wrap" style={{ color: 'var(--rom-ink)' }}>{outline}</pre>
              : <FieldGrid entries={Object.entries(outline)} />}
        </Section>
      )}

      {entities && (
        <Section icon={<Target size={12} />} title="Entities">
          {Array.isArray(entities)
            ? (
              <div className="flex flex-wrap gap-1.5">
                {entities.map((e, i) => (
                  <span key={i} className="text-[11px] px-2 py-1 border" style={{ borderColor: 'var(--rom-rule)', background: 'var(--rom-paper)', color: 'var(--rom-ink)', fontFamily: 'JetBrains Mono, monospace' }}>
                    {typeof e === 'string' ? e : (e?.name || JSON.stringify(e))}
                  </span>
                ))}
              </div>
            )
            : <FieldGrid entries={Object.entries(entities)} />}
        </Section>
      )}

      {schema && (
        <Section icon={<Layers size={12} />} title="Schema requirements">
          {Array.isArray(schema)
            ? (
              <ul className="list-disc pl-5 space-y-1 text-sm" style={{ color: 'var(--rom-ink)' }}>
                {schema.map((s, i) => (
                  <li key={i}>{typeof s === 'string' ? s : (s?.type || JSON.stringify(s))}</li>
                ))}
              </ul>
            )
            : typeof schema === 'string'
              ? <pre className="text-sm whitespace-pre-wrap" style={{ color: 'var(--rom-ink)' }}>{schema}</pre>
              : <FieldGrid entries={Object.entries(schema)} />}
        </Section>
      )}
    </div>
  )
}

// ---------- shared bits ----------

function Collapsible({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border" style={{ borderColor: 'var(--rom-rule)' }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, background: 'var(--rom-paper)' }}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{title}</span>
      </button>
      {open && (
        <div className="px-3 py-3 border-t" style={{ borderColor: 'var(--rom-rule)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

function RawPayload({ payload }) {
  return (
    <pre className="text-xs whitespace-pre-wrap" style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--rom-ink)', lineHeight: 1.65 }}>
{JSON.stringify(payload, null, 2)}
    </pre>
  )
}
