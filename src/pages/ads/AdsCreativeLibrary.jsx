import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { SectionHead, Icon } from '../../components/editorial/atoms'
import Modal from '../../components/editorial/Modal'

/*
  /sales/ads/creative/library — two-tab surface for the creative library:

    1. Library — every video clip (raw + edited), with thumbnails, filters,
       click-to-preview, drop-to-upload.
    2. Editing Queue — what each editor is working on, what's overdue,
       what's next in the pipeline.

  Data sources:
    - lib_creative_library  (114 backfilled rows from the May 2026 batch)
    - lib_creative_editors  (Ahmed, Mohamed, Dean, Unassigned)
    - lib_editing_tasks     (assignments + status)
    - lib_editing_queue (view)
*/

const TYPES = ['Hook', 'Body', 'Full Video', 'Frame', 'Client Testimonial',
               'Client Footage', 'Podcast', 'Client Review', 'Other', 'unknown']
const STATUSES = ['raw', 'in_edit', 'review', 'approved', 'live', 'archived']

export default function AdsCreativeLibrary() {
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('lib.tab') || 'library' } catch { return 'library' }
  })
  useEffect(() => { try { localStorage.setItem('lib.tab', tab) } catch {} }, [tab])

  return (
    <div style={{ padding: '24px 0 60px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <SectionHead level="page" eyebrow="Library">
          Creative library
        </SectionHead>

        {/* Tab switcher */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'var(--paper)' }}>
          <TabBtn active={tab === 'library'} onClick={() => setTab('library')}>Library</TabBtn>
          <TabBtn active={tab === 'queue'}   onClick={() => setTab('queue')}>Editing queue</TabBtn>
        </div>
      </div>

      {tab === 'library' ? <LibraryTab /> : <EditingQueueTab />}
    </div>
  )
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 16px',
      fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      background: active ? 'var(--ink)' : 'transparent',
      color: active ? 'var(--paper)' : 'var(--ink-3)',
      border: 'none', cursor: 'pointer',
    }}>{children}</button>
  )
}

/* ─────────────────────────── LIBRARY TAB ─────────────────────────── */

function LibraryTab() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [creatorFilter, setCreatorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [drawerRow, setDrawerRow] = useState(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('lib.view') || 'tile' } catch { return 'tile' }
  })
  useEffect(() => { try { localStorage.setItem('lib.view', view) } catch {} }, [view])
  const [confirmDelete, setConfirmDelete] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const { data, error } = await supabase
      .from('lib_creative_library')
      .select('*')
      .eq('exclude_from_library', false)
      .order('added_at', { ascending: false })
    if (error) setErr(error.message)
    else setRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    let list = rows
    const search = q.trim().toLowerCase()
    if (search) list = list.filter(r => {
      const blob = `${r.name} ${r.creator || ''} ${r.v21_script_id || ''} ${r.transcript || ''}`.toLowerCase()
      return blob.includes(search)
    })
    if (typeFilter)    list = list.filter(r => r.type === typeFilter)
    if (creatorFilter) list = list.filter(r => r.creator === creatorFilter)
    if (statusFilter)  list = list.filter(r => r.status === statusFilter)
    return list
  }, [rows, q, typeFilter, creatorFilter, statusFilter])

  const creators = useMemo(() =>
    Array.from(new Set(rows.map(r => r.creator).filter(Boolean))).sort()
  , [rows])

  return (
    <>
      {/* Toolbar */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 14px', background: 'var(--paper-2)',
        border: '1px solid var(--rule)', marginBottom: 14,
      }}>
        <input type="text" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search name, transcript, script…"
          style={{
            flex: '1 1 280px', maxWidth: 380,
            padding: '7px 11px', fontFamily: 'var(--sans)', fontSize: 13,
            background: 'white', border: '1px solid var(--rule)', outline: 'none',
          }} />
        <Select value={typeFilter}    onChange={setTypeFilter}    placeholder="All types"    options={TYPES} />
        <Select value={creatorFilter} onChange={setCreatorFilter} placeholder="All creators" options={creators} />
        <Select value={statusFilter}  onChange={setStatusFilter}  placeholder="All statuses" options={STATUSES} />
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
          {filtered.length} / {rows.length}
        </span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'white' }}>
          <ViewBtn active={view === 'tile'} onClick={() => setView('tile')}>Tiles</ViewBtn>
          <ViewBtn active={view === 'list'} onClick={() => setView('list')}>List</ViewBtn>
        </div>
        <button onClick={() => setUploadOpen(true)} style={primaryBtn}>
          + Upload creative
        </button>
      </div>

      {err && <ErrorBanner msg={err} />}

      {loading ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : view === 'tile' ? (
        <div style={{
          display: 'grid', gap: 14,
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        }}>
          {filtered.map(r => (
            <CreativeCard key={r.id} row={r} onClick={() => setDrawerRow(r)} />
          ))}
        </div>
      ) : (
        <CreativeListView
          rows={filtered}
          onClick={setDrawerRow}
          onDelete={setConfirmDelete}
        />
      )}

      {drawerRow && (
        <CreativeDetailModal
          row={drawerRow}
          onClose={() => setDrawerRow(null)}
          onSaved={() => { setDrawerRow(null); load() }}
        />
      )}

      {uploadOpen && (
        <UploadModal
          onClose={() => setUploadOpen(false)}
          onSaved={() => { setUploadOpen(false); load() }}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          row={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onDeleted={() => { setConfirmDelete(null); load() }}
        />
      )}
    </>
  )
}

function ViewBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px',
      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      background: active ? 'var(--ink)' : 'transparent',
      color: active ? 'var(--paper)' : 'var(--ink-3)',
      border: 'none', cursor: 'pointer',
    }}>{children}</button>
  )
}

function CreativeListView({ rows, onClick, onDelete }) {
  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '52px minmax(280px, 1.8fr) 110px 130px 90px 80px 80px 100px',
        padding: '10px 14px', gap: 12,
        background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
      }}>
        <div></div>
        <div>Name</div>
        <div>Type</div>
        <div>Creator</div>
        <div>v21</div>
        <div>Size</div>
        <div>Status</div>
        <div style={{ textAlign: 'right' }}>Actions</div>
      </div>
      {rows.map((r, i) => (
        <div key={r.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '52px minmax(280px, 1.8fr) 110px 130px 90px 80px 80px 100px',
            padding: '10px 14px', gap: 12, alignItems: 'center',
            borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--rule)',
            background: 'transparent', transition: 'background 0.12s',
            cursor: 'pointer',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          onClick={() => onClick(r)}>
          {/* Thumb */}
          <div style={{
            width: 44, height: 28, background: 'var(--paper-2)',
            backgroundImage: r.thumbnail_url ? `url('${r.thumbnail_url}')` : 'none',
            backgroundSize: 'cover', backgroundPosition: 'center',
            border: '1px solid var(--rule)',
          }} />
          {/* Name (canonical + original) */}
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 500,
              color: 'var(--ink)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{r.canonical_name || r.name}</div>
            {r.canonical_name && r.canonical_name !== r.name && (
              <div style={{
                fontFamily: 'var(--sans)', fontSize: 10.5, color: 'var(--ink-4)',
                marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{r.name}</div>
            )}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.type}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.creator || '—'}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                        color: r.v21_script_id ? 'var(--ink)' : 'var(--ink-4)' }}>
            {r.v21_script_id || '—'}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>
            {r.size_mb ? `${Math.round(r.size_mb)} MB` : '—'}
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase',
            color: r.status === 'live' ? '#6a5b00'
                 : r.status === 'approved' ? '#3e8a5e'
                 : r.status === 'in_edit' ? '#b86a0c'
                 : 'var(--ink-3)',
          }}>{r.status}</div>
          {/* Actions */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={e => { e.stopPropagation(); onDelete(r) }} style={{
              padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 10,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              background: 'transparent', color: '#b53e3e',
              border: '1px solid #b53e3e', cursor: 'pointer',
            }}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  )
}

function ConfirmDeleteModal({ row, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const confirm = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase
      .from('lib_creative_library')
      .delete()
      .eq('id', row.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onDeleted?.()
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="sm"
      eyebrow="Delete"
      title="Remove this creative?"
      subtitle="This removes the database row from your library. The file in Drive is NOT deleted — you can re-add it later by uploading again."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={confirm} disabled={busy} style={{
            ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e',
          }}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px' }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 12, padding: 12,
          background: 'var(--paper-2)', border: '1px solid var(--rule)',
          color: 'var(--ink-2)',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{row.canonical_name || row.name}</div>
          {row.canonical_name && row.canonical_name !== row.name && (
            <div style={{ marginTop: 4, color: 'var(--ink-4)', fontSize: 11 }}>{row.name}</div>
          )}
          <div style={{ marginTop: 6, color: 'var(--ink-3)', fontSize: 11 }}>
            {row.type} · {row.creator || 'no creator'} · {row.size_mb ? Math.round(row.size_mb) + ' MB' : ''}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function Select({ value, onChange, placeholder, options }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{
      padding: '7px 11px', fontFamily: 'var(--sans)', fontSize: 12,
      background: 'white', border: '1px solid var(--rule)', outline: 'none',
      cursor: 'pointer',
    }}>
      <option value="">{placeholder}</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

function CreativeCard({ row, onClick }) {
  return (
    <div onClick={onClick} style={{
      cursor: 'pointer',
      background: 'var(--paper)',
      border: '1px solid var(--rule)',
      transition: 'border-color 0.12s, transform 0.12s',
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--ink)'}
    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--rule)'}>
      {/* Thumbnail */}
      <div style={{
        aspectRatio: '16 / 9', background: 'var(--paper-2)',
        backgroundImage: row.thumbnail_url ? `url('${row.thumbnail_url}')` : 'none',
        backgroundSize: 'cover', backgroundPosition: 'center',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
      }}>
        {!row.thumbnail_url && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            No thumbnail
          </span>
        )}
        {/* Type pill — top-left */}
        {row.type && row.type !== 'unknown' && (
          <span style={{
            position: 'absolute', top: 6, left: 6,
            padding: '2px 6px',
            background: 'rgba(0,0,0,0.7)', color: 'white',
            fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 500,
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>{row.type}</span>
        )}
        {/* v21 match pill — top-right */}
        {row.v21_script_id && (
          <span style={{
            position: 'absolute', top: 6, right: 6,
            padding: '2px 6px',
            background: 'var(--accent)', color: 'var(--ink)',
            fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
            letterSpacing: '0.06em',
          }}>{row.v21_script_id}</span>
        )}
      </div>
      {/* Body */}
      <div style={{ padding: '10px 12px' }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
          color: 'var(--ink)', lineHeight: 1.35,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={row.name}>{row.canonical_name || row.name}</div>
        <div style={{
          marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap',
          fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          {row.creator && <span>{row.creator}</span>}
          {row.size_mb && <span>· {Math.round(row.size_mb)} MB</span>}
          <span style={{
            marginLeft: 'auto',
            color: row.status === 'live' ? 'var(--accent-ink, #6a5b00)'
                 : row.status === 'approved' ? '#3e8a5e'
                 : row.status === 'in_edit' ? '#b86a0c'
                 : 'var(--ink-3)',
          }}>{row.status}</span>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────── DETAIL MODAL (click row) ─────────────────────── */

function CreativeDetailModal({ row, onClose, onSaved }) {
  const [edit, setEdit] = useState(row)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const save = async () => {
    setSaving(true); setErr(null)
    const { error } = await supabase
      .from('lib_creative_library')
      .update({
        type: edit.type, creator: edit.creator, status: edit.status,
        v21_script_id: edit.v21_script_id, notes: edit.notes,
      })
      .eq('id', row.id)
    setSaving(false)
    if (error) setErr(error.message)
    else onSaved?.()
  }

  return (
    <Modal open={true} onClose={onClose} size="lg"
      eyebrow={row.type || 'Creative'}
      title={row.name}
      subtitle={`${row.source_bucket || ''}${row.size_mb ? ' · ' + Math.round(row.size_mb) + ' MB' : ''}`}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} style={ghostBtn}>Close</button>
          <button onClick={save} disabled={saving} style={primaryBtn}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 16 }}>
        {/* Video preview */}
        {row.drive_url && (
          <div style={{ aspectRatio: '16 / 9', background: 'black' }}>
            <iframe src={driveEmbedUrl(row.drive_url)}
              title={row.name}
              style={{ width: '100%', height: '100%', border: 'none' }}
              allow="autoplay" />
          </div>
        )}

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Field label="Type">
            <select value={edit.type || ''} onChange={e => setEdit({ ...edit, type: e.target.value })} style={selectStyle}>
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Creator">
            <input type="text" value={edit.creator || ''} onChange={e => setEdit({ ...edit, creator: e.target.value })} style={inputStyle} />
          </Field>
          <Field label="Status">
            <select value={edit.status || 'raw'} onChange={e => setEdit({ ...edit, status: e.target.value })} style={selectStyle}>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="v21 script">
            <input type="text" value={edit.v21_script_id || ''} onChange={e => setEdit({ ...edit, v21_script_id: e.target.value })}
              placeholder="A.1, B.2, etc." style={inputStyle} />
          </Field>
        </div>

        <Field label="Notes">
          <textarea value={edit.notes || ''} onChange={e => setEdit({ ...edit, notes: e.target.value })}
            rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)' }} />
        </Field>

        {row.transcript && (
          <Field label="Transcript">
            <div style={{
              maxHeight: 200, overflowY: 'auto', padding: 12,
              background: 'var(--paper-2)', border: '1px solid var(--rule)',
              fontFamily: 'var(--serif)', fontSize: 13, lineHeight: 1.5,
              color: 'var(--ink-2)', fontStyle: 'italic',
              whiteSpace: 'pre-wrap',
            }}>{row.transcript}</div>
          </Field>
        )}

        {row.drive_url && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
            Drive: <a href={row.drive_url} target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>{row.drive_url.slice(0, 70)}…</a>
          </div>
        )}
      </div>
    </Modal>
  )
}

function driveEmbedUrl(url) {
  // Convert /file/d/ID/view → /file/d/ID/preview
  const m = url.match(/\/file\/d\/([^/]+)/)
  if (m) return `https://drive.google.com/file/d/${m[1]}/preview`
  return url
}

/* ─────────────────────────── UPLOAD MODAL ─────────────────────────── */

function UploadModal({ onClose, onSaved }) {
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const inputRef = useRef(null)

  const handleDrop = (e) => {
    e.preventDefault()
    const f = e.dataTransfer.files?.[0]
    if (f) setFile(f)
  }

  const submit = async () => {
    if (!file) return
    setBusy(true); setErr(null)
    try {
      // Step 1: upload to a temp Supabase Storage bucket (for now)
      // The full pipeline (Drive upload + transcribe + match) will be wired
      // up via creative-library-upload Edge Function next.
      // For now: insert a row with name + size and the file as a Storage upload.
      const path = `incoming/${Date.now()}_${file.name}`
      const { error: upErr } = await supabase.storage
        .from('creative-thumbnails')
        .upload(path, file, { upsert: false })
      if (upErr) throw upErr
      const { data: rowData, error: insErr } = await supabase
        .from('lib_creative_library')
        .insert({
          name: file.name,
          type: 'unknown',
          size_mb: Math.round(file.size / 1024 / 1024 * 10) / 10,
          status: 'raw',
          source_bucket: 'Manual upload',
          notes: `Uploaded via /sales/ads/creative/library on ${new Date().toISOString().slice(0,10)}. Pending Drive upload + transcribe.`,
        })
        .select()
        .single()
      if (insErr) throw insErr
      onSaved?.()
    } catch (e) {
      setErr(e.message || 'upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="md"
      eyebrow="Upload"
      title="Add a new creative"
      subtitle="Drop a video file. We'll add it to the library, then push to Drive + auto-transcribe in the next pass."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={!file || busy} style={primaryBtn}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </>
      }>
      <div style={{ padding: 28 }}>
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          style={{
            padding: 40, textAlign: 'center', cursor: 'pointer',
            border: '2px dashed var(--rule)',
            background: file ? 'var(--paper-2)' : 'var(--paper)',
            transition: 'border-color 0.12s, background 0.12s',
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--ink)'}
          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--rule)'}>
          <input ref={inputRef} type="file" accept="video/*"
            style={{ display: 'none' }}
            onChange={e => setFile(e.target.files?.[0] || null)} />
          {file ? (
            <>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 14, fontWeight: 500, marginBottom: 6 }}>{file.name}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                {(file.size / 1024 / 1024).toFixed(1)} MB · click to change
              </div>
            </>
          ) : (
            <>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink-2)', marginBottom: 4 }}>
                Drop a video file here
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                or click to select
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

/* ─────────────────────────── EDITING QUEUE TAB ─────────────────────────── */

function EditingQueueTab() {
  const [tasks, setTasks] = useState([])
  const [editors, setEditors] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const [t, e] = await Promise.all([
      supabase.from('lib_editing_queue').select('*'),
      supabase.from('lib_creative_editors').select('*').eq('active', true).order('name'),
    ])
    if (t.error) setErr(t.error.message)
    else setTasks(t.data || [])
    setEditors(e.data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Group by editor
  const byEditor = useMemo(() => {
    const m = new Map()
    for (const t of tasks) {
      const key = t.editor_slug || 'unassigned'
      if (!m.has(key)) m.set(key, { editor_name: t.editor_name || 'Unassigned', tasks: [] })
      m.get(key).tasks.push(t)
    }
    return Array.from(m.entries()).map(([slug, v]) => ({ slug, ...v }))
  }, [tasks])

  // Counts
  const overdue = tasks.filter(t => t.is_overdue).length
  const inProg  = tasks.filter(t => t.status === 'in_progress').length
  const queued  = tasks.filter(t => t.status === 'queued').length
  const done    = tasks.filter(t => t.status === 'done').length

  if (loading) return <LoadingState />
  if (err) return <ErrorBanner msg={err} />

  return (
    <>
      {/* KPI bar */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18,
      }}>
        <KpiTile label="Overdue"     value={overdue} accent={overdue > 0 ? '#b53e3e' : null} />
        <KpiTile label="In progress" value={inProg} />
        <KpiTile label="Queued"      value={queued} />
        <KpiTile label="Done"        value={done} />
      </div>

      {tasks.length === 0 ? (
        <div style={{
          border: '1px dashed var(--rule)', padding: 40, textAlign: 'center',
          background: 'var(--paper-2)',
        }}>
          <SectionHead level="section" eyebrow="Empty queue">No editing tasks yet</SectionHead>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-3)', marginTop: 8 }}>
            Assign a creative to an editor from the Library tab — click a card → set editor + due date.
            Tasks will appear here grouped by editor.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 18 }}>
          {byEditor.map(({ slug, editor_name, tasks: t }) => (
            <EditorLane key={slug} editor={editor_name} tasks={t} />
          ))}
        </div>
      )}
    </>
  )
}

function EditorLane({ editor, tasks }) {
  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--rule)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--paper-2)',
      }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            Editor
          </div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500, marginTop: 2 }}>{editor}</div>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </div>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 10, padding: 12,
      }}>
        {tasks.map(t => <QueueCard key={t.task_id} task={t} />)}
      </div>
    </div>
  )
}

function QueueCard({ task }) {
  const statusColor = {
    queued: 'var(--ink-3)',
    in_progress: '#b86a0c',
    review: '#3e7eba',
    done: '#3e8a5e',
    blocked: '#b53e3e',
  }[task.status] || 'var(--ink-3)'

  return (
    <div style={{
      background: 'white', border: '1px solid var(--rule)',
      borderLeft: `3px solid ${statusColor}`,
      padding: '10px 12px',
    }}>
      {task.thumbnail_url && (
        <div style={{
          aspectRatio: '16/9', backgroundImage: `url('${task.thumbnail_url}')`,
          backgroundSize: 'cover', backgroundPosition: 'center',
          marginBottom: 8,
        }} />
      )}
      <div style={{
        fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{task.creative_name}</div>
      <div style={{
        marginTop: 4, display: 'flex', gap: 6, alignItems: 'center',
        fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-3)',
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        <span style={{ color: statusColor, fontWeight: 600 }}>{task.status}</span>
        <span>·</span>
        <span>{task.priority}</span>
        {task.due_date && (
          <span style={{ marginLeft: 'auto', color: task.is_overdue ? '#b53e3e' : 'var(--ink-4)' }}>
            {task.is_overdue ? '⚠ ' : ''}{task.due_date}
          </span>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────── Shared bits ─────────────────────────── */

function KpiTile({ label, value, accent }) {
  return (
    <div style={{
      background: 'var(--paper)', border: '1px solid var(--rule)',
      padding: '14px 18px',
    }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        {label}
      </div>
      <div style={{
        fontFamily: 'var(--sans)', fontSize: 32, fontWeight: 500,
        color: accent || 'var(--ink)', marginTop: 4,
        lineHeight: 1, fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 5, fontWeight: 600,
      }}>{label}</div>
      {children}
    </div>
  )
}

function LoadingState() {
  return (
    <div style={{ padding: 60, textAlign: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
      Loading…
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{ padding: 60, textAlign: 'center', border: '1px dashed var(--rule)', background: 'var(--paper-2)' }}>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink-2)', marginBottom: 6 }}>
        Nothing matches.
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        Adjust filters or upload a new creative
      </div>
    </div>
  )
}

function ErrorBanner({ msg }) {
  return (
    <div style={{
      padding: '10px 14px', marginBottom: 14,
      background: 'rgba(181,62,62,0.08)', border: '1px solid #b53e3e', color: '#b53e3e',
      fontFamily: 'var(--mono)', fontSize: 12,
    }}>Error: {msg}</div>
  )
}

const primaryBtn = {
  padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  background: 'var(--ink)', color: 'var(--paper)',
  border: '1px solid var(--ink)', cursor: 'pointer',
}
const ghostBtn = {
  padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  background: 'transparent', color: 'var(--ink-3)',
  border: '1px solid var(--rule)', cursor: 'pointer',
}
const inputStyle = {
  width: '100%', padding: '8px 11px',
  fontFamily: 'var(--mono)', fontSize: 12,
  background: 'white', border: '1px solid var(--rule)', outline: 'none',
}
const selectStyle = {
  width: '100%', padding: '8px 11px',
  fontFamily: 'var(--sans)', fontSize: 12,
  background: 'white', border: '1px solid var(--rule)', outline: 'none',
  cursor: 'pointer',
}
