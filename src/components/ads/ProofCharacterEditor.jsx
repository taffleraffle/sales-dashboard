import { useState, useEffect } from 'react'
import { X, Check, AlertCircle, Plus, Trash2, Save, Loader } from 'lucide-react'
import {
  listProofCharactersForAngle,
  upsertProofCharacter,
  deleteProofCharacter,
  PROOF_TYPES,
} from '../../services/scriptGenerator'
import ConfirmModal from '../ConfirmModal'

/*
  Proof character editor — per-angle, rows-style.
  Each row: name (short — e.g. "Eric") + one-line result_short
  (e.g. "Closed a $215K job in 90 days"). Optional fields tucked under
  a small expander: industry_context, metric_kind, result_long.

  Save model: each row has its own dirty state and Save button so the
  operator can add a single character without rewriting the others.
  Retire is soft-delete (active=false) via deleteProofCharacter.

  Opens from the angle preview block on the Scripts tab. Closes on
  click-outside or ESC. Refreshing the parent list happens via onSaved.
*/

export default function ProofCharacterEditor({ open, angle, onClose, onSaved }) {
  const [rows, setRows] = useState([])      // existing rows from DB
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  // Buffered edits keyed by row id (or '__new' for the new-row buffer).
  // Each entry = { name, result_short, result_long, industry_context, metric_kind }
  const [edits, setEdits] = useState({})
  const [savingIds, setSavingIds] = useState(new Set())
  const [retireTarget, setRetireTarget] = useState(null)  // { id, name }
  const [retiring, setRetiring] = useState(false)

  useEffect(() => {
    if (!open || !angle?.slug) return
    setLoading(true); setErr(null)
    listProofCharactersForAngle(angle.slug)
      .then(r => {
        setRows(r)
        // Seed an empty new-row buffer
        setEdits({ __new: emptyEdit() })
      })
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }, [open, angle?.slug])

  useEffect(() => {
    if (!open) return
    const onEsc = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [open, onClose])

  if (!open) return null

  function setEdit(id, patch) {
    setEdits(prev => ({ ...prev, [id]: { ...(prev[id] || emptyEdit()), ...patch } }))
  }

  function isDirty(row) {
    const e = edits[row.id] || {}
    return (
      e.name !== undefined && e.name !== row.name ||
      e.result_short !== undefined && e.result_short !== row.result_short ||
      e.result_long !== undefined && (e.result_long || '') !== (row.result_long || '') ||
      e.industry_context !== undefined && (e.industry_context || '') !== (row.industry_context || '') ||
      e.metric_kind !== undefined && (e.metric_kind || '') !== (row.metric_kind || '') ||
      e.proof_type !== undefined && e.proof_type !== (row.proof_type || 'case_study')
    )
  }

  function valueFor(row, field) {
    const e = edits[row.id] || {}
    return e[field] !== undefined ? e[field] : (row[field] || '')
  }

  async function saveRow(rowOrNew) {
    const isNew = rowOrNew === '__new'
    const id = isNew ? '__new' : rowOrNew.id
    const e = edits[id] || {}
    const payload = {
      angle_slug: angle.slug,
      name: (e.name ?? (isNew ? '' : rowOrNew.name) ?? '').trim(),
      result_short: (e.result_short ?? (isNew ? '' : rowOrNew.result_short) ?? '').trim(),
      result_long: (e.result_long ?? (isNew ? '' : rowOrNew.result_long) ?? '').trim() || null,
      industry_context: (e.industry_context ?? (isNew ? '' : rowOrNew.industry_context) ?? '').trim() || null,
      metric_kind: (e.metric_kind ?? (isNew ? '' : rowOrNew.metric_kind) ?? '').trim() || null,
      proof_type: (e.proof_type ?? (isNew ? 'case_study' : rowOrNew.proof_type) ?? 'case_study'),
    }
    if (!payload.name || !payload.result_short) {
      setErr('Name and one-line result are required.')
      return
    }
    setSavingIds(prev => new Set(prev).add(id))
    setErr(null)
    try {
      const saved = await upsertProofCharacter(payload)
      const fresh = await listProofCharactersForAngle(angle.slug)
      setRows(fresh)
      // Clear the buffer for this row so isDirty goes false
      setEdits(prev => {
        const next = { ...prev }
        if (isNew) next.__new = emptyEdit()
        else delete next[id]
        return next
      })
      onSaved?.(saved)
    } catch (e) {
      setErr(`Save failed: ${e.message}`)
    } finally {
      setSavingIds(prev => {
        const n = new Set(prev); n.delete(id); return n
      })
    }
  }

  async function performRetire() {
    if (!retireTarget?.id) return
    setRetiring(true); setErr(null)
    try {
      await deleteProofCharacter(retireTarget.id)
      setRows(prev => prev.filter(r => r.id !== retireTarget.id))
      setRetireTarget(null)
      onSaved?.(null)
    } catch (e) {
      setErr(`Retire failed: ${e.message}`)
    } finally {
      setRetiring(false)
    }
  }

  return (
    <>
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }} onClick={onClose}>
        <div onClick={e => e.stopPropagation()}
          style={{
            background: 'var(--paper)', maxWidth: 820, width: '100%', maxHeight: '90vh',
            overflow: 'auto', border: '1px solid var(--rule)',
            borderTop: '3px solid var(--accent)', borderRadius: 2,
            boxShadow: '0 24px 60px rgba(10,10,10,0.18)',
          }}>
          {/* Header */}
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--rule)',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div className="eyebrow eyebrow-accent">Proof characters</div>
              <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 400, margin: '6px 0 0' }}>
                {angle?.name || 'angle'}
              </h2>
              <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic',
                          color: 'var(--ink-3)', fontSize: 13, margin: '6px 0 0', lineHeight: 1.5 }}>
                Each row is a named client + a one-line result the script generator can pull from.
                Add 3-5 for healthy rotation. The optional details below each row tune which scripts
                pick which character (industry context, metric kind).
              </p>
            </div>
            <button onClick={onClose} style={{
              background: 'transparent', border: 'none', color: 'var(--ink-3)',
              cursor: 'pointer', padding: 4,
            }}>
              <X size={20} />
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: 24 }}>
            {err && (
              <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fca5a5',
                            color: '#b53e3e', fontSize: 13, marginBottom: 16, borderRadius: 2 }}>
                <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
              </div>
            )}

            {loading ? (
              <div style={{ padding: 20, textAlign: 'center',
                            fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-4)',
                            letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                Loading proof characters…
              </div>
            ) : (
              <>
                {/* Existing rows */}
                {rows.length === 0 && (
                  <div style={{
                    padding: '16px 18px', background: 'var(--paper)',
                    border: '1px dashed var(--rule)', fontFamily: 'var(--serif)',
                    fontStyle: 'italic', fontSize: 14, color: 'var(--ink-4)', marginBottom: 14,
                  }}>
                    No proof characters yet for this angle. Add one below to populate the generator.
                  </div>
                )}
                {/* Group existing rows by proof_type so the operator scans
                    cleanly — Case studies, then Statistics, then Authority etc. */}
                {(() => {
                  const grouped = {}
                  const order = []
                  for (const r of rows) {
                    const t = r.proof_type || 'case_study'
                    if (!grouped[t]) { grouped[t] = []; order.push(t) }
                    grouped[t].push(r)
                  }
                  return order.map(t => {
                    const meta = PROOF_TYPES.find(p => p.value === t) || { label: t, hint: '' }
                    return (
                      <div key={t} style={{ marginBottom: 14 }}>
                        <div style={{
                          display: 'flex', alignItems: 'baseline', gap: 8,
                          marginBottom: 6, paddingBottom: 4,
                          borderBottom: '1px solid var(--rule)',
                        }}>
                          <span style={{
                            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                            letterSpacing: '0.14em', textTransform: 'uppercase',
                            color: 'var(--ink)',
                          }}>{meta.label}</span>
                          <span style={{
                            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                          }}>{grouped[t].length}</span>
                        </div>
                        {grouped[t].map(row => {
                          const saving = savingIds.has(row.id)
                          const dirty = isDirty(row)
                          return (
                            <ProofRow
                              key={row.id}
                              title={`#${row.display_order || 100}`}
                              name={valueFor(row, 'name')}
                              resultShort={valueFor(row, 'result_short')}
                              resultLong={valueFor(row, 'result_long')}
                              industryContext={valueFor(row, 'industry_context')}
                              metricKind={valueFor(row, 'metric_kind')}
                              proofType={valueFor(row, 'proof_type') || 'case_study'}
                              onChange={(field, v) => setEdit(row.id, { [field]: v })}
                              onSave={() => saveRow(row)}
                              onRetire={() => setRetireTarget({ id: row.id, name: row.name })}
                              saving={saving}
                              dirty={dirty}
                            />
                          )
                        })}
                      </div>
                    )
                  })
                })()}

                {/* New row buffer */}
                <div style={{
                  marginTop: 16, padding: '14px 16px',
                  background: 'var(--paper)', border: '1px dashed var(--rule)',
                  borderLeft: '3px solid var(--accent)', borderRadius: 2,
                }}>
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
                    textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 10,
                  }}>
                    Add new
                  </div>
                  <ProofRow
                    title="New"
                    name={edits.__new?.name || ''}
                    resultShort={edits.__new?.result_short || ''}
                    resultLong={edits.__new?.result_long || ''}
                    industryContext={edits.__new?.industry_context || ''}
                    metricKind={edits.__new?.metric_kind || ''}
                    proofType={edits.__new?.proof_type || 'case_study'}
                    onChange={(field, v) => setEdit('__new', { [field]: v })}
                    onSave={() => saveRow('__new')}
                    onRetire={null}
                    saving={savingIds.has('__new')}
                    dirty={!!(edits.__new?.name?.trim() && edits.__new?.result_short?.trim())}
                    isNew
                  />
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: '14px 24px', borderTop: '1px solid var(--rule)',
                        display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={onClose}
              style={{ padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11,
                      letterSpacing: '0.12em', textTransform: 'uppercase',
                      border: '1px solid var(--rule)', background: 'transparent',
                      color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 2 }}>
              Done
            </button>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={!!retireTarget}
        onClose={() => !retiring && setRetireTarget(null)}
        onConfirm={performRetire}
        title={`Retire "${retireTarget?.name || 'this character'}"?`}
        message="Removes them from the picker and the generator. Historical scripts that referenced them keep working. Soft delete (sets active = false)."
        confirmLabel="Retire"
        variant="danger"
        loading={retiring}
      />
    </>
  )
}

function emptyEdit() {
  return {
    name: '', result_short: '', result_long: '',
    industry_context: '', metric_kind: '', proof_type: 'case_study',
  }
}

function ProofRow({
  title, name, resultShort, resultLong, industryContext, metricKind, proofType,
  onChange, onSave, onRetire, saving, dirty, isNew,
}) {
  const [showDetails, setShowDetails] = useState(false)
  const typeMeta = PROOF_TYPES.find(p => p.value === proofType) || PROOF_TYPES[0]
  // Per-type placeholder text so the field guides the operator. Names mean
  // different things for different proof types (e.g. for 'authority' the
  // "name" is the source citation, for 'statistic' it's the metric label).
  const nameLabel = {
    case_study:    'Client name',
    testimonial:   'Quote attribution',
    statistic:     'Metric label',
    authority:     'Source / citation',
    demonstration: 'Demo name',
    social_volume: 'Cohort label',
    comparison:    'Vs what',
  }[proofType] || 'Name'
  const namePh = {
    case_study:    'Eric',
    testimonial:   'Mark — plumber, NC',
    statistic:     'HomeAdvisor burnout rate',
    authority:     'Roto-Rooter franchise manual',
    demonstration: 'Month 1 vs month 6 dashboard',
    social_volume: 'Restoration cohort 2024',
    comparison:    'vs HomeAdvisor',
  }[proofType] || 'Eric'
  const resultPh = {
    case_study:    'Closed a $215K job in 90 days',
    testimonial:   '"My closing rate doubled in week 2."',
    statistic:     '67% of restoration owners burn out on HomeAdvisor in year 2',
    authority:     'Explicitly recommends abandoning shared-lead platforms',
    demonstration: '$14K → $48K MRR by month 6, charted',
    social_volume: '38 restoration companies, average $32K/mo lift',
    comparison:    '3.2x bookings, 1/4 the cost-per-lead',
  }[proofType] || 'Closed a $215K job in 90 days'
  return (
    <div style={{
      padding: isNew ? 0 : 14,
      background: isNew ? 'transparent' : 'var(--paper)',
      border: isNew ? 'none' : '1px solid var(--rule)',
      borderRadius: 2, marginBottom: isNew ? 0 : 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Label>Type</Label>
        <select value={proofType} onChange={e => onChange('proof_type', e.target.value)}
          style={{
            padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 11,
            letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600,
            border: '1px solid var(--rule)', background: 'var(--paper)',
            color: 'var(--ink)', borderRadius: 2, outline: 'none', cursor: 'pointer',
          }}>
          {PROOF_TYPES.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <span style={{
          fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 11.5,
          color: 'var(--ink-4)',
        }}>
          {typeMeta.hint}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr auto', gap: 10, alignItems: 'start' }}>
        <div>
          <Label>{nameLabel}</Label>
          <input type="text" value={name}
            onChange={e => onChange('name', e.target.value)}
            placeholder={namePh}
            style={inputStyle} />
        </div>
        <div>
          <Label>One-line proof</Label>
          <input type="text" value={resultShort}
            onChange={e => onChange('result_short', e.target.value)}
            placeholder={resultPh}
            style={inputStyle} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 18 }}>
          <button onClick={onSave} disabled={!dirty || saving}
            style={{
              padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11,
              letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600,
              border: '1px solid var(--ink)',
              background: dirty && !saving ? 'var(--ink)' : 'var(--rule)',
              color: dirty && !saving ? 'var(--paper)' : 'var(--ink-4)',
              cursor: dirty && !saving ? 'pointer' : 'not-allowed',
              borderRadius: 2, display: 'inline-flex', alignItems: 'center', gap: 5,
              minWidth: 76, justifyContent: 'center',
            }}>
            {saving ? <Loader size={12} className="animate-spin" /> : isNew ? <Plus size={12} /> : <Save size={12} />}
            {saving ? '...' : isNew ? 'Add' : 'Save'}
          </button>
          {onRetire && (
            <button onClick={onRetire} disabled={saving}
              title="Retire"
              style={{
                padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                border: '1px solid var(--rule)', background: 'transparent',
                color: 'var(--ink-4)', cursor: saving ? 'wait' : 'pointer',
                borderRadius: 2, display: 'inline-flex', alignItems: 'center', gap: 5,
                justifyContent: 'center',
              }}
              onMouseEnter={(e) => !saving && (e.currentTarget.style.color = '#b53e3e')}
              onMouseLeave={(e) => e.currentTarget.style.color = 'var(--ink-4)'}>
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>

      <button onClick={() => setShowDetails(v => !v)}
        style={{
          marginTop: 10, padding: 0, background: 'transparent', border: 'none',
          color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 10.5,
          letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
        }}>
        {showDetails ? '− Hide details' : '+ Industry · metric · long-form result'}
      </button>

      {showDetails && (
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <Label>Industry context (optional)</Label>
            <input type="text" value={industryContext}
              onChange={e => onChange('industry_context', e.target.value)}
              placeholder="restoration"
              style={inputStyle} />
          </div>
          <div>
            <Label>Metric kind (optional)</Label>
            <input type="text" value={metricKind}
              onChange={e => onChange('metric_kind', e.target.value)}
              placeholder="revenue_close"
              style={inputStyle} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <Label>Long-form result (optional — for body roster use)</Label>
            <textarea value={resultLong} rows={2}
              onChange={e => onChange('result_long', e.target.value)}
              placeholder="Eric came in at $0 in March, signed his first $50K commercial deal in week 6, and closed a $215K loss-of-business job by day 87."
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--serif)', fontSize: 13.5 }} />
          </div>
        </div>
      )}
    </div>
  )
}

const inputStyle = {
  width: '100%', padding: '8px 10px',
  fontFamily: 'var(--sans)', fontSize: 13.5,
  border: '1px solid var(--rule)', background: 'var(--paper)',
  color: 'var(--ink)', borderRadius: 2, outline: 'none',
}

function Label({ children }) {
  return (
    <div style={{
      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
      textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4,
    }}>{children}</div>
  )
}
