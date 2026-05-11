import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader, AlertCircle, Search, Upload, ClipboardPaste, Plus, Trash2, FileVideo } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  Clips page — spreadsheet-style. Three bulk-import paths so Ben never has to
  fill a one-row modal:

    1. Drag-and-drop MP4s → filename parser → upload + insert rows
       Filenames like "H1.1-OSO.MP4" / "BODY-B1-OSO.mov" / "FRAME-OSO.mp4"
       auto-fill clip_id, clip_type, creator_id. Random filenames still land
       as a row with the filename as clip_id; operator fills the rest inline.

    2. Paste TSV from Google Sheets → bulk insert rows
       Tab-separated columns:
         clip_id  clip_type  section  description  creator_id  editor  priority

    3. "Add row" → blank row appears at the bottom, click to edit cells

  Every cell is click-to-edit. Tab moves to the next editable cell. Enter
  saves and starts a new row when on the last row.

  Stage checkboxes (Raw / Rough / Final / Approved) update via the existing
  lib_clip_set_stage RPC. Writes are optimistic — revert on error.
*/

const CLIP_TYPES = ['hook', 'hook_proof', 'body', 'frame', 'client_clip']
const PRIORITY_OPTIONS = ['', 'high', 'med', 'low']
const KNOWN_CREATORS = ['OSO', 'SOFIA', 'NATALIE', 'CLIENT', 'ADAM', 'ERIC', 'MORGAN', 'RESTO-AI']

const STAGES = [
  { key: 'raw',       label: 'Raw' },
  { key: 'rough_cut', label: 'Rough' },
  { key: 'final_cut', label: 'Final' },
  { key: 'approved',  label: 'Approved' },
]

// Filename parser — produces { clip_id, clip_type, creator_id } from
// well-formed filenames. Anything it can't infer is left null so the row
// still inserts and the operator can fill it inline.
function parseFilename(filename) {
  const ext = filename.match(/\.(mp4|mov|webm)$/i)
  const base = ext ? filename.slice(0, ext.index) : filename

  let clip_type = null
  let creator_id = null

  const upper = base.toUpperCase()
  const firstTok = upper.split('-')[0]
  if (/^H\d/.test(firstTok)) clip_type = 'hook'
  else if (firstTok === 'P' || /^P\d/.test(firstTok)) clip_type = 'hook_proof'
  else if (firstTok === 'BODY') clip_type = 'body'
  else if (firstTok === 'FRAME') clip_type = 'frame'
  else if (upper.startsWith('CLIP-CLIENT') || firstTok === 'TESTIMONIAL') clip_type = 'client_clip'

  if (upper.endsWith('-RESTO-AI')) creator_id = 'RESTO-AI'
  else {
    const lastTok = upper.split('-').pop()
    if (KNOWN_CREATORS.includes(lastTok)) creator_id = lastTok
  }

  return { clip_id: base, clip_type, creator_id }
}

function parseTsv(text) {
  // Expected header order (tab-separated):
  // clip_id  clip_type  section  description  creator_id  editor  priority
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim())
  if (!lines.length) return []
  // Skip header if first row contains "clip_id"
  const startIdx = /clip[_\s]*id/i.test(lines[0]) ? 1 : 0
  const out = []
  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (!cols[0]?.trim()) continue
    out.push({
      clip_id:     cols[0]?.trim() || null,
      clip_type:   cols[1]?.trim() || null,
      section:     cols[2]?.trim() || null,
      description: cols[3]?.trim() || null,
      creator_id:  cols[4]?.trim() || null,
      editor:      cols[5]?.trim() || null,
      priority:    cols[6]?.trim() || null,
    })
  }
  return out
}

export default function AdsClips() {
  const [clips, setClips] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [selected, setSelected] = useState(new Set())     // clip_ids
  const [uploading, setUploading] = useState(null)        // { current, total }
  const [showTsv, setShowTsv] = useState(false)
  const fileInputRef = useRef(null)
  const dragCounter = useRef(0)
  const [dragOver, setDragOver] = useState(false)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const { data, error: err } = await supabase
        .from('lib_clips')
        .select('*')
        .order('section', { ascending: true, nullsFirst: false })
        .order('clip_id', { ascending: true })
      if (err) throw new Error(err.message)
      setClips(data || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const editors = useMemo(() => {
    const set = new Set()
    for (const c of clips) if (c.editor) set.add(c.editor)
    return Array.from(set).sort()
  }, [clips])

  const filtered = useMemo(() => {
    let out = clips
    if (typeFilter !== 'all') out = out.filter(c => c.clip_type === typeFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      out = out.filter(c =>
        (c.clip_id || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q) ||
        (c.section || '').toLowerCase().includes(q) ||
        (c.creator_id || '').toLowerCase().includes(q) ||
        (c.editor || '').toLowerCase().includes(q)
      )
    }
    return out
  }, [clips, typeFilter, search])

  // ── Bulk file upload ──────────────────────────────────────────────
  const handleFiles = async (fileList) => {
    const files = Array.from(fileList).filter(f => /\.(mp4|mov|webm)$/i.test(f.name))
    if (!files.length) {
      setError('Drop .mp4, .mov, or .webm files only')
      return
    }
    setError(null)
    setUploading({ current: 0, total: files.length })

    let succeeded = 0
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setUploading({ current: i + 1, total: files.length })
      try {
        const parsed = parseFilename(file.name)
        const path = `clips/${parsed.clip_id}${file.name.match(/\.[^.]+$/)[0]}`

        // Upload to bucket
        const { error: uErr } = await supabase.storage
          .from('ad-source-videos')
          .upload(path, file, { upsert: true, contentType: file.type || 'video/mp4' })
        if (uErr) throw new Error(`upload: ${uErr.message}`)

        // Get a long-lived signed URL (7 days) for the source_file_url cell
        const { data: signed } = await supabase.storage
          .from('ad-source-videos')
          .createSignedUrl(path, 60 * 60 * 24 * 7)

        // Upsert the clip row
        const { error: insertErr } = await supabase.rpc('lib_clip_upsert', {
          p_clip_id: parsed.clip_id,
          p_clip_type: parsed.clip_type || 'hook',
          p_creator_id: parsed.creator_id || null,
          p_source_file_url: signed?.signedUrl || null,
          p_source_file_name: file.name,
        })
        if (insertErr) throw new Error(`insert: ${insertErr.message}`)
        succeeded++
      } catch (e) {
        console.warn(`[clips] upload ${file.name} failed:`, e.message)
      }
    }
    setUploading(null)
    if (succeeded < files.length) {
      setError(`${succeeded}/${files.length} clips uploaded. Check console for failures.`)
    }
    await load()
  }

  // ── TSV paste import ──────────────────────────────────────────────
  const handleTsv = async (text) => {
    const rows = parseTsv(text)
    if (!rows.length) {
      setError('No rows parsed from clipboard. Expected tab-separated columns starting with clip_id.')
      return
    }
    setError(null)
    setUploading({ current: 0, total: rows.length })

    let succeeded = 0
    await Promise.all(rows.map(async (row, i) => {
      try {
        const { error: e } = await supabase.rpc('lib_clip_upsert', {
          p_clip_id: row.clip_id,
          p_clip_type: row.clip_type || 'hook',
          p_section: row.section || null,
          p_description: row.description || null,
          p_creator_id: row.creator_id || null,
          p_editor: row.editor || null,
          p_priority: row.priority || null,
        })
        if (e) throw new Error(e.message)
        succeeded++
      } catch (e) {
        console.warn(`[clips] TSV row ${i} (${row.clip_id}) failed:`, e.message)
      }
    }))
    setUploading(null)
    setShowTsv(false)
    if (succeeded < rows.length) setError(`${succeeded}/${rows.length} rows imported. Check console.`)
    await load()
  }

  // ── Drag-and-drop handlers (full-page drop zone) ──────────────────
  const onDragEnter = (e) => {
    e.preventDefault(); e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer?.types?.includes('Files')) setDragOver(true)
  }
  const onDragLeave = (e) => {
    e.preventDefault(); e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) setDragOver(false)
  }
  const onDragOver = (e) => { e.preventDefault(); e.stopPropagation() }
  const onDrop = (e) => {
    e.preventDefault(); e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files)
  }

  // ── Inline cell save ───────────────────────────────────────────────
  const saveField = async (clip, field, value) => {
    if (clip[field] === value) return
    // Optimistic
    setClips(prev => prev.map(c => c.clip_id === clip.clip_id ? { ...c, [field]: value } : c))
    try {
      const { error: e } = await supabase.rpc('lib_clip_upsert', {
        p_clip_id: clip.clip_id,
        p_clip_type: field === 'clip_type' ? value : (clip.clip_type || 'hook'),
        p_section: field === 'section' ? value : (clip.section || null),
        p_description: field === 'description' ? value : (clip.description || null),
        p_creator_id: field === 'creator_id' ? value : (clip.creator_id || null),
        p_editor: field === 'editor' ? value : (clip.editor || null),
        p_priority: field === 'priority' ? value : (clip.priority || null),
        p_duration_sec: clip.duration_sec || null,
        p_source_file_url: clip.source_file_url || null,
        p_source_file_name: clip.source_file_name || null,
        p_notes: clip.notes || null,
      })
      if (e) throw new Error(e.message)
    } catch (e) {
      setError(`Save failed: ${e.message}`)
      // Revert
      setClips(prev => prev.map(c => c.clip_id === clip.clip_id ? { ...c, [field]: clip[field] } : c))
    }
  }

  const toggleStage = async (clip, stageKey) => {
    const next = !clip[`stage_${stageKey}`]
    setClips(prev => prev.map(c => c.clip_id === clip.clip_id ? { ...c, [`stage_${stageKey}`]: next } : c))
    try {
      const { error: e } = await supabase.rpc('lib_clip_set_stage', { p_clip_id: clip.clip_id, p_stage: stageKey, p_value: next })
      if (e) throw new Error(e.message)
    } catch (e) {
      setClips(prev => prev.map(c => c.clip_id === clip.clip_id ? { ...c, [`stage_${stageKey}`]: !next } : c))
      setError(`Stage update failed: ${e.message}`)
    }
  }

  const addBlankRow = async () => {
    const stub = `CLIP-${Date.now().toString(36).slice(-5).toUpperCase()}`
    try {
      const { error: e } = await supabase.rpc('lib_clip_upsert', {
        p_clip_id: stub, p_clip_type: 'hook',
      })
      if (e) throw new Error(e.message)
      await load()
    } catch (e) { setError(`Add row failed: ${e.message}`) }
  }

  const deleteSelected = async () => {
    if (!selected.size) return
    if (!confirm(`Delete ${selected.size} clip${selected.size > 1 ? 's' : ''}?`)) return
    try {
      await Promise.all(Array.from(selected).map(clip_id =>
        supabase.rpc('lib_clip_delete', { p_clip_id: clip_id })
      ))
      setSelected(new Set())
      await load()
    } catch (e) { setError(`Delete failed: ${e.message}`) }
  }

  const toggleSelect = (clipId) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(clipId)) next.delete(clipId)
      else next.add(clipId)
      return next
    })
  }
  const toggleSelectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set())
    else setSelected(new Set(filtered.map(c => c.clip_id)))
  }

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ position: 'relative', minHeight: 400 }}
    >
      {/* Drag-over overlay */}
      {dragOver && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(244,225,74,0.18)',
          border: '3px dashed var(--accent)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--serif)', fontSize: 28, color: 'var(--ink)', fontStyle: 'italic',
          pointerEvents: 'none',
        }}>
          Drop MP4s to upload + create clip rows
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">Production · Atomic clips</span>
          <h2 className="h3 mt-2" style={{ fontSize: 22 }}>The <em>clip</em> catalog.</h2>
          <p className="mt-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            {clips.length} clips · drop MP4s anywhere on this page · paste from Sheets · click cells to edit
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => fileInputRef.current?.click()} style={btnPrimary}>
            <Upload size={13} /> Upload MP4s
          </button>
          <input
            ref={fileInputRef} type="file" multiple accept="video/mp4,video/quicktime,video/webm"
            onChange={e => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = '' }}
            style={{ display: 'none' }}
          />
          <button onClick={() => setShowTsv(true)} style={btnGhost}>
            <ClipboardPaste size={13} /> Paste TSV
          </button>
          <button onClick={addBlankRow} style={btnGhost}>
            <Plus size={13} /> Add row
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 16 }}>
        <ChipGroup label="Type" value={typeFilter} setValue={setTypeFilter}
          options={[{ value: 'all', label: 'All' }, ...CLIP_TYPES.map(t => ({ value: t, label: t }))]} />
        <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <Search size={12} style={{ color: 'var(--ink-3)', flexShrink: 0, marginLeft: 4 }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
            style={{ flex: 1, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: '5px 8px', fontSize: 12, color: 'var(--ink)', outline: 'none' }} />
        </div>
      </div>

      {/* Upload progress */}
      {uploading && (
        <div style={{ padding: '10px 14px', background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 3, marginBottom: 12, fontSize: 13, color: 'var(--ink)' }}>
          <Loader size={13} className="animate-spin" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
          Uploading {uploading.current}/{uploading.total}…
        </div>
      )}

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

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader className="animate-spin" style={{ color: 'var(--ink-3)' }} />
        </div>
      )}

      {/* Empty state */}
      {!loading && clips.length === 0 && !error && (
        <div style={{ border: '2px dashed var(--rule)', borderRadius: 4, padding: 48, textAlign: 'center', background: 'var(--paper-2)' }}>
          <FileVideo size={48} style={{ color: 'var(--ink-4)', margin: '0 auto 12px' }} />
          <h3 className="h3" style={{ fontSize: 22, marginBottom: 8 }}>Drop your clips here.</h3>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)', maxWidth: '52ch', margin: '0 auto', lineHeight: 1.55 }}>
            Drag MP4s onto this page and the system will parse the filenames (<em>H1.1-OSO.MP4</em>, <em>BODY-B1-OSO.mp4</em>, <em>FRAME-OSO.mp4</em>) into rows. Or paste TSV from Google Sheets, or click "Add row" to start manually.
          </p>
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
                <Th w={160}>Clip ID</Th>
                <Th w={100}>Type</Th>
                <Th w={140}>Section</Th>
                <Th w={260}>Description</Th>
                <Th w={80}>Creator</Th>
                <Th w={90}>Editor</Th>
                <Th w={70}>Priority</Th>
                {STAGES.map(s => <Th key={s.key} w={56} center>{s.label}</Th>)}
                <Th w={90}>File</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.clip_id} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <Td center>
                    <input type="checkbox" checked={selected.has(c.clip_id)} onChange={() => toggleSelect(c.clip_id)} />
                  </Td>
                  <Td mono>{c.clip_id}</Td>
                  <Td><InlineSelect value={c.clip_type} options={CLIP_TYPES} onSave={v => saveField(c, 'clip_type', v)} /></Td>
                  <Td><InlineEdit value={c.section} onSave={v => saveField(c, 'section', v || null)} placeholder="—" /></Td>
                  <Td><InlineEdit value={c.description} onSave={v => saveField(c, 'description', v || null)} placeholder="—" serif /></Td>
                  <Td><InlineEdit value={c.creator_id} onSave={v => saveField(c, 'creator_id', v || null)} placeholder="—" mono /></Td>
                  <Td><InlineEdit value={c.editor} onSave={v => saveField(c, 'editor', v || null)} placeholder="—" /></Td>
                  <Td><InlineSelect value={c.priority} options={PRIORITY_OPTIONS} onSave={v => saveField(c, 'priority', v || null)} placeholder="—" /></Td>
                  {STAGES.map(s => (
                    <Td key={s.key} center>
                      <StageCheckbox checked={c[`stage_${s.key}`]} onChange={() => toggleStage(c, s.key)} />
                    </Td>
                  ))}
                  <Td>
                    {c.source_file_url ? (
                      <a href={c.source_file_url} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)', display: 'inline-flex', alignItems: 'center', gap: 3 }} title={c.source_file_name}>
                        <FileVideo size={11} />open
                      </a>
                    ) : <span style={{ color: 'var(--ink-4)' }}>—</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TSV paste modal */}
      {showTsv && <TsvPasteModal onClose={() => setShowTsv(false)} onImport={handleTsv} />}
    </div>
  )
}

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

function InlineEdit({ value, onSave, placeholder, serif, mono }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value || '')
  useEffect(() => { setV(value || '') }, [value])
  if (editing) {
    return (
      <input
        autoFocus
        value={v}
        onChange={e => setV(e.target.value)}
        onBlur={() => { setEditing(false); onSave(v.trim()) }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
          if (e.key === 'Escape') { setV(value || ''); setEditing(false) }
        }}
        style={{
          width: '100%', minWidth: 60, background: 'var(--paper)', border: '1px solid var(--accent)',
          padding: '3px 6px', fontFamily: mono ? 'var(--mono)' : (serif ? 'var(--serif)' : 'var(--sans)'),
          fontSize: 12, color: 'var(--ink)', outline: 'none', borderRadius: 2,
        }}
      />
    )
  }
  return (
    <span onClick={() => setEditing(true)} style={{
      display: 'inline-block', minWidth: 40, padding: '3px 6px', cursor: 'text',
      fontFamily: mono ? 'var(--mono)' : (serif ? 'var(--serif)' : 'var(--sans)'),
      color: value ? 'var(--ink)' : 'var(--ink-4)', borderRadius: 2,
    }}>
      {value || placeholder || '—'}
    </span>
  )
}

function InlineSelect({ value, options, onSave, placeholder }) {
  return (
    <select
      value={value || ''}
      onChange={e => onSave(e.target.value || null)}
      style={{
        width: '100%', background: 'transparent', border: '1px solid transparent',
        padding: '3px 6px', fontFamily: 'var(--mono)', fontSize: 11, color: value ? 'var(--ink)' : 'var(--ink-4)',
        cursor: 'pointer', borderRadius: 2, outline: 'none',
      }}
    >
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

function TsvPasteModal({ onClose, onImport }) {
  const [text, setText] = useState('')
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 680, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 4, padding: 24, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, margin: '0 0 8px 0' }}>Paste from Sheets</h3>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 12, fontFamily: 'var(--serif)' }}>
          Select rows in Google Sheets (Ctrl+C), paste below. Column order:
        </p>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', color: 'var(--ink-3)', marginBottom: 12, padding: '8px 10px', background: 'var(--paper-2)', borderRadius: 2 }}>
          clip_id &nbsp; clip_type &nbsp; section &nbsp; description &nbsp; creator_id &nbsp; editor &nbsp; priority
        </div>
        <textarea autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="H1.1-OSO	hook	Informative hooks	Referrals & word of mouth	OSO	Mohamed	high" rows={12} style={{ width: '100%', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 3, padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)', outline: 'none', resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => onImport(text)} disabled={!text.trim()} style={btnPrimary}>Import rows</button>
        </div>
      </div>
    </div>
  )
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
