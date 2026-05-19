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
    // Raw/Edited top-level toggle — raw=just status='raw', edited=everything else, all=both
    if (rawEditedFilter === 'raw')         list = list.filter(r => r.status === 'raw')
    else if (rawEditedFilter === 'edited') list = list.filter(r => r.status !== 'raw')
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
      {/* Big Raw vs Edited toggle — sits above the toolbar so it's the
          first decision when you land on the page */}
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
            <ViewBtn active={view === 'tile'} onClick={() => setView('tile')}>Tiles</ViewBtn>
            <ViewBtn active={view === 'list'} onClick={() => setView('list')}>List</ViewBtn>
          </div>
          <button onClick={() => setUploadOpen(true)} style={primaryBtn}>
            + Upload creative
          </button>
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
              ) : (
                <CreativeListView
                  rows={group.rows}
                  onClick={setDrawerRow}
                  onDelete={setConfirmDelete}
                />
              )}
            </section>
          ))}
        </div>
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
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.type}</div>
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
            <button onClick={e => { e.stopPropagation(); onDelete() }} style={{
              padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 10,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              background: 'transparent', color: '#b53e3e',
              border: '1px solid #b53e3e', cursor: 'pointer',
            }}>Delete</button>
          </div>
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
          <span style={{ marginLeft: 'auto' }}><StatusBadge status={row.status} /></span>
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
  const [editors, setEditors] = useState([])
  const [assignEditor, setAssignEditor] = useState('')
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
          <button onClick={save} disabled={saving} style={primaryBtn}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
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

        {/* Assign editor block */}
        <div style={{
          padding: '14px 16px', border: '1px solid var(--rule)', background: 'var(--paper-2)',
        }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)',
            marginBottom: 10,
          }}>Assign editor</div>
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

function EditingQueueTab() {
  const [tasks, setTasks] = useState([])
  const [editors, setEditors] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('queue.view') || 'lanes' } catch { return 'lanes' }
  })
  useEffect(() => { try { localStorage.setItem('queue.view', view) } catch {} }, [view])
  const [addEditorOpen, setAddEditorOpen] = useState(false)
  const [addTaskOpen, setAddTaskOpen] = useState(false)

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

      {/* Toolbar: actions + view toggle */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        marginBottom: 14, padding: '10px 14px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
      }}>
        <button onClick={() => setAddTaskOpen(true)} style={primaryBtn}>+ Add task</button>
        <button onClick={() => setAddEditorOpen(true)} style={ghostBtn}>+ Add editor</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
          {editors.filter(e => e.active).length} editor{editors.filter(e => e.active).length === 1 ? '' : 's'} · {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'white' }}>
          <ViewBtn active={view === 'lanes'}    onClick={() => setView('lanes')}>Editor lanes</ViewBtn>
          <ViewBtn active={view === 'timeline'} onClick={() => setView('timeline')}>Timeline</ViewBtn>
          <ViewBtn active={view === 'kanban'}   onClick={() => setView('kanban')}>Kanban</ViewBtn>
        </div>
      </div>

      {/* Editor roster (always shown so Ben can see who's on the team) */}
      <EditorRoster editors={editors} onToggleActive={async (e) => {
        await supabase.from('lib_creative_editors')
          .update({ active: !e.active }).eq('id', e.id)
        load()
      }} />

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
      ) : view === 'lanes' ? (
        <div style={{ display: 'grid', gap: 18 }}>
          {byEditor.map(({ slug, editor_name, tasks: t }) => (
            <EditorLane key={slug} editor={editor_name} tasks={t} />
          ))}
        </div>
      ) : view === 'timeline' ? (
        <TimelineView tasks={tasks} editors={editors} />
      ) : (
        <KanbanView tasks={tasks} />
      )}

      {addEditorOpen && (
        <AddEditorModal
          onClose={() => setAddEditorOpen(false)}
          onSaved={() => { setAddEditorOpen(false); load() }} />
      )}
      {addTaskOpen && (
        <AddTaskModal
          editors={editors.filter(e => e.active)}
          onClose={() => setAddTaskOpen(false)}
          onSaved={() => { setAddTaskOpen(false); load() }} />
      )}
    </>
  )
}

function EditorRoster({ editors, onToggleActive }) {
  if (!editors.length) return null
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 8,
      padding: '10px 14px', background: 'var(--paper)',
      border: '1px solid var(--rule)', marginBottom: 14,
    }}>
      <span style={chipLabelStyle}>Editors</span>
      {editors.map(e => (
        <span key={e.id} title={e.active ? 'Click to deactivate' : 'Click to reactivate'}
          onClick={() => onToggleActive(e)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', cursor: 'pointer',
            fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
            letterSpacing: '0.04em',
            background: e.active ? 'white' : 'var(--paper-2)',
            color: e.active ? 'var(--ink)' : 'var(--ink-4)',
            border: '1px solid var(--rule)',
            textDecoration: e.active ? 'none' : 'line-through',
          }}>
          {e.name}
        </span>
      ))}
    </div>
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
  const [creatives, setCreatives] = useState([])
  const [search, setSearch] = useState('')
  const [creativeId, setCreativeId] = useState('')
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

  const submit = async () => {
    if (!creativeId || !editorId) return
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_editing_tasks').insert({
      creative_id: creativeId, editor_id: editorId,
      task_type: taskType, priority, due_date: due || null,
      status: 'queued',
    })
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved?.()
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="lg"
      eyebrow="New task"
      title="Assign creative to an editor"
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={!creativeId || !editorId || busy} style={primaryBtn}>
            {busy ? 'Adding…' : 'Add task'}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
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

        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
          <Field label="Editor">
            <select value={editorId} onChange={e => setEditorId(e.target.value)} style={selectStyle}>
              <option value="">Pick…</option>
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

function TimelineView({ tasks, editors }) {
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

  // Distinct color per editor (stable hash of slug). Status becomes a
  // 4px left stripe on each bar instead of bar fill.
  const EDITOR_COLORS = [
    '#3e7eba', '#e0853e', '#5fa55a', '#a05fa5', '#c44b6e',
    '#3eb2a8', '#b8893e', '#7e3eb8', '#5b8a3e', '#b83e3e',
  ]
  function editorColor(slug) {
    let h = 0
    for (let i = 0; i < (slug || '').length; i++) h = ((h << 5) - h + slug.charCodeAt(i)) | 0
    return EDITOR_COLORS[Math.abs(h) % EDITOR_COLORS.length]
  }
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
                        overflow: 'hidden', cursor: 'default', zIndex: 1,
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

function KanbanView({ tasks }) {
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
            {byCol[c].map(t => <QueueCard key={t.task_id} task={t} />)}
          </div>
        </div>
      ))}
    </div>
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
