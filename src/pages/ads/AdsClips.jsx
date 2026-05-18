import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader, AlertCircle, Search, Upload, ClipboardPaste, Plus, Trash2, X, Pencil, Play } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useUploads } from '../../hooks/useUploads'
import { useToast } from '../../hooks/useToast'
import { extractVideoPoster } from '../../lib/videoPoster'
import { SectionHead } from '../../components/editorial/atoms'

/*
  Clips page — card-grid view with thumbnails, drawer-style editing, and
  multi-dimensional filtering. Replaces the old spreadsheet-style table.

  Schema additions in migration 040:
    - library.clips.funnel_position  ('top' | 'middle' | 'bottom' | null)
    - library.clips.thumbnail_url    (poster frame, captured at upload)
    - library.editors                (managed editor entity)
    - library.components type=creator (managed creator entity, already existed)

  Upload pipeline:
    1. Drop / pick MP4s → for each:
       a. extractVideoPoster()                              → JPEG blob
       b. storage.upload(clip path) + storage.upload(poster path)
       c. createSignedUrl for both
       d. lib_clip_upsert RPC with creator_id from filename parse + thumbnail_url

  Edit pipeline:
    - Click a card → ClipDrawer opens with the full form
    - Creator / editor dropdowns have an "+ Add new" option that opens a
      tiny modal and calls lib_creator_add / lib_editor_add then re-fetches.
*/

// ─── Type vocabularies — simplified taxonomy per Ben (2026-05-12) ───
// Old types hook_proof / frame / client_clip folded down to 4 clean ones.
// Old → new mapping (applied via migration):
//   hook_proof   → hook
//   client_clip  → testimonial
//   frame        → testimonial (existing frames were all testimonial intros)
// "full_video" is new — a fully-finished ad clip that doesn't need splicing.
const CLIP_TYPES = [
  { value: 'hook',        label: 'Hook',        color: 'var(--ink)',     bg: 'rgba(10,10,10,0.06)' },
  { value: 'body',        label: 'Body',        color: '#b8810b',         bg: 'rgba(184,129,11,0.12)' },
  { value: 'testimonial', label: 'Testimonial', color: '#1f7a3a',         bg: 'rgba(31,122,58,0.10)' },
  { value: 'full_video',  label: 'Full video',  color: '#7a3aa6',         bg: 'rgba(122,58,166,0.10)' },
]
const FUNNEL_POSITIONS = [
  { value: 'top',    label: 'Top of funnel',    short: 'TOF', color: '#2675d4', bg: 'rgba(38,117,212,0.10)' },
  { value: 'middle', label: 'Middle of funnel', short: 'MOF', color: '#b88714', bg: 'rgba(184,135,20,0.12)' },
  { value: 'bottom', label: 'Bottom of funnel', short: 'BOF', color: '#c64a2a', bg: 'rgba(198,74,42,0.10)' },
]
const PRIORITIES = [
  { value: 'high', label: 'High', color: '#b41e1e' },
  { value: 'med',  label: 'Med',  color: '#b88714' },
  { value: 'low',  label: 'Low',  color: 'var(--ink-3)' },
]
const STAGES = [
  { key: 'raw',       label: 'Raw' },
  { key: 'rough_cut', label: 'Rough' },
  { key: 'final_cut', label: 'Final' },
  { key: 'approved',  label: 'Approved' },
]
const KNOWN_CREATORS_FALLBACK = ['OSO', 'SOFIA', 'NATALIE', 'CLIENT', 'ADAM', 'ERIC', 'MORGAN', 'RESTO-AI']

const typeMeta = (t) => CLIP_TYPES.find(x => x.value === t) || { label: t || '—', color: 'var(--ink-3)', bg: 'transparent' }
const pluralLabel = (t) => ({ hook: 'Hooks', body: 'Bodies', testimonial: 'Testimonials', full_video: 'Full videos' }[t] || t)
const funnelMeta = (f) => FUNNEL_POSITIONS.find(x => x.value === f)
const priorityMeta = (p) => PRIORITIES.find(x => x.value === p)

// ─── Filename / TSV parsers (carried over) ──────────────────────────
function parseFilename(filename) {
  const ext = filename.match(/\.(mp4|mov|webm)$/i)
  const base = ext ? filename.slice(0, ext.index) : filename
  const upper = base.toUpperCase()
  const tokens = upper.split(/[^A-Z0-9]+/).filter(Boolean)
  const firstTok = tokens[0] || ''
  let creator_id = null
  if (upper.includes('RESTO-AI') || upper.includes('RESTOAI')) creator_id = 'RESTO-AI'
  else {
    for (const tok of tokens) {
      if (KNOWN_CREATORS_FALLBACK.includes(tok)) { creator_id = tok; break }
    }
  }
  let clip_type = null
  if (/^H\d/.test(firstTok)) clip_type = 'hook'
  else if (firstTok === 'P' || /^P\d/.test(firstTok)) clip_type = 'hook'  // proof hooks fold to hook
  else if (tokens.includes('BODY')) clip_type = 'body'
  else if (tokens.includes('FULL') || tokens.includes('FULLVIDEO')) clip_type = 'full_video'
  // Testimonial-style phrasings — client/owner/customer talking, or any
  // FRAME-prefixed clip from the previous taxonomy
  else if (tokens.includes('FRAME')) clip_type = 'testimonial'
  else if (/what\s+one\s+of\s+our|client\s+said|owner\s+said|customer\s+said/i.test(base)) clip_type = 'testimonial'
  else if (upper.includes('TESTIMONIAL') || tokens.includes('CLIENT')) clip_type = 'testimonial'
  else if (creator_id === 'RESTO-AI') clip_type = 'testimonial'
  return { clip_id: base, clip_type, creator_id }
}
function sanitizeStorageSlug(name) {
  const slug = name.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[—–]/g, '-').replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
  return slug || `clip-${Date.now().toString(36)}`
}
function parseTsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim())
  if (!lines.length) return []
  const startIdx = /clip[_\s]*id/i.test(lines[0]) ? 1 : 0
  const out = []
  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (!cols[0]?.trim()) continue
    out.push({
      clip_id: cols[0]?.trim() || null,
      clip_type: cols[1]?.trim() || null,
      section: cols[2]?.trim() || null,
      description: cols[3]?.trim() || null,
      creator_id: cols[4]?.trim() || null,
      editor: cols[5]?.trim() || null,
      priority: cols[6]?.trim() || null,
    })
  }
  return out
}

// ─── Main page ──────────────────────────────────────────────────────
export default function AdsClips() {
  const [clips, setClips] = useState([])
  const [creators, setCreators] = useState([])  // [{ component_id, label }]
  const [editors, setEditors] = useState([])    // [{ editor_id, label }]
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState({ type: 'all', funnel: 'all', creator: 'all', editor: 'all', stage: 'all' })
  const [editing, setEditing] = useState(null)   // clip object opened in drawer
  const [showTsv, setShowTsv] = useState(false)
  const [addingKind, setAddingKind] = useState(null)  // 'creator' | 'editor' | null
  const fileInputRef = useRef(null)
  const dragCounter = useRef(0)
  const [dragOver, setDragOver] = useState(false)
  const uploads = useUploads()
  const toast = useToast()

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const [{ data: cs }, { data: cr }, { data: ed }] = await Promise.all([
        supabase.from('lib_clips').select('*').order('created_at', { ascending: false }),
        supabase.from('lib_components').select('component_id, label').eq('type', 'creator').order('label'),
        supabase.from('lib_editors').select('editor_id, label'),
      ])
      setClips(cs || [])
      setCreators(cr || [])
      setEditors(ed || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    let out = clips
    if (filter.type !== 'all')    out = out.filter(c => c.clip_type === filter.type)
    if (filter.funnel !== 'all')  out = out.filter(c => c.funnel_position === filter.funnel)
    if (filter.creator !== 'all') out = out.filter(c => c.creator_id === filter.creator)
    if (filter.editor !== 'all')  out = out.filter(c => c.editor === filter.editor)
    if (filter.stage !== 'all') {
      out = out.filter(c => c[`stage_${filter.stage}`])
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      out = out.filter(c =>
        (c.clip_id || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q) ||
        (c.section || '').toLowerCase().includes(q) ||
        (c.notes || '').toLowerCase().includes(q) ||
        (c.creator_id || '').toLowerCase().includes(q) ||
        (c.editor || '').toLowerCase().includes(q)
      )
    }
    return out
  }, [clips, filter, search])

  // ─── Upload pipeline w/ poster extraction ──────────────────────────
  const handleFiles = async (fileList) => {
    const raw = Array.from(fileList)
    const valid = []
    const preflightFails = []
    const SIZE_CAP = 262144000

    for (const f of raw) {
      if (!/\.(mp4|mov|webm)$/i.test(f.name)) {
        preflightFails.push({ file: f.name, error: 'Unsupported — drop .mp4 / .mov / .webm' })
        continue
      }
      if (f.size > SIZE_CAP) {
        preflightFails.push({ file: f.name, error: `Too large (${(f.size / 1e6).toFixed(0)}MB > 250MB)` })
        continue
      }
      valid.push(f)
    }
    if (!valid.length && preflightFails.length) {
      const runId = uploads.start({ label: 'Clips upload · skipped', total: preflightFails.length })
      for (const fail of preflightFails) { uploads.fail(runId, fail); uploads.progress(runId, { added: 1 }) }
      uploads.done(runId)
      toast.error(`${preflightFails.length} file${preflightFails.length > 1 ? 's' : ''} skipped`)
      return
    }
    if (!valid.length) { toast.error('No valid files — drop .mp4 / .mov / .webm'); return }

    setError(null)
    const runId = uploads.start({ label: `Clips · ${valid.length} file${valid.length > 1 ? 's' : ''}`, total: valid.length + preflightFails.length })
    for (const fail of preflightFails) { uploads.fail(runId, fail); uploads.progress(runId, { added: 1 }) }

    const concurrency = 3
    let succeeded = 0
    const queue = [...valid]
    const workers = Array.from({ length: Math.min(concurrency, valid.length) }, async () => {
      while (queue.length) {
        const file = queue.shift()
        if (!file) break
        try {
          const parsed = parseFilename(file.name)
          const ext = file.name.match(/\.[^.]+$/)?.[0] || '.mp4'
          const safeSlug = sanitizeStorageSlug(parsed.clip_id)
          const vidPath = `clips/${safeSlug}${ext.toLowerCase()}`
          const thumbPath = `clips/thumbs/${safeSlug}.jpg`

          // 1. Upload the video
          const { error: uErr } = await supabase.storage
            .from('ad-source-videos')
            .upload(vidPath, file, { upsert: true, contentType: file.type || 'video/mp4' })
          if (uErr) throw new Error(uErr.message)
          const { data: signed, error: sErr } = await supabase.storage
            .from('ad-source-videos')
            .createSignedUrl(vidPath, 60 * 60 * 24 * 7)
          if (sErr) throw new Error(`sign URL: ${sErr.message}`)

          // 2. Extract poster frame + upload (best-effort — if it fails the
          //    clip still saves without a thumbnail).
          let thumbUrl = null
          try {
            const blob = await extractVideoPoster(file)
            if (blob) {
              const { error: tErr } = await supabase.storage
                .from('ad-source-videos')
                .upload(thumbPath, blob, { upsert: true, contentType: 'image/jpeg' })
              if (!tErr) {
                const { data: tSigned } = await supabase.storage
                  .from('ad-source-videos')
                  .createSignedUrl(thumbPath, 60 * 60 * 24 * 7)
                thumbUrl = tSigned?.signedUrl || null
              }
            }
          } catch (e) { /* non-fatal */ }

          // 3. Insert the row
          const { error: insertErr } = await supabase.rpc('lib_clip_upsert', {
            p_clip_id: parsed.clip_id,
            p_clip_type: parsed.clip_type || 'hook',
            p_creator_id: parsed.creator_id || null,
            p_source_file_url: signed?.signedUrl || null,
            p_source_file_name: file.name,
            p_thumbnail_url: thumbUrl,
          })
          if (insertErr) throw new Error(`DB insert: ${insertErr.message}`)
          succeeded++
          uploads.progress(runId, { added: 1 })
        } catch (e) {
          console.warn(`[clips] upload ${file.name} failed:`, e.message)
          uploads.fail(runId, { file: file.name, error: e.message })
          uploads.progress(runId, { added: 1 })
        }
      }
    })
    await Promise.all(workers)
    uploads.done(runId)

    const total = valid.length + preflightFails.length
    if (succeeded === total && valid.length === 1) {
      // Single-file upload: auto-open the new clip's drawer so the operator
      // sees exactly where it landed + can fix the auto-classification.
      const justUploaded = valid[0]
      const parsed = parseFilename(justUploaded.name)
      toast.success(`${parsed.clip_id} uploaded as ${typeMeta(parsed.clip_type || 'hook').label}`)
      await load()
      setTimeout(() => {
        setClips(prev => {
          const match = prev.find(c => c.clip_id === parsed.clip_id)
          if (match) setEditing(match)
          return prev
        })
      }, 200)
      return
    }
    if (succeeded === total) toast.success(`${succeeded} clip${succeeded > 1 ? 's' : ''} uploaded`)
    else if (succeeded > 0)  toast.error(`${succeeded}/${total} uploaded · ${total - succeeded} failed`)
    else                     toast.error(`All ${total} uploads failed`)
    await load()
  }

  const handleTsv = async (text) => {
    const rows = parseTsv(text)
    if (!rows.length) {
      toast.error('No rows parsed from clipboard. Expected tab-separated columns starting with clip_id.')
      return
    }
    setError(null); setShowTsv(false)
    const runId = uploads.start({ label: `TSV import · ${rows.length}`, total: rows.length })
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
        uploads.progress(runId, { added: 1 })
      } catch (e) {
        console.warn(`[clips] TSV row ${i} failed:`, e.message)
        uploads.fail(runId, { file: row.clip_id || `row ${i}`, error: e.message })
        uploads.progress(runId, { added: 1 })
      }
    }))
    uploads.done(runId)
    if (succeeded === rows.length) toast.success(`${succeeded} imported`)
    else toast.error(`${succeeded}/${rows.length} imported`)
    await load()
  }

  // ─── Drag-drop ────────────────────────────────────────────────────
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
    dragCounter.current = 0; setDragOver(false)
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files)
  }

  // ─── Save / delete / stages ───────────────────────────────────────
  const saveClip = async (clip, updates) => {
    const merged = { ...clip, ...updates }
    // Optimistic
    setClips(prev => prev.map(c => c.clip_id === clip.clip_id ? merged : c))
    if (editing && editing.clip_id === clip.clip_id) setEditing(merged)
    try {
      const { error: e } = await supabase.rpc('lib_clip_upsert', {
        p_clip_id: merged.clip_id,
        p_clip_type: merged.clip_type || 'hook',
        p_section: merged.section || null,
        p_description: merged.description || null,
        p_creator_id: merged.creator_id || null,
        p_editor: merged.editor || null,
        p_priority: merged.priority || null,
        p_duration_sec: merged.duration_sec || null,
        p_source_file_url: merged.source_file_url || null,
        p_source_file_name: merged.source_file_name || null,
        p_notes: merged.notes || null,
        p_funnel_position: merged.funnel_position || null,
        p_thumbnail_url: merged.thumbnail_url || null,
      })
      if (e) throw new Error(e.message)
    } catch (e) {
      toast.error(`Save failed: ${e.message}`)
      // Revert
      setClips(prev => prev.map(c => c.clip_id === clip.clip_id ? clip : c))
      if (editing && editing.clip_id === clip.clip_id) setEditing(clip)
    }
  }
  const toggleStage = async (clip, stageKey) => {
    const next = !clip[`stage_${stageKey}`]
    const updated = { ...clip, [`stage_${stageKey}`]: next }
    setClips(prev => prev.map(c => c.clip_id === clip.clip_id ? updated : c))
    if (editing && editing.clip_id === clip.clip_id) setEditing(updated)
    try {
      const { error: e } = await supabase.rpc('lib_clip_set_stage', { p_clip_id: clip.clip_id, p_stage: stageKey, p_value: next })
      if (e) throw new Error(e.message)
    } catch (e) {
      setClips(prev => prev.map(c => c.clip_id === clip.clip_id ? clip : c))
      if (editing && editing.clip_id === clip.clip_id) setEditing(clip)
      toast.error(`Stage update failed: ${e.message}`)
    }
  }
  const deleteClip = async (clip) => {
    if (!confirm(`Delete clip "${clip.clip_id}"?`)) return
    try {
      const { error: e } = await supabase.rpc('lib_clip_delete', { p_clip_id: clip.clip_id })
      if (e) throw new Error(e.message)
      setClips(prev => prev.filter(c => c.clip_id !== clip.clip_id))
      if (editing && editing.clip_id === clip.clip_id) setEditing(null)
      toast.success('Clip deleted')
    } catch (e) { toast.error(`Delete failed: ${e.message}`) }
  }
  const addBlankClip = async () => {
    const stub = `CLIP-${Date.now().toString(36).slice(-5).toUpperCase()}`
    try {
      const { error: e } = await supabase.rpc('lib_clip_upsert', { p_clip_id: stub, p_clip_type: 'hook' })
      if (e) throw new Error(e.message)
      await load()
      // Open the drawer on the new row so editor can fill it
      setTimeout(() => {
        const newRow = { clip_id: stub, clip_type: 'hook', stage_raw: false, stage_rough_cut: false, stage_final_cut: false, stage_approved: false }
        setEditing(newRow)
      }, 100)
    } catch (e) { toast.error(`Add failed: ${e.message}`) }
  }

  // ─── Add new creator / editor (managed lists) ─────────────────────
  const addCreator = async (id, label) => {
    try {
      const { error: e } = await supabase.rpc('lib_creator_add', { p_id: id, p_label: label || id })
      if (e) throw new Error(e.message)
      toast.success(`Creator ${id.toUpperCase()} added`)
      await load()
    } catch (e) { toast.error(`Add creator failed: ${e.message}`) }
  }
  const addEditor = async (name) => {
    try {
      const { error: e } = await supabase.rpc('lib_editor_add', { p_editor: name })
      if (e) throw new Error(e.message)
      toast.success(`Editor ${name} added`)
      await load()
    } catch (e) { toast.error(`Add editor failed: ${e.message}`) }
  }

  return (
    <div
      onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}
      style={{ position: 'relative' }}
    >
      <SectionHead
        level="page"
        eyebrow="Creative · Clips"
        title="Clips"
        tagline={`${filtered.length} of ${clips.length} clips · drop a .mp4 anywhere on this page to upload.`}
        gap={20}
        right={
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => fileInputRef.current?.click()} style={btnSolid}>
              <Upload size={13} /> Upload
            </button>
            <button onClick={addBlankClip} style={btnGhost}>
              <Plus size={13} /> New clip
            </button>
            <input ref={fileInputRef} type="file" accept=".mp4,.mov,.webm" multiple style={{ display: 'none' }}
              onChange={(e) => e.target.files && handleFiles(e.target.files)} />
          </div>
        }
      />

      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 16, alignItems: 'center' }}>
        <FilterChips label="Type" value={filter.type} setValue={(v) => setFilter({ ...filter, type: v })}
          options={[{ value: 'all', label: 'All' }, ...CLIP_TYPES.map(t => ({ value: t.value, label: t.label, color: t.color }))]} />
        <FilterChips label="Funnel" value={filter.funnel} setValue={(v) => setFilter({ ...filter, funnel: v })}
          options={[{ value: 'all', label: 'All' }, ...FUNNEL_POSITIONS.map(f => ({ value: f.value, label: f.short, color: f.color }))]} />
        <FilterSelect label="Creator" value={filter.creator} setValue={(v) => setFilter({ ...filter, creator: v })}
          options={[{ value: 'all', label: 'All creators' }, ...creators.map(c => ({ value: c.component_id, label: c.label || c.component_id }))]} />
        <FilterSelect label="Editor" value={filter.editor} setValue={(v) => setFilter({ ...filter, editor: v })}
          options={[{ value: 'all', label: 'All editors' }, ...editors.map(e => ({ value: e.label, label: e.label }))]} />
        <FilterChips label="Stage" value={filter.stage} setValue={(v) => setFilter({ ...filter, stage: v })}
          options={[{ value: 'all', label: 'Any' }, ...STAGES.map(s => ({ value: s.key, label: s.label }))]} />
        <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <Search size={12} style={{ color: 'var(--ink-3)', flexShrink: 0, marginLeft: 4 }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name / description / notes…"
            style={{ flex: 1, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: '5px 8px', fontSize: 12, color: 'var(--ink)', outline: 'none' }} />
        </div>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', background: 'var(--down-soft, rgba(180,30,30,0.06))', border: '1px solid var(--down, #b41e1e)', borderLeftWidth: 3, borderRadius: '0 3px 3px 0', color: 'var(--down, #b41e1e)', marginBottom: 16, fontSize: 13 }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} /><div>{error}</div>
        </div>
      )}

      {loading && <div className="flex items-center justify-center py-16"><Loader className="animate-spin" style={{ color: 'var(--ink-3)' }} /></div>}

      {!loading && !filtered.length && (
        <div style={{ border: '1px dashed var(--rule)', borderRadius: 4, padding: 40, textAlign: 'center', background: 'var(--paper-2)' }}>
          <span className="eyebrow eyebrow-accent" style={{ justifyContent: 'center', display: 'inline-flex', marginBottom: 12 }}>Empty</span>
          <h3 className="h3" style={{ fontSize: 20, marginBottom: 10 }}>{clips.length ? 'Nothing matches your filters.' : 'No clips yet — drop a file to start.'}</h3>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        // Section-grouped layout: when filter.type='all' the operator sees
        // four stacked sections (Hooks / Bodies / Testimonials / Full
        // videos) instead of one big mixed grid. When a specific type is
        // chosen via filter chip, we collapse to a single section.
        filter.type !== 'all'
          ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
              {filtered.map(c => <ClipCard key={c.clip_id} clip={c} onOpen={() => setEditing(c)} />)}
            </div>
          )
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
              {CLIP_TYPES.map(t => {
                const items = filtered.filter(c => c.clip_type === t.value)
                if (!items.length) return null
                return (
                  <section key={t.value}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, paddingBottom: 6, borderBottom: `2px solid ${t.color}` }}>
                      <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, color: 'var(--ink)', margin: 0, letterSpacing: '-0.005em' }}>
                        {pluralLabel(t.value)}
                      </h3>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500 }}>
                        {items.length} clip{items.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
                      {items.map(c => <ClipCard key={c.clip_id} clip={c} onOpen={() => setEditing(c)} />)}
                    </div>
                  </section>
                )
              })}
            </div>
          )
      )}

      {/* Drawer + modals */}
      {editing && (
        <ClipDrawer
          clip={editing}
          creators={creators}
          editors={editors}
          onSave={(updates) => saveClip(editing, updates)}
          onToggleStage={(stage) => toggleStage(editing, stage)}
          onDelete={() => deleteClip(editing)}
          onClose={() => setEditing(null)}
          onAddCreator={() => setAddingKind('creator')}
          onAddEditor={() => setAddingKind('editor')}
        />
      )}
      {showTsv && <TsvModal onClose={() => setShowTsv(false)} onSubmit={handleTsv} />}
      {addingKind && (
        <AddEntityModal
          kind={addingKind}
          onClose={() => setAddingKind(null)}
          onSubmit={async (val) => {
            if (addingKind === 'creator') await addCreator(val.id, val.label)
            else                          await addEditor(val.label)
            setAddingKind(null)
          }}
        />
      )}

      {/* Full-page drop overlay */}
      {dragOver && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(31,122,58,0.10)', border: '4px dashed #1f7a3a', zIndex: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 28, color: '#1f7a3a', fontWeight: 500 }}>Drop video files to upload</div>
        </div>
      )}
    </div>
  )
}

// ─── ClipCard ───────────────────────────────────────────────────────
function ClipCard({ clip, onOpen }) {
  const [hover, setHover] = useState(false)
  const videoRef = useRef(null)
  const tMeta = typeMeta(clip.clip_type)
  const fMeta = funnelMeta(clip.funnel_position)
  const pMeta = priorityMeta(clip.priority)

  // On hover, play the source video as a preview if available. Tries to
  // start from the same seek-point as the poster frame to feel continuous.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (hover) {
      v.currentTime = 0
      v.play().catch(() => { /* autoplay may be blocked; thumbnail still shows */ })
    } else {
      v.pause()
      v.currentTime = 0
    }
  }, [hover])

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderLeft: `3px solid ${tMeta.color}`,
        borderRadius: 4,
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'box-shadow 120ms',
        boxShadow: hover ? '0 4px 16px rgba(0,0,0,0.10)' : 'none',
      }}
    >
      {/* Thumbnail */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#0c0c0c', overflow: 'hidden' }}>
        {clip.thumbnail_url ? (
          <img
            src={clip.thumbnail_url}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: hover && clip.source_file_url ? 'none' : 'block' }}
            onError={(e) => { e.target.style.opacity = 0.25 }}
          />
        ) : clip.source_file_url ? (
          // Fallback: render the video itself with preload='metadata' so
          // the browser captures the first frame as a poster. Saves the
          // operator from ever seeing "No preview" when an MP4 is on file.
          <video
            src={clip.source_file_url}
            muted playsInline preload="metadata"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: hover ? 'none' : 'block', background: '#0c0c0c' }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            No file
          </div>
        )}
        {hover && clip.source_file_url && (
          <video
            ref={videoRef}
            src={clip.source_file_url}
            muted playsInline preload="metadata"
            style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }}
          />
        )}
        {/* Top-left: type chip */}
        <span style={{
          position: 'absolute', top: 8, left: 8,
          padding: '3px 8px',
          background: tMeta.color, color: '#fff',
          fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
          borderRadius: 2,
        }}>{tMeta.label}</span>
        {/* Top-right: funnel chip */}
        {fMeta && (
          <span style={{
            position: 'absolute', top: 8, right: 8,
            padding: '3px 8px',
            background: fMeta.bg, color: fMeta.color, border: `1px solid ${fMeta.color}`,
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
            borderRadius: 2,
          }}>{fMeta.short}</span>
        )}
        {/* Bottom-right: priority */}
        {pMeta && (
          <span style={{
            position: 'absolute', bottom: 8, right: 8,
            padding: '2px 7px',
            background: 'rgba(0,0,0,0.6)', color: pMeta.color,
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700,
            borderRadius: 2,
          }}>{pMeta.label} priority</span>
        )}
        {/* Play indicator when hover starts to load video */}
        {hover && !clip.source_file_url && (
          <Play size={28} style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', color: 'rgba(255,255,255,0.5)' }} />
        )}
      </div>

      {/* Body */}
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 14, fontWeight: 500, color: 'var(--ink)', lineHeight: 1.3, wordBreak: 'break-word' }}>
          {clip.clip_id}
        </div>
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
          {clip.creator_id && <span>· {clip.creator_id}</span>}
          {clip.editor && <span>· ed: {clip.editor}</span>}
        </div>
        {/* Stage dots */}
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          {STAGES.map(s => (
            <span key={s.key} title={s.label} style={{
              width: 14, height: 14, borderRadius: 2,
              border: `1px solid ${clip[`stage_${s.key}`] ? '#1f7a3a' : 'var(--rule)'}`,
              background: clip[`stage_${s.key}`] ? '#1f7a3a' : 'transparent',
              fontFamily: 'var(--mono)', fontSize: 8, color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{s.label[0]}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── ClipDrawer ─────────────────────────────────────────────────────
function ClipDrawer({ clip, creators, editors, onSave, onToggleStage, onDelete, onClose, onAddCreator, onAddEditor }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.45)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 520, height: '100vh', overflowY: 'auto',
        background: 'var(--paper)', borderLeft: '1px solid var(--rule)', padding: '20px 24px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span className="eyebrow eyebrow-accent">Edit clip</span>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 2, padding: 6, cursor: 'pointer', color: 'var(--ink-3)' }}>
            <X size={14} />
          </button>
        </div>

        {/* Thumbnail preview */}
        <div style={{ width: '100%', aspectRatio: '16/9', background: '#0c0c0c', borderRadius: 3, overflow: 'hidden', marginBottom: 14 }}>
          {clip.source_file_url ? (
            <video src={clip.source_file_url} controls muted playsInline poster={clip.thumbnail_url || undefined}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : clip.thumbnail_url ? (
            <img src={clip.thumbnail_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              No video / preview
            </div>
          )}
        </div>

        <Field label="Clip name / ID">
          <input value={clip.clip_id || ''} disabled
            style={{ ...inputStyle, color: 'var(--ink-3)', cursor: 'not-allowed' }} />
        </Field>

        <FieldRow>
          <Field label="Type" flex>
            <select value={clip.clip_type || ''} onChange={e => onSave({ clip_type: e.target.value })} style={inputStyle}>
              {CLIP_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Funnel position" flex>
            <select value={clip.funnel_position || ''} onChange={e => onSave({ funnel_position: e.target.value || null })} style={inputStyle}>
              <option value="">—</option>
              {FUNNEL_POSITIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Creator" flex>
            <SelectWithAdd value={clip.creator_id || ''} onChange={(v) => onSave({ creator_id: v || null })}
              options={creators.map(c => ({ value: c.component_id, label: c.label || c.component_id }))}
              onAddNew={onAddCreator} addLabel="+ Add new creator" emptyOption="—" />
          </Field>
          <Field label="Editor" flex>
            <SelectWithAdd value={clip.editor || ''} onChange={(v) => onSave({ editor: v || null })}
              options={editors.map(e => ({ value: e.label, label: e.label }))}
              onAddNew={onAddEditor} addLabel="+ Add new editor" emptyOption="—" />
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Priority" flex>
            <select value={clip.priority || ''} onChange={e => onSave({ priority: e.target.value || null })} style={inputStyle}>
              <option value="">—</option>
              {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Section" flex>
            <input value={clip.section || ''}
              onChange={e => onSave({ section: e.target.value })}
              placeholder="e.g. Adam · April 2026"
              style={inputStyle} />
          </Field>
        </FieldRow>

        <Field label="Description">
          <textarea value={clip.description || ''} onChange={e => onSave({ description: e.target.value })}
            rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
        </Field>

        <Field label="Notes">
          <textarea value={clip.notes || ''} onChange={e => onSave({ notes: e.target.value })}
            rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        </Field>

        <Field label="Production stage">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {STAGES.map(s => (
              <button key={s.key} onClick={() => onToggleStage(s.key)} style={{
                padding: '7px 12px',
                fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
                background: clip[`stage_${s.key}`] ? '#1f7a3a' : 'var(--paper-2)',
                color: clip[`stage_${s.key}`] ? '#fff' : 'var(--ink-2)',
                border: `1px solid ${clip[`stage_${s.key}`] ? '#1f7a3a' : 'var(--rule)'}`,
                borderRadius: 2, cursor: 'pointer',
              }}>{s.label}</button>
            ))}
          </div>
        </Field>

        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--rule)', display: 'flex', justifyContent: 'space-between' }}>
          <button onClick={onDelete} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
            background: 'transparent', color: '#b41e1e', border: '1px solid #b41e1e', borderRadius: 3,
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
            cursor: 'pointer',
          }}>
            <Trash2 size={12} /> Delete
          </button>
          <button onClick={onClose} style={btnSolid}>Done</button>
        </div>
      </div>
    </div>
  )
}

// ─── SelectWithAdd ──────────────────────────────────────────────────
function SelectWithAdd({ value, onChange, options, onAddNew, addLabel = '+ Add new', emptyOption }) {
  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === '__add__') { onAddNew(); return }
        onChange(e.target.value)
      }}
      style={inputStyle}
    >
      {emptyOption !== undefined && <option value="">{emptyOption}</option>}
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      <option disabled style={{ color: 'var(--ink-4)' }}>──────────</option>
      <option value="__add__" style={{ color: '#1f7a3a', fontWeight: 600 }}>{addLabel}</option>
    </select>
  )
}

// ─── AddEntityModal (used for both creator + editor) ────────────────
function AddEntityModal({ kind, onClose, onSubmit }) {
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const isCreator = kind === 'creator'

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)', zIndex: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--paper)', borderRadius: 4, padding: '20px 24px', width: 380,
        border: '1px solid var(--rule)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span className="eyebrow eyebrow-accent">{isCreator ? 'Add creator' : 'Add editor'}</span>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 2, padding: 6, cursor: 'pointer', color: 'var(--ink-3)' }}>
            <X size={14} />
          </button>
        </div>
        {isCreator && (
          <Field label="ID (short, uppercase)">
            <input value={id} onChange={e => setId(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
              placeholder="e.g. LUCAS" style={inputStyle} autoFocus />
          </Field>
        )}
        <Field label={isCreator ? 'Display name' : 'Editor name'}>
          <input value={label} onChange={e => setLabel(e.target.value)}
            placeholder={isCreator ? 'e.g. Lucas' : 'e.g. Mohamed'} style={inputStyle} autoFocus={!isCreator} />
        </Field>
        <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button
            disabled={isCreator ? !id || !label : !label}
            onClick={() => onSubmit(isCreator ? { id, label } : { label })}
            style={{ ...btnSolid, opacity: (isCreator ? (!id || !label) : !label) ? 0.4 : 1 }}
          >Add</button>
        </div>
      </div>
    </div>
  )
}

// ─── TsvModal ───────────────────────────────────────────────────────
function TsvModal({ onClose, onSubmit }) {
  const [text, setText] = useState('')
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)', zIndex: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--paper)', borderRadius: 4, padding: '20px 24px', width: 640, maxWidth: '95vw',
        border: '1px solid var(--rule)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span className="eyebrow eyebrow-accent">Paste TSV from Google Sheets</span>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 2, padding: 6, cursor: 'pointer', color: 'var(--ink-3)' }}>
            <X size={14} />
          </button>
        </div>
        <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 8 }}>
          Columns: clip_id ⇥ clip_type ⇥ section ⇥ description ⇥ creator_id ⇥ editor ⇥ priority
        </p>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={12}
          placeholder={'H4.2\thook\t...\t...\tOSO\tMohamed\thigh\n'} style={{ ...inputStyle, fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical' }} autoFocus />
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={() => onSubmit(text)} disabled={!text.trim()} style={{ ...btnSolid, opacity: text.trim() ? 1 : 0.4 }}>Import</button>
        </div>
      </div>
    </div>
  )
}

// ─── Filter helpers ─────────────────────────────────────────────────
function FilterChips({ label, value, setValue, options }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500, marginRight: 4 }}>{label}</span>
      <div style={{ display: 'inline-flex', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: 2 }}>
        {options.map(opt => {
          const active = value === opt.value
          return (
            <button key={String(opt.value)} onClick={() => setValue(opt.value)} style={{
              padding: '4px 9px',
              fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500,
              background: active ? (opt.color || 'var(--ink)') : 'transparent',
              color: active ? '#fff' : 'var(--ink-3)', borderRadius: 2,
              border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
            }}>{opt.label}</button>
          )
        })}
      </div>
    </div>
  )
}
function FilterSelect({ label, value, setValue, options }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500 }}>{label}</span>
      <select value={value} onChange={(e) => setValue(e.target.value)} style={{
        background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2,
        padding: '4px 6px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)', outline: 'none',
      }}>
        {options.map(o => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

// ─── Tiny form primitives ───────────────────────────────────────────
function Field({ label, children, flex }) {
  return (
    <div style={{ marginBottom: 12, flex: flex ? 1 : undefined, minWidth: flex ? 0 : undefined }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}
function FieldRow({ children }) {
  return <div style={{ display: 'flex', gap: 10 }}>{children}</div>
}

const inputStyle = {
  width: '100%',
  background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2,
  padding: '7px 9px', fontFamily: 'var(--sans, system-ui)', fontSize: 13, color: 'var(--ink)', outline: 'none',
}
const btnSolid = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
  background: 'var(--ink)', color: 'var(--paper)', border: '1px solid var(--ink)', borderRadius: 3,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, cursor: 'pointer',
}
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
  background: 'var(--paper-2)', color: 'var(--ink-2)', border: '1px solid var(--rule)', borderRadius: 3,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500, cursor: 'pointer',
}
