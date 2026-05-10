import { useEffect, useMemo, useState } from 'react'
import { Plus, Loader, AlertCircle, Search, FileVideo, Trash2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  Clips page — replaces the "COMPONENT EDIT TASKS — RAW CLIPS" tab of Ben's
  Google Sheet. One row per atomic, editable clip (e.g. H1.1-OSO,
  P-ADAM-OSO, BODY-B1-OSO). Each clip is cut ONCE by an editor and can be
  reused across many variants.

  Production stages: Raw → Rough Cut → Final Cut → Approved (4 stages, all
  boolean). The Variants page tracks the 5th stage (Uploaded) since that's
  variant-level not clip-level.

  Writes go through SECURITY DEFINER RPCs (lib_clip_upsert,
  lib_clip_set_stage, lib_clip_delete) because PostgREST can't UPDATE views.
*/

const CLIP_TYPES = [
  { value: 'hook',         label: 'Hook' },
  { value: 'hook_proof',   label: 'Hook · proof' },
  { value: 'body',         label: 'Body' },
  { value: 'frame',        label: 'Frame' },
  { value: 'client_clip',  label: 'Client clip' },
]

const STAGES = [
  { key: 'raw',        label: 'Raw' },
  { key: 'rough_cut',  label: 'Rough' },
  { key: 'final_cut',  label: 'Final' },
  { key: 'approved',   label: 'Approved' },
]

const PRIORITY_OPTIONS = ['', 'high', 'med', 'low']

export default function AdsClips() {
  const [clips, setClips] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [editorFilter, setEditorFilter] = useState('all')
  const [showAdd, setShowAdd] = useState(false)
  const [savingStage, setSavingStage] = useState(null) // `${clip_id}:${stage}`

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const { data, error: err } = await supabase
        .from('lib_clips')
        .select('*')
        .order('section', { ascending: true })
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
    if (editorFilter !== 'all') out = out.filter(c => c.editor === editorFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      out = out.filter(c =>
        (c.clip_id || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q) ||
        (c.section || '').toLowerCase().includes(q)
      )
    }
    return out
  }, [clips, typeFilter, editorFilter, search])

  // Group filtered clips by section for the section-header layout
  const grouped = useMemo(() => {
    const groups = {}
    for (const c of filtered) {
      const key = c.section || 'Unsectioned'
      if (!groups[key]) groups[key] = []
      groups[key].push(c)
    }
    return groups
  }, [filtered])

  const toggleStage = async (clip, stageKey) => {
    const next = !clip[`stage_${stageKey}`]
    setSavingStage(`${clip.clip_id}:${stageKey}`)
    // Optimistic update
    setClips(prev => prev.map(c => c.clip_id === clip.clip_id ? { ...c, [`stage_${stageKey}`]: next } : c))
    try {
      const { error: err } = await supabase.rpc('lib_clip_set_stage', {
        p_clip_id: clip.clip_id,
        p_stage: stageKey,
        p_value: next,
      })
      if (err) throw new Error(err.message)
    } catch (e) {
      // Revert
      setClips(prev => prev.map(c => c.clip_id === clip.clip_id ? { ...c, [`stage_${stageKey}`]: !next } : c))
      setError(`Stage update failed: ${e.message}`)
    } finally {
      setSavingStage(null)
    }
  }

  const removeClip = async (clip) => {
    if (!confirm(`Delete clip ${clip.clip_id}? This cannot be undone.`)) return
    try {
      const { error: err } = await supabase.rpc('lib_clip_delete', { p_clip_id: clip.clip_id })
      if (err) throw new Error(err.message)
      setClips(prev => prev.filter(c => c.clip_id !== clip.clip_id))
    } catch (e) { setError(`Delete failed: ${e.message}`) }
  }

  return (
    <div>
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">Production · Atomic clips</span>
          <h2 className="h3 mt-2" style={{ fontSize: 22 }}>The <em>clip</em> catalog.</h2>
          <p
            className="mt-2"
            style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}
          >
            {clips.length} clips · {filtered.length} after filters · raw → rough → final → approved
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 16px',
            background: 'var(--accent)',
            color: 'var(--ink)',
            border: '1px solid var(--accent)',
            borderRadius: 3,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <Plus size={13} /> Add clip
        </button>
      </div>

      {/* Filter bar */}
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 8,
          padding: '10px 12px',
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 3,
          marginBottom: 16,
        }}
      >
        <ChipGroup label="Type" value={typeFilter} setValue={setTypeFilter}
          options={[{ value: 'all', label: 'All' }, ...CLIP_TYPES]} />
        {editors.length > 0 && (
          <ChipGroup label="Editor" value={editorFilter} setValue={setEditorFilter}
            options={[{ value: 'all', label: 'All' }, ...editors.map(e => ({ value: e, label: e }))]} />
        )}
        <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <Search size={12} style={{ color: 'var(--ink-3)', flexShrink: 0, marginLeft: 4 }} />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search clip ID, description, section…"
            style={{ flex: 1, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: '5px 8px', fontSize: 12, color: 'var(--ink)', outline: 'none' }}
          />
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '12px 14px',
          background: 'var(--down-soft)', border: '1px solid var(--down)', borderLeftWidth: 3,
          borderRadius: '0 3px 3px 0', color: 'var(--down)', marginBottom: 16, fontSize: 13,
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 4 }}>Clip error</div>
            {error}
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader className="animate-spin" style={{ color: 'var(--ink-3)' }} />
        </div>
      )}

      {/* Empty state */}
      {!loading && clips.length === 0 && !error && (
        <div style={{
          border: '1px dashed var(--rule)', borderRadius: 4, padding: 32, textAlign: 'center', background: 'var(--paper-2)',
        }}>
          <span className="eyebrow eyebrow-accent" style={{ justifyContent: 'center', display: 'inline-flex', marginBottom: 12 }}>No clips yet</span>
          <h3 className="h3" style={{ fontSize: 22, marginBottom: 10 }}>Start the <em>clip catalog</em>.</h3>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)', maxWidth: '46ch', margin: '0 auto 18px', lineHeight: 1.55 }}>
            Add your first atomic clip — a hook, body, frame, or client testimonial. Each clip is cut once and can be spliced across many variants. The Variants page references these clips and tracks the spliced combinations.
          </p>
          <button onClick={() => setShowAdd(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 16px',
            background: 'var(--accent)', color: 'var(--ink)', border: '1px solid var(--accent)',
            borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, cursor: 'pointer',
          }}>
            <Plus size={13} /> Add first clip
          </button>
        </div>
      )}

      {/* Section groups */}
      {!loading && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {Object.entries(grouped).map(([section, items]) => (
            <section key={section}>
              <h3
                style={{
                  fontFamily: 'var(--serif)', fontSize: 18, lineHeight: 1.2, color: 'var(--ink)', fontWeight: 500,
                  margin: '0 0 8px 0', paddingBottom: 4,
                  borderBottom: '2px solid var(--accent)', display: 'inline-block',
                }}
              >
                {section}
              </h3>
              <div
                style={{
                  background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--rule)', background: 'var(--paper-2)' }}>
                      <ThCell w={140}>Clip ID</ThCell>
                      <ThCell>Description</ThCell>
                      <ThCell w={70}>Creator</ThCell>
                      <ThCell w={90}>Editor</ThCell>
                      <ThCell w={70}>Priority</ThCell>
                      {STAGES.map(s => <ThCell key={s.key} w={62} center>{s.label}</ThCell>)}
                      <ThCell w={80}>File</ThCell>
                      <ThCell w={32}></ThCell>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(c => (
                      <tr key={c.clip_id} style={{ borderBottom: '1px solid var(--rule)' }}>
                        <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)' }}>
                          {c.clip_id}
                        </td>
                        <td style={{ padding: '8px 10px', fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-2)' }}>
                          {c.description || '—'}
                        </td>
                        <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', color: 'var(--ink-3)' }}>
                          {c.creator_id || '—'}
                        </td>
                        <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--ink-2)' }}>
                          {c.editor || <span style={{ color: 'var(--ink-4)' }}>—</span>}
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          {c.priority ? <PriorityPill p={c.priority} /> : <span style={{ color: 'var(--ink-4)', fontSize: 12 }}>—</span>}
                        </td>
                        {STAGES.map(s => (
                          <td key={s.key} style={{ padding: '8px 6px', textAlign: 'center' }}>
                            <StageCheckbox
                              checked={c[`stage_${s.key}`]}
                              saving={savingStage === `${c.clip_id}:${s.key}`}
                              onChange={() => toggleStage(c, s.key)}
                            />
                          </td>
                        ))}
                        <td style={{ padding: '8px 10px' }}>
                          {c.source_file_url ? (
                            <a href={c.source_file_url} target="_blank" rel="noreferrer"
                               style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              <FileVideo size={10} />
                              {c.source_file_name || 'file'}
                            </a>
                          ) : c.source_file_name ? (
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
                              {c.source_file_name}
                            </span>
                          ) : <span style={{ color: 'var(--ink-4)' }}>—</span>}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          <button
                            onClick={() => removeClip(c)}
                            style={{ color: 'var(--ink-4)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }}
                            title="Delete clip"
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Add modal */}
      {showAdd && (
        <AddClipModal
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load() }}
        />
      )}
    </div>
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

function ThCell({ children, w, center }) {
  return (
    <th style={{
      padding: '8px 10px', textAlign: center ? 'center' : 'left',
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
      color: 'var(--ink-3)', fontWeight: 500, width: w ? w : undefined,
    }}>{children}</th>
  )
}

function StageCheckbox({ checked, saving, onChange }) {
  return (
    <button onClick={onChange} disabled={saving} style={{
      width: 18, height: 18,
      background: checked ? 'var(--accent)' : 'var(--paper-2)',
      border: '1px solid', borderColor: checked ? 'var(--accent)' : 'var(--rule)',
      borderRadius: 2, cursor: saving ? 'wait' : 'pointer',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--ink)', fontSize: 11, lineHeight: 1, opacity: saving ? 0.5 : 1,
    }} aria-label={checked ? 'mark incomplete' : 'mark complete'}>
      {checked ? '✓' : ''}
    </button>
  )
}

function PriorityPill({ p }) {
  const color = p === 'high' ? 'var(--accent)' : p === 'low' ? 'var(--ink-4)' : 'var(--ink-3)'
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px',
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
      background: p === 'high' ? 'var(--accent-soft)' : 'var(--paper-2)',
      color, border: `1px solid ${color}`, borderRadius: 2,
    }}>{p}</span>
  )
}

function AddClipModal({ onClose, onSaved }) {
  const [clipId, setClipId] = useState('')
  const [clipType, setClipType] = useState('hook')
  const [section, setSection] = useState('')
  const [description, setDescription] = useState('')
  const [creatorId, setCreatorId] = useState('')
  const [editor, setEditor] = useState('')
  const [priority, setPriority] = useState('')
  const [durationSec, setDurationSec] = useState('')
  const [fileUrl, setFileUrl] = useState('')
  const [fileName, setFileName] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setErr(null); setSaving(true)
    try {
      const { error } = await supabase.rpc('lib_clip_upsert', {
        p_clip_id: clipId.trim(),
        p_clip_type: clipType,
        p_section: section.trim() || null,
        p_description: description.trim() || null,
        p_creator_id: creatorId.trim() || null,
        p_editor: editor.trim() || null,
        p_priority: priority || null,
        p_duration_sec: durationSec ? parseInt(durationSec, 10) : null,
        p_source_file_url: fileUrl.trim() || null,
        p_source_file_name: fileName.trim() || null,
        p_notes: notes.trim() || null,
      })
      if (error) throw new Error(error.message)
      onSaved()
    } catch (e) { setErr(e.message); setSaving(false) }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.4)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} style={{
        width: '100%', maxWidth: 560, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 4, padding: 24,
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, margin: '0 0 16px 0' }}>Add clip</h3>

        <Field label="Clip ID *" hint="e.g. H1.1-OSO, P-ADAM-OSO, BODY-B1-OSO">
          <input required value={clipId} onChange={e => setClipId(e.target.value)} style={inputStyle} placeholder="H1.1-OSO" />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Type *">
            <select value={clipType} onChange={e => setClipType(e.target.value)} style={inputStyle} required>
              {CLIP_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Section">
            <input value={section} onChange={e => setSection(e.target.value)} style={inputStyle} placeholder="Informative hooks" />
          </Field>
        </div>

        <Field label="Description" hint="What the clip shows + rough duration">
          <input value={description} onChange={e => setDescription(e.target.value)} style={inputStyle} placeholder="Referrals & word of mouth (~15s)" />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label="Creator">
            <input value={creatorId} onChange={e => setCreatorId(e.target.value)} style={inputStyle} placeholder="OSO" />
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Duration (s)">
            <input type="number" value={durationSec} onChange={e => setDurationSec(e.target.value)} style={inputStyle} placeholder="15" />
          </Field>
          <Field label="File name">
            <input value={fileName} onChange={e => setFileName(e.target.value)} style={inputStyle} placeholder="20260509_C0588.MP4" />
          </Field>
        </div>

        <Field label="File URL (Drive / Frame.io / etc)">
          <input value={fileUrl} onChange={e => setFileUrl(e.target.value)} style={inputStyle} placeholder="https://drive.google.com/file/d/..." />
        </Field>

        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} style={{ ...inputStyle, minHeight: 60, resize: 'vertical', fontFamily: 'var(--serif)' }} placeholder="Anything else…" />
        </Field>

        {err && <div style={{ marginTop: 8, color: 'var(--down)', fontSize: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose} style={btnSecondaryStyle}>Cancel</button>
          <button type="submit" disabled={saving || !clipId.trim()} style={btnPrimaryStyle}>
            {saving ? 'Saving…' : 'Save clip'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500, marginBottom: 4 }}>
        {label}{hint && <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 11, color: 'var(--ink-4)', textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>{hint}</span>}
      </label>
      {children}
    </div>
  )
}

const inputStyle = {
  width: '100%',
  background: 'var(--paper-2)',
  border: '1px solid var(--rule)',
  borderRadius: 3,
  padding: '8px 10px',
  fontSize: 13,
  fontFamily: 'var(--sans)',
  color: 'var(--ink)',
  outline: 'none',
}

const btnPrimaryStyle = {
  padding: '8px 16px',
  background: 'var(--accent)',
  color: 'var(--ink)',
  border: '1px solid var(--accent)',
  borderRadius: 3,
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
  cursor: 'pointer',
}

const btnSecondaryStyle = {
  padding: '8px 16px',
  background: 'transparent',
  color: 'var(--ink-2)',
  border: '1px solid var(--rule)',
  borderRadius: 3,
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}
