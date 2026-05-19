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

const TYPES = ['Hook', 'Body', 'Full Video', 'Testimony']
const STATUSES = ['raw', 'in_edit', 'review', 'approved', 'live', 'archived']
const STATUS_LABEL = {
  raw: 'Raw',
  in_edit: 'In edit',
  review: 'Review',
  approved: 'Approved',
  live: 'Live',
  archived: 'Archived',
}
const STATUS_COLOR = {
  raw: '#999',
  in_edit: '#b86a0c',
  review: '#3e7eba',
  approved: '#3e8a5e',
  live: '#3e8a5e',
  archived: '#999',
}

// Distinct color per type — helps you scan a busy Matrix view and immediately
// see hooks vs bodies vs full videos vs testimonials.
const TYPE_COLOR = {
  'Hook':       { ink: '#1f4e8f', soft: 'rgba(31,78,143,0.10)',  border: 'rgba(31,78,143,0.35)' },
  'Body':       { ink: '#a05810', soft: 'rgba(160,88,16,0.10)',  border: 'rgba(160,88,16,0.35)' },
  'Full Video': { ink: '#2e6e3f', soft: 'rgba(46,110,63,0.10)',  border: 'rgba(46,110,63,0.35)' },
  'Testimony':  { ink: '#7a3aa8', soft: 'rgba(122,58,168,0.10)', border: 'rgba(122,58,168,0.35)' },
}
function typeColor(t) {
  return TYPE_COLOR[t] || { ink: 'var(--ink-3)', soft: 'var(--paper-2)', border: 'var(--rule)' }
}

// Per-stage indicator values for the Matrix view
const STAGE_VALUES = [
  { v: null,           label: '—',          color: '#ccc',   bg: 'transparent' },
  { v: 'done',         label: 'X',          color: 'white',  bg: '#3e8a5e' },
  { v: 'in_progress',  label: 'In progress', color: '#7a4e08', bg: 'rgba(232,180,8,0.25)' },
  { v: 'blocked',      label: 'Blocked',    color: 'white',  bg: '#b53e3e' },
  { v: 'skip',         label: 'Skip',       color: 'var(--ink-3)', bg: 'rgba(0,0,0,0.05)' },
]
function stageStyle(value) {
  const v = STAGE_VALUES.find(s => s.v === value) || STAGE_VALUES[0]
  return v
}

// Stable distinct color per editor (hash of slug → 10-color palette).
// Used everywhere the editor needs a visual identity (selector chips,
// queue cards, timeline bars, list-view dot).
const EDITOR_COLORS = [
  '#3e7eba', '#e0853e', '#5fa55a', '#a05fa5', '#c44b6e',
  '#3eb2a8', '#b8893e', '#7e3eb8', '#5b8a3e', '#b83e3e',
]
function editorColor(slug) {
  if (!slug) return '#999'
  let h = 0
  for (let i = 0; i < slug.length; i++) h = ((h << 5) - h + slug.charCodeAt(i)) | 0
  return EDITOR_COLORS[Math.abs(h) % EDITOR_COLORS.length]
}

// Default scope = full admin permissions (when used inside the regular dashboard).
// EditorView passes a restricted scope for the public /editor-view/:token surface.
const ADMIN_SCOPE = {
  isEditorView: false,
  editorId: null,
  editorName: null,
  canDelete: true,
  canUpload: true,
  canEditCreative: true,
  canEditTask: true,
  canAssignSelf: true,
  canDeleteTask: true,
  canManageEditors: true,
}

export default function AdsCreativeLibrary({ editorScope }) {
  const scope = editorScope || ADMIN_SCOPE
  // In editor-view mode, default to the Editing Queue tab since that's why
  // they came (to see their assignments). Admins land on Library.
  const [tab, setTab] = useState(() => {
    try {
      const saved = localStorage.getItem('lib.tab')
      return saved || (scope.isEditorView ? 'queue' : 'library')
    } catch { return scope.isEditorView ? 'queue' : 'library' }
  })
  useEffect(() => { try { localStorage.setItem('lib.tab', tab) } catch {} }, [tab])

  return (
    <div style={{ padding: '24px 0 60px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <SectionHead level="page" eyebrow={scope.isEditorView ? 'Editor portal' : 'Library'}>
          {scope.isEditorView ? 'Your queue + creative library' : 'Creative library'}
        </SectionHead>

        {/* Tab switcher */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'var(--paper)' }}>
          <TabBtn active={tab === 'library'} onClick={() => setTab('library')}>Library</TabBtn>
          <TabBtn active={tab === 'queue'}   onClick={() => setTab('queue')}>Editing queue</TabBtn>
        </div>
      </div>

      {tab === 'library' ? <LibraryTab scope={scope} /> : <EditingQueueTab scope={scope} />}
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

function LibraryTab({ scope = ADMIN_SCOPE }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [rawEditedFilter, setRawEditedFilter] = useState(() => {
    try { return localStorage.getItem('lib.rawEdited') || 'edited' } catch { return 'edited' }
  })
  useEffect(() => {
    try { localStorage.setItem('lib.rawEdited', rawEditedFilter) } catch {}
  }, [rawEditedFilter])
  const [drawerRow, setDrawerRow] = useState(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('lib.view') || 'list' } catch { return 'list' }
  })
  useEffect(() => { try { localStorage.setItem('lib.view', view) } catch {} }, [view])
  const [confirmDelete, setConfirmDelete] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const { data, error } = await supabase
      .from('lib_creative_library')
      .select('*, assigned_editor:assigned_editor_id (id, name)')
      .eq('exclude_from_library', false)
      .order('added_at', { ascending: false })
    if (error) setErr(error.message)
    else {
      // Flatten the joined editor name for table consumption
      setRows((data || []).map(r => ({
        ...r,
        assigned_editor_name: r.assigned_editor?.name || null,
      })))
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    let list = rows
    // Raw/Edited top-level toggle — bypassed in Matrix view (one row per
    // creative, stage columns handle the raw-vs-delivered distinction)
    const rawEdited = view === 'matrix' ? 'all' : rawEditedFilter
    if (rawEdited === 'raw')         list = list.filter(r => r.status === 'raw')
    else if (rawEdited === 'edited') list = list.filter(r => r.status !== 'raw')
    const search = q.trim().toLowerCase()
    if (search) list = list.filter(r => {
      const blob = `${r.name} ${r.canonical_name || ''} ${r.creator || ''} ${r.v21_script_id || ''} ${r.transcript || ''}`.toLowerCase()
      return blob.includes(search)
    })
    if (typeFilter)   list = list.filter(r => r.type === typeFilter)
    if (statusFilter) list = list.filter(r => r.status === statusFilter)
    return list
  }, [rows, q, typeFilter, statusFilter, rawEditedFilter])

  // Counts for the Raw/Edited toggle (always over ALL rows)
  const rawCount = useMemo(() => rows.filter(r => r.status === 'raw').length, [rows])
  const editedCount = useMemo(() => rows.filter(r => r.status !== 'raw').length, [rows])

  // Per-type counts for the chip badges (over ALL rows, ignoring current type filter)
  const typeCounts = useMemo(() => {
    const m = {}
    for (const r of rows) m[r.type] = (m[r.type] || 0) + 1
    return m
  }, [rows])

  const statusCounts = useMemo(() => {
    const m = {}
    for (const r of rows) m[r.status] = (m[r.status] || 0) + 1
    return m
  }, [rows])

  // Section groups for the list view — used when no type filter, shows
  // Hooks/Bodies/Full Videos/Testimony as separate sections
  const grouped = useMemo(() => {
    if (typeFilter) return [{ type: typeFilter, rows: filtered }]
    const order = ['Hook', 'Body', 'Full Video', 'Testimony']
    return order
      .map(t => ({ type: t, rows: filtered.filter(r => r.type === t) }))
      .filter(g => g.rows.length > 0)
  }, [filtered, typeFilter])

  return (
    <>
      {/* Big Raw vs Edited toggle — hidden in Matrix view because Matrix
          shows raw + delivered side-by-side in stage columns on the same
          row, so a top-level raw/edited split doesn't make sense there. */}
      {view !== 'matrix' && (
        <div style={{
          display: 'flex', gap: 0, marginBottom: 14,
          border: '1px solid var(--rule)',
        }}>
          <BigToggle active={rawEditedFilter === 'edited'} onClick={() => setRawEditedFilter('edited')}
            label="Edited" count={editedCount}
            subtitle="Finished UGC, hooks, bodies, full ads — ready to use" />
          <BigToggle active={rawEditedFilter === 'raw'} onClick={() => setRawEditedFilter('raw')}
            label="Raw footage" count={rawCount}
            subtitle="Camera files + unedited clips — sources for editing" />
          <BigToggle active={rawEditedFilter === 'all'} onClick={() => setRawEditedFilter('all')}
            label="All" count={rows.length}
            subtitle="Everything in the library" />
        </div>
      )}

      {/* Toolbar */}
      <div style={{
        display: 'grid', gap: 10,
        padding: '14px 16px', background: 'var(--paper-2)',
        border: '1px solid var(--rule)', marginBottom: 14,
      }}>
        {/* Row 1: search + view toggle + upload */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="text" value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search name, transcript, script…"
            style={{
              flex: '1 1 280px', maxWidth: 420,
              padding: '8px 12px', fontFamily: 'var(--sans)', fontSize: 13,
              background: 'white', border: '1px solid var(--rule)', outline: 'none',
            }} />
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
            {filtered.length} / {rows.length}
          </span>
          <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'white' }}>
            <ViewBtn active={view === 'tile'}   onClick={() => setView('tile')}>Tiles</ViewBtn>
            <ViewBtn active={view === 'list'}   onClick={() => setView('list')}>List</ViewBtn>
            <ViewBtn active={view === 'matrix'} onClick={() => setView('matrix')}>Matrix</ViewBtn>
          </div>
          {scope.canUpload && (
            <button onClick={() => setUploadOpen(true)} style={primaryBtn}>
              + Upload creative
            </button>
          )}
        </div>

        {/* Row 2: type filter chips */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={chipLabelStyle}>Type</span>
          <FilterChip active={!typeFilter} onClick={() => setTypeFilter('')} count={rows.length}>All</FilterChip>
          {TYPES.map(t => (
            <FilterChip key={t} active={typeFilter === t} onClick={() => setTypeFilter(t)} count={typeCounts[t] || 0}>
              {t}
            </FilterChip>
          ))}
        </div>

        {/* Row 3: status filter chips */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={chipLabelStyle}>Status</span>
          <FilterChip active={!statusFilter} onClick={() => setStatusFilter('')} count={rows.length}>All</FilterChip>
          {STATUSES.map(s => (
            <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}
              count={statusCounts[s] || 0}
              color={STATUS_COLOR[s]}>
              {STATUS_LABEL[s]}
            </FilterChip>
          ))}
        </div>
      </div>

      {err && <ErrorBanner msg={err} />}

      {loading ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: 'grid', gap: 24 }}>
          {grouped.map(group => (
            <section key={group.type}>
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10,
              }}>
                <h3 style={{
                  margin: 0, fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500,
                  color: 'var(--ink)',
                }}>{group.type}</h3>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)',
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                }}>{group.rows.length} clip{group.rows.length === 1 ? '' : 's'}</span>
              </div>
              {view === 'tile' ? (
                <div style={{
                  display: 'grid', gap: 14,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                }}>
                  {group.rows.map(r => (
                    <CreativeCard key={r.id} row={r} onClick={() => setDrawerRow(r)} />
                  ))}
                </div>
              ) : view === 'list' ? (
                <CreativeListView
                  rows={group.rows}
                  onClick={setDrawerRow}
                  onDelete={scope.canDelete ? setConfirmDelete : null}
                />
              ) : (
                <CreativeMatrixView
                  rows={group.rows}
                  onClick={setDrawerRow}
                />
              )}
            </section>
          ))}
        </div>
      )}

      {drawerRow && (
        <CreativeDetailModal
          row={drawerRow}
          scope={scope}
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

function BigToggle({ active, onClick, label, count, subtitle }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '14px 20px', textAlign: 'left',
      cursor: 'pointer', border: 'none',
      borderRight: '1px solid var(--rule)',
      background: active ? 'var(--ink)' : 'white',
      color: active ? 'var(--paper)' : 'var(--ink)',
      transition: 'background 0.12s',
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4,
      }}>
        <span style={{
          fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500,
        }}>{label}</span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
          color: active ? 'rgba(255,255,255,0.7)' : 'var(--ink-3)',
        }}>{count}</span>
      </div>
      <div style={{
        fontFamily: 'var(--sans)', fontSize: 11.5, lineHeight: 1.35,
        color: active ? 'rgba(255,255,255,0.7)' : 'var(--ink-3)',
      }}>{subtitle}</div>
    </button>
  )
}

function FilterChip({ active, onClick, children, count, color }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '5px 11px',
      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
      letterSpacing: '0.04em', textTransform: 'uppercase',
      background: active ? 'var(--ink)' : 'white',
      color: active ? 'var(--paper)' : 'var(--ink-2)',
      border: '1px solid ' + (active ? 'var(--ink)' : 'var(--rule)'),
      borderRadius: 2, cursor: 'pointer',
    }}>
      {color && !active && (
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      )}
      <span>{children}</span>
      {count != null && (
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
          color: active ? 'rgba(255,255,255,0.6)' : 'var(--ink-4)',
        }}>{count}</span>
      )}
    </button>
  )
}

function LivePulseDot() {
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: 8, height: 8 }}>
      <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: '#3e8a5e',
      }} />
      <span style={{
        position: 'absolute', inset: -3, borderRadius: '50%',
        background: '#3e8a5e', opacity: 0.4,
        animation: 'libPulse 1.6s ease-in-out infinite',
      }} />
      <style>{`@keyframes libPulse {
        0%   { transform: scale(0.6); opacity: 0.55 }
        70%  { transform: scale(1.6); opacity: 0 }
        100% { transform: scale(1.6); opacity: 0 }
      }`}</style>
    </span>
  )
}

function StatusBadge({ status }) {
  if (status === 'live') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: '#3e8a5e',
      }}>
        <LivePulseDot /> Live
      </span>
    )
  }
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 10,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: STATUS_COLOR[status] || 'var(--ink-3)',
    }}>{STATUS_LABEL[status] || status}</span>
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
        <ListRow key={r.id} row={r} isLast={i === rows.length - 1}
          onClick={() => onClick(r)} onDelete={() => onDelete(r)} />
      ))}
    </div>
  )
}

function ListRow({ row: r, isLast, onClick, onDelete }) {
  // `onDelete` may be null when the viewer doesn't have delete permission
  const [hover, setHover] = useState(false)
  return (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '60px minmax(280px, 1.8fr) 110px 130px 90px 80px 90px 100px',
            padding: '10px 14px', gap: 12, alignItems: 'center',
            borderBottom: isLast ? 'none' : '1px solid var(--rule)',
            background: hover ? 'var(--paper-2)' : 'transparent', transition: 'background 0.12s',
            cursor: 'pointer',
          }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onClick={onClick}>
          {/* Thumb (with hover-to-play) */}
          <div style={{
            width: 56, height: 36, background: '#000',
            border: '1px solid var(--rule)', overflow: 'hidden',
            position: 'relative',
          }}>
            {r.thumbnail_url && !(hover && r.preview_url) && (
              <img src={r.thumbnail_url} alt="" loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            )}
            {hover && r.preview_url && (
              <video src={r.preview_url} autoPlay muted loop playsInline
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            )}
          </div>
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
          <div>
            <span style={{
              display: 'inline-block',
              padding: '2px 7px',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              background: typeColor(r.type).soft,
              color: typeColor(r.type).ink,
              border: '1px solid ' + typeColor(r.type).border,
              borderRadius: 2,
            }}>{r.type}</span>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.creator || '—'}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                        color: r.v21_script_id ? 'var(--ink)' : 'var(--ink-4)' }}>
            {r.v21_script_id || '—'}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>
            {r.size_mb ? `${Math.round(r.size_mb)} MB` : '—'}
          </div>
          <div><StatusBadge status={r.status} /></div>
          {/* Actions */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {onDelete && (
              <button onClick={e => { e.stopPropagation(); onDelete() }} style={{
                padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'transparent', color: '#b53e3e',
                border: '1px solid #b53e3e', cursor: 'pointer',
              }}>Delete</button>
            )}
          </div>
        </div>
  )
}

/* Matrix view — mirrors the Component Edits spreadsheet column-by-column.
   Per-stage pills (Raw / Rough Cut / Final Cut / Approved / Delivered)
   with editable values, type color coding, hover-to-preview thumbnail.
   Click any row to open the detail modal. */
function CreativeMatrixView({ rows, onClick }) {
  return (
    <div style={{ overflowX: 'auto', background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{ minWidth: 1500 }}>
        {/* Header — stage columns ARE the file links now (no separate File column) */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '140px 60px 100px minmax(220px, 1.4fr) 90px 110px 90px 80px 80px 80px 80px 80px 90px',
          gap: 10, padding: '10px 14px',
          background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
          fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
          letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
        }}>
          <div>ID</div>
          <div>Thumb</div>
          <div>Type</div>
          <div>Description</div>
          <div>Creator</div>
          <div>Editor</div>
          <div>Priority</div>
          <div style={{ textAlign: 'center' }}>Raw</div>
          <div style={{ textAlign: 'center' }}>Rough cut</div>
          <div style={{ textAlign: 'center' }}>Final cut</div>
          <div style={{ textAlign: 'center' }}>Approved</div>
          <div style={{ textAlign: 'center' }}>Delivered</div>
          <div>Status</div>
        </div>
        {rows.map((r, i) => (
          <MatrixRow key={r.id} row={r} isLast={i === rows.length - 1} onClick={() => onClick(r)} />
        ))}
      </div>
    </div>
  )
}

function MatrixRow({ row: r, isLast, onClick }) {
  const [hover, setHover] = useState(false)
  const tc = typeColor(r.type)
  // Raw is "done" if there's a drive_url (the source file)
  const rawStage = r.drive_url ? 'done' : null
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '140px 60px 100px minmax(220px, 1.4fr) 90px 110px 90px 80px 80px 80px 80px 80px 90px',
        gap: 10, padding: '8px 14px', alignItems: 'center',
        borderBottom: isLast ? 'none' : '1px solid var(--rule)',
        background: hover ? 'var(--paper-2)' : 'transparent',
        cursor: 'pointer', transition: 'background 0.12s',
        fontFamily: 'var(--mono)', fontSize: 10.5,
      }}>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={r.canonical_name || r.name}>{r.canonical_name || r.name}</div>
      <div style={{ width: 50, height: 30, overflow: 'hidden', background: '#000', border: '1px solid var(--rule)' }}>
        {r.thumbnail_url && !(hover && r.preview_url) && (
          <img src={r.thumbnail_url} alt="" loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
        {hover && r.preview_url && (
          <video src={r.preview_url} autoPlay muted loop playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
      </div>
      <div>
        <span style={{
          padding: '2px 6px',
          background: tc.soft, color: tc.ink, border: '1px solid ' + tc.border,
          fontWeight: 600, fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>{r.type}</span>
      </div>
      <div style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: 'var(--sans)', fontSize: 11.5,
      }} title={r.description || r.name}>{r.description || r.name}</div>
      <div style={{ color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.creator || '—'}</div>
      <div style={{ color: r.assigned_editor_id ? 'var(--ink)' : 'var(--ink-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {r.assigned_editor_name || '—'}
      </div>
      <div style={{ color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {r.priority?.replace(' - ', ' ') || '—'}
      </div>
      {/* Each stage cell: clickable link to the file IF a URL is set,
          falls back to status indicator otherwise. */}
      <StageLinkCell value={rawStage}              url={r.drive_url}     label="Open raw" />
      <StageLinkCell value={r.stage_rough_cut}     url={r.rough_cut_url} label="Open rough cut" />
      <StageLinkCell value={r.stage_final_cut}     url={r.final_cut_url} label="Open final cut" />
      <StageLinkCell value={r.stage_approved}      url={r.approved_url}  label="Open approved" />
      <StageLinkCell value={r.stage_delivered}     url={r.delivered_url} label="Open delivered" />
      <div><StatusBadge status={r.status} /></div>
    </div>
  )
}

/* StageLinkCell — if there's a URL for this stage, render a colored
   clickable link pill that opens the file. If status is set but URL
   isn't, fall back to the status indicator (X / In progress / Blocked /
   Skip). If neither, show '—'. */
function StageLinkCell({ value, url, label }) {
  const s = stageStyle(value)
  if (url) {
    return (
      <div style={{ textAlign: 'center' }}>
        <a href={url} target="_blank" rel="noreferrer"
          onClick={e => e.stopPropagation()}
          title={label}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 8px', textDecoration: 'none',
            background: value === 'done' ? '#3e8a5e' : '#1f4e8f',
            color: 'white',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            borderRadius: 2,
          }}>Open ↗</a>
      </div>
    )
  }
  if (!value) return <div style={{ textAlign: 'center', color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 12 }}>—</div>
  return (
    <div style={{ textAlign: 'center' }}>
      <span style={{
        display: 'inline-block', minWidth: 22, padding: '2px 6px',
        background: s.bg, color: s.color,
        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        border: value === 'skip' ? '1px solid var(--rule)' : 'none',
      }}>{s.label}</span>
    </div>
  )
}

/* Inline stage value editor — used inside CreativeDetailModal so Ben can
   set Raw / Rough cut / Final cut / Approved / Delivered per-creative. */
function StageEditor({ label, value, onChange }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        color: 'var(--ink-3)', marginBottom: 4,
      }}>{label}</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {STAGE_VALUES.map(s => {
          const active = (value || null) === s.v
          const styleProps = active
            ? { background: s.bg === 'transparent' ? 'var(--ink)' : s.bg, color: s.color === '#ccc' ? 'white' : s.color }
            : { background: 'white', color: 'var(--ink-3)' }
          return (
            <button key={String(s.v)} onClick={() => onChange(s.v)} style={{
              padding: '4px 8px',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 500,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              border: '1px solid ' + (active ? 'transparent' : 'var(--rule)'),
              borderRadius: 2, cursor: 'pointer',
              ...styleProps,
            }}>{s.label === 'X' && !active ? 'Done' : s.label === '—' ? 'Not started' : s.label}</button>
          )
        })}
      </div>
    </div>
  )
}

function StageCell({ value }) {
  const s = stageStyle(value)
  if (!value) return <div style={{ textAlign: 'center', color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 12 }}>—</div>
  return (
    <div style={{ textAlign: 'center' }}>
      <span style={{
        display: 'inline-block', minWidth: 22, padding: '2px 6px',
        background: s.bg, color: s.color,
        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        border: value === 'skip' ? '1px solid var(--rule)' : 'none',
      }}>{s.label}</span>
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

const chipLabelStyle = {
  fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
  letterSpacing: '0.12em', textTransform: 'uppercase',
  color: 'var(--ink-3)', marginRight: 6,
}

function CreativeCard({ row, onClick }) {
  const [hover, setHover] = useState(false)
  return (
    <div onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: 'pointer',
        background: 'var(--paper)',
        border: hover ? '1px solid var(--ink)' : '1px solid var(--rule)',
        transition: 'border-color 0.12s',
      }}>
      {/* Thumbnail */}
      <div style={{
        aspectRatio: '16 / 9',
        background: row.thumbnail_url
          ? '#000'   // black behind the image to hide letterbox for portrait
          : 'linear-gradient(135deg, var(--paper-2) 0%, var(--rule) 100%)',
        position: 'relative', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {row.thumbnail_url && !(hover && row.preview_url) && (
          <img src={row.thumbnail_url} alt=""
            loading="lazy"
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              display: 'block',
            }} />
        )}
        {hover && row.preview_url && (
          <video src={row.preview_url}
            autoPlay muted loop playsInline
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              display: 'block',
            }} />
        )}
        {!row.thumbnail_url && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            No thumbnail
          </span>
        )}
        {/* Type pill — top-left, color-coded per type */}
        {row.type && row.type !== 'unknown' && (() => {
          const tc = typeColor(row.type)
          return (
            <span style={{
              position: 'absolute', top: 6, left: 6,
              padding: '2px 7px',
              background: tc.ink, color: 'white',
              fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>{row.type}</span>
          )
        })()}
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
          <span style={{ marginLeft: 'auto' }}><StatusBadge status={row.status} /></span>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────── DETAIL MODAL (click row) ─────────────────────── */

function CreativeDetailModal({ row, scope = ADMIN_SCOPE, onClose, onSaved }) {
  const [edit, setEdit] = useState(row)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [editors, setEditors] = useState([])
  // When the viewer is an editor on /editor-view, auto-target them as the assignee.
  const [assignEditor, setAssignEditor] = useState(scope.isEditorView ? (scope.editorId || '') : '')
  const [assignDue, setAssignDue] = useState('')
  const [assignPriority, setAssignPriority] = useState('P2 - Medium')
  const [assignTaskType, setAssignTaskType] = useState('rough_cut')
  const [assignBusy, setAssignBusy] = useState(false)
  const [existingTasks, setExistingTasks] = useState([])

  useEffect(() => {
    let mounted = true
    supabase.from('lib_creative_editors').select('*').eq('active', true).order('name')
      .then(({ data }) => { if (mounted) setEditors(data || []) })
    supabase.from('lib_editing_queue').select('*').eq('creative_id', row.id)
      .then(({ data }) => { if (mounted) setExistingTasks(data || []) })
    return () => { mounted = false }
  }, [row.id])

  const save = async () => {
    setSaving(true); setErr(null)
    const { error } = await supabase
      .from('lib_creative_library')
      .update({
        type: edit.type, creator: edit.creator, status: edit.status,
        v21_script_id: edit.v21_script_id, notes: edit.notes,
        canonical_name: edit.canonical_name,
        description: edit.description || null,
        priority: edit.priority || null,
        assigned_editor_id: edit.assigned_editor_id || null,
        stage_rough_cut: edit.stage_rough_cut || null,
        stage_final_cut: edit.stage_final_cut || null,
        stage_approved:  edit.stage_approved || null,
        stage_delivered: edit.stage_delivered || null,
      })
      .eq('id', row.id)
    setSaving(false)
    if (error) setErr(error.message)
    else onSaved?.()
  }

  const assign = async () => {
    if (!assignEditor) return
    setAssignBusy(true); setErr(null)
    const { error } = await supabase.from('lib_editing_tasks').insert({
      creative_id: row.id,
      editor_id: assignEditor,
      due_date: assignDue || null,
      priority: assignPriority,
      task_type: assignTaskType,
      status: 'queued',
    })
    setAssignBusy(false)
    if (error) setErr(error.message)
    else {
      // Refresh existing tasks
      const { data } = await supabase.from('lib_editing_queue').select('*').eq('creative_id', row.id)
      setExistingTasks(data || [])
      // Reset form
      setAssignEditor(''); setAssignDue('')
    }
  }

  // Pick the best playback URL — self-hosted preview > drive iframe
  const playbackKind = row.preview_url ? 'video' : row.drive_url ? 'iframe' : 'none'

  return (
    <Modal open={true} onClose={onClose} size="lg"
      eyebrow={edit.canonical_name || row.type || 'Creative'}
      title={row.canonical_name || row.name}
      subtitle={row.canonical_name ? row.name : `${row.source_bucket || ''}${row.size_mb ? ' · ' + Math.round(row.size_mb) + ' MB' : ''}`}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} style={ghostBtn}>Close</button>
          {scope.canEditCreative && (
            <button onClick={save} disabled={saving} style={primaryBtn}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 16 }}>
        {/* Video preview */}
        {playbackKind === 'video' && (
          <div style={{ aspectRatio: '16 / 9', background: 'black' }}>
            <video
              src={row.preview_url}
              controls
              preload="metadata"
              poster={row.thumbnail_url || undefined}
              style={{ width: '100%', height: '100%', display: 'block' }}
            />
          </div>
        )}
        {playbackKind === 'iframe' && (
          <div style={{ aspectRatio: '16 / 9', background: 'black', position: 'relative' }}>
            <iframe src={driveEmbedUrl(row.drive_url)}
              title={row.name}
              style={{ width: '100%', height: '100%', border: 'none' }}
              allow="autoplay" />
            <div style={{
              position: 'absolute', bottom: 6, left: 6, right: 6,
              padding: '4px 8px', fontSize: 10.5, fontFamily: 'var(--mono)',
              background: 'rgba(0,0,0,0.6)', color: 'rgba(255,255,255,0.85)',
              letterSpacing: '0.05em', borderRadius: 2,
            }}>
              Drive-hosted preview · self-hosted version still processing
            </div>
          </div>
        )}
        {playbackKind === 'none' && (
          <div style={{
            aspectRatio: '16 / 9', background: 'var(--paper-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)',
          }}>
            No playback available
          </div>
        )}

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Field label="Canonical name">
            <input type="text" value={edit.canonical_name || ''}
              onChange={e => setEdit({ ...edit, canonical_name: e.target.value })}
              style={inputStyle} />
          </Field>
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
          <Field label="Original filename">
            <div style={{
              padding: '8px 11px', fontFamily: 'var(--mono)', fontSize: 11,
              background: 'var(--paper-2)', border: '1px solid var(--rule)',
              color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }} title={row.name}>{row.name}</div>
          </Field>
        </div>

        <Field label="Description (separate from canonical name)">
          <input type="text" value={edit.description || ''}
            onChange={e => setEdit({ ...edit, description: e.target.value })}
            placeholder="Short human description for the Matrix view"
            style={inputStyle} />
        </Field>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Field label="Priority">
            <select value={edit.priority || ''}
              onChange={e => setEdit({ ...edit, priority: e.target.value || null })}
              style={selectStyle}>
              <option value="">—</option>
              <option>P1 - High</option>
              <option>P2 - Medium</option>
              <option>P3 - Low</option>
            </select>
          </Field>
          <Field label="Assigned editor">
            <select value={edit.assigned_editor_id || ''}
              onChange={e => setEdit({ ...edit, assigned_editor_id: e.target.value || null })}
              style={selectStyle}>
              <option value="">— Unassigned</option>
              {editors.filter(e => e.active).map(e => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </Field>
        </div>

        {/* Production stages — mirror the Component Edits sheet columns */}
        <Field label="Production stages">
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <StageEditor label="Rough cut" value={edit.stage_rough_cut}
              onChange={v => setEdit({ ...edit, stage_rough_cut: v })} />
            <StageEditor label="Final cut" value={edit.stage_final_cut}
              onChange={v => setEdit({ ...edit, stage_final_cut: v })} />
            <StageEditor label="Approved"  value={edit.stage_approved}
              onChange={v => setEdit({ ...edit, stage_approved: v })} />
            <StageEditor label="Delivered" value={edit.stage_delivered}
              onChange={v => setEdit({ ...edit, stage_delivered: v })} />
          </div>
        </Field>

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

        {/* Existing tasks */}
        {existingTasks.length > 0 && (
          <Field label="Editing tasks">
            <div style={{ display: 'grid', gap: 6 }}>
              {existingTasks.map(t => (
                <div key={t.task_id} style={{
                  padding: '8px 12px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
                  display: 'flex', alignItems: 'center', gap: 12,
                  fontFamily: 'var(--mono)', fontSize: 11,
                }}>
                  <span style={{ fontWeight: 600 }}>{t.editor_name}</span>
                  <span style={{ color: 'var(--ink-3)' }}>{t.task_type}</span>
                  <span style={{ color: 'var(--ink-3)' }}>{t.status}</span>
                  <span style={{ marginLeft: 'auto', color: t.is_overdue ? '#b53e3e' : 'var(--ink-4)' }}>
                    {t.is_overdue ? '⚠ overdue ' : ''}{t.due_date || 'no due date'}
                  </span>
                </div>
              ))}
            </div>
          </Field>
        )}

        {/* Assign editor block — only when viewer can manage assignments */}
        {scope.canEditTask && (
        <div style={{
          padding: '14px 16px', border: '1px solid var(--rule)', background: 'var(--paper-2)',
        }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)',
            marginBottom: 10,
          }}>{scope.isEditorView ? 'Self-assign this clip' : 'Assign editor'}</div>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1.2fr 1fr 1fr 1.4fr auto' }}>
            <select value={assignEditor} onChange={e => setAssignEditor(e.target.value)} style={selectStyle}>
              <option value="">Pick editor…</option>
              {editors.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <select value={assignPriority} onChange={e => setAssignPriority(e.target.value)} style={selectStyle}>
              <option>P1 - High</option>
              <option>P2 - Medium</option>
              <option>P3 - Low</option>
            </select>
            <select value={assignTaskType} onChange={e => setAssignTaskType(e.target.value)} style={selectStyle}>
              <option value="rough_cut">Rough cut</option>
              <option value="final_cut">Final cut</option>
              <option value="patch_hook_body">Patch hook+body</option>
              <option value="revision">Revision</option>
              <option value="thumbnail">Thumbnail</option>
              <option value="other">Other</option>
            </select>
            <input type="date" value={assignDue} onChange={e => setAssignDue(e.target.value)} style={inputStyle} />
            <button onClick={assign} disabled={!assignEditor || assignBusy} style={primaryBtn}>
              {assignBusy ? 'Assigning…' : 'Assign'}
            </button>
          </div>
        </div>
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
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [progress, setProgress] = useState({})  // filename -> 'uploading'|'done'|err msg
  const inputRef = useRef(null)

  const acceptFiles = (incoming) => {
    const added = Array.from(incoming || []).filter(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name))
    if (added.length) setFiles(prev => [...prev, ...added])
  }

  const handleDrop = (e) => {
    e.preventDefault()
    acceptFiles(e.dataTransfer.files)
  }

  const submit = async () => {
    if (!files.length) return
    setBusy(true); setErr(null)
    const stamp = new Date().toISOString().slice(0,10)
    let ok = 0, fail = 0
    for (const file of files) {
      setProgress(p => ({ ...p, [file.name]: 'uploading' }))
      try {
        const path = `incoming/${Date.now()}_${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`
        // Skip the Storage upload for large files (>50MB) — they'd hit limits
        // and we don't need the temp copy. Just insert the row.
        if (file.size < 50 * 1024 * 1024) {
          const { error: upErr } = await supabase.storage
            .from('creative-thumbnails')
            .upload(path, file, { upsert: false })
          if (upErr && !upErr.message?.includes('already exists')) throw upErr
        }
        const { error: insErr } = await supabase
          .from('lib_creative_library')
          .insert({
            name: file.name,
            type: 'Full Video',
            size_mb: Math.round(file.size / 1024 / 1024 * 10) / 10,
            status: 'raw',
            source_bucket: 'Manual upload',
            notes: `Uploaded via /sales/ads/creative/library on ${stamp}. Pending Drive upload + transcribe.`,
          })
        if (insErr) throw insErr
        setProgress(p => ({ ...p, [file.name]: 'done' }))
        ok++
      } catch (e) {
        setProgress(p => ({ ...p, [file.name]: 'error: ' + (e.message || 'failed') }))
        fail++
      }
    }
    setBusy(false)
    if (fail === 0) {
      // All good — close + refresh
      setTimeout(() => onSaved?.(), 500)
    } else {
      setErr(`${ok} uploaded, ${fail} failed — see list below`)
    }
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="md"
      eyebrow="Upload"
      title={`Add ${files.length || ''} new creative${files.length === 1 ? '' : 's'}`}
      subtitle="Drop one or more video files. We add rows to the library — Drive upload + auto-transcribe runs after via the background pipeline."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={!files.length || busy} style={primaryBtn}>
            {busy ? 'Uploading…' : `Upload ${files.length || ''}`}
          </button>
        </>
      }>
      <div style={{ padding: 28 }}>
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          style={{
            padding: 32, textAlign: 'center', cursor: 'pointer',
            border: '2px dashed var(--rule)',
            background: files.length ? 'var(--paper-2)' : 'var(--paper)',
            transition: 'border-color 0.12s, background 0.12s',
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--ink)'}
          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--rule)'}>
          <input ref={inputRef} type="file" accept="video/*" multiple
            style={{ display: 'none' }}
            onChange={e => acceptFiles(e.target.files)} />
          <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink-2)', marginBottom: 4 }}>
            Drop video files here
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            or click to select (multi-select allowed)
          </div>
        </div>

        {files.length > 0 && (
          <div style={{
            marginTop: 14, border: '1px solid var(--rule)', maxHeight: 280, overflowY: 'auto',
          }}>
            {files.map((f, i) => {
              const p = progress[f.name]
              const color = p === 'done' ? '#3e8a5e' : p?.startsWith('error') ? '#b53e3e' : p === 'uploading' ? '#b86a0c' : 'var(--ink-3)'
              return (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '1fr 90px 90px 30px',
                  gap: 10, alignItems: 'center',
                  padding: '8px 12px',
                  borderBottom: i === files.length - 1 ? 'none' : '1px solid var(--rule)',
                  background: i % 2 === 0 ? 'transparent' : 'var(--paper-2)',
                }}>
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }} title={f.name}>{f.name}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>
                    {(f.size / 1024 / 1024).toFixed(1)} MB
                  </div>
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    color,
                  }}>{p || 'queued'}</div>
                  <button onClick={() => setFiles(files.filter((_, j) => j !== i))} disabled={busy} style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: 'var(--ink-4)', fontSize: 16, padding: 0,
                  }}>×</button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ─────────────────────────── EDITING QUEUE TAB ─────────────────────────── */

function EditingQueueTab({ scope = ADMIN_SCOPE }) {
  const [tasks, setTasks] = useState([])
  const [editors, setEditors] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('queue.view') || 'list' } catch { return 'list' }
  })
  useEffect(() => { try { localStorage.setItem('queue.view', view) } catch {} }, [view])
  const [addEditorOpen, setAddEditorOpen] = useState(false)
  const [addTaskOpen, setAddTaskOpen] = useState(false)
  const [manageEditorsOpen, setManageEditorsOpen] = useState(false)
  const [shareLinksOpen, setShareLinksOpen] = useState(false)
  const [editingTask, setEditingTask] = useState(null)
  const [editingEditor, setEditingEditor] = useState(null)
  // Editor multi-select for filtering. Editor-view auto-selects the
  // viewing editor on first mount so they see their own tasks by default.
  const [selectedEditors, setSelectedEditors] = useState(() => {
    if (scope.isEditorView && scope.editorId) return new Set([scope.editorId])
    return new Set()
  })

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const [t, e] = await Promise.all([
      supabase.from('lib_editing_queue').select('*'),
      supabase.from('lib_creative_editors').select('*').order('name'),
    ])
    if (t.error) setErr(t.error.message)
    else setTasks(t.data || [])
    setEditors(e.data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Filter tasks by selected editors (when set is empty, show all)
  const filteredTasks = useMemo(() => {
    if (selectedEditors.size === 0) return tasks
    return tasks.filter(t => selectedEditors.has(t.editor_id) || (t.editor_id == null && selectedEditors.has('unassigned')))
  }, [tasks, selectedEditors])

  // Group by editor (on filtered tasks)
  const byEditor = useMemo(() => {
    const m = new Map()
    for (const t of filteredTasks) {
      const key = t.editor_slug || 'unassigned'
      if (!m.has(key)) m.set(key, { editor_name: t.editor_name || 'Unassigned', tasks: [] })
      m.get(key).tasks.push(t)
    }
    return Array.from(m.entries()).map(([slug, v]) => ({ slug, ...v }))
  }, [filteredTasks])

  const overdue = filteredTasks.filter(t => t.is_overdue).length
  const inProg  = filteredTasks.filter(t => t.status === 'in_progress').length
  const queued  = filteredTasks.filter(t => t.status === 'queued').length
  const done    = filteredTasks.filter(t => t.status === 'done').length

  const toggleEditor = (id) => {
    setSelectedEditors(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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

      {/* Toolbar: actions + view toggle */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        marginBottom: 14, padding: '10px 14px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
      }}>
        {scope.canEditTask && (
          <button onClick={() => setAddTaskOpen(true)} style={primaryBtn}>+ Add task</button>
        )}
        {scope.canManageEditors && (
          <>
            <button onClick={() => setShareLinksOpen(true)} style={{ ...ghostBtn, color: '#a86a08', borderColor: '#a86a08' }}>
              ↗ Share with editor
            </button>
            <button onClick={() => setManageEditorsOpen(true)} style={ghostBtn}>Manage editors</button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
          {editors.filter(e => e.active).length} editor{editors.filter(e => e.active).length === 1 ? '' : 's'} · {filteredTasks.length} of {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'white' }}>
          <ViewBtn active={view === 'list'}     onClick={() => setView('list')}>List</ViewBtn>
          <ViewBtn active={view === 'lanes'}    onClick={() => setView('lanes')}>Editor lanes</ViewBtn>
          <ViewBtn active={view === 'timeline'} onClick={() => setView('timeline')}>Timeline</ViewBtn>
          <ViewBtn active={view === 'kanban'}   onClick={() => setView('kanban')}>Kanban</ViewBtn>
        </div>
      </div>

      {/* Editor selection bar — click a chip to FILTER tasks to that editor.
          Empty selection = show all. Hidden in editor-view mode (their
          selection is already locked to themselves). */}
      {!scope.isEditorView && (
        <EditorSelector
          editors={editors}
          selected={selectedEditors}
          onToggle={toggleEditor}
          onClearAll={() => setSelectedEditors(new Set())}
          onEditEditor={scope.canManageEditors ? (e) => setEditingEditor(e) : null}
          tasks={tasks}
        />
      )}

      {tasks.length === 0 ? (
        <div style={{
          border: '1px dashed var(--rule)', padding: 40, textAlign: 'center',
          background: 'var(--paper-2)', marginTop: 14,
        }}>
          <SectionHead level="section" eyebrow="Empty queue">No editing tasks yet</SectionHead>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-3)', marginTop: 8, marginBottom: 16 }}>
            Use <strong style={{ color: 'var(--ink)' }}>+ Add task</strong> above to assign a creative
            to one of your editors, or open any creative from the Library tab and use the "Assign editor" block at the bottom.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button onClick={() => setAddTaskOpen(true)} style={primaryBtn}>+ Add task</button>
            <button onClick={() => setAddEditorOpen(true)} style={ghostBtn}>+ Add editor</button>
          </div>
        </div>
      ) : view === 'list' ? (
        <QueueListView tasks={filteredTasks} editors={editors} onEdit={setEditingTask} />
      ) : view === 'lanes' ? (
        <div style={{ display: 'grid', gap: 18 }}>
          {byEditor.map(({ slug, editor_name, tasks: t }) => (
            <EditorLane key={slug} editor={editor_name} tasks={t} onEdit={setEditingTask} />
          ))}
        </div>
      ) : view === 'timeline' ? (
        <TimelineView tasks={filteredTasks} editors={editors.filter(e => e.active)} onEdit={setEditingTask} />
      ) : (
        <KanbanView tasks={filteredTasks} onEdit={setEditingTask} />
      )}

      {addEditorOpen && (
        <AddEditorModal
          onClose={() => setAddEditorOpen(false)}
          onSaved={() => { setAddEditorOpen(false); load() }} />
      )}
      {manageEditorsOpen && (
        <ManageEditorsModal
          editors={editors}
          tasks={tasks}
          onClose={() => setManageEditorsOpen(false)}
          onChanged={load}
          onOpenEditor={(e) => { setManageEditorsOpen(false); setEditingEditor(e) }}
        />
      )}
      {shareLinksOpen && (
        <ShareLinksModal
          editors={editors.filter(e => e.active)}
          onClose={() => setShareLinksOpen(false)}
        />
      )}
      {addTaskOpen && (
        <AddTaskModal
          editors={editors.filter(e => e.active)}
          onClose={() => setAddTaskOpen(false)}
          onSaved={() => { setAddTaskOpen(false); load() }} />
      )}
      {editingTask && (
        <EditTaskModal
          task={editingTask}
          editors={editors}
          scope={scope}
          onClose={() => setEditingTask(null)}
          onSaved={() => { setEditingTask(null); load() }}
          onDeleted={() => { setEditingTask(null); load() }} />
      )}
      {editingEditor && (
        <EditEditorModal
          editor={editingEditor}
          onClose={() => setEditingEditor(null)}
          onSaved={() => { setEditingEditor(null); load() }}
          onDeleted={() => { setEditingEditor(null); load() }} />
      )}
    </>
  )
}

/* Editor selection bar — multi-select chips that FILTER tasks to chosen editors.
   Empty selection = show all. Each chip has a small (✎) icon to open the edit modal. */
function EditorSelector({ editors, selected, onToggle, onClearAll, onEditEditor, tasks }) {
  if (!editors.length) return null
  const taskCountByEditorId = useMemo(() => {
    const m = {}
    for (const t of tasks) m[t.editor_id || 'unassigned'] = (m[t.editor_id || 'unassigned'] || 0) + 1
    return m
  }, [tasks])
  const sortedEditors = editors.filter(e => e.active)

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
      padding: '10px 14px', background: 'var(--paper)',
      border: '1px solid var(--rule)', marginBottom: 14,
    }}>
      <span style={chipLabelStyle}>Show tasks for</span>
      <button onClick={onClearAll} style={{
        padding: '5px 11px',
        fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
        letterSpacing: '0.04em', textTransform: 'uppercase',
        background: selected.size === 0 ? 'var(--ink)' : 'white',
        color: selected.size === 0 ? 'var(--paper)' : 'var(--ink-2)',
        border: '1px solid ' + (selected.size === 0 ? 'var(--ink)' : 'var(--rule)'),
        borderRadius: 2, cursor: 'pointer',
      }}>All editors</button>
      {sortedEditors.map(e => {
        const isSelected = selected.has(e.id)
        const color = editorColor(e.slug)
        const count = taskCountByEditorId[e.id] || 0
        return (
          <span key={e.id} style={{
            display: 'inline-flex', alignItems: 'stretch', borderRadius: 2,
            border: '1px solid ' + (isSelected ? color : 'var(--rule)'),
            background: isSelected ? color : 'white',
            overflow: 'hidden',
          }}>
            <button onClick={() => onToggle(e.id)} style={{
              padding: '5px 10px 5px 8px', display: 'inline-flex', alignItems: 'center', gap: 7,
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
              letterSpacing: '0.04em',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: isSelected ? 'white' : 'var(--ink-2)',
            }}>
              {!isSelected && <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />}
              <span>{e.name}</span>
              {count > 0 && (
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                  color: isSelected ? 'rgba(255,255,255,0.7)' : 'var(--ink-4)',
                }}>{count}</span>
              )}
            </button>
            <button onClick={() => onEditEditor(e)} title="Edit editor"
              style={{
                padding: '0 6px', cursor: 'pointer',
                fontSize: 11, color: isSelected ? 'rgba(255,255,255,0.8)' : 'var(--ink-4)',
                background: 'transparent', border: 'none',
                borderLeft: '1px solid ' + (isSelected ? 'rgba(255,255,255,0.25)' : 'var(--rule)'),
              }}>✎</button>
          </span>
        )
      })}
    </div>
  )
}

/* QueueListView — matrix-style task list with sortable columns + inline edit
   on click. Mirrors the Component Edits sheet pattern. */
function QueueListView({ tasks, editors, onEdit }) {
  if (!tasks.length) return null
  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '56px minmax(220px, 1.6fr) 130px 110px 110px 120px 90px 50px',
        padding: '10px 14px', gap: 12,
        background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
      }}>
        <div></div>
        <div>Creative</div>
        <div>Editor</div>
        <div>Status</div>
        <div>Task type</div>
        <div>Due</div>
        <div>Priority</div>
        <div style={{ textAlign: 'right' }}>Source</div>
      </div>
      {tasks.map((t, i) => {
        const color = editorColor(t.editor_slug || 'unassigned')
        return (
          <div key={t.task_id}
            onClick={() => onEdit(t)}
            style={{
              display: 'grid',
              gridTemplateColumns: '56px minmax(220px, 1.6fr) 130px 110px 110px 120px 90px 50px',
              padding: '10px 14px', gap: 12, alignItems: 'center',
              borderBottom: i === tasks.length - 1 ? 'none' : '1px solid var(--rule)',
              cursor: 'pointer', transition: 'background 0.12s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <div style={{
              width: 50, height: 32, overflow: 'hidden',
              background: '#000', border: '1px solid var(--rule)',
            }}>
              {t.thumbnail_url && <img src={t.thumbnail_url} alt="" loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 500, color: 'var(--ink)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{t.creative_name}</div>
              <div style={{
                fontFamily: 'var(--sans)', fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2,
              }}>{t.creative_type}{t.creative_creator ? ' · ' + t.creative_creator : ''}{t.v21_script_id ? ' · ' + t.v21_script_id : ''}</div>
            </div>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              fontFamily: 'var(--mono)', fontSize: 11,
            }}>
              {t.editor_name && <span style={{ width: 9, height: 9, borderRadius: 2, background: color, flexShrink: 0 }} />}
              <span style={{ color: t.editor_name ? 'var(--ink)' : 'var(--ink-4)' }}>{t.editor_name || 'Unassigned'}</span>
            </div>
            <div><StatusPipBadge status={t.status} isOverdue={t.is_overdue} /></div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{t.task_type || '—'}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11,
                          color: t.is_overdue ? '#b53e3e' : 'var(--ink-3)' }}>
              {t.is_overdue && '⚠ '}{t.due_date || '—'}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
              {t.priority?.replace(' - ', ' ') || '—'}
            </div>
            <div style={{ textAlign: 'right' }}>
              {t.drive_url && (
                <a href={t.drive_url} target="_blank" rel="noreferrer"
                  onClick={e => e.stopPropagation()}
                  title="Open Drive file"
                  style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', textDecoration: 'none' }}>↗</a>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatusPipBadge({ status, isOverdue }) {
  const STEPS = ['queued', 'in_progress', 'review', 'done']
  if (status === 'blocked') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        background: 'rgba(181,62,62,0.1)', color: '#b53e3e',
        border: '1px solid rgba(181,62,62,0.3)', borderRadius: 2,
      }}>Blocked</span>
    )
  }
  const idx = STEPS.indexOf(status)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ display: 'inline-flex', gap: 3 }}>
        {STEPS.map((s, i) => (
          <span key={s} style={{
            width: 7, height: 7, borderRadius: '50%',
            background: i <= idx
              ? (isOverdue ? '#b53e3e' : (s === 'done' ? '#3e8a5e' : '#3e7eba'))
              : 'var(--rule)',
          }} />
        ))}
      </span>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        color: STATUS_COLOR[status] || 'var(--ink-3)',
      }}>{STATUS_LABEL[status] || status}</span>
    </span>
  )
}

/* Click any task anywhere → opens this modal. Change editor / status /
   priority / type / due date / notes. Or delete the task. */
function EditTaskModal({ task, editors, scope = ADMIN_SCOPE, onClose, onSaved, onDeleted }) {
  const [editorId, setEditorId] = useState(task.editor_id || '')
  const [status, setStatus] = useState(task.status || 'queued')
  const [priority, setPriority] = useState(task.priority || 'P2 - Medium')
  const [taskType, setTaskType] = useState(task.task_type || 'rough_cut')
  const [due, setDue] = useState(task.due_date || '')
  const [notes, setNotes] = useState(task.notes || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [confirmDel, setConfirmDel] = useState(false)
  // Upload edited version state
  const [uploadFile, setUploadFile] = useState(null)
  const [uploadProgress, setUploadProgress] = useState(null)
  const uploadInputRef = useRef(null)

  const save = async () => {
    setBusy(true); setErr(null)
    const patch = {
      editor_id: editorId || null,
      status, priority, task_type: taskType, due_date: due || null,
      notes: notes || null,
    }
    // Auto-set started_at when moving into in_progress
    if (status === 'in_progress' && !task.started_at) patch.started_at = new Date().toISOString()
    // Auto-set completed_at when moving to done
    if (status === 'done' && !task.completed_at) patch.completed_at = new Date().toISOString()
    const { error } = await supabase.from('lib_editing_tasks').update(patch).eq('id', task.task_id)
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved?.()
  }
  const remove = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_editing_tasks').delete().eq('id', task.task_id)
    setBusy(false)
    if (error) setErr(error.message)
    else onDeleted?.()
  }

  // Upload an edited version of the SAME creative — file → creative-uploads
  // bucket → write the URL into the appropriate stage on the SOURCE creative
  // (rough_cut_url / final_cut_url / approved_url / delivered_url) based on
  // task_type, AND mark that stage as 'done'. One row per creative; the
  // matrix view's stage cells become clickable file links.
  const uploadEditedVersion = async () => {
    if (!uploadFile) return
    setBusy(true); setErr(null); setUploadProgress(0)
    try {
      const sanitized = uploadFile.name.replace(/[^A-Za-z0-9._-]+/g, '_')
      const storagePath = `edited/${Date.now()}_${sanitized}`
      const { error: upErr } = await supabase.storage
        .from('creative-uploads')
        .upload(storagePath, uploadFile, { upsert: false })
      if (upErr) throw upErr
      setUploadProgress(50)
      const publicUrl = `https://kjfaqhmllagbxjdxlopm.supabase.co/storage/v1/object/public/creative-uploads/${storagePath}`

      // Map task type → which stage URL / stage column to update on the source.
      const stageMap = {
        rough_cut: { url: 'rough_cut_url', flag: 'stage_rough_cut' },
        final_cut: { url: 'final_cut_url', flag: 'stage_final_cut' },
        thumbnail: { url: 'thumbnail_url', flag: null },
        revision:  { url: 'final_cut_url', flag: 'stage_final_cut' },
      }
      const target = stageMap[task.task_type] || { url: 'delivered_url', flag: 'stage_delivered' }
      const patch = { [target.url]: publicUrl }
      if (target.flag) patch[target.flag] = 'done'

      // Write to the SOURCE creative row (no new row created)
      const { error: pErr } = await supabase.from('lib_creative_library')
        .update(patch)
        .eq('id', task.creative_id)
      if (pErr) throw pErr
      setUploadProgress(85)

      // Auto-advance the task status to review
      await supabase.from('lib_editing_tasks')
        .update({ status: 'review', started_at: task.started_at || new Date().toISOString() })
        .eq('id', task.task_id)
      setUploadProgress(100)
      onSaved?.()
    } catch (e) {
      setErr(e.message || 'upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="lg"
      eyebrow="Edit task"
      title={task.creative_name}
      subtitle={`${task.creative_type || ''}${task.creative_creator ? ' · ' + task.creative_creator : ''}${task.v21_script_id ? ' · ' + task.v21_script_id : ''}`}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          {confirmDel ? (
            <>
              <span style={{ fontSize: 12, color: '#b53e3e', marginRight: 'auto' }}>Delete this task? It can't be undone.</span>
              <button onClick={() => setConfirmDel(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={remove} disabled={busy} style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
                {busy ? 'Deleting…' : 'Delete task'}
              </button>
            </>
          ) : (
            <>
              {scope.canDeleteTask && (
                <button onClick={() => setConfirmDel(true)} disabled={busy} style={{
                  ...ghostBtn, color: '#b53e3e', borderColor: 'rgba(181,62,62,0.4)', marginRight: 'auto',
                }}>Delete</button>
              )}
              <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
            </>
          )}
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        {/* Quick-action status row */}
        <div>
          <div style={chipLabelStyle}>Status</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {['queued', 'in_progress', 'review', 'done', 'blocked'].map(s => (
              <button key={s} onClick={() => setStatus(s)} style={{
                padding: '6px 11px',
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: status === s ? (STATUS_COLOR[s] || 'var(--ink)') : 'white',
                color: status === s ? 'white' : 'var(--ink-2)',
                border: '1px solid ' + (status === s ? (STATUS_COLOR[s] || 'var(--ink)') : 'var(--rule)'),
                borderRadius: 2, cursor: 'pointer',
              }}>{STATUS_LABEL[s] || s}</button>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Field label="Editor">
            <select value={editorId} onChange={e => setEditorId(e.target.value)} style={selectStyle}>
              <option value="">Unassigned</option>
              {editors.filter(e => e.active).map(e => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={e => setPriority(e.target.value)} style={selectStyle}>
              <option>P1 - High</option><option>P2 - Medium</option><option>P3 - Low</option>
            </select>
          </Field>
          <Field label="Task type">
            <select value={taskType} onChange={e => setTaskType(e.target.value)} style={selectStyle}>
              <option value="rough_cut">Rough cut</option>
              <option value="final_cut">Final cut</option>
              <option value="patch_hook_body">Patch hook+body</option>
              <option value="revision">Revision</option>
              <option value="thumbnail">Thumbnail</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Due date">
            <input type="date" value={due} onChange={e => setDue(e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)' }}
            placeholder="Notes on this task — feedback, blockers, links to revisions…" />
        </Field>

        {/* Upload edited version — editors drop their cut here. New library
            row is created with parent_id pointing at the source. Task auto-
            advances to 'review' so admin sees there's a new version. */}
        <div style={{
          padding: '14px 16px', border: '1px solid var(--rule)', background: 'var(--paper-2)',
        }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)',
            marginBottom: 10,
          }}>Upload edited version</div>
          <div
            onClick={() => !busy && uploadInputRef.current?.click()}
            onDrop={e => {
              e.preventDefault()
              const f = e.dataTransfer.files?.[0]
              if (f) setUploadFile(f)
            }}
            onDragOver={e => e.preventDefault()}
            style={{
              padding: 20, textAlign: 'center', cursor: busy ? 'not-allowed' : 'pointer',
              border: '2px dashed var(--rule)',
              background: uploadFile ? 'white' : 'transparent',
            }}>
            <input ref={uploadInputRef} type="file" accept="video/*"
              style={{ display: 'none' }}
              onChange={e => setUploadFile(e.target.files?.[0] || null)} />
            {uploadFile ? (
              <>
                <div style={{ fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 500 }}>{uploadFile.name}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 4 }}>
                  {(uploadFile.size / 1024 / 1024).toFixed(1)} MB · click to change
                </div>
              </>
            ) : (
              <>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)' }}>
                  Drop the edited version here
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 3 }}>
                  or click to select
                </div>
              </>
            )}
          </div>
          {uploadProgress != null && (
            <div style={{
              marginTop: 8, height: 4, background: 'var(--rule)', borderRadius: 2, overflow: 'hidden',
            }}>
              <div style={{
                width: `${uploadProgress}%`, height: '100%',
                background: uploadProgress === 100 ? '#3e8a5e' : 'var(--accent)',
                transition: 'width 0.2s',
              }} />
            </div>
          )}
          {uploadFile && (
            <button onClick={uploadEditedVersion} disabled={busy} style={{
              ...primaryBtn, marginTop: 10,
            }}>
              {busy ? `Uploading… ${uploadProgress || 0}%` : 'Upload + mark for review'}
            </button>
          )}
        </div>

        {task.drive_url && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
            Source file: <a href={task.drive_url} target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>{task.drive_url.slice(0, 80)}…</a>
          </div>
        )}
      </div>
    </Modal>
  )
}

/* Dedicated Manage Editors modal — centralized roster view + add new +
   row-level edit click-through. Replaces the inline ✎ chip pattern. */
function ManageEditorsModal({ editors, tasks, onClose, onChanged, onOpenEditor }) {
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  // Task counts per editor (active + overall)
  const counts = useMemo(() => {
    const m = {}
    for (const t of tasks) {
      const id = t.editor_id || '__unassigned'
      if (!m[id]) m[id] = { open: 0, done: 0 }
      if (t.status === 'done') m[id].done++
      else m[id].open++
    }
    return m
  }, [tasks])

  const addEditor = async () => {
    if (!newName.trim()) return
    setBusy(true); setErr(null)
    const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const { error } = await supabase.from('lib_creative_editors')
      .insert({ name: newName.trim(), slug })
    setBusy(false)
    if (error) setErr(error.message)
    else {
      setNewName('')
      onChanged?.()
    }
  }

  const toggleActive = async (e) => {
    await supabase.from('lib_creative_editors')
      .update({ active: !e.active }).eq('id', e.id)
    onChanged?.()
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="lg"
      eyebrow="Settings"
      title="Manage editors"
      subtitle="Roster of short-form editors. Add new ones, deactivate inactive ones, click any row to edit details + share links."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={primaryBtn}>Done</button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        {/* Add new editor */}
        <div style={{
          padding: '12px 14px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <span style={chipLabelStyle}>Add new</span>
          <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addEditor() }}
            placeholder="Editor name (e.g. Sarah)"
            style={{ ...inputStyle, flex: 1 }} />
          <button onClick={addEditor} disabled={!newName.trim() || busy} style={primaryBtn}>
            {busy ? '…' : '+ Add'}
          </button>
        </div>

        {/* Roster table */}
        <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '32px minmax(160px, 1fr) 90px 90px 100px 80px',
            gap: 10, padding: '10px 14px',
            background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
          }}>
            <div></div>
            <div>Name</div>
            <div style={{ textAlign: 'right' }}>Open</div>
            <div style={{ textAlign: 'right' }}>Done</div>
            <div>Active</div>
            <div></div>
          </div>
          {editors.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
              No editors yet — add one above.
            </div>
          )}
          {editors.map((e, i) => {
            const c = counts[e.id] || { open: 0, done: 0 }
            const color = editorColor(e.slug)
            return (
              <div key={e.id} onClick={() => onOpenEditor(e)} style={{
                display: 'grid',
                gridTemplateColumns: '32px minmax(160px, 1fr) 90px 90px 100px 80px',
                gap: 10, padding: '10px 14px', alignItems: 'center',
                borderBottom: i === editors.length - 1 ? 'none' : '1px solid var(--rule)',
                cursor: 'pointer', transition: 'background 0.12s',
                opacity: e.active ? 1 : 0.55,
              }}
                onMouseEnter={ev => ev.currentTarget.style.background = 'var(--paper-2)'}
                onMouseLeave={ev => ev.currentTarget.style.background = 'transparent'}>
                <span style={{ width: 18, height: 18, borderRadius: 3, background: color }} />
                <div style={{ fontFamily: 'var(--sans)', fontSize: 14, fontWeight: 500, color: 'var(--ink)' }}>
                  {e.name}
                  {!e.active && <span style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)' }}>(inactive)</span>}
                </div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>{c.open}</div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>{c.done}</div>
                <div>
                  <label onClick={ev => ev.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={e.active}
                      onChange={() => toggleActive(e)} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
                      {e.active ? 'Active' : 'Off'}
                    </span>
                  </label>
                </div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                  Edit ↗
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

/* Dedicated share-with-editor modal — opens straight from the toolbar so
   Ben doesn't have to dig through Manage Editors → click row → scroll.
   Two link types:
     1. TEAM-WIDE link (no editor_id binding) — anyone can see the whole queue
     2. Per-editor links (editor_id bound) — filtered to one editor's tasks */
function ShareLinksModal({ editors, onClose }) {
  const [links, setLinks] = useState({})   // editor_id -> link row
  const [teamLink, setTeamLink] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyEditor, setBusyEditor] = useState(null)
  const [busyTeam, setBusyTeam] = useState(false)
  const [copyOk, setCopyOk] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let mounted = true
    supabase.from('lib_editor_share_links')
      .select('*')
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!mounted) return
        if (error) {
          setErr('Migration 077 not yet applied — share links unavailable')
        } else {
          const m = {}
          let team = null
          for (const link of (data || [])) {
            if (link.editor_id) {
              if (!m[link.editor_id]) m[link.editor_id] = link
            } else if (!team) {
              team = link  // most recent team-wide link
            }
          }
          setLinks(m)
          setTeamLink(team)
        }
        setLoading(false)
      })
    return () => { mounted = false }
  }, [])

  const generateTeamLink = async () => {
    setBusyTeam(true); setErr(null)
    const arr = new Uint8Array(21)
    crypto.getRandomValues(arr)
    const token = btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const { data, error } = await supabase.from('lib_editor_share_links')
      .insert({
        token, editor_id: null,
        label: 'Team-wide link',
        created_by: 'admin',
      })
      .select()
      .single()
    setBusyTeam(false)
    if (error) setErr(error.message)
    else setTeamLink(data)
  }
  const revokeTeamLink = async () => {
    if (!teamLink) return
    setBusyTeam(true)
    await supabase.from('lib_editor_share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', teamLink.id)
    setTeamLink(null)
    setBusyTeam(false)
  }

  const generate = async (editor) => {
    setBusyEditor(editor.id); setErr(null)
    const arr = new Uint8Array(21)
    crypto.getRandomValues(arr)
    const token = btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const { data, error } = await supabase.from('lib_editor_share_links')
      .insert({
        token, editor_id: editor.id,
        label: `${editor.name}'s share link`,
        created_by: 'admin',
      })
      .select()
      .single()
    setBusyEditor(null)
    if (error) setErr(error.message)
    else setLinks({ ...links, [editor.id]: data })
  }

  const revoke = async (link) => {
    setBusyEditor(link.editor_id); setErr(null)
    await supabase.from('lib_editor_share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', link.id)
    const next = { ...links }
    delete next[link.editor_id]
    setLinks(next)
    setBusyEditor(null)
  }

  const buildUrl = (token) => `${window.location.origin}/editor-view/${token}`
  const copyLink = async (token) => {
    try {
      await navigator.clipboard.writeText(buildUrl(token))
      setCopyOk(token); setTimeout(() => setCopyOk(null), 1800)
    } catch {}
  }

  return (
    <Modal open={true} onClose={onClose} size="lg"
      eyebrow="Share"
      title="Share the editor portal"
      subtitle="One link the whole team uses, OR per-editor links. No login required for either."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} style={primaryBtn}>Done</button>
        </>
      }>
      <div style={{ padding: '20px 28px' }}>
        {loading ? (
          <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            {/* Team-wide link — the primary CTA. One link, everyone sees
                everything, can upload their own finished work, can update
                their own task status. */}
            <div style={{
              padding: '16px 18px', marginBottom: 20,
              background: '#fffaea', border: '2px solid #e8b408',
              borderRadius: 2,
            }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.14em', textTransform: 'uppercase', color: '#7a4e08',
                marginBottom: 4,
              }}>Team-wide link · recommended</div>
              <div style={{
                fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 500,
                color: 'var(--ink)', marginBottom: 12,
              }}>
                One link for the whole editing team
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center',
              }}>
                {teamLink ? (
                  <>
                    <div style={{
                      padding: '8px 12px', background: 'white', border: '1px solid var(--rule)',
                      fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={buildUrl(teamLink.token)}>{buildUrl(teamLink.token)}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => copyLink(teamLink.token)} style={{
                        padding: '8px 16px',
                        fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: copyOk === teamLink.token ? '#3e8a5e' : '#e8b408',
                        color: copyOk === teamLink.token ? 'white' : '#3a2a08',
                        border: 'none', cursor: 'pointer',
                      }}>{copyOk === teamLink.token ? '✓ Copied' : '↗ Copy link'}</button>
                      <button onClick={revokeTeamLink} disabled={busyTeam} style={{
                        padding: '8px 12px',
                        fontFamily: 'var(--mono)', fontSize: 10,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'transparent', color: '#b53e3e',
                        border: '1px solid rgba(181,62,62,0.4)', cursor: 'pointer',
                      }}>Revoke</button>
                    </div>
                  </>
                ) : (
                  <>
                    <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
                      No team-wide link yet
                    </span>
                    <button onClick={generateTeamLink} disabled={busyTeam} style={{
                      padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                      background: '#e8b408', color: '#3a2a08',
                      border: 'none', cursor: 'pointer',
                    }}>{busyTeam ? '…' : '+ Generate team link'}</button>
                  </>
                )}
              </div>
              <p style={{
                marginTop: 10, fontFamily: 'var(--serif)', fontSize: 12.5,
                color: 'var(--ink-3)', fontStyle: 'italic', lineHeight: 1.45, margin: '10px 0 0',
              }}>
                Anyone with this link sees the whole queue (all editors' tasks), the full creative
                library, and can <strong>upload finished work</strong> — even without an assigned task.
                You review + assign it from your admin view. They can't delete creatives or manage
                editors.
              </p>
            </div>

            {/* Per-editor links — secondary */}
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)',
              marginBottom: 10,
            }}>Per-editor links (optional)</div>
            {editors.length === 0 ? (
              <div style={{
                padding: 16, textAlign: 'center', border: '1px dashed var(--rule)',
                fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 12,
              }}>
                No active editors. Add one in Manage editors first.
              </div>
            ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {editors.map(e => {
              const link = links[e.id]
              const color = editorColor(e.slug)
              return (
                <div key={e.id} style={{
                  padding: '12px 14px', background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  display: 'grid', gridTemplateColumns: '180px 1fr auto', gap: 14, alignItems: 'center',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: color }} />
                    <span style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500 }}>{e.name}</span>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    {link ? (
                      <div style={{
                        padding: '6px 10px', background: 'var(--paper-2)',
                        border: '1px solid var(--rule)',
                        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={buildUrl(link.token)}>{buildUrl(link.token)}</div>
                    ) : (
                      <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 12 }}>
                        No active link yet
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {link ? (
                      <>
                        <button onClick={() => copyLink(link.token)} style={{
                          padding: '6px 12px',
                          fontFamily: 'var(--mono)', fontSize: 10.5,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          background: copyOk === link.token ? '#3e8a5e' : 'var(--ink)',
                          color: copyOk === link.token ? 'white' : 'var(--paper)',
                          border: 'none', cursor: 'pointer',
                        }}>{copyOk === link.token ? '✓ Copied' : '↗ Copy link'}</button>
                        <button onClick={() => revoke(link)}
                          disabled={busyEditor === e.id} style={{
                            padding: '6px 10px',
                            fontFamily: 'var(--mono)', fontSize: 10,
                            letterSpacing: '0.06em', textTransform: 'uppercase',
                            background: 'transparent', color: '#b53e3e',
                            border: '1px solid rgba(181,62,62,0.4)', cursor: 'pointer',
                          }}>Revoke</button>
                      </>
                    ) : (
                      <button onClick={() => generate(e)}
                        disabled={busyEditor === e.id} style={primaryBtn}>
                        {busyEditor === e.id ? '…' : 'Generate'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <p style={{
          marginTop: 14, fontFamily: 'var(--serif)', fontSize: 12.5,
          color: 'var(--ink-3)', fontStyle: 'italic', lineHeight: 1.5,
        }}>
          Per-editor links narrow the view to that editor's tasks only. Use these
          if you want a contractor to see exactly what they're working on and nothing else.
        </p>
          </>
        )}
      </div>
    </Modal>
  )
}

function EditEditorModal({ editor, onClose, onSaved, onDeleted }) {
  const [name, setName] = useState(editor.name || '')
  const [active, setActive] = useState(editor.active !== false)
  const [notes, setNotes] = useState(editor.notes || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [confirmDel, setConfirmDel] = useState(false)
  // Share links state — load existing + allow generate / revoke
  const [links, setLinks] = useState([])
  const [linksLoading, setLinksLoading] = useState(true)
  const [copyOk, setCopyOk] = useState(null)

  const [linksAvailable, setLinksAvailable] = useState(true)
  useEffect(() => {
    let mounted = true
    supabase.from('lib_editor_share_links')
      .select('*')
      .eq('editor_id', editor.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!mounted) return
        if (error) {
          // Migration 077 hasn't been applied yet — degrade gracefully
          setLinksAvailable(false)
        } else {
          setLinks(data || [])
        }
        setLinksLoading(false)
      })
    return () => { mounted = false }
  }, [editor.id])

  const generateLink = async () => {
    // Random URL-safe token, 28 chars
    const arr = new Uint8Array(21)
    crypto.getRandomValues(arr)
    const token = btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const { data, error } = await supabase.from('lib_editor_share_links')
      .insert({
        token, editor_id: editor.id,
        label: `${editor.name}'s share link`,
        created_by: 'admin',
      })
      .select()
      .single()
    if (error) setErr(error.message)
    else setLinks([data, ...links])
  }
  const revokeLink = async (id) => {
    const { error } = await supabase.from('lib_editor_share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
    if (error) setErr(error.message)
    else setLinks(links.map(l => l.id === id ? { ...l, revoked_at: new Date().toISOString() } : l))
  }
  const buildUrl = (token) =>
    `${window.location.origin}/editor-view/${token}`
  const copyLink = async (token) => {
    try {
      await navigator.clipboard.writeText(buildUrl(token))
      setCopyOk(token); setTimeout(() => setCopyOk(null), 1800)
    } catch {}
  }

  const save = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_creative_editors')
      .update({ name: name.trim(), active, notes: notes || null })
      .eq('id', editor.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved?.()
  }
  const remove = async () => {
    setBusy(true); setErr(null)
    // Soft-delete by deactivating (don't hard-delete since tasks reference this row)
    const { error } = await supabase.from('lib_creative_editors')
      .update({ active: false }).eq('id', editor.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onDeleted?.()
  }
  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="sm"
      eyebrow="Edit editor"
      title={editor.name}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          {confirmDel ? (
            <>
              <span style={{ fontSize: 12, color: '#b53e3e', marginRight: 'auto' }}>Deactivate this editor? Their existing tasks stay.</span>
              <button onClick={() => setConfirmDel(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={remove} disabled={busy} style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
                {busy ? '…' : 'Deactivate'}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setConfirmDel(true)} disabled={busy} style={{
                ...ghostBtn, color: '#b53e3e', borderColor: 'rgba(181,62,62,0.4)', marginRight: 'auto',
              }}>Deactivate</button>
              <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={save} disabled={!name.trim() || busy} style={primaryBtn}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        <Field label="Name">
          <input type="text" value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Active">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--sans)', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
            Editor is currently working on the team
          </label>
        </Field>
        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)' }}
            placeholder="Internal notes about this editor (specialty, working hours, etc.)" />
        </Field>

        {/* Share links — for giving editors a public /editor-view URL */}
        <Field label="Share link">
          {linksLoading ? (
            <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 12 }}>Loading…</div>
          ) : !linksAvailable ? (
            <div style={{
              padding: '10px 12px', background: 'rgba(184,106,12,0.08)',
              border: '1px solid rgba(184,106,12,0.3)',
              fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-2)',
            }}>
              <strong>Pending migration 077.</strong> Apply <code style={{ fontFamily: 'var(--mono)', fontSize: 11, background: 'white', padding: '1px 5px' }}>supabase/migrations/077_editor_share_links.sql</code> in Supabase Studio → SQL Editor to enable share links. Existing functionality is unaffected.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {links.filter(l => !l.revoked_at).map(l => (
                <div key={l.id} style={{
                  padding: '8px 12px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
                  display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{buildUrl(l.token)}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginTop: 2 }}>
                      Created {new Date(l.created_at).toLocaleDateString()}
                      {l.last_used_at && ` · last used ${new Date(l.last_used_at).toLocaleDateString()}`}
                    </div>
                  </div>
                  <button onClick={() => copyLink(l.token)} style={{
                    padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: copyOk === l.token ? '#3e8a5e' : 'white',
                    color: copyOk === l.token ? 'white' : 'var(--ink-2)',
                    border: '1px solid ' + (copyOk === l.token ? '#3e8a5e' : 'var(--rule)'),
                    cursor: 'pointer',
                  }}>{copyOk === l.token ? 'Copied' : 'Copy'}</button>
                  <button onClick={() => revokeLink(l.id)} style={{
                    padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: 'transparent', color: '#b53e3e',
                    border: '1px solid rgba(181,62,62,0.4)', cursor: 'pointer',
                  }}>Revoke</button>
                </div>
              ))}
              <button onClick={generateLink} style={{
                ...ghostBtn, justifySelf: 'flex-start',
              }}>+ Generate share link</button>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 11.5, color: 'var(--ink-3)', fontStyle: 'italic' }}>
                Anyone with the link can view {editor.name}'s queue + the creative library, and update
                task status. They can't delete creatives, change canonical names, or manage editors.
                Revoke to kill access.
              </div>
            </div>
          )}
        </Field>
      </div>
    </Modal>
  )
}

function AddEditorModal({ onClose, onSaved }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true); setErr(null)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const { error } = await supabase.from('lib_creative_editors').insert({ name: name.trim(), slug })
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved?.()
  }
  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="sm"
      eyebrow="New editor"
      title="Add an editor"
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={!name.trim() || busy} style={primaryBtn}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px' }}>
        <Field label="Name">
          <input type="text" autoFocus value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Sarah" style={inputStyle}
            onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        </Field>
      </div>
    </Modal>
  )
}

function AddTaskModal({ editors, onClose, onSaved }) {
  const [mode, setMode] = useState('pick')   // 'pick' or 'upload'
  const [creatives, setCreatives] = useState([])
  const [search, setSearch] = useState('')
  const [creativeId, setCreativeId] = useState('')
  // Upload-mode state
  const [uploadFile, setUploadFile] = useState(null)
  const [uploadName, setUploadName] = useState('')
  const [uploadType, setUploadType] = useState('Full Video')
  const [uploadProgress, setUploadProgress] = useState(null)
  const uploadInputRef = useRef(null)
  // Common state
  const [editorId, setEditorId] = useState('')
  const [taskType, setTaskType] = useState('rough_cut')
  const [priority, setPriority] = useState('P2 - Medium')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    supabase.from('lib_creative_library')
      .select('id,name,canonical_name,type,creator')
      .eq('exclude_from_library', false)
      .order('canonical_name', { ascending: true })
      .limit(500)
      .then(({ data }) => setCreatives(data || []))
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return creatives.slice(0, 50)
    return creatives.filter(c =>
      (c.canonical_name || c.name).toLowerCase().includes(q) ||
      (c.name || '').toLowerCase().includes(q)
    ).slice(0, 50)
  }, [creatives, search])

  const onFilePick = (file) => {
    if (!file) return
    setUploadFile(file)
    // Auto-fill name from filename (strip extension)
    if (!uploadName) setUploadName(file.name.replace(/\.[^.]+$/, ''))
  }

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      let cid = creativeId
      // Upload mode: upload file → insert lib_creative_library row → use its id
      if (mode === 'upload') {
        if (!uploadFile || !uploadName.trim()) {
          setErr('Pick a file and give it a name'); setBusy(false); return
        }
        setUploadProgress(10)
        const sanitized = uploadFile.name.replace(/[^A-Za-z0-9._-]+/g, '_')
        const storagePath = `edited/${Date.now()}_${sanitized}`
        const { error: upErr } = await supabase.storage
          .from('creative-uploads')
          .upload(storagePath, uploadFile, { upsert: false })
        if (upErr) throw upErr
        setUploadProgress(60)
        const publicUrl = `https://kjfaqhmllagbxjdxlopm.supabase.co/storage/v1/object/public/creative-uploads/${storagePath}`
        const { data: newRow, error: insErr } = await supabase.from('lib_creative_library')
          .insert({
            name: uploadName.trim() + (uploadFile.name.match(/\.[^.]+$/) || [''])[0],
            type: uploadType,
            size_mb: Math.round(uploadFile.size / 1024 / 1024 * 10) / 10,
            status: 'review',
            source_bucket: 'Editor upload (via Add task)',
            preview_url: publicUrl,
            drive_url: publicUrl,
            notes: `Uploaded ${new Date().toISOString().slice(0,10)} alongside a new task. Pending review + assignment.`,
          })
          .select()
          .single()
        if (insErr) throw insErr
        cid = newRow.id
        setUploadProgress(85)
      }
      if (!cid) { setErr('Pick a creative or upload a new file'); setBusy(false); return }

      // Insert the task (editor optional — admin assigns later if blank)
      const { error: taskErr } = await supabase.from('lib_editing_tasks').insert({
        creative_id: cid,
        editor_id: editorId || null,
        task_type: taskType, priority, due_date: due || null,
        status: editorId ? 'queued' : 'review',  // unassigned uploads land in review
      })
      if (taskErr) throw taskErr
      setUploadProgress(100)
      onSaved?.()
    } catch (e) {
      setErr(e.message || 'failed')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = mode === 'pick'
    ? !!creativeId
    : !!uploadFile && !!uploadName.trim()

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="lg"
      eyebrow="New task"
      title="Add a task"
      subtitle="Either pick an existing creative to assign, or upload your finished output and we'll create a new library row for it."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={!canSubmit || busy} style={primaryBtn}>
            {busy
              ? (mode === 'upload' ? `Uploading… ${uploadProgress || 0}%` : 'Adding…')
              : (mode === 'upload' ? 'Upload + add task' : 'Add task')}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        {/* Mode tabs */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'var(--paper-2)' }}>
          <button onClick={() => setMode('pick')} style={{
            padding: '8px 18px', flex: 1,
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            background: mode === 'pick' ? 'var(--ink)' : 'transparent',
            color: mode === 'pick' ? 'var(--paper)' : 'var(--ink-3)',
            border: 'none', cursor: 'pointer',
          }}>Pick existing</button>
          <button onClick={() => setMode('upload')} style={{
            padding: '8px 18px', flex: 1,
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            background: mode === 'upload' ? 'var(--ink)' : 'transparent',
            color: mode === 'upload' ? 'var(--paper)' : 'var(--ink-3)',
            border: 'none', cursor: 'pointer',
          }}>↗ Upload new file</button>
        </div>

        {mode === 'pick' ? (
          <Field label="Creative">
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by name…" style={{ ...inputStyle, marginBottom: 8 }} />
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--rule)' }}>
              {filtered.length === 0 && (
                <div style={{ padding: 12, fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 12 }}>
                  No matches.
                </div>
              )}
              {filtered.map(c => (
                <div key={c.id}
                  onClick={() => setCreativeId(c.id)}
                  style={{
                    padding: '8px 12px', cursor: 'pointer',
                    background: creativeId === c.id ? 'var(--accent-soft, rgba(244,225,74,0.18))' : 'transparent',
                    borderBottom: '1px solid var(--rule)',
                    fontFamily: 'var(--mono)', fontSize: 11.5,
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.canonical_name || c.name}
                  </span>
                  <span style={{ color: 'var(--ink-4)', fontSize: 10 }}>{c.type}</span>
                </div>
              ))}
            </div>
          </Field>
        ) : (
          <>
            <Field label="Upload your finished file">
              <div
                onClick={() => !busy && uploadInputRef.current?.click()}
                onDrop={e => { e.preventDefault(); onFilePick(e.dataTransfer.files?.[0]) }}
                onDragOver={e => e.preventDefault()}
                style={{
                  padding: 24, textAlign: 'center', cursor: busy ? 'not-allowed' : 'pointer',
                  border: '2px dashed var(--rule)',
                  background: uploadFile ? 'white' : 'var(--paper-2)',
                }}>
                <input ref={uploadInputRef} type="file" accept="video/*"
                  style={{ display: 'none' }}
                  onChange={e => onFilePick(e.target.files?.[0])} />
                {uploadFile ? (
                  <>
                    <div style={{ fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 500 }}>{uploadFile.name}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                      {(uploadFile.size / 1024 / 1024).toFixed(1)} MB · click to change
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)' }}>
                      Drop your finished file here
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 4 }}>
                      or click to select
                    </div>
                  </>
                )}
              </div>
              {uploadProgress != null && (
                <div style={{ marginTop: 8, height: 4, background: 'var(--rule)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    width: `${uploadProgress}%`, height: '100%',
                    background: uploadProgress === 100 ? '#3e8a5e' : 'var(--accent)',
                    transition: 'width 0.2s',
                  }} />
                </div>
              )}
            </Field>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '2fr 1fr' }}>
              <Field label="Name this creative">
                <input type="text" value={uploadName} onChange={e => setUploadName(e.target.value)}
                  placeholder="e.g. 'Eric direct call breakthrough — final cut'"
                  style={inputStyle} />
              </Field>
              <Field label="Type">
                <select value={uploadType} onChange={e => setUploadType(e.target.value)} style={selectStyle}>
                  <option>Hook</option>
                  <option>Body</option>
                  <option>Full Video</option>
                  <option>Testimony</option>
                </select>
              </Field>
            </div>
          </>
        )}

        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
          <Field label="Editor (optional)">
            <select value={editorId} onChange={e => setEditorId(e.target.value)} style={selectStyle}>
              <option value="">— Unassigned</option>
              {editors.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </Field>
          <Field label="Task type">
            <select value={taskType} onChange={e => setTaskType(e.target.value)} style={selectStyle}>
              <option value="rough_cut">Rough cut</option>
              <option value="final_cut">Final cut</option>
              <option value="patch_hook_body">Patch hook+body</option>
              <option value="revision">Revision</option>
              <option value="thumbnail">Thumbnail</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={e => setPriority(e.target.value)} style={selectStyle}>
              <option>P1 - High</option>
              <option>P2 - Medium</option>
              <option>P3 - Low</option>
            </select>
          </Field>
          <Field label="Due date">
            <input type="date" value={due} onChange={e => setDue(e.target.value)} style={inputStyle} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

/* ─────────────────────── TIMELINE (Gantt-style) ─────────────────────── */

function TimelineView({ tasks, editors, onEdit }) {
  const [range, setRange] = useState(() => {
    try { return localStorage.getItem('queue.timelineRange') || 'month' } catch { return 'month' }
  })
  useEffect(() => { try { localStorage.setItem('queue.timelineRange', range) } catch {} }, [range])
  const [offsetDays, setOffsetDays] = useState(0)

  const today = new Date(); today.setHours(0,0,0,0)
  // Range = exact intended span. Week starts today, no back-padding.
  const RANGES = {
    week:    { days: 7,   back: 0,  width: 100 },
    month:   { days: 30,  back: 3,  width: 38 },
    '90days':{ days: 90,  back: 7,  width: 16 },
    '6months':{ days: 180, back: 14, width: 9 },
  }
  const cfg = RANGES[range] || RANGES.month
  const minDate = new Date(today); minDate.setDate(today.getDate() - cfg.back + offsetDays); minDate.setHours(0,0,0,0)
  const totalDays = cfg.days
  const dayWidth = cfg.width
  const totalWidth = totalDays * dayWidth

  // Build editor rows (always show all active editors)
  const editorRows = editors.length ? editors : [{ id: 'unassigned', name: 'Unassigned', slug: 'unassigned' }]
  const tasksByEditor = new Map()
  for (const t of tasks) {
    const key = t.editor_slug || 'unassigned'
    if (!tasksByEditor.has(key)) tasksByEditor.set(key, [])
    tasksByEditor.get(key).push(t)
  }

  const dayLabel = (i) => {
    const d = new Date(minDate); d.setDate(minDate.getDate() + i)
    return d
  }
  const xForDate = (dateStr) => {
    const d = new Date(dateStr); d.setHours(0,0,0,0)
    return Math.round((d - minDate) / 86400000) * dayWidth
  }

  // Status stripe color (per task bar's left edge in the timeline)
  const STATUS_STRIPE = {
    queued: '#999', in_progress: '#e0853e',
    review: '#3e7eba', done: '#3e8a5e',
    blocked: '#b53e3e',
  }

  // Pack tasks into non-overlapping rows per editor (interval scheduling).
  // Each row gets a y-position based on which row it lands in. Row count
  // determines how tall the editor's lane needs to be.
  function packTasks(taskList) {
    const items = taskList
      .map(t => {
        const start = t.assigned_at ? new Date(t.assigned_at) : null
        const end = t.completed_at ? new Date(t.completed_at) : (t.due_date ? new Date(t.due_date) : new Date())
        if (!start) return null
        return { task: t, start: start.getTime(), end: end.getTime() }
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start)
    const rows = []  // each entry = end-of-last-task in that row
    const placed = []  // [{ task, rowIdx, start, end }]
    for (const it of items) {
      let rowIdx = rows.findIndex(endTs => endTs <= it.start)
      if (rowIdx === -1) { rows.push(it.end); rowIdx = rows.length - 1 }
      else { rows[rowIdx] = it.end }
      placed.push({ ...it, rowIdx })
    }
    return { placed, rowCount: rows.length || 1 }
  }

  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      {/* Range controls */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 14px', borderBottom: '1px solid var(--rule)',
        background: 'var(--paper-2)',
      }}>
        <span style={chipLabelStyle}>Zoom</span>
        <FilterChip active={range === 'week'}    onClick={() => { setRange('week'); setOffsetDays(0) }}>Week</FilterChip>
        <FilterChip active={range === 'month'}   onClick={() => { setRange('month'); setOffsetDays(0) }}>Month</FilterChip>
        <FilterChip active={range === '90days'}  onClick={() => { setRange('90days'); setOffsetDays(0) }}>90 days</FilterChip>
        <FilterChip active={range === '6months'} onClick={() => { setRange('6months'); setOffsetDays(0) }}>6 months</FilterChip>
        <span style={{ flex: 1 }} />
        <button onClick={() => setOffsetDays(o => o - (range === 'week' ? 7 : range === 'month' ? 14 : 30))} style={ghostBtn}>← Back</button>
        <button onClick={() => setOffsetDays(0)} style={ghostBtn}>Today</button>
        <button onClick={() => setOffsetDays(o => o + (range === 'week' ? 7 : range === 'month' ? 14 : 30))} style={ghostBtn}>Forward →</button>
      </div>

      <div style={{ overflow: 'auto' }}>
      <div style={{ minWidth: totalWidth + 200 }}>
        {/* Date header */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--rule)', background: 'var(--paper-2)' }}>
          <div style={{ width: 200, padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
                        borderRight: '1px solid var(--rule)' }}>Editor</div>
          <div style={{ display: 'flex', flex: 1, position: 'relative' }}>
            {Array.from({ length: totalDays }, (_, i) => {
              const d = dayLabel(i)
              const isToday = d.getTime() === today.getTime()
              const dow = d.getDay()
              const weekend = dow === 0 || dow === 6
              return (
                <div key={i} style={{
                  width: dayWidth, padding: '6px 4px', textAlign: 'center',
                  fontFamily: 'var(--mono)', fontSize: 9.5,
                  color: isToday ? 'var(--ink)' : 'var(--ink-3)',
                  background: isToday ? 'rgba(244,225,74,0.25)' : weekend ? 'var(--paper-2)' : 'transparent',
                  borderRight: '1px solid var(--rule)',
                  fontWeight: isToday ? 600 : 400,
                }}>
                  <div>{d.toLocaleString('en', { weekday: 'short' }).slice(0,2)}</div>
                  <div style={{ fontSize: 11, marginTop: 2 }}>{d.getDate()}</div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Rows */}
        {editorRows.map(editor => {
          const editorTasks = tasksByEditor.get(editor.slug) || []
          const color = editorColor(editor.slug)
          const { placed, rowCount } = packTasks(editorTasks)
          const BAR_HEIGHT = 22
          const ROW_GAP = 6
          const PADDING = 10
          const laneHeight = Math.max(72, PADDING * 2 + rowCount * (BAR_HEIGHT + ROW_GAP) - ROW_GAP)
          return (
            <div key={editor.id} style={{ display: 'flex', borderBottom: '1px solid var(--rule)', minHeight: laneHeight }}>
              <div style={{ width: 200, padding: '12px 14px',
                            borderRight: '1px solid var(--rule)', flexShrink: 0,
                            background: 'var(--paper-2)',
                            borderLeft: `4px solid ${color}`,
                          }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500 }}>{editor.name}</span>
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', marginTop: 4 }}>
                  {editorTasks.length} task{editorTasks.length === 1 ? '' : 's'}
                </div>
              </div>
              <div style={{ position: 'relative', flex: 1, width: totalWidth, height: laneHeight }}>
                {/* Day grid lines */}
                {Array.from({ length: totalDays }, (_, i) => {
                  const d = dayLabel(i); const dow = d.getDay()
                  return (
                    <div key={i} style={{
                      position: 'absolute', left: i * dayWidth, top: 0, bottom: 0,
                      width: dayWidth, borderRight: '1px solid var(--rule)',
                      background: dow === 0 || dow === 6 ? 'var(--paper-2)' : 'transparent',
                    }} />
                  )
                })}
                {/* Today line */}
                <div style={{
                  position: 'absolute', left: xForDate(today.toISOString()),
                  top: 0, bottom: 0, width: 2, background: 'var(--accent)', zIndex: 2,
                }} />
                {/* Packed task bars */}
                {placed.map(({ task: t, rowIdx, start }) => {
                  const startStr = new Date(start).toISOString()
                  const endTs = t.completed_at ? new Date(t.completed_at).getTime() : (t.due_date ? new Date(t.due_date).getTime() : Date.now())
                  const x = xForDate(startStr)
                  const w = Math.max(dayWidth - 2, xForDate(new Date(endTs).toISOString()) - x + dayWidth - 2)
                  const y = PADDING + rowIdx * (BAR_HEIGHT + ROW_GAP)
                  const stripe = t.is_overdue ? '#b53e3e' : (STATUS_STRIPE[t.status] || '#999')
                  return (
                    <div key={t.task_id}
                      onClick={() => onEdit?.(t)}
                      title={`${t.creative_name} · ${t.status}${t.due_date ? ' · due ' + t.due_date : ''}${t.is_overdue ? ' · OVERDUE' : ''}`}
                      style={{
                        position: 'absolute', left: x + 2, top: y,
                        width: w, height: BAR_HEIGHT,
                        background: color,
                        borderLeft: `4px solid ${stripe}`,
                        borderRadius: 2,
                        paddingLeft: 8, paddingRight: 6,
                        display: 'flex', alignItems: 'center', gap: 6,
                        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
                        color: 'white',
                        overflow: 'hidden', cursor: onEdit ? 'pointer' : 'default', zIndex: 1,
                        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
                      }}>
                      <span style={{
                        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{t.creative_name}</span>
                      {t.is_overdue && (
                        <span style={{
                          fontSize: 9, padding: '1px 4px',
                          background: 'rgba(255,255,255,0.25)', borderRadius: 2,
                          textTransform: 'uppercase', letterSpacing: '0.06em',
                        }}>OVD</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      </div>
    </div>
  )
}

/* ─────────────────────────── KANBAN view ─────────────────────────── */

function KanbanView({ tasks, onEdit }) {
  const cols = ['queued', 'in_progress', 'review', 'blocked', 'done']
  const colLabels = {
    queued: 'Queued', in_progress: 'In progress', review: 'Review',
    blocked: 'Blocked', done: 'Done',
  }
  const byCol = Object.fromEntries(cols.map(c => [c, tasks.filter(t => t.status === c)]))
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${cols.length}, 1fr)`,
      gap: 10, alignItems: 'flex-start',
    }}>
      {cols.map(c => (
        <div key={c} style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
          <div style={{
            padding: '10px 14px', background: 'var(--paper-2)',
            borderBottom: '1px solid var(--rule)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                          letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              {colLabels[c]}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>{byCol[c].length}</div>
          </div>
          <div style={{ padding: 8, display: 'grid', gap: 8 }}>
            {byCol[c].map(t => <QueueCard key={t.task_id} task={t} onClick={() => onEdit?.(t)} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function EditorLane({ editor, tasks, onEdit }) {
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
        {tasks.map(t => <QueueCard key={t.task_id} task={t} onClick={() => onEdit?.(t)} />)}
      </div>
    </div>
  )
}

function QueueCard({ task, onClick }) {
  const statusColor = {
    queued: 'var(--ink-3)',
    in_progress: '#b86a0c',
    review: '#3e7eba',
    done: '#3e8a5e',
    blocked: '#b53e3e',
  }[task.status] || 'var(--ink-3)'

  return (
    <div onClick={onClick} style={{
      background: 'white', border: '1px solid var(--rule)',
      borderLeft: `3px solid ${statusColor}`,
      padding: '10px 12px',
      cursor: onClick ? 'pointer' : 'default',
      transition: 'background 0.12s',
    }}
    onMouseEnter={e => onClick && (e.currentTarget.style.background = 'var(--paper-2)')}
    onMouseLeave={e => onClick && (e.currentTarget.style.background = 'white')}>
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
