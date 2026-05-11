import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertCircle, Search, Plus, Grid3x3, Trash2, ExternalLink } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  Variants page — spreadsheet-style.

  Three ways to populate:
    1. Matrix generator — pick hook-clips × body-clips (× optional frame)
       and the system creates ONE variant per combination via the
       lib_variants_bulk_from_clips RPC. Supports partial composition:
       just hooks (no body) or just bodies works too.
    2. "Add row" — single blank variant, click cells to fill.
    3. Edit any existing row inline.

  Performance-first sort: highest 30d-spend live variants float to the top
  so the splice recipe of a winner is immediately visible. Rows that are
  not linked to a Meta ad are shown below the live ones.
*/

const STAGES = [
  { key: 'raw',       label: 'Raw' },
  { key: 'rough_cut', label: 'Rough' },
  { key: 'final_cut', label: 'Final' },
  { key: 'approved',  label: 'Approved' },
  { key: 'uploaded',  label: 'Uploaded' },
]

const STATUS_OPTIONS = ['planned', 'editing', 'ready', 'live', 'paused', 'killed', 'winner']
const PRIORITY_OPTIONS = ['', 'high', 'med', 'low']

function fmt$(n) {
  if (n == null || isNaN(n) || n === 0) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${Math.round(n).toLocaleString()}`
}
function fmtN(n) { return n == null || isNaN(n) || n === 0 ? '—' : Math.round(n).toLocaleString() }

export default function AdsVariants() {
  const [rows, setRows] = useState([])
  const [clips, setClips] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [showMatrix, setShowMatrix] = useState(false)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const [{ data: variants, error: vErr }, { data: clipData }] = await Promise.all([
        supabase.from('lib_variants_with_performance').select('*').order('spend_30d', { ascending: false, nullsFirst: false }),
        supabase.from('lib_clips').select('clip_id, clip_type, description').order('clip_id'),
      ])
      if (vErr) throw new Error(vErr.message)
      setRows(variants || [])
      setClips(clipData || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    let out = rows
    if (statusFilter !== 'all') out = out.filter(v => v.status === statusFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      out = out.filter(v =>
        (v.variant_id || '').toLowerCase().includes(q) ||
        (v.hook_clip_id || '').toLowerCase().includes(q) ||
        (v.body_clip_id || '').toLowerCase().includes(q) ||
        (v.notes || '').toLowerCase().includes(q) ||
        (v.meta_ad_name || '').toLowerCase().includes(q)
      )
    }
    return out
  }, [rows, statusFilter, search])

  // Save a single cell inline. Optimistic.
  const saveField = async (variant, field, value) => {
    if (variant[field] === value) return
    setRows(prev => prev.map(r => r.variant_id === variant.variant_id ? { ...r, [field]: value } : r))
    try {
      const { error: e } = await supabase.rpc('lib_variant_upsert', {
        p_variant_id: variant.variant_id,
        p_status: field === 'status' ? value : (variant.status || 'planned'),
        p_iteration: variant.iteration || 1,
        p_hook_clip_id: field === 'hook_clip_id' ? value : (variant.hook_clip_id || null),
        p_body_clip_id: field === 'body_clip_id' ? value : (variant.body_clip_id || null),
        p_frame_clip_id: field === 'frame_clip_id' ? value : (variant.frame_clip_id || null),
        p_editor: field === 'editor' ? value : (variant.editor || null),
        p_priority: field === 'priority' ? value : (variant.priority || null),
        p_meta_ad_id: field === 'meta_ad_id' ? value : (variant.meta_ad_id || null),
        p_meta_ad_name: field === 'meta_ad_name' ? value : (variant.meta_ad_name || null),
        p_notes: field === 'notes' ? value : (variant.notes || null),
      })
      if (e) throw new Error(e.message)
    } catch (e) {
      setError(`Save failed: ${e.message}`)
      setRows(prev => prev.map(r => r.variant_id === variant.variant_id ? { ...r, [field]: variant[field] } : r))
    }
  }

  const toggleStage = async (variant, stageKey) => {
    const next = !variant[`stage_${stageKey}`]
    setRows(prev => prev.map(r => r.variant_id === variant.variant_id ? { ...r, [`stage_${stageKey}`]: next } : r))
    try {
      const { error: e } = await supabase.rpc('lib_variant_set_stage', { p_variant_id: variant.variant_id, p_stage: stageKey, p_value: next })
      if (e) throw new Error(e.message)
    } catch (e) {
      setRows(prev => prev.map(r => r.variant_id === variant.variant_id ? { ...r, [`stage_${stageKey}`]: !next } : r))
      setError(`Stage update failed: ${e.message}`)
    }
  }

  const addBlankRow = async () => {
    const stub = `VAR-${Date.now().toString(36).slice(-5).toUpperCase()}`
    try {
      const { error: e } = await supabase.rpc('lib_variant_upsert', { p_variant_id: stub })
      if (e) throw new Error(e.message)
      await load()
    } catch (e) { setError(`Add row failed: ${e.message}`) }
  }

  const deleteSelected = async () => {
    if (!selected.size) return
    if (!confirm(`Delete ${selected.size} variant${selected.size > 1 ? 's' : ''}?`)) return
    try {
      await Promise.all(Array.from(selected).map(variant_id =>
        supabase.rpc('lib_variant_delete', { p_variant_id: variant_id })
      ))
      setSelected(new Set())
      await load()
    } catch (e) { setError(`Delete failed: ${e.message}`) }
  }

  const toggleSelect = (vid) => {
    setSelected(prev => { const next = new Set(prev); next.has(vid) ? next.delete(vid) : next.add(vid); return next })
  }
  const toggleSelectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set())
    else setSelected(new Set(filtered.map(v => v.variant_id)))
  }

  const clipOptions = (type) => [
    '',
    ...clips.filter(c => !type || c.clip_type === type).map(c => c.clip_id),
  ]

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">Production · Spliced variants</span>
          <h2 className="h3 mt-2" style={{ fontSize: 22 }}>The <em>variant</em> board.</h2>
          <p className="mt-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            {rows.length} variants · sorted by 30d spend · winners float up · click cells to edit
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => setShowMatrix(true)} style={btnPrimary}>
            <Grid3x3 size={13} /> Matrix splice
          </button>
          <button onClick={addBlankRow} style={btnGhost}>
            <Plus size={13} /> Add row
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 16 }}>
        <ChipGroup label="Status" value={statusFilter} setValue={setStatusFilter}
          options={[{ value: 'all', label: 'All' }, ...STATUS_OPTIONS.map(s => ({ value: s, label: s }))]} />
        <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <Search size={12} style={{ color: 'var(--ink-3)', flexShrink: 0, marginLeft: 4 }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search variant ID, clips, ad…"
            style={{ flex: 1, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: '5px 8px', fontSize: 12, color: 'var(--ink)', outline: 'none' }} />
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', background: 'var(--down-soft)', border: '1px solid var(--down)', borderLeftWidth: 3, borderRadius: '0 3px 3px 0', color: 'var(--down)', marginBottom: 16, fontSize: 13 }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>{error}</div>
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--ink)', color: 'var(--paper)', borderRadius: 3, marginBottom: 12 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em' }}>{selected.size} SELECTED</span>
          <button onClick={deleteSelected} style={{ marginLeft: 'auto', padding: '5px 10px', background: 'var(--down)', color: 'var(--paper)', border: 'none', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, cursor: 'pointer' }}>
            <Trash2 size={11} style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }} />Delete
          </button>
          <button onClick={() => setSelected(new Set())} style={{ padding: '5px 10px', background: 'transparent', color: 'var(--paper)', border: '1px solid var(--paper-2)', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer' }}>Clear</button>
        </div>
      )}

      {loading && <div className="flex items-center justify-center py-16"><Loader className="animate-spin" style={{ color: 'var(--ink-3)' }} /></div>}

      {/* Empty state */}
      {!loading && rows.length === 0 && !error && (
        <div style={{ border: '2px dashed var(--rule)', borderRadius: 4, padding: 48, textAlign: 'center', background: 'var(--paper-2)' }}>
          <Grid3x3 size={48} style={{ color: 'var(--ink-4)', margin: '0 auto 12px' }} />
          <h3 className="h3" style={{ fontSize: 22, marginBottom: 8 }}>Splice your first variants.</h3>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)', maxWidth: '52ch', margin: '0 auto 18px', lineHeight: 1.55 }}>
            Pick hooks × bodies from your Clips catalog and the matrix generator creates one variant row per combination. Or add rows one at a time. You can test just a hook + body — frame and creator are optional.
          </p>
          <button onClick={() => setShowMatrix(true)} style={{ ...btnPrimary, padding: '10px 18px' }}>
            <Grid3x3 size={13} /> Open matrix splicer
          </button>
        </div>
      )}

      {/* Spreadsheet */}
      {!loading && filtered.length > 0 && (
        <div style={{ overflowX: 'auto', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3 }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
                <Th w={32} center>
                  <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleSelectAll} />
                </Th>
                <Th w={150}>Variant ID</Th>
                <Th w={90}>Status</Th>
                <Th w={130}>Hook clip</Th>
                <Th w={130}>Body clip</Th>
                <Th w={120}>Frame clip</Th>
                <Th w={80}>Editor</Th>
                <Th w={70}>Priority</Th>
                {STAGES.map(s => <Th key={s.key} w={52} center>{s.label}</Th>)}
                <Th w={140}>Linked Meta ad</Th>
                <Th w={70} center>Spend 30d</Th>
                <Th w={60} center>Booked</Th>
                <Th w={70} center>Revenue</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(v => (
                <tr key={v.variant_id} style={{ borderBottom: '1px solid var(--rule)', background: v.status === 'winner' ? 'var(--accent-soft)' : undefined }}>
                  <Td center><input type="checkbox" checked={selected.has(v.variant_id)} onChange={() => toggleSelect(v.variant_id)} /></Td>
                  <Td mono>{v.variant_id}</Td>
                  <Td><InlineSelect value={v.status} options={STATUS_OPTIONS} onSave={val => saveField(v, 'status', val)} /></Td>
                  <Td><InlineSelect value={v.hook_clip_id} options={clipOptions('hook').concat(clipOptions('hook_proof').slice(1))} onSave={val => saveField(v, 'hook_clip_id', val || null)} placeholder="—" /></Td>
                  <Td><InlineSelect value={v.body_clip_id} options={clipOptions('body')} onSave={val => saveField(v, 'body_clip_id', val || null)} placeholder="—" /></Td>
                  <Td><InlineSelect value={v.frame_clip_id} options={clipOptions('frame').concat(clipOptions('client_clip').slice(1))} onSave={val => saveField(v, 'frame_clip_id', val || null)} placeholder="—" /></Td>
                  <Td><InlineEdit value={v.editor} onSave={val => saveField(v, 'editor', val || null)} /></Td>
                  <Td><InlineSelect value={v.priority} options={PRIORITY_OPTIONS} onSave={val => saveField(v, 'priority', val || null)} /></Td>
                  {STAGES.map(s => (
                    <Td key={s.key} center><StageCheckbox checked={v[`stage_${s.key}`]} onChange={() => toggleStage(v, s.key)} /></Td>
                  ))}
                  <Td>
                    {v.meta_ad_id ? (
                      <Link to={`/sales/ads/ad/${v.meta_ad_id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--serif)', fontSize: 12, color: 'var(--ink-2)', textDecoration: 'underline', textDecorationColor: 'var(--ink-4)' }}>
                        {v.meta_ad_name ? (v.meta_ad_name.length > 22 ? v.meta_ad_name.slice(0, 20) + '…' : v.meta_ad_name) : v.meta_ad_id.slice(-8)}
                        <ExternalLink size={9} />
                      </Link>
                    ) : (
                      <InlineEdit value={v.meta_ad_id} onSave={val => saveField(v, 'meta_ad_id', val || null)} placeholder="link…" mono />
                    )}
                  </Td>
                  <Td center mono>{fmt$(v.spend_30d)}</Td>
                  <Td center mono>{fmtN(v.hyros_calls)}</Td>
                  <Td center mono>{fmt$(parseFloat(v.hyros_revenue || 0))}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Matrix splice modal */}
      {showMatrix && (
        <MatrixSpliceModal
          clips={clips}
          onClose={() => setShowMatrix(false)}
          onCreated={() => { setShowMatrix(false); load() }}
        />
      )}
    </div>
  )
}

// ── Matrix splicer modal ────────────────────────────────────────────
function MatrixSpliceModal({ clips, onClose, onCreated }) {
  const hooks = clips.filter(c => c.clip_type === 'hook' || c.clip_type === 'hook_proof')
  const bodies = clips.filter(c => c.clip_type === 'body')
  const frames = clips.filter(c => c.clip_type === 'frame' || c.clip_type === 'client_clip')

  const [selectedHooks, setSelectedHooks] = useState(new Set())
  const [selectedBodies, setSelectedBodies] = useState(new Set())
  const [selectedFrame, setSelectedFrame] = useState('')
  const [editor, setEditor] = useState('')
  const [priority, setPriority] = useState('')
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState(null)

  const toggle = (set, setSet, id) => {
    const next = new Set(set); next.has(id) ? next.delete(id) : next.add(id); setSet(next)
  }

  // Pre-compute combinations count for the operator
  const hookCount = selectedHooks.size || 1   // matrix RPC treats 0 as 1 (with NULL)
  const bodyCount = selectedBodies.size || 1
  const willCreate = (selectedHooks.size === 0 && selectedBodies.size === 0) ? 0 : hookCount * bodyCount

  const submit = async (e) => {
    e.preventDefault()
    setErr(null); setCreating(true)
    try {
      const { data, error } = await supabase.rpc('lib_variants_bulk_from_clips', {
        p_hook_clip_ids: Array.from(selectedHooks),
        p_body_clip_ids: Array.from(selectedBodies),
        p_frame_clip_id: selectedFrame || null,
        p_editor: editor || null,
        p_priority: priority || null,
      })
      if (error) throw new Error(error.message)
      onCreated(data || 0)
    } catch (e) { setErr(e.message); setCreating(false) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} style={{ width: '100%', maxWidth: 760, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 4, padding: 24, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500, margin: '0 0 6px 0' }}>Matrix splicer</h3>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 18, fontFamily: 'var(--serif)' }}>
          Pick hooks × bodies. Click <em>Generate</em> and the system creates one variant per combination. Pick just one of each to test a single hook+body. Leave both empty to skip the matrix.
        </p>

        {/* Hooks */}
        <SelectGroup
          label={`Hook clips · ${selectedHooks.size} selected`}
          items={hooks}
          selected={selectedHooks}
          onToggle={id => toggle(selectedHooks, setSelectedHooks, id)}
          emptyMsg="No hook clips on file yet. Upload some on the Clips tab."
        />

        {/* Bodies */}
        <SelectGroup
          label={`Body clips · ${selectedBodies.size} selected`}
          items={bodies}
          selected={selectedBodies}
          onToggle={id => toggle(selectedBodies, setSelectedBodies, id)}
          emptyMsg="No body clips on file yet."
        />

        {/* Frame (single-select) + editor + priority */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 18 }}>
          <Field label="Frame clip (single, optional)">
            <select value={selectedFrame} onChange={e => setSelectedFrame(e.target.value)} style={inputStyle}>
              <option value="">—</option>
              {frames.map(f => <option key={f.clip_id} value={f.clip_id}>{f.clip_id}</option>)}
            </select>
          </Field>
          <Field label="Editor">
            <input value={editor} onChange={e => setEditor(e.target.value)} style={inputStyle} placeholder="Mohamed" />
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={e => setPriority(e.target.value)} style={inputStyle}>
              {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p || '—'}</option>)}
            </select>
          </Field>
        </div>

        {/* Preview */}
        <div style={{ marginTop: 18, padding: '12px 14px', background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 3 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4 }}>Will create</div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 20, color: 'var(--ink)', fontWeight: 500 }}>
            {willCreate === 0 ? 'No variants — pick at least one hook or body' : `${willCreate} variant${willCreate > 1 ? 's' : ''}`}
            {selectedFrame && willCreate > 0 ? ` · all use frame ${selectedFrame}` : ''}
          </div>
        </div>

        {err && <div style={{ marginTop: 8, color: 'var(--down)', fontSize: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
          <button type="submit" disabled={creating || willCreate === 0} style={btnPrimary}>
            {creating ? 'Generating…' : `Generate ${willCreate} variant${willCreate === 1 ? '' : 's'}`}
          </button>
        </div>
      </form>
    </div>
  )
}

function SelectGroup({ label, items, selected, onToggle, emptyMsg }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500, marginBottom: 8 }}>
        {label}
      </div>
      {items.length === 0 ? (
        <div style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontFamily: 'var(--serif)', fontSize: 13 }}>{emptyMsg}</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 200, overflowY: 'auto', padding: 6, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2 }}>
          {items.map(c => {
            const active = selected.has(c.clip_id)
            return (
              <button key={c.clip_id} type="button" onClick={() => onToggle(c.clip_id)}
                title={c.description || ''}
                style={{
                  padding: '5px 10px',
                  fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.05em', fontWeight: 500,
                  background: active ? 'var(--accent)' : 'var(--paper)', color: 'var(--ink)',
                  border: '1px solid', borderColor: active ? 'var(--accent)' : 'var(--rule)', borderRadius: 2,
                  cursor: 'pointer',
                }}
              >
                {c.clip_id}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500, marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  )
}

// ── Shared spreadsheet cell components ──────────────────────────────
function Th({ children, w, center }) {
  return (
    <th style={{
      padding: '8px 10px', textAlign: center ? 'center' : 'left',
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
      color: 'var(--ink-3)', fontWeight: 500, width: w ? w : undefined, whiteSpace: 'nowrap',
    }}>{children}</th>
  )
}
function Td({ children, center, mono }) {
  return (
    <td style={{
      padding: '4px 8px', textAlign: center ? 'center' : 'left', verticalAlign: 'middle',
      fontFamily: mono ? 'var(--mono)' : undefined, fontSize: 12, color: 'var(--ink)',
    }}>{children}</td>
  )
}

function InlineEdit({ value, onSave, placeholder, mono }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value || '')
  useEffect(() => { setV(value || '') }, [value])
  if (editing) {
    return (
      <input autoFocus value={v} onChange={e => setV(e.target.value)}
        onBlur={() => { setEditing(false); onSave(v.trim()) }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
          if (e.key === 'Escape') { setV(value || ''); setEditing(false) }
        }}
        style={{ width: '100%', minWidth: 60, background: 'var(--paper)', border: '1px solid var(--accent)', padding: '3px 6px', fontFamily: mono ? 'var(--mono)' : 'var(--sans)', fontSize: 12, color: 'var(--ink)', outline: 'none', borderRadius: 2 }} />
    )
  }
  return (
    <span onClick={() => setEditing(true)} style={{ display: 'inline-block', minWidth: 40, padding: '3px 6px', cursor: 'text', fontFamily: mono ? 'var(--mono)' : 'var(--sans)', color: value ? 'var(--ink)' : 'var(--ink-4)', borderRadius: 2 }}>
      {value || placeholder || '—'}
    </span>
  )
}

function InlineSelect({ value, options, onSave, placeholder }) {
  return (
    <select value={value || ''} onChange={e => onSave(e.target.value || null)}
      style={{ width: '100%', background: 'transparent', border: '1px solid transparent', padding: '3px 6px', fontFamily: 'var(--mono)', fontSize: 11, color: value ? 'var(--ink)' : 'var(--ink-4)', cursor: 'pointer', borderRadius: 2, outline: 'none' }}>
      {!value && <option value="">{placeholder || '—'}</option>}
      {options.map(o => {
        const val = typeof o === 'string' ? o : o.value
        const label = typeof o === 'string' ? o : o.label
        return <option key={val} value={val}>{label || placeholder || '—'}</option>
      })}
    </select>
  )
}

function StageCheckbox({ checked, onChange }) {
  return (
    <button onClick={onChange} style={{
      width: 18, height: 18,
      background: checked ? 'var(--accent)' : 'var(--paper-2)',
      border: '1px solid', borderColor: checked ? 'var(--accent)' : 'var(--rule)',
      borderRadius: 2, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--ink)', fontSize: 11, lineHeight: 1,
    }}>{checked ? '✓' : ''}</button>
  )
}

function ChipGroup({ label, value, setValue, options }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500, marginRight: 4 }}>{label}</span>
      <div style={{ display: 'inline-flex', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: 2 }}>
        {options.map(opt => {
          const active = value === opt.value
          return (
            <button key={String(opt.value)} onClick={() => setValue(opt.value)} style={{
              padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500,
              background: active ? 'var(--ink)' : 'transparent', color: active ? 'var(--paper)' : 'var(--ink-3)', borderRadius: 2,
              border: 'none', cursor: 'pointer',
            }}>{opt.label}</button>
          )
        })}
      </div>
    </div>
  )
}

const inputStyle = {
  width: '100%', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 3,
  padding: '8px 10px', fontSize: 13, fontFamily: 'var(--sans)', color: 'var(--ink)', outline: 'none',
}
const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
  background: 'var(--accent)', color: 'var(--ink)', border: '1px solid var(--accent)', borderRadius: 3,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, cursor: 'pointer',
}
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
  background: 'var(--paper-2)', color: 'var(--ink-2)', border: '1px solid var(--rule)', borderRadius: 3,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500, cursor: 'pointer',
}
const btnSecondary = {
  padding: '8px 16px', background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--rule)', borderRadius: 3,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
}
