import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { FileText, Send, UserPlus, CheckCircle2, AlertCircle } from 'lucide-react'

const STATUS_LABELS = {
  briefed: 'BRIEFED',
  assigned: 'ASSIGNED',
  drafting: 'DRAFTING',
  in_qa: 'IN QA',
  awaiting_strategist: 'AWAITING STRATEGIST',
  approved: 'APPROVED',
  published: 'PUBLISHED',
}

const STATUS_COLORS = {
  briefed: { bg: '#F3F4F6', fg: '#374151' },
  assigned: { bg: '#FEF3C7', fg: '#92400E' },
  drafting: { bg: '#DBEAFE', fg: '#1E40AF' },
  in_qa: { bg: '#E0E7FF', fg: '#3730A3' },
  awaiting_strategist: { bg: '#FEF3C7', fg: '#92400E' },
  approved: { bg: '#DCFCE7', fg: '#166534' },
  published: { bg: '#D1FAE5', fg: '#065F46' },
}

const INTENT_LABELS = {
  informational: 'INFO',
  commercial: 'COMMERCIAL',
  transactional: 'TRANSACTIONAL',
  navigational: 'NAV',
  local: 'LOCAL',
}

function timeAgo(iso) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export default function HQContent() {
  const [briefs, setBriefs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState('all')
  const [selected, setSelected] = useState(null)
  const [writerInput, setWriterInput] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [draftBody, setDraftBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [qaResult, setQaResult] = useState(null)
  const [qaError, setQaError] = useState(null)

  useEffect(() => {
    load().then(() => setLoading(false))

    const channel = supabase
      .channel('content-briefs-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'content_briefs' }, () => load())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  async function load() {
    const { data } = await supabase
      .from('content_briefs')
      .select('id, client_id, target_keyword, search_intent, current_position, target_position, status, word_count_target, outline, entities, schema_requirements, tone_notes, writer_assigned, created_at, clients(business_name, primary_city, slug)')
      .order('created_at', { ascending: false })
      .limit(200)
    setBriefs(data || [])
    // refresh selection if it's still in the list
    if (selected) {
      const fresh = (data || []).find((b) => b.id === selected.id)
      if (fresh) setSelected(fresh)
    }
  }

  const filtered = useMemo(() => {
    return briefs.filter((b) => {
      if (filterStatus !== 'all' && b.status !== filterStatus) return false
      return true
    })
  }, [briefs, filterStatus])

  const stats = useMemo(() => {
    const byStatus = {}
    briefs.forEach((b) => { byStatus[b.status] = (byStatus[b.status] || 0) + 1 })
    return {
      total: briefs.length,
      briefed: byStatus.briefed || 0,
      drafting: (byStatus.assigned || 0) + (byStatus.drafting || 0),
      qa: (byStatus.in_qa || 0) + (byStatus.awaiting_strategist || 0),
      published: byStatus.published || 0,
    }
  }, [briefs])

  function selectBrief(b) {
    setSelected(b)
    setWriterInput(b.writer_assigned || '')
    setDraftBody('')
    setQaResult(null)
    setQaError(null)
  }

  async function assignWriter() {
    if (!selected || !writerInput.trim()) return
    setAssigning(true)
    try {
      const { error } = await supabase
        .from('content_briefs')
        .update({ writer_assigned: writerInput.trim(), status: 'assigned' })
        .eq('id', selected.id)
      if (error) { alert(`Assign failed: ${error.message}`); return }
      await load()
    } finally {
      setAssigning(false)
    }
  }

  async function submitDraft() {
    if (!selected || !draftBody.trim()) return
    setSubmitting(true)
    setQaResult(null)
    setQaError(null)
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/content-editor-qa`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          brief_id: selected.id,
          draft_body_md: draftBody,
          writer: selected.writer_assigned || writerInput || 'unknown',
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        setQaError(data.error || res.statusText)
        return
      }
      setQaResult(data)
      await load()
    } catch (err) {
      setQaError(err.message || 'request failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-[1700px] mx-auto p-6">
      <div className="flex items-baseline justify-between mb-6 pb-4 border-b" style={{ borderColor: 'var(--rom-rule)' }}>
        <div>
          <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            Rank On Maps · Content
          </span>
          <h1 className="text-3xl font-display font-black uppercase tracking-tight mt-1" style={{ color: 'var(--rom-ink)' }}>
            Content Briefs
          </h1>
          <p className="text-xs mt-2" style={{ color: 'var(--rom-ink-2)' }}>
            Every page we ship runs through here. Assign a writer, submit the draft, ship it to QA.
          </p>
        </div>
        <div className="flex gap-3">
          <StatTile label="Total" value={stats.total} />
          <StatTile label="Briefed" value={stats.briefed} />
          <StatTile label="In draft" value={stats.drafting} />
          <StatTile label="In QA" value={stats.qa} />
          <StatTile label="Published" value={stats.published} accent />
        </div>
      </div>

      <div className="flex gap-3 mb-4">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="text-xs px-3 py-2 border bg-white"
          style={{ fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--rom-rule)' }}
        >
          <option value="all">ALL STATUSES</option>
          {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 lg:col-span-5">
          <div className="bg-white border" style={{ borderColor: 'var(--rom-rule)' }}>
            {loading && (
              <div className="p-6 text-center text-sm" style={{ color: 'var(--rom-ink-2)' }}>Loading briefs…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="p-6 text-center text-sm" style={{ color: 'var(--rom-ink-2)' }}>
                No briefs match. Either nothing's been generated yet, or the filter is too strict.
              </div>
            )}
            {filtered.map((b) => (
              <BriefRow
                key={b.id}
                brief={b}
                selected={selected?.id === b.id}
                onClick={() => selectBrief(b)}
              />
            ))}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-7">
          {!selected && (
            <div className="bg-white border p-8 text-center" style={{ borderColor: 'var(--rom-rule)' }}>
              <FileText size={32} style={{ color: 'var(--rom-sage)', margin: '0 auto 12px' }} />
              <p className="text-sm" style={{ color: 'var(--rom-ink-2)' }}>
                Select a brief to view the outline, assign a writer, or submit a draft for QA.
              </p>
            </div>
          )}
          {selected && (
            <BriefDetail
              brief={selected}
              writerInput={writerInput}
              onWriterChange={setWriterInput}
              onAssign={assignWriter}
              assigning={assigning}
              draftBody={draftBody}
              onDraftChange={setDraftBody}
              onSubmitDraft={submitDraft}
              submitting={submitting}
              qaResult={qaResult}
              qaError={qaError}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function StatTile({ label, value, accent }) {
  return (
    <div style={{
      padding: '10px 16px',
      background: accent ? 'var(--rom-paper)' : 'white',
      border: '1px solid var(--rom-rule)',
      minWidth: 90,
    }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
      <div className="text-2xl font-display font-black tabular-nums" style={{ color: 'var(--rom-ink)' }}>{value}</div>
    </div>
  )
}

function StatusPill({ status }) {
  const c = STATUS_COLORS[status] || { bg: '#F3F4F6', fg: '#374151' }
  const label = STATUS_LABELS[status] || (status || '').toUpperCase()
  return (
    <span
      className="text-[10px] uppercase tracking-wider px-2 py-0.5"
      style={{ background: c.bg, color: c.fg, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
    >
      {label}
    </span>
  )
}

function PositionDelta({ current, target }) {
  if (current == null && target == null) return null
  const cur = current ?? '—'
  const tgt = target ?? '—'
  return (
    <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
      #{cur} → #{tgt}
    </span>
  )
}

function BriefRow({ brief, selected, onClick }) {
  const intentLabel = INTENT_LABELS[brief.search_intent] || (brief.search_intent || '').toUpperCase()
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 border-b transition-colors"
      style={{
        borderColor: 'var(--rom-rule)',
        background: selected ? 'var(--rom-paper)' : 'white',
        borderLeft: selected ? '3px solid var(--rom-sage)' : '3px solid transparent',
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wider flex-shrink-0" style={{ color: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            {brief.clients?.business_name?.toUpperCase() || 'UNKNOWN'}
          </span>
          {intentLabel && (
            <span className="text-[10px] uppercase tracking-wider flex-shrink-0" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
              · {intentLabel}
            </span>
          )}
        </div>
        <StatusPill status={brief.status} />
      </div>
      <div className="text-sm mt-1 font-medium truncate" style={{ color: 'var(--rom-ink)' }}>
        {brief.target_keyword || '(no target keyword)'}
      </div>
      <div className="flex items-center gap-3 mt-1">
        <PositionDelta current={brief.current_position} target={brief.target_position} />
        {brief.word_count_target ? (
          <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
            {brief.word_count_target}w target
          </span>
        ) : null}
        {brief.writer_assigned ? (
          <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
            writer: {brief.writer_assigned}
          </span>
        ) : null}
        <span className="text-[10px] uppercase tracking-wider ml-auto" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
          {timeAgo(brief.created_at)} ago
        </span>
      </div>
    </button>
  )
}

function Section({ label, children }) {
  return (
    <div className="mb-5">
      <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
        {label}
      </div>
      <div className="text-sm" style={{ color: 'var(--rom-ink)', lineHeight: 1.6 }}>
        {children}
      </div>
    </div>
  )
}

function renderField(value) {
  if (value == null || value === '') {
    return <span style={{ color: 'var(--rom-ink-2)' }}>not set</span>
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span style={{ color: 'var(--rom-ink-2)' }}>none</span>
    return (
      <ul className="list-disc pl-5 space-y-1">
        {value.map((v, i) => (
          <li key={i}>
            {typeof v === 'object' ? (
              <pre className="text-xs whitespace-pre-wrap" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {JSON.stringify(v, null, 2)}
              </pre>
            ) : String(v)}
          </li>
        ))}
      </ul>
    )
  }
  if (typeof value === 'object') {
    return (
      <pre className="text-xs whitespace-pre-wrap" style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--rom-ink)' }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  return <span>{String(value)}</span>
}

function BriefDetail({
  brief,
  writerInput,
  onWriterChange,
  onAssign,
  assigning,
  draftBody,
  onDraftChange,
  onSubmitDraft,
  submitting,
  qaResult,
  qaError,
}) {
  return (
    <div className="bg-white border" style={{ borderColor: 'var(--rom-rule)' }}>
      <div className="px-5 py-4 border-b flex items-start justify-between" style={{ borderColor: 'var(--rom-rule)', background: 'var(--rom-paper)' }}>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            {brief.clients?.business_name?.toUpperCase() || 'UNKNOWN'}
            {brief.clients?.primary_city ? ` · ${brief.clients.primary_city.toUpperCase()}` : ''}
          </div>
          <div className="font-display font-black uppercase tracking-tight mt-1 text-xl" style={{ color: 'var(--rom-ink)' }}>
            {brief.target_keyword || '(no target keyword)'}
          </div>
          <div className="flex items-center gap-3 mt-2">
            <StatusPill status={brief.status} />
            <PositionDelta current={brief.current_position} target={brief.target_position} />
            {brief.word_count_target ? (
              <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
                {brief.word_count_target}w target
              </span>
            ) : null}
          </div>
        </div>
        <div className="text-[10px] uppercase tracking-wider text-right flex-shrink-0" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
          Created {timeAgo(brief.created_at)} ago
        </div>
      </div>

      <div className="px-5 py-5 max-h-[420px] overflow-auto">
        <Section label="Outline">{renderField(brief.outline)}</Section>
        <Section label="Entities">{renderField(brief.entities)}</Section>
        <Section label="Schema requirements">{renderField(brief.schema_requirements)}</Section>
        <Section label="Tone notes">{renderField(brief.tone_notes)}</Section>
      </div>

      <div className="px-5 py-4 border-t" style={{ borderColor: 'var(--rom-rule)' }}>
        <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
          ASSIGN WRITER
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={writerInput}
            onChange={(e) => onWriterChange(e.target.value)}
            placeholder="writer name"
            className="flex-1 px-3 py-2 border text-sm"
            style={{ borderColor: 'var(--rom-rule)' }}
          />
          <button
            onClick={onAssign}
            disabled={assigning || !writerInput.trim()}
            className="px-3 py-2 text-xs font-semibold uppercase tracking-wider border"
            style={{
              borderColor: 'var(--rom-rule)',
              background: 'white',
              color: 'var(--rom-ink)',
              fontFamily: 'JetBrains Mono, monospace',
              opacity: assigning || !writerInput.trim() ? 0.5 : 1,
            }}
          >
            <UserPlus size={12} style={{ display: 'inline', marginRight: 4 }} />
            {assigning ? 'Assigning…' : brief.writer_assigned ? 'Reassign' : 'Assign'}
          </button>
        </div>
        {brief.writer_assigned && (
          <div className="text-[10px] uppercase tracking-wider mt-2" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
            Currently assigned: {brief.writer_assigned}
          </div>
        )}
      </div>

      <div className="px-5 py-4 border-t" style={{ borderColor: 'var(--rom-rule)' }}>
        <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
          SUBMIT DRAFT (MARKDOWN)
        </div>
        <textarea
          value={draftBody}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="paste the full draft body in markdown"
          rows={10}
          className="w-full px-3 py-2 border text-sm"
          style={{ borderColor: 'var(--rom-rule)', fontFamily: 'JetBrains Mono, monospace' }}
        />
        <div className="flex items-center justify-between mt-2">
          <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
            {draftBody.trim().split(/\s+/).filter(Boolean).length} words
            {brief.word_count_target ? ` / ${brief.word_count_target} target` : ''}
          </div>
          <button
            onClick={onSubmitDraft}
            disabled={submitting || !draftBody.trim()}
            className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-white"
            style={{
              background: 'var(--rom-sage)',
              fontFamily: 'JetBrains Mono, monospace',
              opacity: submitting || !draftBody.trim() ? 0.5 : 1,
            }}
          >
            <Send size={12} style={{ display: 'inline', marginRight: 4 }} />
            {submitting ? 'Running QA…' : 'Submit for QA'}
          </button>
        </div>
      </div>

      {qaError && (
        <div className="px-5 py-4 border-t" style={{ borderColor: 'var(--rom-rule)', background: '#FEF2F2' }}>
          <div className="flex items-start gap-2">
            <AlertCircle size={14} style={{ color: '#B91C1C', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: '#991B1B', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                QA FAILED
              </div>
              <div className="text-sm mt-1" style={{ color: '#991B1B' }}>{qaError}</div>
            </div>
          </div>
        </div>
      )}

      {qaResult && (
        <div className="px-5 py-4 border-t" style={{ borderColor: 'var(--rom-rule)', background: 'var(--rom-paper)' }}>
          <div className="flex items-start gap-2 mb-3">
            <CheckCircle2 size={14} style={{ color: 'var(--rom-sage)', flexShrink: 0, marginTop: 2 }} />
            <div className="flex-1">
              <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                QA VERDICT
              </div>
              <div className="flex items-baseline gap-4 mt-1">
                <span className="font-display font-black uppercase tracking-tight text-lg" style={{ color: 'var(--rom-ink)' }}>
                  {qaResult.verdict || qaResult.status || 'returned'}
                </span>
                {qaResult.score != null && (
                  <span className="text-2xl font-display font-black tabular-nums" style={{ color: 'var(--rom-ink)' }}>
                    {qaResult.score}
                    <span className="text-xs ml-1" style={{ color: 'var(--rom-ink-2)' }}>/100</span>
                  </span>
                )}
              </div>
            </div>
          </div>
          <pre className="text-xs whitespace-pre-wrap" style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--rom-ink)', lineHeight: 1.65 }}>
{JSON.stringify(qaResult, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
