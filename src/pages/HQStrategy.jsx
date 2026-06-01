import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { Sparkles, Check, X, Edit3, AlertCircle, Clock } from 'lucide-react'

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
}

const KIND_PRIORITY_COLOR = {
  high: 'var(--rom-sage)',
  med: 'var(--rom-tone)',
  low: 'var(--rom-ink-2)',
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
  const payload = item.proposed_payload || {}
  const headline =
    payload.headline
    || payload.title
    || payload.target_keyword
    || payload.memo?.headline
    || payload.summary
    || payload.competitor
    || payload.vision?.slice(0, 80)
    || 'Untitled item'

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

      <div className="px-5 py-5 max-h-[500px] overflow-auto">
        <pre className="text-xs whitespace-pre-wrap" style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--rom-ink)', lineHeight: 1.65 }}>
{JSON.stringify(payload, null, 2)}
        </pre>
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
