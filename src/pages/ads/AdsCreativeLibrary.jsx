import { useEffect, useMemo, useState, useCallback, useRef, memo } from 'react'
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

const TYPES = ['Hook', 'Body', 'Full Video', 'Joined', 'Testimony', 'Retargeting']
const STATUSES = ['raw', 'edited']
const STATUS_LABEL = {
  raw: 'Raw',
  edited: 'Edited',
}
const STATUS_COLOR = {
  raw: '#b53e3e',      // red — needs attention / not yet edited
  edited: '#3e8a5e',   // green — done
}

// Known offer slugs surface as filter chips + pill colors. Source of truth
// is the `offers` table — we fetch the live list and merge with these
// colors. Anything unrecognised falls back to a neutral grey pill.
const OFFER_COLOR = {
  'opt-restoration':        { ink: '#1f4e8f', soft: 'rgba(31,78,143,0.10)',  border: 'rgba(31,78,143,0.35)' },
  'opt-roofing-stub':       { ink: '#a05810', soft: 'rgba(160,88,16,0.10)',  border: 'rgba(160,88,16,0.35)' },
  'opt-whitelabel-template':{ ink: '#7a3aa8', soft: 'rgba(122,58,168,0.10)', border: 'rgba(122,58,168,0.35)' },
}
function offerColor(slug) {
  return OFFER_COLOR[slug] || { ink: 'var(--ink-3)', soft: 'var(--paper-2)', border: 'var(--rule)' }
}

// Distinct color per type — helps you scan a busy Matrix view and immediately
// see hooks vs bodies vs joined videos vs testimonials.
const TYPE_COLOR = {
  'Hook':       { ink: '#1f4e8f', soft: 'rgba(31,78,143,0.10)',  border: 'rgba(31,78,143,0.35)' },
  'Body':       { ink: '#a05810', soft: 'rgba(160,88,16,0.10)',  border: 'rgba(160,88,16,0.35)' },
  // Full Video = a whole script delivered as one raw clip (no edit needed)
  'Full Video': { ink: '#2e6e3f', soft: 'rgba(46,110,63,0.10)',  border: 'rgba(46,110,63,0.35)' },
  // Joined = a merged hook+body (post-edit composite)
  'Joined':     { ink: '#b86a0c', soft: 'rgba(184,106,12,0.10)', border: 'rgba(184,106,12,0.35)' },
  'Testimony':  { ink: '#7a3aa8', soft: 'rgba(122,58,168,0.10)', border: 'rgba(122,58,168,0.35)' },
  // Retargeting = a clip aimed at warm/lukewarm audiences (e.g. HAMMER recall content)
  'Retargeting':{ ink: '#c44b6e', soft: 'rgba(196,75,110,0.10)', border: 'rgba(196,75,110,0.35)' },
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
function editorColor(slugOrEditor) {
  // Accept either a slug string OR an editor object. When given an editor
  // object with a `color` set, use that — lets operators override the
  // hash-derived color via the Manage Editors UI. Falls back to slug-hash
  // otherwise (stable across renders for the same slug).
  if (slugOrEditor && typeof slugOrEditor === 'object') {
    if (slugOrEditor.color) return slugOrEditor.color
    return editorColor(slugOrEditor.slug || '')
  }
  const slug = slugOrEditor
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
    <div style={{ padding: '12px 0 60px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10, flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
          letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)',
        }}>
          {scope.isEditorView ? 'Editor portal · ' : ''}{tab === 'library' ? 'Library' : 'Editing queue'}
        </div>
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
  // All filters are Sets to support multi-select. Empty set = no filter applied.
  const [typeFilter, setTypeFilter]   = useState(() => new Set())
  const [offerFilter, setOfferFilter] = useState(() => new Set())  // values: offer_slug | '__none__'
  const [runFilter, setRunFilter]     = useState(() => new Set())  // values: 'yes' | 'no'
  const [stageFilter, setStageFilter] = useState(() => new Set())  // values: 'raw_unused' | 'raw_used' | 'edited_seg' | 'merged'
  const [latestOnly, setLatestOnly] = useState(false)  // when true, hide non-latest versions
  // Column sort for the Matrix view. sortKey = '' means default order
  // (insertion / added_at desc). Clicking a header sets the key; clicking
  // the same key again toggles direction.
  const [sortKey, setSortKey] = useState('')
  const [sortDir, setSortDir] = useState('asc')   // 'asc' | 'desc'
  const [drawerRow, setDrawerRow] = useState(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('lib.view') || 'list' } catch { return 'list' }
  })
  useEffect(() => { try { localStorage.setItem('lib.view', view) } catch {} }, [view])
  const [confirmDelete, setConfirmDelete] = useState(null)
  // Bulk selection — set of row IDs. When non-empty, shows the bulk
  // action bar above the grid. Clicking a tile's checkbox toggles
  // membership; clicking the body (outside checkbox) still opens
  // the detail drawer as normal.
  const [selected, setSelected] = useState(() => new Set())
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  // Editors + offers for inline dropdowns in the Matrix view. Loaded once
  // alongside the main rows fetch — not chained, so we don't add latency.
  const [editors, setEditors] = useState([])
  const [offers, setOffers] = useState([])
  // Distinct creators derived from current rows — used for the Creator
  // dropdown in matrix + detail modal. Recomputed when rows change so a
  // newly-added creator immediately appears in the picker.
  const knownCreators = useMemo(() => {
    const set = new Set()
    for (const r of rows) if (r.creator) set.add(r.creator)
    return Array.from(set).sort()
  }, [rows])

  const toggleSelect = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearSelection = useCallback(() => setSelected(new Set()), [])
  // Stable reference for the row-click handler — MatrixRow uses React.memo
  // so passing a fresh inline lambda each render would defeat the memo.
  const openDrawer = useCallback((row) => setDrawerRow(row), [])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const [rowsRes, edRes, ofRes] = await Promise.all([
      supabase.from('lib_creative_library')
        .select('*, assigned_editor:assigned_editor_id (id, name)')
        .eq('exclude_from_library', false)
        .order('added_at', { ascending: false }),
      supabase.from('lib_creative_editors').select('*').eq('active', true).order('name'),
      supabase.from('offers').select('slug,name').eq('retired', false).order('slug'),
    ])
    if (rowsRes.error) setErr(rowsRes.error.message)
    else {
      setRows((rowsRes.data || []).map(r => ({
        ...r,
        assigned_editor_name: r.assigned_editor?.name || null,
      })))
    }
    setEditors(edRes.data || [])
    setOffers(ofRes.data || [])
    setLoading(false)
  }, [])

  // Inline patch — used by the Matrix view when an inline dropdown changes.
  // Optimistic: capture the pre-update snapshot inside the setRows updater
  // so concurrent calls (e.g. user blurs description, then editor select
  // fires before the first patch resolves) each get a fresh `prev` from
  // current state — no stale-closure clobbering.
  const patchRow = useCallback(async (id, patch) => {
    let prevRow = null
    setRows(curr => {
      const idx = curr.findIndex(r => r.id === id)
      if (idx < 0) return curr
      prevRow = curr[idx]
      const next = { ...prevRow, ...patch }
      if ('assigned_editor_id' in patch) {
        const ed = editors.find(e => e.id === patch.assigned_editor_id)
        next.assigned_editor_name = ed?.name || null
      }
      const out = curr.slice()
      out[idx] = next
      return out
    })
    if (!prevRow) return
    const { error } = await supabase.from('lib_creative_library').update(patch).eq('id', id)
    if (error) {
      // Roll back ONLY this row's columns — preserve any other patches that
      // landed between the optimistic update and now.
      const rollbackKeys = Object.keys(patch)
      setRows(curr => curr.map(r => {
        if (r.id !== id) return r
        const restored = { ...r }
        for (const k of rollbackKeys) restored[k] = prevRow[k]
        if ('assigned_editor_id' in patch) restored.assigned_editor_name = prevRow.assigned_editor_name
        return restored
      }))
      setErr(error.message)
    }
  }, [editors])

  useEffect(() => { load() }, [load])

  // Compute which raw rows have already been edited (incorporated into
  // an edited composite).
  //
  // Type-based rule from Ben (2026-05-20):
  //   - Raw Hook   -> always treated as already edited
  //   - Raw Body   -> always treated as NOT yet edited
  //   - Other raw types -> transcript-overlap heuristic (10-word phrase
  //     from raw appears verbatim in any edited row's transcript)
  //
  // The type rule reflects Ben's actual workflow: all his hook raws have
  // been merged into Joined composites already, and bodies are his
  // current editing queue. The heuristic covers Testimony / Full Video
  // raws that fall between those buckets.
  const usedRawIds = useMemo(() => {
    const used = new Set()
    // Type-based fast path
    for (const r of rows) {
      if (r.status !== 'raw') continue
      if (r.type === 'Hook') { used.add(r.id); continue }
      // Body is explicitly the editing queue — never auto-mark as edited
      // even if transcript happens to overlap.
    }
    // Transcript-overlap heuristic for non-Hook / non-Body raws
    const editedTexts = rows
      .filter(r => r.status === 'edited')
      .map(e => (e.transcript || '').toLowerCase())
    if (editedTexts.length === 0) return used
    for (const r of rows) {
      if (r.status !== 'raw') continue
      if (r.type === 'Hook' || r.type === 'Body') continue
      if (used.has(r.id)) continue
      const t = (r.transcript || '').toLowerCase().replace(/\s+/g, ' ').trim()
      if (t.length < 60) continue
      const words = t.split(' ')
      if (words.length < 10) continue
      let matched = false
      for (let i = 0; i <= words.length - 10 && !matched; i += 5) {
        const phrase = words.slice(i, i + 10).join(' ')
        for (const eT of editedTexts) {
          if (eT.length >= phrase.length && eT.includes(phrase)) {
            matched = true; break
          }
        }
      }
      if (matched) used.add(r.id)
    }
    return used
  }, [rows])

  const filtered = useMemo(() => {
    let list = rows
    const search = q.trim().toLowerCase()
    if (search) list = list.filter(r => {
      const blob = `${r.name} ${r.canonical_name || ''} ${r.description || ''} ${r.creator || ''} ${r.v21_script_id || ''} ${r.notes || ''} ${r.transcript || ''}`.toLowerCase()
      return blob.includes(search)
    })
    // Multi-select filters: empty Set = no filter; otherwise OR within
    // a group (any-match) and AND across groups (intersection).
    if (typeFilter.size > 0) list = list.filter(r => typeFilter.has(r.type))
    if (offerFilter.size > 0) list = list.filter(r => {
      if (offerFilter.has('__none__') && !r.offer_slug) return true
      return r.offer_slug && offerFilter.has(r.offer_slug)
    })
    if (runFilter.size > 0) list = list.filter(r => {
      if (runFilter.has('yes') && r.has_been_run) return true
      if (runFilter.has('no') && !r.has_been_run) return true
      return false
    })
    if (stageFilter.size > 0) {
      list = list.filter(r => {
        if (stageFilter.has('raw_used') && r.status === 'raw' && usedRawIds.has(r.id)) return true
        if (stageFilter.has('raw_unused') && r.status === 'raw' && !usedRawIds.has(r.id)) return true
        if (stageFilter.has('edited_seg') && r.status === 'edited') return true
        return false
      })
    }
    if (latestOnly) {
      // For each root (parent_id || id), keep only the row with the
      // highest version_number. Roots without children just stay.
      const latestByRoot = new Map()
      for (const r of rows) {
        const rootId = r.parent_id || r.id
        const v = r.version_number || 1
        const cur = latestByRoot.get(rootId)
        if (!cur || v > (cur.version_number || 1)) latestByRoot.set(rootId, r)
      }
      const keepIds = new Set(Array.from(latestByRoot.values()).map(r => r.id))
      list = list.filter(r => keepIds.has(r.id))
    }
    // Column sort (Matrix view) — applied last so it works on the filtered list
    if (sortKey) {
      const dir = sortDir === 'desc' ? -1 : 1
      const valueOf = (r) => {
        switch (sortKey) {
          case 'id':       return (r.canonical_name || r.name || '').toLowerCase()
          case 'desc':     return (r.description || r.name || '').toLowerCase()
          case 'type':     return (r.type || '').toLowerCase()
          case 'creator':  return (r.creator || '').toLowerCase()
          case 'editor':   return (r.assigned_editor_name || '').toLowerCase()
          case 'offer':    return (r.offer_slug || '').toLowerCase()
          case 'run':      return r.has_been_run ? 1 : 0
          case 'status':   return (r.status || '').toLowerCase()
          default:         return 0
        }
      }
      list = [...list].sort((a, b) => {
        const va = valueOf(a), vb = valueOf(b)
        if (va < vb) return -1 * dir
        if (va > vb) return 1 * dir
        return 0
      })
    }
    return list
  }, [rows, q, typeFilter, offerFilter, runFilter, stageFilter, latestOnly, sortKey, sortDir, usedRawIds])

  // Header click handler — passed down to the Matrix header row.
  // First click on a column: asc. Second click: desc. Third click: clear.
  const handleSort = useCallback((key) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc')
      else { setSortKey(''); setSortDir('asc') }   // third click clears
    } else {
      setSortKey(key); setSortDir('asc')
    }
  }, [sortKey, sortDir])

  // Per-type counts for the chip badges (over ALL rows, ignoring current type filter)
  const typeCounts = useMemo(() => {
    const m = {}
    for (const r of rows) m[r.type] = (m[r.type] || 0) + 1
    return m
  }, [rows])

  const offerCounts = useMemo(() => {
    const m = { __none__: 0 }
    for (const r of rows) {
      if (r.offer_slug) m[r.offer_slug] = (m[r.offer_slug] || 0) + 1
      else m.__none__ += 1
    }
    return m
  }, [rows])

  const runCount    = useMemo(() => rows.filter(r => r.has_been_run).length, [rows])
  const notRunCount = useMemo(() => rows.filter(r => !r.has_been_run).length, [rows])
  // Stable reference for MatrixRow's editor dropdown — same memo concern
  // as openDrawer: avoid re-creating this array each render.
  const activeEditors = useMemo(() => editors.filter(e => e.active), [editors])
  // Status counts. 'Edited' includes Joined (since Joined is a sub-state of
  // edited). 'Merged' is a narrower filter showing only Joined.
  const stageCounts = useMemo(() => ({
    raw_used:   rows.filter(r => r.status === 'raw' && usedRawIds.has(r.id)).length,
    raw_unused: rows.filter(r => r.status === 'raw' && !usedRawIds.has(r.id)).length,
    edited_seg: rows.filter(r => r.status === 'edited').length,
  }), [rows, usedRawIds])

  // Section groups for the list view — used when no type filter, shows
  // Hooks/Bodies/Joined/Testimony as separate sections. With multi-select
  // type filter, still group by type so each selected type gets its own
  // section.
  const grouped = useMemo(() => {
    const order = ['Hook', 'Body', 'Full Video', 'Joined', 'Testimony', 'Retargeting']
    return order
      .map(t => ({ type: t, rows: filtered.filter(r => r.type === t) }))
      .filter(g => g.rows.length > 0)
  }, [filtered])

  return (
    <>
      {/* Toolbar — compact, single block. No more 5-row chip stack. */}
      <div style={{
        padding: '10px 14px', background: 'var(--paper-2)',
        border: '1px solid var(--rule)', marginBottom: 14,
      }}>
        {/* Top row: search + view toggle + upload */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <input type="text" value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search name, description, transcript, notes…"
            style={{
              flex: '1 1 280px', maxWidth: 420,
              padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: 12.5,
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

        {/* Editorial inline filter strip — 4 groups, each on its own line,
            text-style instead of buttoned chips. Click the label/"All" to
            click the small button to open a popover with options. */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        }}>
          <FilterDropdown label="STATUS"
            selected={stageFilter}
            options={[
              { value: 'raw_unused', label: 'RAW — NEEDS EDITING', sublabel: 'not yet edited', count: stageCounts.raw_unused, dot: '#b53e3e' },
              { value: 'raw_used',   label: 'RAW — ALREADY EDITED', sublabel: 'already used in a composite', count: stageCounts.raw_used, dot: '#999' },
              { value: 'edited_seg', label: 'EDITED',       count: stageCounts.edited_seg, dot: '#3e8a5e' },
            ]}
            allCount={rows.length}
            onChange={setStageFilter} />
          <FilterDropdown label="TYPE"
            selected={typeFilter}
            options={TYPES.map(t => ({ value: t, label: t.toUpperCase(), count: typeCounts[t] || 0, dot: typeColor(t).ink }))}
            allCount={rows.length}
            onChange={setTypeFilter} />
          <FilterDropdown label="OFFER"
            selected={offerFilter}
            options={[
              ...offers.map(o => ({
                value: o.slug,
                label: o.slug.replace(/^opt-/, '').replace(/-stub$/, '').replace(/-template$/, '').toUpperCase(),
                count: offerCounts[o.slug] || 0,
                dot: offerColor(o.slug).ink,
              })),
              ...(offerCounts.__none__ > 0 ? [{ value: '__none__', label: 'NO OFFER', count: offerCounts.__none__, dot: 'var(--ink-4)' }] : []),
            ]}
            allCount={rows.length}
            onChange={setOfferFilter} />
          <FilterDropdown label="RUN"
            selected={runFilter}
            options={[
              { value: 'yes', label: 'RUN BEFORE', count: runCount,    dot: '#3e8a5e' },
              { value: 'no',  label: 'NOT YET',    count: notRunCount, dot: 'var(--ink-4)' },
            ]}
            allCount={rows.length}
            onChange={setRunFilter} />
          <button type="button"
            onClick={() => setLatestOnly(v => !v)}
            title="Show only the latest version of each clip (hide v1 when a v2 exists)"
            style={{
              padding: '5px 9px',
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              background: latestOnly ? 'var(--accent)' : 'white',
              color: 'var(--ink)',
              border: '1px solid ' + (latestOnly ? 'var(--ink)' : 'var(--rule)'),
              borderRadius: 2, cursor: 'pointer',
            }}>{latestOnly ? '☑ Latest only' : 'Latest only'}</button>
          {(stageFilter.size + typeFilter.size + offerFilter.size + runFilter.size > 0 || latestOnly) && (
            <button type="button"
              onClick={() => {
                setStageFilter(new Set()); setTypeFilter(new Set())
                setOfferFilter(new Set()); setRunFilter(new Set())
                setLatestOnly(false)
              }}
              style={{
                marginLeft: 4, padding: '4px 9px',
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: 'transparent', color: 'var(--ink-3)',
                border: '1px solid var(--rule)', cursor: 'pointer',
              }}>Clear filters</button>
          )}
        </div>
      </div>

      {err && <ErrorBanner msg={err} />}

      {/* Bulk selection bar — sticky, appears when ≥1 tile is selected */}
      {selected.size > 0 && scope.canEditCreative && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 50,
          marginBottom: 14, padding: '10px 14px',
          background: 'var(--ink)', color: 'white',
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.08em',
          }}>
            {selected.size} selected
          </span>
          <button onClick={() => setSelected(new Set(filtered.map(r => r.id)))}
            style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'white',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Select all visible ({filtered.length})</button>
          <button onClick={clearSelection}
            style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'white',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Clear</button>
          <span style={{ flex: 1 }} />
          <button onClick={() => setBulkEditOpen(true)} disabled={bulkBusy}
            style={{
              padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 10.5,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'var(--accent)', color: 'var(--ink)',
              border: 'none', cursor: 'pointer',
            }}>Bulk edit {selected.size}</button>
        </div>
      )}

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
                    <CreativeCard key={r.id} row={r}
                      isUsed={usedRawIds.has(r.id)}
                      onClick={() => setDrawerRow(r)}
                      selected={selected.has(r.id)}
                      selectionMode={selected.size > 0}
                      onToggleSelect={scope.canEditCreative ? toggleSelect : null} />
                  ))}
                </div>
              ) : view === 'list' ? (
                <CreativeListView
                  rows={group.rows}
                  usedRawIds={usedRawIds}
                  onClick={setDrawerRow}
                  onDelete={scope.canDelete ? setConfirmDelete : null}
                />
              ) : (
                <CreativeMatrixView
                  rows={group.rows}
                  editors={activeEditors}
                  offers={offers}
                  creators={knownCreators}
                  usedRawIds={usedRawIds}
                  onRowClick={openDrawer}
                  onPatch={scope.canEditCreative ? patchRow : null}
                  selected={selected}
                  selectionMode={selected.size > 0}
                  onToggleSelect={scope.canEditCreative ? toggleSelect : null}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
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
          editors={editors}
          offers={offers}
          knownCreators={knownCreators}
          onClose={() => setDrawerRow(null)}
          onSaved={() => { setDrawerRow(null); load() }}
          onRowPatched={(id, patch) => {
            // Merge changed fields into the parent's rows state.
            // No full DB reload — DB is already updated by the modal's
            // debounced auto-save. Updates the assigned_editor_name
            // derived field too.
            setRows(curr => curr.map(r => {
              if (r.id !== id) return r
              const next = { ...r, ...patch }
              if ('assigned_editor_id' in patch) {
                const ed = editors.find(e => e.id === patch.assigned_editor_id)
                next.assigned_editor_name = ed?.name || null
              }
              return next
            }))
          }}
          onDeleted={() => { setDrawerRow(null); load() }}
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

      {bulkEditOpen && (
        <BulkEditModal
          ids={Array.from(selected)}
          editors={editors}
          offers={offers}
          knownCreators={knownCreators}
          onClose={() => setBulkEditOpen(false)}
          onSaved={() => {
            setBulkEditOpen(false)
            clearSelection()
            load()
          }} />
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

function CreativeListView({ rows, usedRawIds, onClick, onDelete }) {
  // 8 columns: thumb · name · type · creator · offer · run? · status · actions.
  // Dropped v21 + size — both available in the detail modal. Keeps the row
  // scannable without horizontal scroll on 1280px+ screens.
  const gridCols = '52px minmax(240px, 1.6fr) 90px 90px 140px 70px 80px 80px'
  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: gridCols,
        padding: '10px 14px', gap: 12,
        background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
      }}>
        <div></div>
        <div>Name</div>
        <div>Type</div>
        <div>Creator</div>
        <div>Offer</div>
        <div>Run?</div>
        <div>Status</div>
        <div style={{ textAlign: 'right' }}>Actions</div>
      </div>
      {rows.map((r, i) => (
        <ListRow key={r.id} row={r} isLast={i === rows.length - 1}
          isUsed={usedRawIds?.has(r.id)}
          gridCols={gridCols}
          onClick={() => onClick(r)} onDelete={() => onDelete(r)} />
      ))}
    </div>
  )
}

function ListRow({ row: r, isLast, gridCols, isUsed, onClick, onDelete }) {
  // `onDelete` may be null when the viewer doesn't have delete permission
  const [hover, setHover] = useState(false)
  const offerName = r.offer_slug ? r.offer_slug.replace(/^opt-/, '').replace(/-stub$/, '').replace(/-template$/, '') : null
  const oc = offerColor(r.offer_slug)
  // Left stripe color matches Matrix view: red = raw needs editing,
  // grey = raw already merged, green = edited, orange = merged final
  const stripeColor =
    (r.type === 'Joined' && r.status === 'edited') ? '#b86a0c'
    : (r.status === 'edited')                       ? '#3e8a5e'
    : (r.status === 'raw' && isUsed)                ? '#999'
    :                                                 '#b53e3e'
  return (
        <div
          style={{
            display: 'grid', gridTemplateColumns: gridCols,
            padding: '10px 14px', gap: 12, alignItems: 'center',
            borderBottom: isLast ? 'none' : '1px solid var(--rule)',
            borderLeft: `3px solid ${stripeColor}`,
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
          {/* Name */}
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 500,
              color: 'var(--ink)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              textDecoration: (r.status === 'raw' && isUsed) ? 'line-through' : 'none',
              opacity: (r.status === 'raw' && isUsed) ? 0.7 : 1,
            }}>
              {(r.status === 'raw' && isUsed) && (
                <span title="Already edited"
                  style={{ color: '#3e8a5e', fontWeight: 600, marginRight: 5 }}>✓</span>
              )}
              {r.canonical_name || r.name}
            </div>
          </div>
          {/* Type pill */}
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
          {/* Offer pill */}
          <div>
            {offerName ? (
              <span style={{
                display: 'inline-block', padding: '2px 7px',
                fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: oc.soft, color: oc.ink,
                border: '1px solid ' + oc.border, borderRadius: 2,
              }}>{offerName}</span>
            ) : (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)' }}>—</span>
            )}
          </div>
          {/* Run? pill */}
          <div>
            {r.has_been_run ? (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '2px 7px',
                fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'rgba(62,138,94,0.10)', color: '#3e8a5e',
                border: '1px solid rgba(62,138,94,0.35)', borderRadius: 2,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3e8a5e' }} />
                Yes
              </span>
            ) : (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)' }}>—</span>
            )}
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
/* Matrix view — edge-to-edge dense table modeled on the Component Edits
   spreadsheet but trimmed of the 4 per-stage columns Ben said he didn't
   need. Every cell that can be edited (description, type, creator, editor,
   offer, run?, status) is inline-editable via onPatch — no modal click
   needed. Static thumbnail only (no hover-to-play) to keep scrolling fast
   when 100+ rows are visible. */
// Condensed edge-to-edge layout. Adds a 22px checkbox column when bulk-
// select handlers are wired in. Slightly tighter column widths than before.
const MATRIX_COLS_BASE = '38px minmax(110px, 0.85fr) minmax(180px, 1.8fr) 86px 70px 120px 120px 56px 76px 62px'
const MATRIX_COLS_SEL  = `26px ${MATRIX_COLS_BASE}`

// Header cell with clickable sort + arrow indicator. Used in CreativeMatrixView.
function SortableHeader({ label, k, sortKey, sortDir, onSort }) {
  const isActive = sortKey === k
  return (
    <div onClick={() => onSort?.(k)}
      title={`Sort by ${label}`}
      style={{
        cursor: onSort ? 'pointer' : 'default',
        userSelect: 'none',
        color: isActive ? 'var(--ink)' : 'var(--ink-3)',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}>
      <span>{label}</span>
      {isActive ? (
        <span style={{ fontSize: 9 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
      ) : (
        <span style={{ fontSize: 9, color: 'var(--ink-4)', opacity: 0.4 }}>↕</span>
      )}
    </div>
  )
}

function CreativeMatrixView({ rows, editors, offers, creators, usedRawIds, onRowClick, onPatch, selected, selectionMode, onToggleSelect, sortKey, sortDir, onSort }) {
  const selectable = !!onToggleSelect
  const cols = selectable ? MATRIX_COLS_SEL : MATRIX_COLS_BASE
  const allVisible = rows.every(r => selected?.has(r.id))
  const someVisible = !allVisible && rows.some(r => selected?.has(r.id))
  const toggleAll = () => {
    if (!onToggleSelect) return
    if (allVisible) rows.forEach(r => onToggleSelect(r.id))   // toggles off all
    else            rows.forEach(r => !selected?.has(r.id) && onToggleSelect(r.id))  // adds missing
  }
  return (
    <div style={{ width: '100%', background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: cols,
        gap: 5, padding: '6px 10px',
        background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
        fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
        alignItems: 'center',
      }}>
        {selectable && (
          <div onClick={toggleAll} title="Select / deselect all visible"
            style={{
              width: 16, height: 16, borderRadius: 2,
              border: '1.5px solid var(--ink-3)',
              background: allVisible ? 'var(--accent)' : (someVisible ? 'var(--paper-2)' : 'white'),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}>
            {allVisible && (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {someVisible && (
              <span style={{ width: 8, height: 2, background: 'var(--ink-3)' }} />
            )}
          </div>
        )}
        <div></div>
        <SortableHeader label="ID"          k="id"      sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Description" k="desc"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Type"        k="type"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Creator"     k="creator" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Editor"      k="editor"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Offer"       k="offer"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Run?"        k="run"     sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Status"      k="status"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <div>Raw</div>
      </div>
      {rows.map((r, i) => (
        <MatrixRow key={r.id} row={r}
          editors={editors} offers={offers} creators={creators}
          isLast={i === rows.length - 1}
          isUsed={!!usedRawIds?.has(r.id)}
          onRowClick={onRowClick}
          onPatch={onPatch}
          cols={cols}
          selected={selected?.has(r.id)}
          selectionMode={selectionMode}
          onToggleSelect={onToggleSelect} />
      ))}
    </div>
  )
}

/* Native <select>/<input> styled to look flat in the cell. Clicking opens
   the native picker (which is fast and avoids hand-rolling popovers).
   stopPropagation so the click doesn't fall through to the row's onClick
   (which opens the full detail modal). */
const cellSelectStyle = {
  width: '100%', padding: '3px 18px 3px 6px',
  background: 'transparent', border: '1px solid transparent',
  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink)',
  cursor: 'pointer', appearance: 'auto',
  outline: 'none',
}
const cellInputStyle = {
  width: '100%', padding: '3px 6px',
  background: 'transparent', border: '1px solid transparent',
  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink)',
  outline: 'none',
}

const MatrixRow = memo(function MatrixRow({ row: r, editors, offers, creators, isLast, isUsed, onRowClick, onPatch, cols, selected, selectionMode, onToggleSelect }) {
  const [hover, setHover] = useState(false)
  const tc = typeColor(r.type)
  const oc = offerColor(r.offer_slug)
  const editable = !!onPatch
  const selectable = !!onToggleSelect
  // Local state mirrors the row so inline edits feel snappy. The parent's
  // optimistic update in patchRow will sync the canonical state on next
  // render — so we re-init from row when it changes.
  const [desc, setDesc] = useState(r.description || r.name || '')
  const [creator, setCreator] = useState(r.creator || '')
  useEffect(() => { setDesc(r.description || r.name || '') }, [r.description, r.name])
  useEffect(() => { setCreator(r.creator || '') }, [r.creator])
  const stop = e => e.stopPropagation()
  // In selection mode, clicking row body toggles selection instead of
  // opening the drawer. Inline-editor cells still stopPropagation so
  // editing doesn't toggle selection.
  const handleRowClick = () => {
    if (selectionMode && selectable) onToggleSelect(r.id)
    else onRowClick?.(r)
  }
  // Pipeline-state color stripe on the left edge of every row — fast
  // visual scan of which rows are raw / edited / merged.
  // Used raws (already merged into a Joined) get a muted grey stripe
  // instead of red — so you can spot them as "done, no action needed".
  const stripeColor =
    (r.type === 'Joined' && r.status === 'edited') ? '#b86a0c'     // merged (orange)
    : (r.status === 'edited')                       ? '#3e8a5e'     // edited (green)
    : (r.status === 'raw' && isUsed)                ? '#999'        // raw + used (muted)
    :                                                 '#b53e3e'     // raw + unused (red — needs attention)
  return (
    <div
      onClick={handleRowClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid', gridTemplateColumns: cols,
        gap: 5, padding: '4px 10px', alignItems: 'center',
        borderBottom: isLast ? 'none' : '1px solid var(--rule)',
        borderLeft: `3px solid ${stripeColor}`,
        background: selected ? 'rgba(244,225,74,0.15)' : (hover ? 'var(--paper-2)' : 'transparent'),
        cursor: 'pointer', transition: 'background 0.08s',
        fontFamily: 'var(--mono)', fontSize: 10,
      }}>
      {selectable && (
        <div onClick={(e) => { e.stopPropagation(); onToggleSelect(r.id) }}
          style={{
            width: 16, height: 16, borderRadius: 2,
            border: selected ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
            background: selected ? 'var(--accent)' : 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
          }}>
          {selected && (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}
      {/* Thumbnail — static, no hover-to-play (was slowing the page) */}
      <div style={{ width: 36, height: 24, overflow: 'hidden', background: '#000', border: '1px solid var(--rule)' }}>
        {r.thumbnail_url && (
          <img src={r.thumbnail_url} alt="" loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
      </div>
      {/* ID (canonical_name, small mono). Raw+used = strikethrough +
          green check so it's obvious the raw is already merged into a
          Joined elsewhere and doesn't need editing. */}
      <div style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontSize: 10, color: 'var(--ink-3)',
        display: 'flex', alignItems: 'center', gap: 4,
        textDecoration: (r.status === 'raw' && isUsed) ? 'line-through' : 'none',
        opacity: (r.status === 'raw' && isUsed) ? 0.65 : 1,
      }} title={r.canonical_name || r.name}>
        {(r.status === 'raw' && isUsed) && (
          <span title="Already edited"
            style={{ color: '#3e8a5e', fontWeight: 600, flexShrink: 0 }}>✓</span>
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.canonical_name || r.name}
        </span>
      </div>
      {/* Description — inline-editable text */}
      <div onClick={stop} style={{ minWidth: 0 }}>
        {editable ? (
          <input type="text" value={desc}
            onChange={e => setDesc(e.target.value)}
            onBlur={() => { if (desc !== (r.description || r.name)) onPatch(r.id, { description: desc }) }}
            placeholder={r.name}
            style={{ ...cellInputStyle, fontFamily: 'var(--sans)', fontSize: 11.5 }} />
        ) : (
          <span style={{ fontFamily: 'var(--sans)', fontSize: 11.5 }}>{r.description || r.name}</span>
        )}
      </div>
      {/* Type — inline select, rendered as colored pill */}
      <div onClick={stop} style={{ position: 'relative' }}>
        {editable ? (
          <select value={r.type || ''}
            onChange={e => onPatch(r.id, { type: e.target.value })}
            style={{
              ...cellSelectStyle,
              background: tc.soft, color: tc.ink,
              border: '1px solid ' + tc.border, borderRadius: 2,
              fontWeight: 600, fontSize: 9.5, textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        ) : (
          <span style={{
            padding: '2px 6px',
            background: tc.soft, color: tc.ink, border: '1px solid ' + tc.border,
            fontWeight: 600, fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>{r.type}</span>
        )}
      </div>
      {/* Creator — inline select from known creators */}
      <div onClick={stop}>
        {editable ? (
          <select value={r.creator || ''}
            onChange={e => {
              const v = e.target.value
              if (v === '__ADD__') {
                const next = prompt('New creator name')
                if (next && next.trim()) onPatch(r.id, { creator: next.trim().toUpperCase() })
              } else {
                onPatch(r.id, { creator: v || null })
              }
            }}
            style={cellSelectStyle}>
            <option value="">—</option>
            {(creators || []).map(c => <option key={c} value={c}>{c}</option>)}
            {/* Ensure current value is in options even if not in known list */}
            {r.creator && !(creators || []).includes(r.creator) && (
              <option value={r.creator}>{r.creator}</option>
            )}
            <option value="__ADD__">+ Add new…</option>
          </select>
        ) : (
          <span style={{ color: 'var(--ink-3)' }}>{r.creator || '—'}</span>
        )}
      </div>
      {/* Editor — inline select */}
      <div onClick={stop}>
        {editable ? (
          <select value={r.assigned_editor_id || ''}
            onChange={e => onPatch(r.id, { assigned_editor_id: e.target.value || null })}
            style={{ ...cellSelectStyle, color: r.assigned_editor_id ? 'var(--ink)' : 'var(--ink-4)' }}>
            <option value="">—</option>
            {editors.filter(e => e.active).map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        ) : (
          <span style={{ color: r.assigned_editor_id ? 'var(--ink)' : 'var(--ink-4)' }}>
            {r.assigned_editor_name || '—'}
          </span>
        )}
      </div>
      {/* Offer — inline select with color */}
      <div onClick={stop}>
        {editable ? (
          <select value={r.offer_slug || ''}
            onChange={e => onPatch(r.id, { offer_slug: e.target.value || null })}
            style={{
              ...cellSelectStyle,
              background: r.offer_slug ? oc.soft : 'transparent',
              color: r.offer_slug ? oc.ink : 'var(--ink-4)',
              border: r.offer_slug ? '1px solid ' + oc.border : '1px solid transparent',
              borderRadius: 2,
              fontWeight: r.offer_slug ? 600 : 400,
              fontSize: 9.5, textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
            <option value="">—</option>
            {offers.map(o => <option key={o.slug} value={o.slug}>{o.slug.replace(/^opt-/, '').replace(/-stub$/, '').replace(/-template$/, '')}</option>)}
          </select>
        ) : (
          <span style={{ color: 'var(--ink-3)' }}>{r.offer_slug || '—'}</span>
        )}
      </div>
      {/* Run? — toggle button */}
      <div onClick={stop} style={{ display: 'flex', justifyContent: 'center' }}>
        {editable ? (
          <button type="button"
            onClick={() => onPatch(r.id, { has_been_run: !r.has_been_run })}
            title={r.has_been_run ? 'Has been run' : 'Not yet run'}
            style={{
              padding: '3px 7px',
              background: r.has_been_run ? 'rgba(62,138,94,0.15)' : 'transparent',
              border: r.has_been_run ? '1px solid rgba(62,138,94,0.4)' : '1px solid var(--rule)',
              borderRadius: 2, cursor: 'pointer',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
              color: r.has_been_run ? '#3e8a5e' : 'var(--ink-4)',
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>
            {r.has_been_run ? 'Yes' : '—'}
          </button>
        ) : (
          <span style={{ color: r.has_been_run ? '#3e8a5e' : 'var(--ink-4)' }}>
            {r.has_been_run ? 'Yes' : '—'}
          </span>
        )}
      </div>
      {/* Status — inline select */}
      <div onClick={stop}>
        {editable ? (
          <select value={r.status || 'raw'}
            onChange={e => onPatch(r.id, { status: e.target.value })}
            style={{
              ...cellSelectStyle,
              color: STATUS_COLOR[r.status] || 'var(--ink-3)',
              fontWeight: 600, fontSize: 9.5, textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
            {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>)}
          </select>
        ) : (
          <span style={{ color: STATUS_COLOR[r.status] || 'var(--ink-3)' }}>{STATUS_LABEL[r.status] || r.status}</span>
        )}
      </div>
      {/* Raw — open the source file */}
      <div onClick={stop} style={{ display: 'flex', justifyContent: 'center' }}>
        {r.drive_url ? (
          <a href={r.drive_url} target="_blank" rel="noreferrer"
            onClick={stop}
            style={{
              padding: '3px 8px',
              background: 'rgba(62,138,94,0.12)',
              border: '1px solid rgba(62,138,94,0.4)',
              color: '#3e8a5e', textDecoration: 'none',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              borderRadius: 2,
            }}>Open</a>
        ) : (
          <span style={{ color: 'var(--ink-4)' }}>—</span>
        )}
      </div>
    </div>
  )
})

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

/* Editor picker — custom dropdown that shows each editor with their
   color dot inline (which a plain <select> can't do). Used in the
   detail modal + bulk edit + matrix inline cell. */
function EditorPicker({ value, editors, onChange, placeholder = '— Unassigned' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const current = editors.find(e => e.id === value)
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          ...inputStyle, display: 'flex', alignItems: 'center', gap: 8,
          cursor: 'pointer', width: '100%', textAlign: 'left',
        }}>
        {current ? (
          <>
            <span style={{ width: 10, height: 10, borderRadius: 2,
              background: editorColor(current), flexShrink: 0 }} />
            <span style={{ flex: 1, fontFamily: 'var(--sans)' }}>{current.name}</span>
          </>
        ) : (
          <span style={{ flex: 1, fontFamily: 'var(--sans)', color: 'var(--ink-4)' }}>{placeholder}</span>
        )}
        <span style={{ fontSize: 9, opacity: 0.5 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0,
          maxHeight: 280, overflowY: 'auto', zIndex: 30,
          background: 'white', border: '1px solid var(--ink)',
          boxShadow: '0 8px 24px rgba(10,10,10,0.18)',
          padding: 4,
        }}>
          <button type="button"
            onClick={() => { onChange(null); setOpen(false) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '6px 10px', background: !value ? 'var(--paper-2)' : 'transparent',
              border: 'none', cursor: 'pointer', textAlign: 'left',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: !value ? 700 : 500,
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--ink-4)', flexShrink: 0 }} />
            <span style={{ flex: 1 }}>Unassigned</span>
          </button>
          {editors.filter(e => e.active !== false).map(e => {
            const isOn = e.id === value
            return (
              <button key={e.id} type="button"
                onClick={() => { onChange(e.id); setOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '6px 10px', background: isOn ? 'var(--paper-2)' : 'transparent',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'var(--sans)', fontSize: 13, fontWeight: isOn ? 600 : 500,
                }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: editorColor(e), flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{e.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* Creator picker — dropdown of known creators with an inline 'Add new'
   that switches to a free-text input. Avoids typos that fragment creators
   into multiple variants (NATALIE vs Natalie vs natalie). */
function CreatorPicker({ value, known, onChange }) {
  const [addingNew, setAddingNew] = useState(false)
  // If the current value isn't in the known list, expose it inline so the
  // dropdown still shows it as selected.
  const options = useMemo(() => {
    const set = new Set(known)
    if (value && !set.has(value)) set.add(value)
    return Array.from(set).sort()
  }, [known, value])
  if (addingNew) {
    return (
      <div style={{ display: 'flex', gap: 4 }}>
        <input type="text" autoFocus
          defaultValue={value || ''}
          onBlur={e => { onChange(e.target.value.toUpperCase().trim() || null); setAddingNew(false) }}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          placeholder="New creator name"
          style={inputStyle} />
      </div>
    )
  }
  return (
    <select value={value || ''}
      onChange={e => {
        if (e.target.value === '__ADD__') setAddingNew(true)
        else onChange(e.target.value || null)
      }}
      style={selectStyle}>
      <option value="">— Pick creator —</option>
      {options.map(c => <option key={c} value={c}>{c}</option>)}
      <option value="__ADD__">+ Add new creator…</option>
    </select>
  )
}

/* Transcript display with expand/collapse + copy-to-clipboard. Sits in
   the detail modal under the form. Long transcripts collapse to ~6 lines
   with a 'Show more' affordance. */
function TranscriptBox({ text }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef(null)
  useEffect(() => () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current) }, [])
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 5,
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600,
        }}>Transcript</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <button onClick={onCopy} type="button"
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              color: copied ? '#3e8a5e' : 'var(--ink-3)',
              textDecoration: 'underline',
            }}>{copied ? 'Copied' : 'Copy'}</button>
          <button onClick={() => setExpanded(v => !v)} type="button"
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              color: 'var(--ink-3)', textDecoration: 'underline',
            }}>{expanded ? 'Collapse' : 'Show full'}</button>
        </div>
      </div>
      <div style={{
        maxHeight: expanded ? 'none' : 160,
        overflowY: expanded ? 'visible' : 'auto',
        padding: 12,
        background: 'var(--paper-2)', border: '1px solid var(--rule)',
        fontFamily: 'var(--serif)', fontSize: 13, lineHeight: 1.5,
        color: 'var(--ink-2)', fontStyle: 'italic',
        whiteSpace: 'pre-wrap',
      }}>{text}</div>
    </div>
  )
}

/* Usage history — when viewing a Hook or Body source clip, show which
   Joined composites used it. Match is heuristic: extract the slot from
   the row's original name (Hook 4, Body C, HAMMER-H1, etc.) then query
   joined rows whose name contains that slot. */
/* Versions panel — lists all version siblings of the current creative
   (linked via parent_id pointing at v1). Lets Ben upload a new version
   that inherits most metadata from the current one but gets its own
   row + new transcript + new preview. */
function VersionsPanel({ row, onReload }) {
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(null)
  const [err, setErr] = useState(null)
  const fileInputRef = useRef(null)

  // Root id = the v1 row. If current row has parent_id, that's the root.
  // Otherwise this row IS the root.
  const rootId = row.parent_id || row.id

  useEffect(() => {
    let mounted = true
    // Pull all versions: the root + everything with parent_id = root.
    supabase.from('lib_creative_library')
      .select('id, canonical_name, name, version_number, status, type, thumbnail_url, preview_url, added_at')
      .or(`id.eq.${rootId},parent_id.eq.${rootId}`)
      .eq('exclude_from_library', false)
      .order('version_number', { ascending: true })
      .then(({ data }) => {
        if (!mounted) return
        setVersions(data || [])
        setLoading(false)
      })
    return () => { mounted = false }
  }, [rootId])

  const handleUpload = async (file) => {
    if (!file) return
    setUploading(true); setErr(null); setProgress('Uploading…')
    try {
      const nextVersion = Math.max(0, ...versions.map(v => v.version_number || 1)) + 1
      const sanitized = file.name.replace(/[^A-Za-z0-9._-]+/g, '_')
      const storagePath = `ingest/${Date.now()}_v${nextVersion}_${sanitized}`
      // 1. Upload to creative-uploads (full file for preview)
      const { error: upErr } = await supabase.storage
        .from('creative-uploads')
        .upload(storagePath, file, { upsert: false, contentType: file.type || 'video/mp4' })
      if (upErr) throw upErr
      const publicUrl = `https://kjfaqhmllagbxjdxlopm.supabase.co/storage/v1/object/public/creative-uploads/${storagePath}`
      // 2. Insert new library row inheriting metadata
      setProgress('Creating version…')
      const { data: inserted, error: insErr } = await supabase.from('lib_creative_library')
        .insert({
          name: `v${nextVersion} of ${row.canonical_name || row.name}`,
          type: row.type,
          creator: row.creator,
          status: 'edited',
          offer_slug: row.offer_slug,
          assigned_editor_id: row.assigned_editor_id,
          parent_id: rootId,
          version_number: nextVersion,
          size_mb: Math.round(file.size / 1024 / 1024 * 10) / 10,
          preview_url: publicUrl,
          source_bucket: 'New version upload',
          notes: `v${nextVersion} of ${row.canonical_name || row.name}, uploaded ${new Date().toISOString().slice(0,10)}.`,
        })
        .select()
        .single()
      if (insErr) throw insErr
      // 3. Fire transcribe + describe asynchronously (don't block UI)
      setProgress('Transcribing in background…')
      supabase.functions.invoke('transcribe-library-clip', {
        body: { library_id: inserted.id, storage_path: storagePath },
      }).then(() => {
        supabase.functions.invoke('creative-library-describe', {
          body: { library_ids: [inserted.id] },
        })
      })
      // Optimistic: add to local list
      setVersions(prev => [...prev, inserted])
      setUploadOpen(false); setUploadFile(null); setProgress(null)
    } catch (e) {
      setErr(e.message || 'upload failed')
      setProgress(null)
    } finally {
      setUploading(false)
    }
  }

  if (loading) return null
  // Only show panel if there's a version structure to display OR upload affordance
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 6,
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600,
        }}>
          Versions {versions.length > 1 && `· ${versions.length}`}
        </div>
        <button onClick={() => { setUploadOpen(true); setTimeout(() => fileInputRef.current?.click(), 50) }}
          type="button"
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'var(--ink)', textDecoration: 'underline',
          }}>+ Upload new version</button>
      </div>
      {/* Hidden file picker triggered by the button above */}
      <input ref={fileInputRef} type="file" accept="video/*"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) { setUploadFile(f); handleUpload(f) } }} />
      {err && (
        <div style={{ padding: '6px 10px', background: 'rgba(181,62,62,0.08)', border: '1px solid rgba(181,62,62,0.3)', color: '#b53e3e', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 6 }}>
          {err}
        </div>
      )}
      {progress && (
        <div style={{ padding: '6px 10px', background: 'var(--paper-2)', border: '1px solid var(--rule)', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>
          {progress}
        </div>
      )}
      <div style={{ display: 'grid', gap: 6 }}>
        {versions.map(v => {
          const isCurrent = v.id === row.id
          return (
            <div key={v.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 10px',
              background: isCurrent ? 'rgba(244,225,74,0.18)' : 'var(--paper-2)',
              border: isCurrent ? '1px solid var(--ink)' : '1px solid var(--rule)',
              fontFamily: 'var(--mono)', fontSize: 11,
            }}>
              <div style={{ width: 40, height: 24, background: '#000', overflow: 'hidden', flexShrink: 0 }}>
                {v.thumbnail_url && (
                  <img src={v.thumbnail_url} alt="" loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
              </div>
              <span style={{
                padding: '2px 7px', background: 'var(--ink)', color: 'var(--paper)',
                fontWeight: 600, letterSpacing: '0.06em',
              }}>v{v.version_number || 1}</span>
              <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <div style={{ fontWeight: isCurrent ? 700 : 500 }}>
                  {v.canonical_name || v.name}
                  {isCurrent && <span style={{ marginLeft: 6, color: 'var(--ink-3)', fontSize: 9.5 }}>CURRENT</span>}
                </div>
              </div>
              <span style={{ color: v.status === 'edited' ? '#3e8a5e' : '#b53e3e', fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {v.status}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UsageHistory({ row }) {
  const [matches, setMatches] = useState([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let mounted = true
    if (!row || (row.type !== 'Hook' && row.type !== 'Body')) { setMatches([]); return }
    // Slot extraction from original name. Note: integer hook numbers only —
    // 'CLIP-H1.1-SOFIA' is treated as 'Hook 1', same bucket as 'CLIP-H1-OSO'.
    // OK today because Joined composite names ('Hook 4 Body C') only use
    // integer hook numbers. If sub-versions are ever introduced (e.g.
    // 'Hook 1.1 Body C') this will need a finer-grained match.
    const name = row.name || ''
    let pattern = null
    if (row.type === 'Hook') {
      const m = name.match(/H(\d+)(?:\.(\d+))?/i)
      if (m) pattern = `Hook ${m[1]}`
    } else if (row.type === 'Body') {
      const lt = name.match(/Body\s*([A-Z])/i)
      const nm = name.match(/B(\d+)/i)
      if (lt)      pattern = `Body ${lt[1].toUpperCase()}`
      else if (nm) pattern = `Body ${nm[1]}`
    }
    if (!pattern) { setMatches([]); return () => { mounted = false } }
    setLoading(true)
    supabase.from('lib_creative_library')
      .select('id, name, canonical_name, status, thumbnail_url, preview_url')
      .eq('type', 'Joined')
      .ilike('name', `%${pattern}%`)
      .order('name')
      .then(({ data }) => {
        if (!mounted) return
        setMatches(data || []); setLoading(false)
      })
    return () => { mounted = false }
  }, [row?.id, row?.type, row?.name])

  if (!row || (row.type !== 'Hook' && row.type !== 'Body')) return null
  if (loading) return null
  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600,
        marginBottom: 5,
      }}>
        Used in {matches.length} Joined composite{matches.length === 1 ? '' : 's'}
      </div>
      {matches.length === 0 ? (
        <div style={{
          padding: '10px 12px', background: 'var(--paper-2)',
          border: '1px dashed var(--rule)',
          fontFamily: 'var(--serif)', fontStyle: 'italic',
          fontSize: 12, color: 'var(--ink-3)',
        }}>
          Not yet merged with any body / hook. Once a Joined creative
          named after this slot exists, it'll show up here.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {matches.map(m => (
            <div key={m.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 10px',
              background: 'var(--paper-2)', border: '1px solid var(--rule)',
              fontFamily: 'var(--mono)', fontSize: 11,
            }}>
              <div style={{ width: 40, height: 24, background: '#000', overflow: 'hidden', flexShrink: 0 }}>
                {m.thumbnail_url && (
                  <img src={m.thumbnail_url} alt="" loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
              </div>
              <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <div style={{ fontWeight: 600 }}>{m.canonical_name || m.name}</div>
                <div style={{ color: 'var(--ink-4)', fontSize: 10 }}>{m.name}</div>
              </div>
              <span style={{ color: m.status === 'edited' ? '#3e8a5e' : 'var(--ink-4)', fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {m.status}
              </span>
            </div>
          ))}
        </div>
      )}
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

/* ──────────────────────── BULK EDIT MODAL ──────────────────────── */
/* Applies a patch to N selected library rows in a single .update().in()
   call. Empty fields are skipped — only fields the user explicitly sets
   are written. Lets Ben reorganise dozens of clips in one pass. */

function BulkEditModal({ ids, editors = [], offers = [], knownCreators = [], onClose, onSaved }) {
  // null = no change, otherwise the value to write
  const [type, setType] = useState(null)
  const [status, setStatus] = useState(null)
  const [creator, setCreator] = useState(null)
  const [assignedEditorId, setAssignedEditorId] = useState(null)
  const [offerSlug, setOfferSlug] = useState(null)
  const [hasBeenRun, setHasBeenRun] = useState(null)   // null | true | false
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const patch = useMemo(() => {
    const p = {}
    if (type !== null)             p.type = type
    if (status !== null)           p.status = status
    if (creator !== null)          p.creator = creator
    if (assignedEditorId !== null) p.assigned_editor_id = assignedEditorId || null
    if (offerSlug !== null)        p.offer_slug = offerSlug || null
    if (hasBeenRun !== null)       p.has_been_run = hasBeenRun
    return p
  }, [type, status, creator, assignedEditorId, offerSlug, hasBeenRun])
  const hasChanges = Object.keys(patch).length > 0

  const apply = async () => {
    if (!hasChanges) return
    setBusy(true); setErr(null)
    const { error } = await supabase
      .from('lib_creative_library')
      .update(patch)
      .in('id', ids)
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved?.()
  }

  // Small "Keep existing" pill that appears when a field is null
  const keepPill = { padding: '5px 9px', fontSize: 10, fontFamily: 'var(--mono)',
    background: 'transparent', color: 'var(--ink-4)',
    border: '1px dashed var(--rule)', cursor: 'pointer', letterSpacing: '0.06em',
    textTransform: 'uppercase', fontWeight: 600, borderRadius: 2 }

  return (
    <Modal open={true} onClose={onClose} size="md"
      eyebrow={`BULK EDIT · ${ids.length} CLIP${ids.length === 1 ? '' : 'S'}`}
      title="Reorganise selected creatives"
      subtitle="Click a field's value to set it. Anything left as KEEP EXISTING stays unchanged."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          {!hasChanges && !err && (
            <span style={{
              fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-4)',
              marginRight: 'auto', fontStyle: 'italic',
            }}>Set at least one field to apply</span>
          )}
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={apply} disabled={busy || !hasChanges} style={primaryBtn}>
            {busy ? 'Applying…' : `Apply to ${ids.length} clip${ids.length === 1 ? '' : 's'}`}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 16 }}>
        {/* TYPE — colored pill buttons + keep-existing */}
        <Field label="Type">
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <button onClick={() => setType(null)} type="button"
              style={type === null ? { ...keepPill, color: 'var(--ink)', borderColor: 'var(--ink)', borderStyle: 'solid', background: 'var(--accent)' } : keepPill}>
              Keep existing
            </button>
            {TYPES.map(t => {
              const isOn = type === t
              const tc = typeColor(t)
              return (
                <button key={t} type="button" onClick={() => setType(t)}
                  style={{
                    padding: '5px 9px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: isOn ? tc.ink : tc.soft,
                    color: isOn ? 'white' : tc.ink,
                    border: '1px solid ' + (isOn ? tc.ink : tc.border),
                    borderRadius: 2, cursor: 'pointer',
                  }}>{t}</button>
              )
            })}
          </div>
        </Field>

        {/* STATUS — Raw/Edited pill toggle */}
        <Field label="Status">
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <button onClick={() => setStatus(null)} type="button"
              style={status === null ? { ...keepPill, color: 'var(--ink)', borderColor: 'var(--ink)', borderStyle: 'solid', background: 'var(--accent)' } : keepPill}>
              Keep existing
            </button>
            {STATUSES.map(s => {
              const isOn = status === s
              const color = STATUS_COLOR[s] || 'var(--ink-3)'
              return (
                <button key={s} type="button" onClick={() => setStatus(s)}
                  style={{
                    padding: '5px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: isOn ? color : 'white',
                    color: isOn ? 'white' : color,
                    border: '1px solid ' + color,
                    borderRadius: 2, cursor: 'pointer',
                  }}>{STATUS_LABEL[s] || s}</button>
              )
            })}
          </div>
        </Field>

        {/* RUN BEFORE — pill toggle */}
        <Field label="Run before">
          <div style={{ display: 'flex', gap: 5 }}>
            <button onClick={() => setHasBeenRun(null)} type="button"
              style={hasBeenRun === null ? { ...keepPill, color: 'var(--ink)', borderColor: 'var(--ink)', borderStyle: 'solid', background: 'var(--accent)' } : keepPill}>
              Keep existing
            </button>
            <button onClick={() => setHasBeenRun(true)} type="button"
              style={{
                padding: '5px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: hasBeenRun === true ? '#3e8a5e' : 'white',
                color: hasBeenRun === true ? 'white' : '#3e8a5e',
                border: '1px solid #3e8a5e',
                borderRadius: 2, cursor: 'pointer',
              }}>Yes — run before</button>
            <button onClick={() => setHasBeenRun(false)} type="button"
              style={{
                padding: '5px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: hasBeenRun === false ? 'var(--ink)' : 'white',
                color: hasBeenRun === false ? 'white' : 'var(--ink-3)',
                border: '1px solid var(--rule)',
                borderRadius: 2, cursor: 'pointer',
              }}>No — not yet</button>
          </div>
        </Field>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Field label="Creator">
            <select value={creator === null ? '__KEEP__' : creator || ''}
              onChange={e => {
                const v = e.target.value
                if (v === '__KEEP__') setCreator(null)
                else if (v === '__ADD__') {
                  const next = prompt('New creator name')
                  if (next?.trim()) setCreator(next.trim().toUpperCase())
                } else setCreator(v)
              }}
              style={selectStyle}>
              <option value="__KEEP__">— KEEP EXISTING —</option>
              {knownCreators.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="__ADD__">+ Add new…</option>
            </select>
          </Field>
          <Field label="Offer / niche">
            <select value={offerSlug === null ? '__KEEP__' : offerSlug || '__CLEAR__'}
              onChange={e => {
                const v = e.target.value
                if (v === '__KEEP__') setOfferSlug(null)
                else if (v === '__CLEAR__') setOfferSlug(null)
                else setOfferSlug(v)
              }}
              style={selectStyle}>
              <option value="__KEEP__">— KEEP EXISTING —</option>
              <option value="">Clear offer</option>
              {offers.map(o => <option key={o.slug} value={o.slug}>{o.name}</option>)}
            </select>
          </Field>
          <Field label="Assigned editor">
            {/* Tri-state: 'KEEP EXISTING' / 'Unassign' / specific editor.
                Custom UI since EditorPicker doesn't model 'keep existing'. */}
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" onClick={() => setAssignedEditorId(null)}
                style={assignedEditorId === null ? {
                  padding: '5px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                  fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'var(--accent)', color: 'var(--ink)',
                  border: '1px solid var(--ink)', borderRadius: 2, cursor: 'pointer',
                } : {
                  padding: '5px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                  fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'transparent', color: 'var(--ink-4)',
                  border: '1px dashed var(--rule)', borderRadius: 2, cursor: 'pointer',
                }}>Keep existing</button>
              <div style={{ flex: '1 1 220px', minWidth: 200 }}>
                <EditorPicker value={assignedEditorId === null ? '' : (assignedEditorId || '')}
                  editors={editors}
                  onChange={v => setAssignedEditorId(v || '')}
                  placeholder="Unassign (clear editor)" />
              </div>
            </div>
          </Field>
        </div>

        {hasChanges && (
          <div style={{
            padding: '10px 12px', background: 'var(--paper-2)',
            border: '1px dashed var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
            letterSpacing: '0.04em',
          }}>
            <strong style={{ color: 'var(--ink)' }}>Will write:</strong>{' '}
            {Object.entries(patch).map(([k, v]) => (
              <span key={k}>{k}={v === null ? 'null' : String(v)}; </span>
            ))}
          </div>
        )}
      </div>
    </Modal>
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

/* Multi-select filter dropdown — small button that opens a popover with
   checkboxes. selected is a Set of currently-chosen values; onChange
   receives a new Set. Button label shows count when 2+ are selected.
   Click outside or Esc to close. */
function FilterDropdown({ label, selected, options, allCount, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const isAll = selected.size === 0
  const selectedOpts = options.filter(o => selected.has(o.value))
  const buttonLabel = isAll
    ? `${label}: ALL`
    : selectedOpts.length === 1
      ? `${label}: ${selectedOpts[0].label}`
      : `${label}: ${selectedOpts.length} SELECTED`

  const toggle = (v) => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v); else next.add(v)
    onChange(next)
  }
  const clear = () => onChange(new Set())

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          padding: '5px 9px',
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          background: isAll ? 'white' : 'var(--accent)',
          color: 'var(--ink)',
          border: '1px solid ' + (isAll ? 'var(--rule)' : 'var(--ink)'),
          borderRadius: 2, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
        {selectedOpts.length === 1 && selectedOpts[0].dot && (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: selectedOpts[0].dot, display: 'inline-block' }} />
        )}
        <span>{buttonLabel}</span>
        <span style={{ fontSize: 8, opacity: 0.6 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0,
          minWidth: 260, zIndex: 30,
          background: 'white', border: '1px solid var(--ink)',
          boxShadow: '0 8px 24px rgba(10,10,10,0.18)',
          padding: 4,
        }}>
          <button onClick={clear}
            type="button"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', padding: '6px 10px',
              background: isAll ? 'var(--paper-2)' : 'transparent',
              border: 'none', cursor: 'pointer', textAlign: 'left',
              fontFamily: 'var(--mono)', fontSize: 11,
              fontWeight: isAll ? 700 : 500,
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>
            <span style={{
              width: 16, height: 16, borderRadius: 2,
              border: isAll ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
              background: isAll ? 'var(--accent)' : 'white',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              {isAll && (
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <span style={{ flex: 1 }}>All</span>
            <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>{allCount}</span>
          </button>
          {options.map(opt => {
            const isOn = selected.has(opt.value)
            return (
              <button key={opt.value}
                onClick={() => toggle(opt.value)}
                type="button"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '6px 10px',
                  background: isOn ? 'var(--paper-2)' : 'transparent',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'var(--mono)', fontSize: 11,
                  fontWeight: isOn ? 700 : 500,
                  letterSpacing: '0.06em',
                }}>
                <span style={{
                  width: 16, height: 16, borderRadius: 2,
                  border: isOn ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                  background: isOn ? 'var(--accent)' : 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {isOn && (
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                      <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                        strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: opt.dot || 'var(--ink-4)',
                  flexShrink: 0,
                }} />
                <span style={{ flex: 1 }}>
                  {opt.label}
                  {opt.sublabel && (
                    <span style={{ marginLeft: 6, color: 'var(--ink-4)', fontSize: 9.5, fontWeight: 400, textTransform: 'none' }}>
                      · {opt.sublabel}
                    </span>
                  )}
                </span>
                <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>{opt.count}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* Editorial-style inline filter strip — kept for any callers that still
   want the inline format. New library toolbar uses FilterDropdown. */
function FilterStrip({ label, active, options, onPick, onClear, totalCount }) {
  const sep = (
    <span style={{ color: 'var(--ink-4)', opacity: 0.5, padding: '0 8px' }}>·</span>
  )
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', flexWrap: 'wrap',
      padding: '4px 0',
      fontFamily: 'var(--mono)', fontSize: 11,
    }}>
      <div style={{
        width: 56, flexShrink: 0,
        fontSize: 9.5, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase',
        color: 'var(--ink-3)',
      }}>{label}</div>
      <button onClick={onClear} type="button"
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontFamily: 'var(--mono)', fontSize: 11,
          color: !active ? 'var(--ink)' : 'var(--ink-3)',
          fontWeight: !active ? 600 : 400,
          borderBottom: !active ? '2px solid var(--accent)' : '2px solid transparent',
          lineHeight: 1.5,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
        All <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>{totalCount}</span>
      </button>
      {options.map(opt => {
        const isOn = active === opt.value
        return (
          <span key={opt.value} style={{ display: 'inline-flex', alignItems: 'baseline' }}>
            {sep}
            <button onClick={() => onPick(opt.value)} type="button"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                fontFamily: 'var(--mono)', fontSize: 11,
                color: isOn ? 'var(--ink)' : 'var(--ink-3)',
                fontWeight: isOn ? 600 : 400,
                borderBottom: isOn ? '2px solid var(--accent)' : '2px solid transparent',
                lineHeight: 1.5,
                display: 'inline-flex', alignItems: 'center', gap: 5,
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
              {opt.dot && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: opt.dot, display: 'inline-block' }} />
              )}
              <span>{opt.label}</span>
              <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>{opt.count}</span>
            </button>
          </span>
        )
      })}
    </div>
  )
}

function CreativeCard({ row, isUsed = false, onClick, selected = false, selectionMode = false, onToggleSelect = null }) {
  const [hover, setHover] = useState(false)
  // In selectionMode, clicking the tile body toggles selection instead of
  // opening the drawer. Click the checkbox directly to toggle out of
  // selection mode. The checkbox is always visible to onToggleSelect-
  // enabled viewers (otherwise it's hidden entirely).
  const handleCardClick = (e) => {
    if (selectionMode && onToggleSelect) {
      onToggleSelect(row.id)
    } else {
      onClick?.()
    }
  }
  const handleCheckboxClick = (e) => {
    e.stopPropagation()
    if (onToggleSelect) onToggleSelect(row.id)
  }
  return (
    <div onClick={handleCardClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: 'pointer',
        background: 'var(--paper)',
        border: selected ? '2px solid var(--accent)'
              : hover ? '1px solid var(--ink)'
              : '1px solid var(--rule)',
        transition: 'border-color 0.12s',
        position: 'relative',
        outline: selected ? '1px solid rgba(240,224,80,0.5)' : 'none',
        outlineOffset: selected ? 1 : 0,
      }}>
      {/* Selection checkbox — top-left corner. Always visible if a
          toggle handler is wired in; hover/selected states have stronger
          contrast. */}
      {onToggleSelect && (
        <div onClick={handleCheckboxClick}
          style={{
            position: 'absolute', top: 8, left: 8, zIndex: 3,
            width: 22, height: 22,
            borderRadius: 3,
            background: selected ? 'var(--accent)' : 'rgba(255,255,255,0.92)',
            border: selected ? '2px solid var(--ink)' : '1.5px solid var(--ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            opacity: (selected || hover || selectionMode) ? 1 : 0.55,
            transition: 'opacity 0.12s, background 0.12s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          }}
          title={selected ? 'Deselect' : 'Select for bulk edit'}>
          {selected && (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}
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
          textDecoration: (row.status === 'raw' && isUsed) ? 'line-through' : 'none',
          opacity: (row.status === 'raw' && isUsed) ? 0.7 : 1,
        }} title={row.name}>
          {(row.status === 'raw' && isUsed) && (
            <span title="Already edited"
              style={{ color: '#3e8a5e', marginRight: 4 }}>✓</span>
          )}
          {row.canonical_name || row.name}
        </div>
        <div style={{
          marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
          fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          {row.creator && <span>{row.creator}</span>}
          {row.offer_slug && (() => {
            const oc = offerColor(row.offer_slug)
            const short = row.offer_slug.replace(/^opt-/, '').replace(/-stub$/, '').replace(/-template$/, '')
            return (
              <span style={{
                padding: '1px 5px',
                background: oc.soft, color: oc.ink,
                border: '1px solid ' + oc.border, borderRadius: 2,
                fontWeight: 600,
              }}>{short}</span>
            )
          })()}
          {row.has_been_run && (
            <span title="Run before"
              style={{ width: 7, height: 7, borderRadius: '50%', background: '#3e8a5e' }} />
          )}
          <span style={{ marginLeft: 'auto' }}><StatusBadge status={row.status} /></span>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────── DETAIL MODAL (click row) ─────────────────────── */

function CreativeDetailModal({ row, scope = ADMIN_SCOPE, editors: editorsProp, offers: offersProp, knownCreators: knownCreatorsProp, onClose, onSaved, onRowPatched, onDeleted }) {
  const [edit, setEdit] = useState(row)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [autoSaveStatus, setAutoSaveStatus] = useState('idle') // idle | saving | saved | error
  // Prefer props from the parent (avoid 3 extra network roundtrips
  // each time the modal opens). Fall back to local fetch if the
  // parent didn't pass them (e.g. modal opened standalone somewhere).
  const [editorsLocal, setEditorsLocal] = useState([])
  const [offersLocal, setOffersLocal] = useState([])
  const [knownCreatorsLocal, setKnownCreatorsLocal] = useState([])
  const editors = editorsProp && editorsProp.length > 0 ? editorsProp : editorsLocal
  const offers = offersProp && offersProp.length > 0 ? offersProp : offersLocal
  const knownCreators = knownCreatorsProp && knownCreatorsProp.length > 0 ? knownCreatorsProp : knownCreatorsLocal
  const [showAdvanced, setShowAdvanced] = useState(false)
  // When the viewer is an editor on /editor-view, auto-target them as the assignee.
  const [assignEditor, setAssignEditor] = useState(scope.isEditorView ? (scope.editorId || '') : '')
  const [assignDue, setAssignDue] = useState('')
  const [assignPriority, setAssignPriority] = useState('P2 - Medium')
  const [assignTaskType, setAssignTaskType] = useState('edit')
  const [assignBusy, setAssignBusy] = useState(false)
  const [existingTasks, setExistingTasks] = useState([])
  const firstEditRef = useRef(true)
  const saveTimerRef = useRef(null)
  const savedFlashTimerRef = useRef(null)
  // Track if any auto-save fired during this modal session — if so, we
  // ping onSaved() ONCE when the modal closes so the parent list reloads
  // with fresh data. Avoids the "screen refreshes every keystroke" jank.
  const dirtyDuringSessionRef = useRef(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const deleteCreative = async () => {
    // Cancel any pending debounced auto-save — without this, a save that
    // was queued (e.g. user edited a field then clicked Delete within 600ms)
    // would fire AFTER the delete, re-upserting the row back into the DB.
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    setDeleting(true); setErr(null)
    const { error } = await supabase.from('lib_creative_library').delete().eq('id', row.id)
    setDeleting(false)
    if (error) {
      setErr(error.message)
      setConfirmDelete(false)
    } else {
      onDeleted?.()
    }
  }

  useEffect(() => {
    let mounted = true
    // Editing-queue tasks for this creative — always fetch (row-specific).
    supabase.from('lib_editing_queue').select('*').eq('creative_id', row.id)
      .then(({ data }) => { if (mounted) setExistingTasks(data || []) })
    // Only fetch editors / offers / creators if the parent didn't pass
    // them as props. Avoids 3 redundant queries per modal open.
    if (!editorsProp || editorsProp.length === 0) {
      supabase.from('lib_creative_editors').select('*').eq('active', true).order('name')
        .then(({ data }) => { if (mounted) setEditorsLocal(data || []) })
    }
    if (!offersProp || offersProp.length === 0) {
      supabase.from('offers').select('slug,name').eq('retired', false).order('slug')
        .then(({ data }) => { if (mounted) setOffersLocal(data || []) })
    }
    if (!knownCreatorsProp || knownCreatorsProp.length === 0) {
      supabase.from('lib_creative_library').select('creator')
        .not('creator', 'is', null).eq('exclude_from_library', false)
        .then(({ data }) => {
          if (!mounted) return
          const set = new Set((data || []).map(r => r.creator).filter(Boolean))
          setKnownCreatorsLocal(Array.from(set).sort())
        })
    }
    return () => { mounted = false }
  }, [row.id, editorsProp, offersProp, knownCreatorsProp])

  const save = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setSaving(true)
    setErr(null)
    setAutoSaveStatus('saving')
    const { error } = await supabase
      .from('lib_creative_library')
      .update({
        type: edit.type, creator: edit.creator, status: edit.status,
        v21_script_id: edit.v21_script_id, notes: edit.notes,
        canonical_name: edit.canonical_name,
        assigned_editor_id: edit.assigned_editor_id || null,
        offer_slug: edit.offer_slug || null,
        has_been_run: !!edit.has_been_run,
      })
      .eq('id', row.id)
    if (!silent) setSaving(false)
    if (error) {
      setErr(error.message)
      setAutoSaveStatus('error')
    } else {
      setAutoSaveStatus('saved')
      // Auto-saves DON'T trigger a parent reload — that was causing the
      // "screen refreshes on every keystroke" jank. We track that something
      // changed and ping onSaved() once when the modal closes.
      if (silent) dirtyDuringSessionRef.current = true
      else onSaved?.()
      if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current)
      savedFlashTimerRef.current = setTimeout(() => setAutoSaveStatus('idle'), 1500)
    }
  }, [edit, row.id, onSaved])

  // Wrap onClose. If we made any auto-saves during the session, patch
  // the parent's row state in-place via onRowPatched instead of calling
  // onSaved (which used to trigger a full grid reload — annoying). DB
  // is already up to date from the debounced saves; we just need the
  // parent to merge the new field values for this row.
  const handleClose = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      await save({ silent: true })
    }
    if (dirtyDuringSessionRef.current) {
      if (onRowPatched) {
        // Pass the full editable shape; parent merges only the fields it
        // tracks. No full reload, no grid flicker.
        onRowPatched(row.id, {
          type: edit.type, creator: edit.creator, status: edit.status,
          v21_script_id: edit.v21_script_id, notes: edit.notes,
          canonical_name: edit.canonical_name,
          assigned_editor_id: edit.assigned_editor_id || null,
          offer_slug: edit.offer_slug || null,
          has_been_run: !!edit.has_been_run,
        })
      } else {
        onSaved?.()  // legacy fallback if parent didn't wire onRowPatched
      }
      dirtyDuringSessionRef.current = false
    }
    onClose?.()
  }, [onClose, onSaved, onRowPatched, save, row.id, edit])

  // Auto-save on field changes — Notion-style. Debounced 600ms so we don't
  // hammer the DB during typing. Skip the first render (edit was just
  // hydrated from row) and skip entirely for read-only viewers.
  useEffect(() => {
    if (firstEditRef.current) { firstEditRef.current = false; return }
    if (!scope.canEditCreative) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { save({ silent: true }) }, 600)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [edit, save, scope.canEditCreative])

  // Cleanup pending timers on unmount
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current)
  }, [])

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
    <Modal open={true} onClose={handleClose} size="lg"
      eyebrow={edit.canonical_name || row.type || 'Creative'}
      title={row.canonical_name || row.name}
      subtitle={row.canonical_name ? row.name : `${row.source_bucket || ''}${row.size_mb ? ' · ' + Math.round(row.size_mb) + ' MB' : ''}`}
      footer={
        confirmDelete ? (
          <>
            <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto', fontFamily: 'var(--mono)' }}>
              Delete this creative permanently? Can't be undone.
            </span>
            <button onClick={() => setConfirmDelete(false)} disabled={deleting} style={ghostBtn}>Cancel</button>
            <button onClick={deleteCreative} disabled={deleting}
              style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
              {deleting ? 'Deleting…' : 'Delete forever'}
            </button>
          </>
        ) : (
          <>
            {scope.canEditCreative && (
              <span style={{
                fontSize: 11, fontFamily: 'var(--mono)', marginRight: 'auto',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                color: autoSaveStatus === 'error' ? '#b53e3e'
                     : autoSaveStatus === 'saving' ? 'var(--ink-3)'
                     : autoSaveStatus === 'saved' ? '#3e8a5e'
                     : 'var(--ink-4)',
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: autoSaveStatus === 'error' ? '#b53e3e'
                            : autoSaveStatus === 'saving' ? '#e8b408'
                            : autoSaveStatus === 'saved' ? '#3e8a5e'
                            : 'var(--ink-4)',
                }} />
                {autoSaveStatus === 'saving' ? 'Saving…'
                  : autoSaveStatus === 'saved' ? 'Saved'
                  : autoSaveStatus === 'error' ? (err || 'Save failed')
                  : 'Changes save automatically'}
              </span>
            )}
            {err && !scope.canEditCreative && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
            {scope.canDelete && onDeleted && (
              <button onClick={() => setConfirmDelete(true)}
                style={{ ...ghostBtn, color: '#b53e3e', borderColor: 'rgba(181,62,62,0.4)' }}>
                Delete
              </button>
            )}
            <button onClick={handleClose} style={ghostBtn}>Close</button>
            {scope.canEditCreative && (
              <button onClick={() => save()} disabled={saving} style={primaryBtn}>
                {saving ? 'Saving…' : 'Save now'}
              </button>
            )}
          </>
        )
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

        {/* Slim form — only the fields Ben actually uses to organise creatives.
            Notes, v21 script, and original filename are tucked into the
            'Advanced' disclosure below. */}
        <Field label="Name">
          <input type="text" value={edit.canonical_name || ''}
            onChange={e => setEdit({ ...edit, canonical_name: e.target.value })}
            style={inputStyle} />
        </Field>

        {/* Type — pill button group, color-coded per type. Much more
            scannable than a native select. */}
        <Field label="Type">
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {TYPES.map(t => {
              const isOn = edit.type === t
              const tc = typeColor(t)
              return (
                <button key={t} type="button"
                  onClick={() => setEdit({ ...edit, type: t })}
                  style={{
                    padding: '7px 12px', fontFamily: 'var(--mono)', fontSize: 11,
                    fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: isOn ? tc.ink : tc.soft,
                    color: isOn ? 'white' : tc.ink,
                    border: '1px solid ' + (isOn ? tc.ink : tc.border),
                    borderRadius: 2, cursor: 'pointer',
                    transition: 'all 0.1s',
                  }}>
                  {t}
                </button>
              )
            })}
          </div>
        </Field>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Status">
            <div style={{ display: 'flex', gap: 5 }}>
              {STATUSES.map(s => {
                const isOn = edit.status === s
                const color = STATUS_COLOR[s] || 'var(--ink-3)'
                return (
                  <button key={s} type="button"
                    onClick={() => setEdit({ ...edit, status: s })}
                    style={{
                      flex: 1, padding: '8px 14px',
                      fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      background: isOn ? color : 'white',
                      color: isOn ? 'white' : color,
                      border: '1px solid ' + color,
                      cursor: 'pointer', borderRadius: 2,
                    }}>
                    {STATUS_LABEL[s] || s}
                  </button>
                )
              })}
            </div>
          </Field>
          <Field label="Run before?">
            <button type="button"
              onClick={() => setEdit({ ...edit, has_been_run: !edit.has_been_run })}
              style={{
                padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11,
                fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                background: edit.has_been_run ? '#3e8a5e' : 'white',
                color: edit.has_been_run ? 'white' : 'var(--ink-3)',
                border: edit.has_been_run ? '1px solid #3e8a5e' : '1px solid var(--rule)',
                cursor: 'pointer', textAlign: 'center', width: '100%',
              }}>
              {edit.has_been_run ? 'Yes — run before' : 'No — not yet'}
            </button>
          </Field>
        </div>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <Field label="Creator">
            <CreatorPicker value={edit.creator || ''}
              known={knownCreators}
              onChange={v => setEdit({ ...edit, creator: v || null })} />
          </Field>
          <Field label="Offer / niche">
            <select value={edit.offer_slug || ''}
              onChange={e => setEdit({ ...edit, offer_slug: e.target.value || null })}
              style={selectStyle}>
              <option value="">— Pick offer —</option>
              {offers.map(o => <option key={o.slug} value={o.slug}>{o.name}</option>)}
            </select>
          </Field>
          <Field label="Assigned editor">
            <EditorPicker value={edit.assigned_editor_id}
              editors={editors}
              onChange={v => setEdit({ ...edit, assigned_editor_id: v || null })} />
          </Field>
        </div>

        {/* Advanced disclosure — only opens if user wants to touch the rarely-
            used fields. Keeps the default view clean. */}
        <button type="button" onClick={() => setShowAdvanced(v => !v)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '6px 0', textAlign: 'left',
            fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--ink-3)',
          }}>
          {showAdvanced ? '▾ Hide details' : '▸ More details (notes, v21 script, original filename)'}
        </button>
        {showAdvanced && (
          <>
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <Field label="v21 script slot">
                <input type="text" value={edit.v21_script_id || ''}
                  onChange={e => setEdit({ ...edit, v21_script_id: e.target.value })}
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
              <textarea value={edit.notes || ''}
                onChange={e => setEdit({ ...edit, notes: e.target.value })}
                rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)' }} />
            </Field>
          </>
        )}

        {row.transcript && <TranscriptBox text={row.transcript} />}

        {/* Versions — show v1/v2/v3... if this clip has siblings linked
            via parent_id. Includes an Upload-new-version button. */}
        <VersionsPanel row={row} onReload={() => onSaved?.()} />

        {/* Hook/Body history — when viewing a source clip, show which
            Joined composites have used it. */}
        <UsageHistory row={row} />

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
              <option value="edit">Edit</option>
              <option value="patch">Patch</option>
              <option value="revision">Revision</option>
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
  // Transcription is fire-and-forget — the modal can close before Whisper
  // returns. Gate setProgress calls so we don't try to setState on an
  // unmounted component.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])
  const safeSetProgress = (updater) => { if (mountedRef.current) setProgress(updater) }

  const acceptFiles = (incoming) => {
    const added = Array.from(incoming || []).filter(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name))
    if (added.length) setFiles(prev => [...prev, ...added])
  }

  const handleDrop = (e) => {
    e.preventDefault()
    acceptFiles(e.dataTransfer.files)
  }

  // Per-file pipeline:
  //   1. Insert library row (status='raw', type='Joined' as default)
  //   2. Upload file to creative-uploads bucket (skips files >900MB — bucket limit)
  //   3. Call transcribe-library-clip Edge Function → writes transcript
  //      onto the library row.
  // Each step updates the progress map so the user sees what's happening.
  const submit = async () => {
    if (!files.length) return
    setBusy(true); setErr(null)
    const stamp = new Date().toISOString().slice(0,10)
    let ok = 0, fail = 0
    for (const file of files) {
      setProgress(p => ({ ...p, [file.name]: 'creating row' }))
      try {
        // 1. Insert library row first so we get an ID to associate the upload with
        const { data: inserted, error: insErr } = await supabase
          .from('lib_creative_library')
          .insert({
            name: file.name,
            type: 'Joined',
            size_mb: Math.round(file.size / 1024 / 1024 * 10) / 10,
            status: 'raw',
            source_bucket: 'Manual upload',
            notes: `Uploaded via /sales/ads/creative/library on ${stamp}.`,
          })
          .select('id')
          .single()
        if (insErr) throw insErr
        const libraryId = inserted.id

        // 2. Upload file to creative-uploads bucket. Skip massive files
        //    (>900MB) — bucket limit is 1GB and we leave headroom.
        const tooLarge = file.size > 900 * 1024 * 1024
        let storagePath = null
        if (!tooLarge) {
          setProgress(p => ({ ...p, [file.name]: 'uploading' }))
          storagePath = `incoming/${libraryId}_${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`
          const { error: upErr } = await supabase.storage
            .from('creative-uploads')
            .upload(storagePath, file, { upsert: false, contentType: file.type || 'video/mp4' })
          if (upErr) throw upErr
        }

        // 3. Kick off transcription (only if we successfully uploaded the file).
        //    Don't await the response strictly — it can take 30s+ for long
        //    files. Fire-and-forget with a status check; UI will pick up the
        //    transcript on next page refresh.
        if (storagePath) {
          safeSetProgress(p => ({ ...p, [file.name]: 'transcribing' }))
          supabase.functions.invoke('transcribe-library-clip', {
            body: { library_id: libraryId, storage_path: storagePath },
          }).then(({ data, error: fnErr }) => {
            if (fnErr) {
              safeSetProgress(p => ({ ...p, [file.name]: 'transcribe failed: ' + fnErr.message }))
            } else if (data?.error) {
              // Function returned 4xx/5xx body (e.g. Whisper 25MB limit)
              safeSetProgress(p => ({ ...p, [file.name]: 'transcribe failed: ' + data.error }))
            } else {
              safeSetProgress(p => ({ ...p, [file.name]: 'done (transcribed)' }))
            }
          })
          // Mark "uploaded" right away — transcript arrives later
          safeSetProgress(p => ({ ...p, [file.name]: 'uploaded · transcribing in background' }))
        } else {
          safeSetProgress(p => ({ ...p, [file.name]: 'row created (file too large to upload)' }))
        }
        ok++
      } catch (e) {
        setProgress(p => ({ ...p, [file.name]: 'error: ' + (e.message || 'failed') }))
        fail++
      }
    }
    setBusy(false)
    if (fail === 0) {
      // Refresh list immediately so new rows appear; transcripts fill in
      // a few seconds later (next manual refresh picks them up).
      setTimeout(() => onSaved?.(), 800)
    } else {
      setErr(`${ok} uploaded, ${fail} failed — see list below`)
    }
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="md"
      eyebrow="Upload"
      title={`Add ${files.length || ''} new creative${files.length === 1 ? '' : 's'}`}
      subtitle="Drop video files (up to 900MB each). We upload to the library bucket and auto-transcribe via Whisper. Transcripts appear in the row's detail modal once ready (usually <60s)."
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
  // Prefill for AddTaskModal — set when the user drags across days in
  // the Timeline view. Falls back to empty fields when opened via the
  // toolbar button or the editor row '+ Add' button.
  const [addTaskPrefill, setAddTaskPrefill] = useState({ editorId: '', due: '', start: '' })
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

  // Group by editor (on filtered tasks). We also seed an entry for every
  // active editor — even if they have zero tasks — so they appear as a
  // drop target. Otherwise you couldn't drag a task TO an editor who
  // currently has no work.
  const byEditor = useMemo(() => {
    const m = new Map()
    // Always include "Unassigned" as a drop target
    m.set('unassigned', { editor_id: null, editor_name: 'Unassigned', tasks: [] })
    for (const e of editors.filter(e => e.active)) {
      m.set(e.slug || e.id, { editor_id: e.id, editor_name: e.name, tasks: [] })
    }
    for (const t of filteredTasks) {
      const key = t.editor_slug || 'unassigned'
      if (!m.has(key)) m.set(key, { editor_id: t.editor_id || null, editor_name: t.editor_name || 'Unassigned', tasks: [] })
      m.get(key).tasks.push(t)
    }
    return Array.from(m.entries()).map(([slug, v]) => ({ slug, ...v }))
  }, [filteredTasks, editors])

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

  // Move a task to a new status (Kanban drag-and-drop). Optimistic update:
  // patch local state immediately, then write to DB. Roll back on error.
  const moveTaskStatus = useCallback(async (task, nextStatus) => {
    if (!task || !nextStatus || task.status === nextStatus) return
    const prevStatus = task.status
    setTasks(prev => prev.map(t => t.task_id === task.task_id ? { ...t, status: nextStatus } : t))
    const { error } = await supabase
      .from('lib_editing_tasks')
      .update({ status: nextStatus })
      .eq('id', task.task_id)
    if (error) {
      setTasks(prev => prev.map(t => t.task_id === task.task_id ? { ...t, status: prevStatus } : t))
      setErr(error.message)
    }
  }, [])

  // General-purpose task assignment update — handles editor change AND/OR
  // date shift in a single optimistic update + DB write. Used by:
  //   - Lane drop (drag to another editor's row)
  //   - Date drop  (drag within a row to a different X position)
  //   - Combined  (drag to another row at a different X)
  const updateTaskAssignment = useCallback(async (task, { editorId, assignedAt, dueDate }) => {
    if (!task) return
    const patch = {}
    if (editorId !== undefined)  patch.editor_id  = editorId
    if (assignedAt !== undefined) patch.assigned_at = assignedAt
    if (dueDate !== undefined)   patch.due_date   = dueDate
    if (Object.keys(patch).length === 0) return

    const prevState = {
      editor_id: task.editor_id, editor_name: task.editor_name, editor_slug: task.editor_slug,
      assigned_at: task.assigned_at, due_date: task.due_date,
    }
    const editor = editorId !== undefined ? editors.find(e => e.id === editorId) : null
    setTasks(curr => curr.map(t => {
      if (t.task_id !== task.task_id) return t
      const next = { ...t }
      if (editorId !== undefined) {
        next.editor_id   = editorId
        next.editor_name = editor?.name || (editorId ? '…' : 'Unassigned')
        next.editor_slug = editor?.slug || null
      }
      if (assignedAt !== undefined) next.assigned_at = assignedAt
      if (dueDate !== undefined)    next.due_date    = dueDate
      return next
    }))
    const { error } = await supabase.from('lib_editing_tasks').update(patch).eq('id', task.task_id)
    if (error) {
      setTasks(curr => curr.map(t => t.task_id === task.task_id ? { ...t, ...prevState } : t))
      setErr(error.message)
    }
  }, [editors])

  // Compatibility wrapper — existing callers (Editor Lanes view, etc.)
  // still call moveTaskToEditor(task, editorId).
  const moveTaskToEditor = useCallback((task, nextEditorId) => {
    if (!task) return
    if ((task.editor_id || null) === (nextEditorId || null)) return
    return updateTaskAssignment(task, { editorId: nextEditorId || null })
  }, [updateTaskAssignment])

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
          {byEditor.map(({ slug, editor_id, editor_name, tasks: t }) => (
            <EditorLane key={slug}
              editor={editor_name}
              editorId={editor_id}
              tasks={t}
              onEdit={setEditingTask}
              onMoveEditor={moveTaskToEditor} />
          ))}
        </div>
      ) : view === 'timeline' ? (
        <TimelineView tasks={filteredTasks} editors={editors.filter(e => e.active)}
          onEdit={setEditingTask} onMoveEditor={moveTaskToEditor}
          onUpdateAssignment={updateTaskAssignment}
          onAddTask={(pre) => { setAddTaskPrefill(pre); setAddTaskOpen(true) }} />
      ) : (
        <KanbanView tasks={filteredTasks} onEdit={setEditingTask} onMove={moveTaskStatus} />
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
          prefillEditorId={addTaskPrefill.editorId}
          prefillDue={addTaskPrefill.due}
          prefillStart={addTaskPrefill.start}
          onClose={() => { setAddTaskOpen(false); setAddTaskPrefill({ editorId: '', due: '', start: '' }) }}
          onSaved={() => { setAddTaskOpen(false); setAddTaskPrefill({ editorId: '', due: '', start: '' }); load() }} />
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
  const [taskType, setTaskType] = useState(task.task_type || 'edit')
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
      // All three task types now land in the 'final cut' slot — the editor's
      // output is treated as the working final cut, ready for review.
      const stageMap = {
        edit:     { url: 'final_cut_url', flag: 'stage_final_cut' },
        patch:    { url: 'final_cut_url', flag: 'stage_final_cut' },
        revision: { url: 'final_cut_url', flag: 'stage_final_cut' },
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
        {/* Source file — editor needs to grab the original to start editing.
            Yellow accent so it's the first thing they see when the modal opens. */}
        {task.drive_url && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px',
            background: 'var(--paper-2)',
            border: '1px solid var(--rule)',
            borderLeft: '3px solid var(--accent)',
          }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
            }}>Source file</span>
            <span style={{ flex: 1 }} />
            <a href={task.drive_url} target="_blank" rel="noreferrer"
              style={{
                padding: '6px 12px',
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'var(--accent)', color: 'var(--ink)',
                border: 'none', cursor: 'pointer', textDecoration: 'none',
              }}>Open in Drive</a>
            <a href={task.drive_url} target="_blank" rel="noreferrer"
              download
              style={{
                padding: '6px 12px',
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'white', color: 'var(--ink)',
                border: '1px solid var(--ink)', cursor: 'pointer', textDecoration: 'none',
              }}>Download original</a>
          </div>
        )}

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
              <option value="edit">Edit</option>
              <option value="patch">Patch</option>
              <option value="revision">Revision</option>
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
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const toggleSel = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const selectAll = () => setSelectedIds(new Set(editors.map(e => e.id)))
  const clearSel = () => setSelectedIds(new Set())
  const bulkDelete = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_creative_editors')
      .delete().in('id', Array.from(selectedIds))
    setBusy(false)
    if (error) setErr(error.message)
    else { setSelectedIds(new Set()); setConfirmBulkDelete(false); onChanged?.() }
  }

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

        {/* Bulk selection bar — sticky when any editor is selected */}
        {selectedIds.size > 0 && (
          <div style={{
            padding: '10px 14px', background: 'var(--ink)', color: 'white',
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em' }}>
              {selectedIds.size} SELECTED
            </span>
            <button onClick={selectAll} style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'white',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Select all ({editors.length})</button>
            <button onClick={clearSel} style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'white',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Clear</button>
            <span style={{ flex: 1 }} />
            {confirmBulkDelete ? (
              <>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#ffb4b4' }}>
                  Delete {selectedIds.size} editor{selectedIds.size === 1 ? '' : 's'} forever? Their tasks become Unassigned.
                </span>
                <button onClick={() => setConfirmBulkDelete(false)} disabled={busy} style={{
                  padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  background: 'transparent', color: 'white',
                  border: '1px solid rgba(255,255,255,0.5)', cursor: 'pointer',
                }}>Cancel</button>
                <button onClick={bulkDelete} disabled={busy} style={{
                  padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  background: '#b53e3e', color: 'white', border: 'none', cursor: 'pointer',
                }}>{busy ? 'Deleting…' : 'Delete forever'}</button>
              </>
            ) : (
              <button onClick={() => setConfirmBulkDelete(true)} style={{
                padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: 'var(--accent)', color: 'var(--ink)',
                border: 'none', cursor: 'pointer',
              }}>Delete {selectedIds.size}</button>
            )}
          </div>
        )}

        {/* Roster table */}
        <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '24px 32px minmax(160px, 1fr) 90px 90px 100px 80px',
            gap: 10, padding: '10px 14px',
            background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
          }}>
            <div></div>
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
            const color = editorColor(e)
            const isSel = selectedIds.has(e.id)
            return (
              <div key={e.id} onClick={() => onOpenEditor(e)} style={{
                display: 'grid',
                gridTemplateColumns: '24px 32px minmax(160px, 1fr) 90px 90px 100px 80px',
                gap: 10, padding: '10px 14px', alignItems: 'center',
                borderBottom: i === editors.length - 1 ? 'none' : '1px solid var(--rule)',
                cursor: 'pointer', transition: 'background 0.12s',
                opacity: e.active ? 1 : 0.55,
                background: isSel ? 'rgba(244,225,74,0.15)' : 'transparent',
              }}
                onMouseEnter={ev => { if (!isSel) ev.currentTarget.style.background = 'var(--paper-2)' }}
                onMouseLeave={ev => { if (!isSel) ev.currentTarget.style.background = 'transparent' }}>
                <div onClick={ev => { ev.stopPropagation(); toggleSel(e.id) }}
                  style={{
                    width: 16, height: 16, borderRadius: 2,
                    border: isSel ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                    background: isSel ? 'var(--accent)' : 'white',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer',
                  }}>
                  {isSel && (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                      <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                        strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
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
  const [color, setColor] = useState(editor.color || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)
  const [confirmHardDelete, setConfirmHardDelete] = useState(false)
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
      .update({ name: name.trim(), active, notes: notes || null, color: color || null })
      .eq('id', editor.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved?.()
  }
  const deactivate = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_creative_editors')
      .update({ active: false }).eq('id', editor.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onDeleted?.()
  }
  // Hard delete — removes the row entirely. Editing tasks that referenced
  // this editor get editor_id=NULL via ON DELETE SET NULL (per migration 075).
  const hardDelete = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_creative_editors')
      .delete().eq('id', editor.id)
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
          {confirmDeactivate ? (
            <>
              <span style={{ fontSize: 12, color: '#b53e3e', marginRight: 'auto' }}>Deactivate this editor? Their existing tasks stay.</span>
              <button onClick={() => setConfirmDeactivate(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={deactivate} disabled={busy} style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
                {busy ? '…' : 'Deactivate'}
              </button>
            </>
          ) : confirmHardDelete ? (
            <>
              <span style={{ fontSize: 12, color: '#b53e3e', marginRight: 'auto' }}>
                Permanently delete? Their existing tasks become Unassigned. Can't be undone.
              </span>
              <button onClick={() => setConfirmHardDelete(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={hardDelete} disabled={busy} style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
                {busy ? '…' : 'Delete forever'}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setConfirmDeactivate(true)} disabled={busy} style={{
                ...ghostBtn, color: 'var(--ink-3)', borderColor: 'var(--rule)', marginRight: 4,
              }}>Deactivate</button>
              <button onClick={() => setConfirmHardDelete(true)} disabled={busy} style={{
                ...ghostBtn, color: '#b53e3e', borderColor: 'rgba(181,62,62,0.4)', marginRight: 'auto',
              }}>Delete forever</button>
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
        <Field label="Color">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Reset to auto (hash-derived) */}
            <button type="button" onClick={() => setColor('')}
              title="Use the auto color (hash from name)"
              style={{
                width: 28, height: 28, borderRadius: 4,
                background: 'repeating-linear-gradient(45deg, var(--paper), var(--paper) 4px, var(--rule) 4px, var(--rule) 6px)',
                border: !color ? '2px solid var(--ink)' : '1px solid var(--rule)',
                cursor: 'pointer',
              }} />
            {EDITOR_COLORS.map(c => (
              <button key={c} type="button" onClick={() => setColor(c)}
                title={c}
                style={{
                  width: 28, height: 28, borderRadius: 4,
                  background: c,
                  border: color === c ? '2px solid var(--ink)' : '1px solid rgba(0,0,0,0.15)',
                  cursor: 'pointer',
                }} />
            ))}
            <input type="color" value={color || editorColor({ slug: editor.slug, color: null })}
              onChange={e => setColor(e.target.value)}
              title="Pick a custom hex color"
              style={{ width: 28, height: 28, border: '1px solid var(--rule)', borderRadius: 4, cursor: 'pointer', background: 'white', padding: 0 }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
            {color ? `Custom: ${color}` : 'Auto (hash of name)'}
          </div>
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

function AddTaskModal({ editors, onClose, onSaved, prefillEditorId = '', prefillDue = '', prefillStart = '' }) {
  const [mode, setMode] = useState('pick')   // 'pick' or 'upload'
  const [creatives, setCreatives] = useState([])
  const [search, setSearch] = useState('')
  // Selected creative(s) — Set of ids. UI toggles between single and multi:
  // checkbox per row + a "Select all visible" affordance.
  const [creativeIds, setCreativeIds] = useState(() => new Set())
  // Upload-mode state
  const [uploadFile, setUploadFile] = useState(null)
  const [uploadName, setUploadName] = useState('')
  const [uploadType, setUploadType] = useState('Joined')
  const [uploadProgress, setUploadProgress] = useState(null)
  const uploadInputRef = useRef(null)
  // Common state — accept pre-fill from Timeline drag
  const [editorId, setEditorId] = useState(prefillEditorId || '')
  const [taskType, setTaskType] = useState('edit')
  const [priority, setPriority] = useState('P2 - Medium')
  const [due, setDue] = useState(prefillDue || '')
  // Optional start date — if user dragged across multiple days in the
  // timeline, we capture the first day as the task's assigned_at.
  const [startDate, setStartDate] = useState(prefillStart || '')
  // Optional project name applied as canonical_name prefix when assigning
  // multiple creatives at once — Ben asked to "rename the project for
  // multiple videos" in one shot from this modal.
  const [projectName, setProjectName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    supabase.from('lib_creative_library')
      .select('id,name,canonical_name,type,creator,thumbnail_url,description')
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
      let cids = []
      // Upload mode: upload file → insert library row → single creative id
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
        cids = [newRow.id]
        setUploadProgress(85)
      } else {
        cids = Array.from(creativeIds)
      }
      if (cids.length === 0) { setErr('Pick one or more creatives or upload a new file'); setBusy(false); return }

      // Optional: bulk-rename the picked creatives to a shared project name.
      // Format: "<projectName> 1", "<projectName> 2", ... so each row has
      // a unique canonical_name (no DB unique constraint, but Ben wants
      // them visually distinct in lists).
      if (projectName.trim() && mode === 'pick') {
        const proj = projectName.trim()
        const updates = cids.map((id, i) => ({ id, canonical_name: cids.length === 1 ? proj : `${proj} ${i + 1}` }))
        // Bulk update via individual writes — Supabase doesn't have a clean
        // 'upsert different values per row' API. N is small (selected count)
        // so this is fine.
        for (const u of updates) {
          const { error: rnErr } = await supabase.from('lib_creative_library')
            .update({ canonical_name: u.canonical_name })
            .eq('id', u.id)
          if (rnErr) throw rnErr
        }
      }

      // Insert ONE task per selected creative
      // If the user dragged across days in Timeline, startDate is set —
      // we use it as assigned_at so the bar in Timeline spans from start
      // to due_date instead of from "now" to due.
      const assignedAt = startDate ? new Date(startDate + 'T00:00:00Z').toISOString() : null
      const rows = cids.map(creative_id => ({
        creative_id,
        editor_id: editorId || null,
        task_type: taskType, priority, due_date: due || null,
        ...(assignedAt ? { assigned_at: assignedAt } : {}),
        status: editorId ? 'queued' : 'review',
      }))
      const { error: taskErr } = await supabase.from('lib_editing_tasks').insert(rows)
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
    ? creativeIds.size > 0
    : !!uploadFile && !!uploadName.trim()
  const toggleCreative = (id) => {
    setCreativeIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

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
          <>
            <Field label={`Creatives ${creativeIds.size > 0 ? `· ${creativeIds.size} selected` : ''}`}>
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search by name…" style={{ ...inputStyle, marginBottom: 8 }} />
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                marginBottom: 6, gap: 8,
              }}>
                <button type="button"
                  onClick={() => setCreativeIds(new Set(filtered.map(c => c.id)))}
                  style={{
                    padding: '4px 9px',
                    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
                    textTransform: 'uppercase', background: 'transparent',
                    border: '1px solid var(--rule)', cursor: 'pointer', color: 'var(--ink-2)',
                  }}>Select all visible ({filtered.length})</button>
                {creativeIds.size > 0 && (
                  <button type="button" onClick={() => setCreativeIds(new Set())}
                    style={{
                      padding: '4px 9px',
                      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
                      textTransform: 'uppercase', background: 'transparent',
                      border: '1px solid var(--rule)', cursor: 'pointer', color: 'var(--ink-3)',
                    }}>Clear</button>
                )}
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--rule)' }}>
                {filtered.length === 0 && (
                  <div style={{ padding: 12, fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 12 }}>
                    No matches.
                  </div>
                )}
                {filtered.map(c => {
                  const isOn = creativeIds.has(c.id)
                  return (
                    <div key={c.id}
                      onClick={() => toggleCreative(c.id)}
                      style={{
                        padding: '6px 10px', cursor: 'pointer',
                        background: isOn ? 'rgba(244,225,74,0.18)' : 'transparent',
                        borderBottom: '1px solid var(--rule)',
                        fontFamily: 'var(--mono)', fontSize: 11.5,
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                      <span style={{
                        width: 16, height: 16, borderRadius: 2,
                        border: isOn ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                        background: isOn ? 'var(--accent)' : 'white',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        {isOn && (
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                            <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                              strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      {/* Thumbnail — visual ID for cryptic canonical names */}
                      <div style={{
                        width: 48, height: 32, background: '#000',
                        border: '1px solid var(--rule)',
                        overflow: 'hidden', flexShrink: 0,
                      }}>
                        {c.thumbnail_url ? (
                          <img src={c.thumbnail_url} alt="" loading="lazy"
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                        ) : (
                          <div style={{
                            width: '100%', height: '100%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)',
                          }}>—</div>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          fontWeight: 500,
                        }}>{c.canonical_name || c.name}</div>
                        {c.description && (
                          <div style={{
                            fontFamily: 'var(--sans)', fontSize: 10.5, color: 'var(--ink-3)',
                            marginTop: 1,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{c.description}</div>
                        )}
                      </div>
                      <span style={{ color: 'var(--ink-4)', fontSize: 10 }}>{c.type}</span>
                    </div>
                  )
                })}
              </div>
            </Field>
            {/* Project rename — applies the same project name to all selected
                creatives (auto-numbered when there's more than one). */}
            {creativeIds.size > 0 && (
              <Field label={creativeIds.size === 1 ? 'Optional: rename this creative' : `Optional: rename all ${creativeIds.size} as a project`}>
                <input type="text" value={projectName} onChange={e => setProjectName(e.target.value)}
                  placeholder={creativeIds.size === 1 ? 'New name (leave blank to keep current)' : 'e.g. HAMMER campaign — will become "HAMMER campaign 1", "HAMMER campaign 2"…'}
                  style={inputStyle} />
              </Field>
            )}
          </>
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
                  {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
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
              <option value="edit">Edit</option>
              <option value="patch">Patch</option>
              <option value="revision">Revision</option>
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
        {/* Optional start date — appears auto-filled when user dragged
            across days in Timeline. Lets them tweak before saving. */}
        {(startDate || prefillStart) && (
          <Field label="Start date (drag-created task)">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

/* ─────────────────────── TIMELINE (Gantt-style) ─────────────────────── */

function TimelineView({ tasks, editors, onEdit, onMoveEditor, onUpdateAssignment, onAddTask }) {
  const [range, setRange] = useState(() => {
    try { return localStorage.getItem('queue.timelineRange') || 'month' } catch { return 'month' }
  })
  useEffect(() => { try { localStorage.setItem('queue.timelineRange', range) } catch {} }, [range])
  const [offsetDays, setOffsetDays] = useState(0)
  // Drag/drop state — which editor lane is currently a hover-drop target,
  // and the id of the task being dragged (so we can show a banner +
  // highlight every drop target while drag is in flight).
  const [dropOnId, setDropOnId] = useState(null)
  const [draggingTaskId, setDraggingTaskId] = useState(null)
  // Calendar-style drag-to-create: click on a day cell, drag across N days,
  // release to open AddTask with editor + start/end dates pre-filled.
  // { editorId, startIdx, endIdx } or null.
  const [dragCreate, setDragCreate] = useState(null)
  const tasksById = useMemo(() => Object.fromEntries(tasks.map(t => [t.task_id, t])), [tasks])
  const draggingTask = draggingTaskId ? tasksById[draggingTaskId] : null

  const handleTaskDragStart = (e, task) => {
    e.dataTransfer.setData('application/x-task-id', task.task_id)
    e.dataTransfer.setData('text/plain', task.task_id)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingTaskId(task.task_id)
  }
  const handleTaskDragEnd = () => {
    setDraggingTaskId(null)
    setDropOnId(null)
  }
  const handleLaneDragEnter = (e, editorId) => {
    if (!onMoveEditor) return
    e.preventDefault()
    if (dropOnId !== editorId) setDropOnId(editorId)
  }
  const handleLaneDragOver = (e, editorId) => {
    if (!onMoveEditor) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropOnId !== editorId) setDropOnId(editorId)
  }
  const handleLaneDragLeave = (e, editorId) => {
    // Only clear if leaving the row entirely (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget)) return
    if (dropOnId === editorId) setDropOnId(null)
  }
  const handleLaneDrop = (e, editorId) => {
    if (!onMoveEditor && !onUpdateAssignment) return
    e.preventDefault()
    setDropOnId(null)
    setDraggingTaskId(null)
    const taskId = e.dataTransfer.getData('application/x-task-id') || e.dataTransfer.getData('text/plain')
    if (!taskId) return
    const task = tasksById[taskId]
    if (!task) return
    const targetEditorId = editorId === 'unassigned' ? null : editorId

    // Compute the new start day from drop X relative to the lane container.
    // The row's left edge + 200px (editor info column) = lane's left edge.
    // Subtracting that from clientX gives lane-local X.
    const rowRect = e.currentTarget.getBoundingClientRect()
    const laneLeftPx = rowRect.left + 200
    const dropXInLane = e.clientX - laneLeftPx
    const newDayIdx = Math.max(0, Math.min(totalDays - 1, Math.floor(dropXInLane / dayWidth)))
    const newStart = dayLabel(newDayIdx)
    const newStartISO = newStart.toISOString()

    // Preserve duration: if task had assigned_at + due_date, shift due_date
    // by the same delta. Otherwise just set assigned_at and leave due alone.
    let newDueDate
    if (task.assigned_at && task.due_date) {
      const oldStart = new Date(task.assigned_at); oldStart.setUTCHours(0,0,0,0)
      const oldDue   = new Date(task.due_date);    oldDue.setUTCHours(0,0,0,0)
      const durationDays = Math.max(0, Math.round((oldDue - oldStart) / 86400000))
      const newDue = new Date(newStart); newDue.setUTCDate(newDue.getUTCDate() + durationDays)
      newDueDate = newDue.toISOString().slice(0, 10)
    }

    // Detect no-op: same editor + same start day = nothing to do
    const editorChanged = (task.editor_id || null) !== (targetEditorId || null)
    const oldStartISO = task.assigned_at ? new Date(task.assigned_at).toISOString().slice(0, 10) : null
    const dateChanged = newStart.toISOString().slice(0, 10) !== oldStartISO
    if (!editorChanged && !dateChanged) return

    const patch = {}
    if (editorChanged) patch.editorId = targetEditorId
    if (dateChanged) {
      patch.assignedAt = newStartISO
      if (newDueDate) patch.dueDate = newDueDate
    }
    onUpdateAssignment?.(task, patch)
  }

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
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)', position: 'relative' }}>
      {/* Drag-in-flight banner — sticky across the top so Ben can confirm
          the drag is actually active and see what's being moved. */}
      {draggingTask && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 50,
          padding: '8px 14px',
          background: 'var(--ink)', color: 'var(--paper)',
          fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', gap: 10,
          boxShadow: '0 4px 10px rgba(0,0,0,0.25)',
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />
          <span>Dragging:</span>
          <span style={{ color: 'var(--accent)' }}>{draggingTask.creative_name}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: 'rgba(255,255,255,0.6)' }}>
            Drop on any highlighted editor row to reassign
          </span>
        </div>
      )}
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
          // Always give the lane enough vertical room to fit every packed
          // bar with a row of padding to spare. The -ROW_GAP from before
          // could tighten the last row against the bottom edge so a 3rd+
          // bar would clip into the next editor's lane when overflow:hidden
          // was on. Now we add ROW_GAP of buffer instead.
          const laneHeight = Math.max(72, PADDING * 2 + rowCount * (BAR_HEIGHT + ROW_GAP) + ROW_GAP)
          const isDropTarget = dropOnId === editor.id
          // Every row gets a visible "drop target" indicator while a drag
          // is in flight — even ones not currently hovered — so Ben can
          // tell at a glance which rows will accept the drop.
          const isPotentialTarget = !!draggingTaskId && !!onMoveEditor &&
            (draggingTask?.editor_id || null) !== (editor.id === 'unassigned' ? null : editor.id)
          return (
            <div key={editor.id}
              onDragEnter={(onMoveEditor || onUpdateAssignment) ? (e) => handleLaneDragEnter(e, editor.id) : undefined}
              onDragOver={(onMoveEditor || onUpdateAssignment) ? (e) => handleLaneDragOver(e, editor.id) : undefined}
              onDragLeave={(onMoveEditor || onUpdateAssignment) ? (e) => handleLaneDragLeave(e, editor.id) : undefined}
              onDrop={(onMoveEditor || onUpdateAssignment) ? (e) => handleLaneDrop(e, editor.id) : undefined}
              style={{
                display: 'flex',
                borderBottom: '1px solid var(--rule)',
                minHeight: laneHeight,
                background: isDropTarget ? 'rgba(244,225,74,0.18)'
                          : isPotentialTarget ? 'rgba(244,225,74,0.04)'
                          : 'transparent',
                outline: isDropTarget ? '2px solid var(--accent)' : 'none',
                outlineOffset: '-2px',
                transition: 'background 0.1s',
              }}>
              <div style={{ width: 200, padding: '12px 14px',
                            borderRight: '1px solid var(--rule)', flexShrink: 0,
                            background: isDropTarget ? 'rgba(244,225,74,0.18)' : 'var(--paper-2)',
                            borderLeft: `4px solid ${color}`,
                            position: 'relative',
                          }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500 }}>{editor.name}</span>
                </div>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', marginTop: 4,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                }}>
                  <span>{editorTasks.length} task{editorTasks.length === 1 ? '' : 's'}</span>
                  {onAddTask && editor.id !== 'unassigned' && (
                    <button type="button"
                      onClick={(e) => { e.stopPropagation(); onAddTask({ editorId: editor.id, due: '' }) }}
                      title={`Add a new task for ${editor.name}`}
                      style={{
                        padding: '3px 8px',
                        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'var(--ink)', color: 'var(--paper)',
                        border: 'none', cursor: 'pointer', borderRadius: 2,
                      }}>+ Add</button>
                  )}
                </div>
              </div>
              <div style={{ position: 'relative', flex: 1, width: totalWidth, height: laneHeight, overflow: 'hidden' }}
                // Calendar-style drag-to-create: mousedown on an empty area,
                // drag across N days, release to open AddTask with editor +
                // start/end pre-filled. Skipped during a reassign-drag, on
                // the Unassigned row, or if onAddTask isn't wired.
                onMouseDown={(e) => {
                  if (draggingTaskId) return
                  if (!onAddTask || editor.id === 'unassigned') return
                  // Don't start drag-create if mousedown landed on a task bar
                  if (e.target.closest('[data-task-bar]')) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const idx = Math.max(0, Math.min(totalDays - 1, Math.floor((e.clientX - rect.left) / dayWidth)))
                  setDragCreate({ editorId: editor.id, startIdx: idx, endIdx: idx })
                }}
                onMouseMove={(e) => {
                  if (!dragCreate || dragCreate.editorId !== editor.id) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const idx = Math.max(0, Math.min(totalDays - 1, Math.floor((e.clientX - rect.left) / dayWidth)))
                  if (idx !== dragCreate.endIdx) setDragCreate({ ...dragCreate, endIdx: idx })
                }}
                onMouseUp={() => {
                  if (!dragCreate || dragCreate.editorId !== editor.id) return
                  const sIdx = Math.min(dragCreate.startIdx, dragCreate.endIdx)
                  const eIdx = Math.max(dragCreate.startIdx, dragCreate.endIdx)
                  const startISO = dayLabel(sIdx).toISOString().slice(0, 10)
                  const endISO = dayLabel(eIdx).toISOString().slice(0, 10)
                  onAddTask({ editorId: editor.id, due: endISO, start: startISO })
                  setDragCreate(null)
                }}
                onMouseLeave={() => {
                  // If they leave the lane mid-drag, cancel (avoids hung state)
                  if (dragCreate?.editorId === editor.id) setDragCreate(null)
                }}>
                {/* Drop-here hint shown on empty lanes during a drag */}
                {isDropTarget && editorTasks.length === 0 && (
                  <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    color: 'var(--ink-3)', pointerEvents: 'none', zIndex: 3,
                  }}>Drop to assign to {editor.name}</div>
                )}
                {/* Day grid lines — purely visual now. Pointer events are
                    disabled so the lane-level mouse handlers see the events
                    directly and we can drag-create across cells. */}
                {Array.from({ length: totalDays }, (_, i) => {
                  const d = dayLabel(i); const dow = d.getDay()
                  return (
                    <div key={i}
                      style={{
                        position: 'absolute', left: i * dayWidth, top: 0, bottom: 0,
                        width: dayWidth, borderRight: '1px solid var(--rule)',
                        background: dow === 0 || dow === 6 ? 'var(--paper-2)' : 'transparent',
                        pointerEvents: 'none',
                      }} />
                  )
                })}
                {/* Drag-create overlay — yellow rectangle while user is
                    dragging across days to define a new task's date range. */}
                {dragCreate && dragCreate.editorId === editor.id && (() => {
                  const sIdx = Math.min(dragCreate.startIdx, dragCreate.endIdx)
                  const eIdx = Math.max(dragCreate.startIdx, dragCreate.endIdx)
                  const left = sIdx * dayWidth
                  const width = (eIdx - sIdx + 1) * dayWidth
                  const startD = dayLabel(sIdx)
                  const endD = dayLabel(eIdx)
                  return (
                    <div style={{
                      position: 'absolute', left, top: 6, height: laneHeight - 12, width,
                      background: 'rgba(244,225,74,0.4)',
                      border: '2px solid var(--accent)',
                      borderRadius: 2, zIndex: 3, pointerEvents: 'none',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                      color: 'var(--ink)',
                    }}>
                      {startD.getDate()}{sIdx !== eIdx ? ` → ${endD.getDate()}` : ''} · release to add task
                    </div>
                  )
                })()}
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
                      data-task-bar="true"
                      onClick={() => onEdit?.(t)}
                      draggable={!!(onMoveEditor || onUpdateAssignment)}
                      onDragStart={(e) => handleTaskDragStart(e, t)}
                      onDragEnd={handleTaskDragEnd}
                      title={`${t.creative_name} · ${t.status}${t.due_date ? ' · due ' + t.due_date : ''}${t.is_overdue ? ' · OVERDUE' : ''}${(onMoveEditor || onUpdateAssignment) ? ' · drag horizontally to reschedule, or to another row to reassign' : ''}`}
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
                        overflow: 'hidden',
                        cursor: (onMoveEditor || onUpdateAssignment) ? 'grab' : (onEdit ? 'pointer' : 'default'),
                        zIndex: 1,
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

function KanbanView({ tasks, onEdit, onMove }) {
  const cols = ['queued', 'in_progress', 'review', 'blocked', 'done']
  const colLabels = {
    queued: 'Queued', in_progress: 'In progress', review: 'Review',
    blocked: 'Blocked', done: 'Done',
  }
  const colAccent = {
    queued: 'var(--ink-3)', in_progress: '#b86a0c', review: '#3e7eba',
    blocked: '#b53e3e', done: '#3e8a5e',
  }
  const byCol = Object.fromEntries(cols.map(c => [c, tasks.filter(t => t.status === c)]))
  const taskById = useMemo(() => Object.fromEntries(tasks.map(t => [t.task_id, t])), [tasks])
  const [dragOver, setDragOver] = useState(null)

  const handleDragStart = (e, task) => {
    e.dataTransfer.setData('text/plain', task.task_id)
    e.dataTransfer.effectAllowed = 'move'
  }
  const handleDragOver = (e, col) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOver !== col) setDragOver(col)
  }
  const handleDragLeave = (e, col) => {
    // Only clear if leaving the column (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget)) return
    if (dragOver === col) setDragOver(null)
  }
  const handleDrop = (e, col) => {
    e.preventDefault()
    setDragOver(null)
    const taskId = e.dataTransfer.getData('text/plain')
    const task = taskById[taskId]
    if (task && task.status !== col) onMove?.(task, col)
  }

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${cols.length}, 1fr)`,
      gap: 10, alignItems: 'flex-start',
    }}>
      {cols.map(c => (
        <div key={c}
          onDragOver={e => handleDragOver(e, c)}
          onDragLeave={e => handleDragLeave(e, c)}
          onDrop={e => handleDrop(e, c)}
          style={{
            background: 'var(--paper)',
            border: dragOver === c ? `2px dashed ${colAccent[c]}` : '1px solid var(--rule)',
            minHeight: 200, transition: 'border-color 0.12s',
          }}>
          <div style={{
            padding: '10px 14px', background: 'var(--paper-2)',
            borderBottom: '1px solid var(--rule)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                          letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: colAccent[c] }} />
              {colLabels[c]}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>{byCol[c].length}</div>
          </div>
          <div style={{ padding: 8, display: 'grid', gap: 8 }}>
            {byCol[c].map(t => (
              <QueueCard key={t.task_id} task={t}
                onClick={() => onEdit?.(t)}
                draggable={!!onMove}
                onDragStart={e => handleDragStart(e, t)} />
            ))}
            {byCol[c].length === 0 && dragOver === c && (
              <div style={{
                padding: '20px 12px', textAlign: 'center',
                fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
                letterSpacing: '0.08em', textTransform: 'uppercase',
              }}>Drop to move</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function EditorLane({ editor, editorId, tasks, onEdit, onMoveEditor }) {
  const [dragOver, setDragOver] = useState(false)
  const eColor = editorId ? editorColor(editor?.toLowerCase().replace(/\s+/g, '-') || '') : '#999'

  // Cache the task lookup once per render via a tasks-map on the parent
  // would be cleaner, but parsing the drag payload here is fine — it's
  // just an id roundtrip. We use a custom payload prefix so we don't
  // accidentally accept drops from the Kanban view.
  const handleDragStart = (e, task) => {
    e.dataTransfer.setData('text/plain', `lane:${task.task_id}`)
    e.dataTransfer.setData('application/x-task-id', task.task_id)
    e.dataTransfer.effectAllowed = 'move'
  }
  const handleDragOver = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragOver) setDragOver(true)
  }
  const handleDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
    if (dragOver) setDragOver(false)
  }
  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData('application/x-task-id') || e.dataTransfer.getData('text/plain')
    if (!raw) return
    const taskId = raw.startsWith('lane:') ? raw.slice(5) : raw
    // Find the task across ALL lanes by searching props.tasks first; if
    // not in this lane, parent's onMoveEditor will still work because we
    // pass a task-shaped object with editor_id for diff.
    const task = tasks.find(t => t.task_id === taskId)
      || { task_id: taskId, editor_id: null }  // shallow stub — parent has full state
    onMoveEditor?.(task, editorId)
  }

  return (
    <div
      onDragOver={onMoveEditor ? handleDragOver : undefined}
      onDragLeave={onMoveEditor ? handleDragLeave : undefined}
      onDrop={onMoveEditor ? handleDrop : undefined}
      style={{
        background: 'var(--paper)',
        border: dragOver ? `2px dashed ${eColor}` : '1px solid var(--rule)',
        transition: 'border-color 0.1s',
      }}>
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
        gap: 10, padding: 12, minHeight: 80,
      }}>
        {tasks.map(t => (
          <QueueCard key={t.task_id} task={t}
            onClick={() => onEdit?.(t)}
            draggable={!!onMoveEditor}
            onDragStart={e => handleDragStart(e, t)} />
        ))}
        {tasks.length === 0 && (
          <div style={{
            gridColumn: '1 / -1',
            padding: '12px', textAlign: 'center',
            fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
            letterSpacing: '0.08em', textTransform: 'uppercase',
            fontStyle: 'italic',
          }}>
            {dragOver ? 'Drop to assign' : 'No tasks · drag a card here to assign'}
          </div>
        )}
      </div>
    </div>
  )
}

function QueueCard({ task, onClick, draggable, onDragStart }) {
  const statusColor = {
    queued: 'var(--ink-3)',
    in_progress: '#b86a0c',
    review: '#3e7eba',
    done: '#3e8a5e',
    blocked: '#b53e3e',
  }[task.status] || 'var(--ink-3)'

  const eColor = task.editor_slug ? editorColor(task.editor_slug) : null

  return (
    <div onClick={onClick}
      draggable={!!draggable}
      onDragStart={onDragStart}
      style={{
        background: 'white', border: '1px solid var(--rule)',
        borderLeft: `3px solid ${statusColor}`,
        padding: '10px 12px',
        cursor: draggable ? 'grab' : (onClick ? 'pointer' : 'default'),
        transition: 'background 0.12s, opacity 0.12s',
      }}
      onMouseEnter={e => onClick && (e.currentTarget.style.background = 'var(--paper-2)')}
      onMouseLeave={e => onClick && (e.currentTarget.style.background = 'white')}
      onDragStartCapture={e => { e.currentTarget.style.opacity = '0.5' }}
      onDragEnd={e => { e.currentTarget.style.opacity = '1' }}>
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
      {/* Editor pill — surfaces who is working on this card */}
      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        {eColor ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 7px', borderRadius: 999,
            background: 'white', border: `1px solid ${eColor}`,
            fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-2)',
            fontWeight: 500,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: eColor }} />
            {task.editor_name}
          </span>
        ) : (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 7px', borderRadius: 999,
            background: '#fffaea', border: '1px solid #e8b408',
            fontFamily: 'var(--mono)', fontSize: 9.5, color: '#7a4e08',
            fontWeight: 500,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#e8b408' }} />
            Unassigned
          </span>
        )}
      </div>
      <div style={{
        marginTop: 6, display: 'flex', gap: 6, alignItems: 'center',
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
