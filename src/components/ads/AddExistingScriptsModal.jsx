import { useEffect, useMemo, useState } from 'react'
import { Check, AlertCircle } from 'lucide-react'
import Modal from '../editorial/Modal'
import { Eyebrow, ValueChip } from '../editorial/atoms'
import { searchScriptsForAttach, addScriptsToBatch } from '../../services/testBatches'

/*
  Pick previously generated/edited scripts and attach them to the current
  test batch. Useful when the operator wrote scripts on the Generate page
  before creating the batch, or wants to move scripts from one batch to
  another.
*/

export default function AddExistingScriptsModal({ open, onClose, batch, onSaved }) {
  const [scripts, setScripts] = useState([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [err, setErr] = useState(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('loose')   // loose | all | other_batch
  const [selected, setSelected] = useState(new Set())

  useEffect(() => {
    if (!open) {
      setSearch(''); setFilter('loose'); setSelected(new Set()); setErr(null)
      return
    }
    setLoading(true); setErr(null)
    searchScriptsForAttach({
      offer_slug: batch?.offer_slug || null,
      excludeBatchId: batch?.id,
      limit: 500,
    })
      .then(setScripts)
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }, [open, batch?.id, batch?.offer_slug])

  const filtered = useMemo(() => {
    let rows = scripts
    if (filter === 'loose')       rows = rows.filter(r => !r.test_batch_id)
    else if (filter === 'other_batch') rows = rows.filter(r =>  r.test_batch_id)
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.body  || '').toLowerCase().includes(q)
    )
    return rows
  }, [scripts, filter, search])

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function selectAllVisible() {
    setSelected(prev => {
      const next = new Set(prev)
      for (const r of filtered) next.add(r.id)
      return next
    })
  }
  function deselectVisible() {
    setSelected(prev => {
      const next = new Set(prev)
      for (const r of filtered) next.delete(r.id)
      return next
    })
  }

  async function handleAttach() {
    if (!selected.size) return
    setWorking(true); setErr(null)
    try {
      await addScriptsToBatch(batch.id, [...selected])
      onSaved?.()
      onClose()
    } catch (e) {
      setErr(e.message)
    } finally {
      setWorking(false)
    }
  }

  return (
    <Modal open={open} onClose={working ? () => {} : onClose} size="xl"
      eyebrow={`Add to “${batch?.name || ''}”`}
      title="Pick existing scripts"
      subtitle="Attach scripts you've already generated or written to this batch. Moving a script from another batch is allowed."
      footer={
        <>
          {err && (
            <span style={{
              flex: 1, fontFamily: 'var(--sans)', fontSize: 12.5, color: '#b53e3e',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              <AlertCircle size={14} /> {err}
            </span>
          )}
          {!err && (
            <span style={{
              flex: 1, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
              letterSpacing: '0.04em', textTransform: 'uppercase',
            }}>
              {selected.size} selected · {filtered.length} visible
            </span>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={working} style={btnGhost}>Cancel</button>
            <button onClick={handleAttach} disabled={!selected.size || working} style={btnPrimary}>
              <Check size={13} /> Attach {selected.size || ''}
            </button>
          </div>
        </>
      }>
      {/* Toolbar */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 1,
        padding: '14px 24px', background: 'var(--paper)',
        borderBottom: '1px solid var(--rule)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search title or body…"
          style={{
            flex: '1 1 280px', maxWidth: 360,
            padding: '8px 12px', fontFamily: 'var(--sans)', fontSize: 14,
            border: '1px solid var(--rule-2)', background: 'white', outline: 'none',
          }} />
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { k: 'loose', l: 'Loose drafts' },
            { k: 'other_batch', l: 'In other batches' },
            { k: 'all', l: 'All' },
          ].map(o => (
            <button key={o.k} onClick={() => setFilter(o.k)} style={{
              padding: '6px 12px',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              background: filter === o.k ? 'var(--ink)' : 'transparent',
              color: filter === o.k ? 'var(--paper)' : 'var(--ink-3)',
              border: `1px solid ${filter === o.k ? 'var(--ink)' : 'var(--rule-2)'}`,
              cursor: 'pointer',
            }}>{o.l}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={selectAllVisible} style={btnGhost}>Select visible</button>
        <button onClick={deselectVisible} style={btnGhost}>Deselect</button>
      </div>

      {/* List */}
      {loading ? (
        <div style={{ padding: 64, textAlign: 'center', color: 'var(--ink-4)',
                      fontFamily: 'var(--serif)', fontStyle: 'italic' }}>
          Loading scripts…
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 64, textAlign: 'center', color: 'var(--ink-4)',
                      fontFamily: 'var(--serif)', fontStyle: 'italic' }}>
          {search ? 'No matches.' : filter === 'loose' ? 'No loose drafts. Generate some on the Generate page first.' : 'Nothing to show.'}
        </div>
      ) : filtered.map((s, i) => (
        <ScriptPickerRow key={s.id} script={s}
          checked={selected.has(s.id)}
          onToggle={() => toggle(s.id)}
          isLast={i === filtered.length - 1} />
      ))}
    </Modal>
  )
}

function ScriptPickerRow({ script, checked, onToggle, isLast }) {
  const t = script.target_attributes || {}
  return (
    <div onClick={onToggle}
      style={{
        display: 'grid', gridTemplateColumns: '24px 1fr auto',
        gap: 14, padding: '14px 24px',
        borderBottom: isLast ? 'none' : '1px solid var(--rule)',
        alignItems: 'flex-start', cursor: 'pointer',
        background: checked ? 'var(--paper-2)' : 'transparent',
        transition: 'background 0.12s',
      }}
      onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--paper-2)' }}
      onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent' }}>
      <input type="checkbox" checked={checked} onChange={onToggle}
        onClick={e => e.stopPropagation()}
        style={{ marginTop: 4, accentColor: 'var(--ink)', width: 16, height: 16 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 500, color: 'var(--ink)',
          marginBottom: 4,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {script.title || `Script ${script.id.slice(0, 8)}`}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {t.hook_type && <ValueChip attr="hook_type" value={t.hook_type} size="xs" />}
          {t.message_frame && <ValueChip attr="message_frame" value={t.message_frame} size="xs" />}
          {t.mechanism_reveal && <ValueChip attr="mechanism_reveal" value={t.mechanism_reveal} size="xs" />}
          {t.pain_angle && <ValueChip attr="pain_angle" value={t.pain_angle} size="xs" />}
          {t.proof_character && t.proof_character !== 'none' && <ValueChip attr="proof_character" value={t.proof_character} size="xs" />}
        </div>
        {script.body && (
          <div style={{
            fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--ink-3)',
            lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{script.body}</div>
        )}
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        gap: 4, flexShrink: 0,
      }}>
        {script.test_batch_id && (
          <span style={{
            padding: '2px 7px',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: '#b86a0c',
            border: '1px solid rgba(184,106,12,0.3)',
            background: 'rgba(184,106,12,0.06)',
          }}>In other batch</span>
        )}
        {script.ad_id && (
          <span style={{
            padding: '2px 7px',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: '#3e8a5e',
            border: '1px solid rgba(62,138,94,0.3)',
            background: 'rgba(62,138,94,0.06)',
          }}>Linked</span>
        )}
      </div>
    </div>
  )
}

const btnGhost = {
  padding: '6px 12px',
  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  background: 'transparent', color: 'var(--ink-3)',
  border: '1px solid var(--rule-2)', cursor: 'pointer',
}
const btnPrimary = {
  padding: '8px 16px',
  fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 600,
  background: 'var(--ink)', color: 'var(--paper)',
  border: '1px solid var(--ink)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
