import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Flag, Trash2, Check, Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

// The vocabulary of what can be wrong with a bot text. These are not decoration:
// each one maps to a different KIND of fix, which is what makes a batch of flags
// triageable instead of a pile of opinions.
//
//   kind 'rule'   -> can be caught deterministically in services/message_rules.py,
//                    which means once fixed it can never come back
//   kind 'prompt' -> a judgement call the model has to make better; only
//                    fixable in config/prompts.py, and needs the eval to prove
//                    it did not break the conversations you did not flag
export const REASONS = [
  { key: 'too_wordy', label: 'too wordy', kind: 'rule' },
  { key: 'robotic', label: 'sounds robotic', kind: 'prompt' },
  { key: 'pushy', label: 'pushy', kind: 'prompt' },
  { key: 'wrong_time', label: 'wrong time / timezone', kind: 'rule' },
  { key: 'repeats', label: 'repeats itself', kind: 'rule' },
  { key: 'promise', label: 'promises a call', kind: 'rule' },
  { key: 'not_josh', label: 'not how Josh talks', kind: 'prompt' },
  { key: 'wrong_info', label: 'factually wrong', kind: 'prompt' },
  { key: 'weak_ask', label: 'weak ask for the time', kind: 'prompt' },
  { key: 'too_formal', label: 'too formal', kind: 'prompt' },
]

export async function loadFlags(status = 'open') {
  const q = supabase.from('sandbox_feedback').select('*').order('created_at', { ascending: false })
  const { data, error } = status === 'all' ? await q : await q.eq('status', status)
  if (error) throw error
  return data || []
}

export async function saveFlag(flag) {
  const { data, error } = await supabase.from('sandbox_feedback').insert(flag).select()
  if (error) throw error
  return data?.[0]
}

/** The chip picker that appears over a selection. */
export function FlagPopover({ anchor, selected, onCancel, onSave }) {
  const [reasons, setReasons] = useState([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const toggle = (key) =>
    setReasons(r => (r.includes(key) ? r.filter(x => x !== key) : [...r, key]))

  const submit = async () => {
    if (!reasons.length && !note.trim()) return
    setSaving(true)
    await onSave({ reasons, note: note.trim() })
    setSaving(false)
  }

  return (
    <div ref={ref}
      className="fixed z-50 p-3 rounded-lg shadow-lg"
      style={{
        top: Math.min(anchor.top + 8, window.innerHeight - 260),
        left: Math.max(12, Math.min(anchor.left, window.innerWidth - 372)),
        width: 360, background: 'var(--paper, #fff)', border: '1px solid var(--rule)',
      }}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-[11px] leading-snug" style={{ color: 'var(--ink-3)' }}>
          {selected
            ? <>flagging <span style={{ background: '#fef08a', color: '#000', padding: '0 3px' }}>{selected}</span></>
            : <>flagging <strong>this whole text</strong> — select just part of it if you want to be specific</>}
        </div>
        <button onClick={onCancel}><X className="w-3.5 h-3.5" style={{ color: 'var(--ink-3)' }} /></button>
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {REASONS.map(r => {
          const on = reasons.includes(r.key)
          return (
            <button key={r.key} onClick={() => toggle(r.key)}
              className="px-2 py-1 text-[11px] rounded-full"
              style={{
                border: `1px solid ${on ? '#0a6b39' : 'var(--rule)'}`,
                background: on ? '#d6f5e0' : 'transparent',
                color: on ? '#0a6b39' : 'var(--ink-2, #444)',
              }}>
              {r.label}
            </button>
          )
        })}
      </div>
      <input
        autoFocus
        value={note}
        onChange={e => setNote(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="why is it wrong? (optional)"
        className="w-full px-2 py-1.5 text-xs rounded mb-2"
        style={{ border: '1px solid var(--rule)', background: 'transparent' }}
      />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-2 py-1 text-xs rounded"
          style={{ border: '1px solid var(--rule)' }}>cancel</button>
        <button onClick={submit} disabled={saving || (!reasons.length && !note.trim())}
          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded"
          style={{
            background: '#111', color: '#fff',
            opacity: (saving || (!reasons.length && !note.trim())) ? 0.5 : 1,
          }}>
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Flag className="w-3 h-3" />} flag it
        </button>
      </div>
    </div>
  )
}

/**
 * One rendered bot text, with the flagged spans highlighted and any selection
 * inside it reported back up.
 *
 * The whole message is one text node on purpose. Selection offsets are taken
 * straight from the DOM range, which only stays honest while nothing else
 * splits the text — so the highlights are rebuilt as slices rather than by
 * wrapping words in place.
 */
export function FlaggableText({ text, flags, onSelect, style }) {
  const ref = useRef(null)

  const handleUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !ref.current) return
    if (!ref.current.contains(sel.anchorNode) || !ref.current.contains(sel.focusNode)) return
    const picked = sel.toString().trim()
    if (!picked) return
    // Offsets within the full message, not within whichever highlight slice the
    // selection happened to start in.
    const start = text.indexOf(picked)
    if (start < 0) return
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    onSelect({
      text: picked, start, end: start + picked.length,
      anchor: { top: rect.bottom, left: rect.left },
    })
  }, [text, onSelect])

  // Cut the message into flagged / unflagged slices so existing flags stay
  // visible while new ones are being added.
  const spans = (flags || [])
    .filter(f => f.span_start != null && f.span_end != null)
    .sort((a, b) => a.span_start - b.span_start)
  const pieces = []
  let cursor = 0
  spans.forEach((f, i) => {
    if (f.span_start > cursor) pieces.push({ t: text.slice(cursor, f.span_start) })
    pieces.push({ t: text.slice(f.span_start, f.span_end), flag: f, key: `f${i}` })
    cursor = Math.max(cursor, f.span_end)
  })
  if (cursor < text.length) pieces.push({ t: text.slice(cursor) })

  return (
    <div ref={ref} onMouseUp={handleUp} style={{ ...style, cursor: 'text' }}>
      {pieces.map((p, i) => p.flag ? (
        <mark key={i}
          title={[...(p.flag.reasons || []), p.flag.note].filter(Boolean).join(' · ')}
          style={{ background: '#fecaca', color: 'inherit', borderBottom: '2px solid #dc2626', padding: 0 }}>
          {p.t}
        </mark>
      ) : <span key={i}>{p.t}</span>)}
    </div>
  )
}

/** The list of everything flagged and not yet fixed. */
export function FlagQueue({ flags, onRefresh }) {
  const [busy, setBusy] = useState('')

  const remove = async (id) => {
    setBusy(id)
    await supabase.from('sandbox_feedback').delete().eq('id', id)
    await onRefresh()
    setBusy('')
  }

  const byKind = { rule: 0, prompt: 0 }
  flags.forEach(f => (f.reasons || []).forEach(k => {
    const r = REASONS.find(x => x.key === k)
    if (r) byKind[r.kind] += 1
  }))

  if (!flags.length) {
    return (
      <p className="text-sm py-6 text-center" style={{ color: 'var(--ink-3)' }}>
        Nothing flagged yet. Select any words in a bot message to flag them.
      </p>
    )
  }

  return (
    <>
      <p className="text-[11px] mb-3" style={{ color: 'var(--ink-3)' }}>
        {flags.length} open · roughly {byKind.rule} fixable as a hard rule, {byKind.prompt} needing a prompt change.
        Tell Claude <strong>&ldquo;fix the flags&rdquo;</strong> and they get done as one batch.
      </p>
      {flags.map(f => (
        <div key={f.id} className="p-3 mb-2 rounded" style={{ border: '1px solid var(--rule)' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <div className="text-sm mb-1">
                {f.highlighted
                  ? <span style={{ background: '#fecaca', borderBottom: '2px solid #dc2626' }}>{f.highlighted}</span>
                  : <em style={{ color: 'var(--ink-3)' }}>(whole message)</em>}
              </div>
              <div className="text-[11px] mb-1.5" style={{ color: 'var(--ink-3)' }}>
                in: “{(f.message || '').slice(0, 130)}{(f.message || '').length > 130 ? '…' : ''}”
              </div>
              <div className="flex flex-wrap gap-1 items-center">
                {(f.reasons || []).map(k => {
                  const r = REASONS.find(x => x.key === k)
                  return (
                    <span key={k} className="tag"
                      style={r?.kind === 'rule'
                        ? { background: '#eef2ff', color: '#3730a3', borderColor: '#c7d2fe' }
                        : { background: '#fff4d6', color: '#8a5a00', borderColor: '#d6b876' }}>
                      {r?.label || k}
                    </span>
                  )
                })}
                {f.note && <span className="text-[11px]" style={{ color: 'var(--ink-2, #444)' }}>— {f.note}</span>}
              </div>
              <div className="text-[10px] mt-1.5" style={{ color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
                {f.run_label} · {new Date(f.created_at).toLocaleString()}
              </div>
            </div>
            <button onClick={() => remove(f.id)} disabled={busy === f.id} title="delete">
              {busy === f.id
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Trash2 className="w-3.5 h-3.5" style={{ color: '#991b1b' }} />}
            </button>
          </div>
        </div>
      ))}
    </>
  )
}

export function FixedBadge({ flag }) {
  if (flag.status !== 'fixed') return null
  return (
    <span className="tag" style={{ background: '#d6f5e0', color: '#0a6b39', borderColor: '#8fd6ab' }}>
      <Check className="w-3 h-3 inline" /> fixed{flag.fix_pr ? ` · ${flag.fix_pr}` : ''}
    </span>
  )
}
