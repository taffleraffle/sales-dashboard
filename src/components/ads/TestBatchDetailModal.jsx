import { useEffect, useState } from 'react'
import { ExternalLink, Trash2, Send, FileText, Plus, Upload, FilePlus } from 'lucide-react'
import { Link } from 'react-router-dom'
import Modal from '../editorial/Modal'
import UploadScriptsModal from './UploadScriptsModal'
import AddExistingScriptsModal from './AddExistingScriptsModal'
import {
  Eyebrow, ValueChip, attrColor, displayValue, tint, PALETTE,
} from '../editorial/atoms'
import {
  getTestBatch,
  launchTestBatch,
  closeTestBatch,
  removeScriptsFromBatch,
  deleteTestBatch,
} from '../../services/testBatches'

const DIMENSIONS = [
  { id: 'hook_type',        label: 'Hook' },
  { id: 'message_frame',    label: 'Frame' },
  { id: 'mechanism_reveal', label: 'Mechanism' },
  { id: 'pain_angle',       label: 'Pain' },
  { id: 'proof_character',  label: 'Proof' },
  { id: 'funnel_stage',     label: 'Funnel' },
]

/*
  Detail view for one test batch. Top: name + hypothesis + status pill.
  Density grid: one row per dimension, stacked colored bar showing the
  mix of values in the batch's scripts. Below: list of scripts with
  title, target attributes, and link/delete actions. Footer: Launch /
  Mark closed / Delete.
*/
export default function TestBatchDetailModal({ open, onClose, batchId, onChanged }) {
  const [batch, setBatch] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [working, setWorking] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (!open || !batchId) return
    let alive = true
    setLoading(true); setErr(null)
    getTestBatch(batchId)
      .then(b => { if (alive) setBatch(b) })
      .catch(e => { if (alive) setErr(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, batchId])

  async function refresh() {
    if (!batchId) return
    try {
      const b = await getTestBatch(batchId)
      setBatch(b)
    } catch (e) { setErr(e.message) }
  }

  async function handleLaunch() {
    if (!batch) return
    if (!window.confirm(`Launch "${batch.name}"? This marks it as launched and exits the draft state.`)) return
    setWorking(true)
    try { await launchTestBatch(batch.id); await refresh(); onChanged?.() }
    catch (e) { setErr(e.message) }
    finally { setWorking(false) }
  }

  async function handleClose() {
    if (!batch) return
    if (!window.confirm(`Mark "${batch.name}" as closed (test complete)?`)) return
    setWorking(true)
    try { await closeTestBatch(batch.id); await refresh(); onChanged?.() }
    catch (e) { setErr(e.message) }
    finally { setWorking(false) }
  }

  async function handleDelete() {
    if (!batch) return
    if (!window.confirm(`Delete "${batch.name}"? Scripts are kept; they just lose their batch link.`)) return
    setWorking(true)
    try {
      await deleteTestBatch(batch.id)
      onChanged?.()
      onClose()
    } catch (e) { setErr(e.message); setWorking(false) }
  }

  async function handleRemoveScript(scriptId) {
    setWorking(true)
    try { await removeScriptsFromBatch([scriptId]); await refresh(); onChanged?.() }
    catch (e) { setErr(e.message) }
    finally { setWorking(false) }
  }

  if (!open) return null

  const isDraft = batch && !batch.launched_at
  const isClosed = batch?.closed_at

  return (
    <Modal open={open} onClose={working ? () => {} : onClose} size="xl"
      eyebrow={isDraft ? 'Test draft' : isClosed ? 'Test · closed' : 'Test · launched'}
      title={batch?.name || 'Loading…'}
      subtitle={batch?.hypothesis}
      right={batch && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px',
          background: isDraft ? tint(PALETTE.orange, 0.1)
            : isClosed ? 'var(--paper-2)'
            : tint(PALETTE.green, 0.1),
          color: isDraft ? PALETTE.orange : isClosed ? 'var(--ink-3)' : PALETTE.green,
          border: `1px solid ${isDraft ? tint(PALETTE.orange, 0.3)
            : isClosed ? 'var(--rule-2)'
            : tint(PALETTE.green, 0.3)}`,
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
          letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: 6,
            background: isDraft ? PALETTE.orange : isClosed ? 'var(--ink-4)' : PALETTE.green,
          }} />
          {isDraft ? 'Draft' : isClosed ? 'Closed' : 'Launched'}
        </span>
      )}
      footer={batch && (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleDelete} disabled={working} style={btnDanger}>
              <Trash2 size={12} /> Delete
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            {isDraft && (
              <button onClick={handleLaunch} disabled={working || batch.script_count === 0}
                style={btnPrimary} title={batch.script_count === 0 ? 'Add scripts before launching' : 'Mark this test as launched'}>
                <Send size={12} /> Launch test
              </button>
            )}
            {!isDraft && !isClosed && (
              <button onClick={handleClose} disabled={working} style={btnGhost}>
                Mark closed
              </button>
            )}
          </div>
        </>
      )}>
      <div style={{ padding: 24 }}>
        {err && (
          <div style={{
            padding: '10px 12px', marginBottom: 16,
            background: '#fef2f2', border: '1px solid #fca5a5',
            color: '#b53e3e', fontSize: 13,
          }}>{err}</div>
        )}

        {loading && !batch && (
          <div style={{
            padding: 48, textAlign: 'center', color: 'var(--ink-4)',
            fontFamily: 'var(--serif)', fontStyle: 'italic',
          }}>Loading…</div>
        )}

        {batch && (
          <>
            {/* Quick stats row */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 16, marginBottom: 24,
              padding: '14px 18px', border: '1px solid var(--rule)', background: 'white',
            }}>
              <Stat label="Scripts" value={batch.script_count} />
              <Stat label="Linked to ads" value={`${batch.linked_count}/${batch.script_count}`} />
              <Stat label="Created" value={fmtAgo(batch.created_at)} />
              {batch.launched_at && <Stat label="Launched" value={fmtAgo(batch.launched_at)} />}
              {batch.campaign_names?.length > 0 && (
                <Stat label="Campaigns" value={batch.campaign_names.length} />
              )}
            </div>

            {/* Density */}
            <Eyebrow style={{ marginBottom: 8 }}>Density</Eyebrow>
            <p style={{
              margin: '0 0 14px', fontFamily: 'var(--sans)', fontSize: 12.5,
              color: 'var(--ink-3)', lineHeight: 1.5,
            }}>
              Distribution of test variables across the {batch.script_count} script{batch.script_count === 1 ? '' : 's'} in this batch.
              {batch.script_count === 0 && ' Add scripts to see the breakdown.'}
            </p>
            <div style={{
              background: 'white', border: '1px solid var(--rule)',
              marginBottom: 28,
            }}>
              {DIMENSIONS.map(d => (
                <DensityRow key={d.id}
                  label={d.label}
                  attr={d.id}
                  counts={batch.density[d.id] || {}}
                  total={batch.script_count}
                />
              ))}
            </div>

            {/* Scripts list */}
            <div style={{
              display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
              marginBottom: 12, gap: 12, flexWrap: 'wrap',
            }}>
              <div>
                <Eyebrow>Scripts in this batch</Eyebrow>
                <div style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-3)', marginTop: 2 }}>
                  {batch.script_count === 0
                    ? 'Empty. Add scripts using one of the three methods on the right.'
                    : `${batch.script_count} script${batch.script_count === 1 ? '' : 's'} attached.`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setPickerOpen(true)}
                  style={btnGhostInline} title="Attach scripts you already have">
                  <FilePlus size={12} /> Pick existing
                </button>
                <button onClick={() => setUploadOpen(true)}
                  style={btnGhostInline} title="Upload a doc — Claude splits it into scripts">
                  <Upload size={12} /> Upload doc
                </button>
                <Link to="/sales/ads/creative/generate"
                  style={{ ...btnGhostInline, textDecoration: 'none', color: 'var(--ink-2)' }}>
                  <Plus size={12} /> Generate
                </Link>
              </div>
            </div>
            {batch.scripts.length > 0 && (
              <div style={{ background: 'white', border: '1px solid var(--rule)' }}>
                {batch.scripts.map((s, i) => (
                  <ScriptRow key={s.id} script={s}
                    isLast={i === batch.scripts.length - 1}
                    onRemove={() => handleRemoveScript(s.id)}
                    working={working} />
                ))}
              </div>
            )}

            {/* Campaign names (when launched) */}
            {batch.launched_at && batch.campaign_names?.length > 0 && (
              <div style={{ marginTop: 28 }}>
                <Eyebrow style={{ marginBottom: 8 }}>Launched as</Eyebrow>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {batch.campaign_names.map(c => (
                    <span key={c} style={{
                      padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 11,
                      letterSpacing: '0.04em', color: 'var(--ink-2)',
                      background: 'var(--paper-2)', border: '1px solid var(--rule-2)',
                    }}>{c}</span>
                  ))}
                </div>
              </div>
            )}

            {batch.notes && (
              <div style={{ marginTop: 28 }}>
                <Eyebrow style={{ marginBottom: 6 }}>Notes</Eyebrow>
                <div style={{
                  padding: '12px 14px',
                  background: 'var(--paper-2)', border: '1px solid var(--rule)',
                  fontFamily: 'var(--sans)', fontSize: 13.5, color: 'var(--ink-2)',
                  lineHeight: 1.55, whiteSpace: 'pre-wrap',
                }}>
                  {batch.notes}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <UploadScriptsModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        batch={batch}
        onSaved={() => { refresh(); onChanged?.() }}
      />
      <AddExistingScriptsModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        batch={batch}
        onSaved={() => { refresh(); onChanged?.() }}
      />
    </Modal>
  )
}

const btnGhostInline = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '6px 12px',
  fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  background: 'transparent', color: 'var(--ink-2)',
  border: '1px solid var(--rule-2)', cursor: 'pointer',
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
        letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-4)',
        marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontFamily: 'var(--sans)', fontVariantNumeric: 'tabular-nums',
        fontSize: 20, fontWeight: 600, color: 'var(--ink)',
      }}>{value}</div>
    </div>
  )
}

function DensityRow({ label, attr, counts, total }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '100px 1fr',
      gap: 14, padding: '12px 16px',
      borderBottom: '1px solid var(--rule)',
      alignItems: 'center',
    }}>
      <div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
          letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-2)',
        }}>{label}</div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
          letterSpacing: '0.04em', marginTop: 3,
        }}>
          {entries.length === 0 ? '— none —' : `${entries.length} value${entries.length === 1 ? '' : 's'}`}
        </div>
      </div>
      <div>
        {/* Stacked bar */}
        {total > 0 && entries.length > 0 && (
          <div style={{
            display: 'flex', height: 12, background: 'var(--paper-2)',
            border: '1px solid var(--rule)', overflow: 'hidden',
            marginBottom: 8,
          }}>
            {entries.map(([v, n]) => (
              <div key={v} title={`${displayValue(v)}: ${n} of ${total}`}
                style={{
                  width: `${(n / total) * 100}%`,
                  background: attrColor(attr, v),
                  transition: 'width 0.3s ease',
                }} />
            ))}
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {entries.map(([v, n]) => (
            <span key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <ValueChip attr={attr} value={v} size="xs" />
              <span style={{
                fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                fontSize: 10.5, fontWeight: 600, color: 'var(--ink-3)',
              }}>×{n}</span>
            </span>
          ))}
          {entries.length === 0 && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-5)' }}>—</span>
          )}
        </div>
      </div>
    </div>
  )
}

function ScriptRow({ script, isLast, onRemove, working }) {
  const t = script.target_attributes || {}
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr auto',
      gap: 14, padding: '14px 18px',
      borderBottom: isLast ? 'none' : '1px solid var(--rule)',
      alignItems: 'flex-start',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500, color: 'var(--ink)',
          marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {script.title || script.ref || `Script ${script.id.slice(0, 8)}`}
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
          }}>
            {script.body}
          </div>
        )}
        {script.ad_id && (
          <div style={{
            marginTop: 6, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
            letterSpacing: '0.04em', textTransform: 'uppercase',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: 5,
              background: PALETTE.green,
            }} />
            Linked to ad <span style={{ color: 'var(--ink-3)' }}>{script.ad_id}</span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {script.ad_id && (
          <Link to={`/sales/ads/ad/${script.ad_id}`} title="Open the linked ad"
            style={{
              padding: '5px 9px', fontFamily: 'var(--mono)', fontSize: 10,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              background: 'transparent', color: 'var(--ink-3)',
              border: '1px solid var(--rule-2)', textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
            <ExternalLink size={10} /> Ad
          </Link>
        )}
        <button onClick={onRemove} disabled={working}
          title="Remove this script from the batch (the script itself is preserved)"
          style={{
            padding: '5px 9px', fontFamily: 'var(--mono)', fontSize: 10,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            background: 'transparent', color: 'var(--ink-4)',
            border: '1px solid var(--rule-2)', cursor: 'pointer',
            opacity: working ? 0.4 : 1,
          }}>
          Remove
        </button>
      </div>
    </div>
  )
}

function fmtAgo(dateStr) {
  if (!dateStr) return '—'
  const t = new Date(dateStr).getTime()
  if (isNaN(t)) return '—'
  const days = Math.floor((Date.now() - t) / 86400000)
  if (days < 1) return 'today'
  if (days < 7) return `${days}d ago`
  if (days < 60) return `${Math.floor(days / 7)}w ago`
  return new Date(t).toISOString().slice(0, 10)
}

const btnGhost = {
  padding: '8px 14px',
  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.08em', textTransform: 'uppercase',
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
const btnDanger = {
  padding: '8px 12px',
  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.08em', textTransform: 'uppercase',
  background: 'transparent', color: '#b53e3e',
  border: '1px solid rgba(181,62,62,0.3)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4,
}
