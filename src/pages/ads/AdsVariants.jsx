import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Loader, AlertCircle, Search, Plus, Grid3x3, Trash2, ExternalLink, FlaskConical,
  LayoutGrid, Table2, X, Link2, TrendingUp, Trophy, Sparkles, Type, MessageSquare
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import ConfirmModal from '../../components/ConfirmModal'
import { pagedFetch } from '../../lib/pagedFetch'
import { useToast } from '../../hooks/useToast'
import { SectionHead } from '../../components/editorial/atoms'

// Clip-type colour tokens — keep in sync with CLIP_TYPES in AdsClips.jsx
// so the type chips read the same across both pages.
const CLIP_TYPE_COLORS = {
  hook:        'var(--ink)',
  body:        '#b8810b',
  testimonial: '#1f7a3a',
  full_video:  '#7a3aa6',
}

// Status color tokens — every status gets a consistent tint everywhere it
// appears (drawer dropdown, sheet pill, matrix cell, by-hook row).
// bg = filled background for the pill, fg = text color, accent = left-rule
// indicator color for table rows.
const STATUS_COLORS = {
  planned:  { bg: 'var(--paper-2)',                 fg: 'var(--ink-3)', accent: 'var(--rule)'   },
  editing:  { bg: 'rgba(10,10,10,0.08)',            fg: 'var(--ink)',   accent: 'var(--ink-3)'  },
  ready:    { bg: 'rgba(244,225,74,0.22)',          fg: 'var(--ink)',   accent: 'var(--accent)' },
  live:     { bg: 'var(--accent)',                  fg: 'var(--ink)',   accent: 'var(--accent)' },
  paused:   { bg: 'rgba(10,10,10,0.04)',            fg: 'var(--ink-3)', accent: 'var(--ink-4)'  },
  killed:   { bg: 'var(--down-soft, rgba(180,30,30,0.08))', fg: 'var(--down, #b41e1e)', accent: 'var(--down, #b41e1e)' },
  winner:   { bg: 'var(--accent)',                  fg: 'var(--ink)',   accent: 'var(--accent)' },
}

/*
  Variant board — Matrix-first.

  Three views (toggle in header):
    1. Matrix    — hooks × bodies grid. Default. Color-coded by performance.
                   Click a cell to open the detail drawer. Empty cells offer
                   one-click "create + link" to spin up a new variant for
                   that hook+body combo.
    2. Spreadsheet — inline-edit table (kept for bulk operations).
    3. By hook   — variants grouped by hook clip, so the operator can see
                   "this hook works regardless of body" patterns.

  Top of page: pattern strip showing top hook, top body, winner count,
  untested-combo count.

  Detail drawer (right-side, click a variant cell): shows the variant +
  links to a Meta ad picker (search live ads.ad_name), stage checkboxes,
  performance metrics, notes.
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

// Short-form a long clip ID for display: DEMO-BODY-B1-OSO → B1-OSO
function shortClipId(id, type) {
  if (!id) return ''
  let s = id
  if (s.startsWith('DEMO-')) s = s.slice(5)
  if (type === 'body' && s.startsWith('BODY-')) s = s.slice(5)
  if (type === 'hook' && /^H\d/.test(s)) s = s
  return s
}

// Performance heat — bucket each variant's spend into 0..4 for a heatmap tint.
function heatBucket(spend, maxSpend) {
  if (!spend || !maxSpend) return 0
  const ratio = spend / maxSpend
  if (ratio >= 0.66) return 4
  if (ratio >= 0.33) return 3
  if (ratio >= 0.1)  return 2
  return 1
}

export default function AdsVariants() {
  const [rows, setRows] = useState([])
  const [clips, setClips] = useState([])
  const [ads, setAds] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [view, setView] = useState('matrix')              // 'matrix' | 'sheet' | 'byHook'
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selectedVariant, setSelectedVariant] = useState(null)  // for the detail drawer
  const [seeding, setSeeding] = useState(false)
  const [showMatrix, setShowMatrix] = useState(false)
  const [showAddClip, setShowAddClip] = useState(null)  // 'hook' | 'body' | 'full_video' | null
  const toast = useToast()

  // Two-stage load: variants first (paints the page fast), clips + ads in
  // parallel (slot in when ready for the picker dropdowns).
  const load = async () => {
    setError(null); setLoading(true)
    const clipsPromise = supabase
      .from('lib_clips').select('clip_id, clip_type, description, creator_id, source_file_url')
      .order('clip_id').then(({ data }) => setClips(data || []))
    // Paged through PostgREST's 1000-row cap. The prior hardcoded
    // .limit(500) hid every ad past the 500th from the variant matcher
    // without warning.
    const adsPromise = pagedFetch(() => supabase
      .from('ads').select('ad_id, ad_name, effective_status, campaign_name, thumbnail_url')
      .order('first_seen_at', { ascending: false })).then((data) => setAds(data))
    try {
      const { data: variants, error: vErr } = await supabase
        .from('lib_variants_with_performance').select('*')
        .order('spend_30d', { ascending: false, nullsFirst: false })
      if (vErr) throw new Error(vErr.message)
      setRows(variants || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
    await Promise.all([clipsPromise, adsPromise])
  }
  useEffect(() => { load() }, [])

  const hooks = useMemo(() => clips.filter(c => c.clip_type === 'hook'), [clips])
  const bodies = useMemo(() => clips.filter(c => c.clip_type === 'body'), [clips])
  const clipById = useMemo(() => Object.fromEntries(clips.map(c => [c.clip_id, c])), [clips])

  // Index variants by hook+body key for matrix lookup
  const variantByCombo = useMemo(() => {
    const map = new Map()
    for (const v of rows) {
      const key = `${v.hook_clip_id || 'NULL'}|${v.body_clip_id || 'NULL'}`
      // If multiple variants exist for the same combo, prefer the highest-spend
      const existing = map.get(key)
      if (!existing || (v.spend_30d || 0) > (existing.spend_30d || 0)) {
        map.set(key, v)
      }
    }
    return map
  }, [rows])

  // Rollup performance per hook + per body (across all variants using each)
  const { hookPerf, bodyPerf } = useMemo(() => {
    const hp = {}, bp = {}
    for (const v of rows) {
      const s = parseFloat(v.spend_30d || 0)
      const booked = v.hyros_calls || 0
      const revenue = parseFloat(v.hyros_revenue || 0)
      if (v.hook_clip_id) {
        const r = hp[v.hook_clip_id] || { spend: 0, booked: 0, revenue: 0, variantCount: 0 }
        r.spend += s; r.booked += booked; r.revenue += revenue; r.variantCount++
        hp[v.hook_clip_id] = r
      }
      if (v.body_clip_id) {
        const r = bp[v.body_clip_id] || { spend: 0, booked: 0, revenue: 0, variantCount: 0 }
        r.spend += s; r.booked += booked; r.revenue += revenue; r.variantCount++
        bp[v.body_clip_id] = r
      }
    }
    return { hookPerf: hp, bodyPerf: bp }
  }, [rows])

  const maxVariantSpend = useMemo(() => {
    let max = 0
    for (const v of rows) max = Math.max(max, parseFloat(v.spend_30d || 0))
    return max
  }, [rows])

  // Summary stats
  const summary = useMemo(() => {
    const totalCombos = hooks.length * bodies.length
    const testedCombos = variantByCombo.size
    const winners = rows.filter(v => v.status === 'winner').length
    const live = rows.filter(v => v.status === 'live').length
    let topHook = null, topHookSpend = 0
    for (const [id, r] of Object.entries(hookPerf)) {
      if (r.spend > topHookSpend) { topHook = id; topHookSpend = r.spend }
    }
    let topBody = null, topBodySpend = 0
    for (const [id, r] of Object.entries(bodyPerf)) {
      if (r.spend > topBodySpend) { topBody = id; topBodySpend = r.spend }
    }
    return { totalCombos, testedCombos, winners, live, topHook, topHookSpend, topBody, topBodySpend }
  }, [hooks, bodies, variantByCombo, rows, hookPerf, bodyPerf])

  // Filtered rows for the sheet/by-hook views
  const filtered = useMemo(() => {
    let out = rows
    if (statusFilter !== 'all') out = out.filter(v => v.status === statusFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      out = out.filter(v =>
        (v.variant_id || '').toLowerCase().includes(q) ||
        (v.hook_clip_id || '').toLowerCase().includes(q) ||
        (v.body_clip_id || '').toLowerCase().includes(q) ||
        (v.meta_ad_name || '').toLowerCase().includes(q)
      )
    }
    return out
  }, [rows, statusFilter, search])

  // ── Mutations ─────────────────────────────────────────────────────
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
      setRows(prev => prev.map(r => r.variant_id === variant.variant_id ? { ...r, [field]: variant[field] } : r))
      toast.error(`Save failed: ${e.message}`)
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
      toast.error(`Stage update failed: ${e.message}`)
    }
  }

  const createVariantForCombo = async (hookId, bodyId) => {
    const stub = `${hookId}_${bodyId}`
    try {
      const { error: e } = await supabase.rpc('lib_variant_upsert', {
        p_variant_id: stub,
        p_hook_clip_id: hookId,
        p_body_clip_id: bodyId,
        p_status: 'planned',
      })
      if (e) throw new Error(e.message)
      toast.success(`Variant ${stub} created`)
      await load()
      // Open the drawer for the new variant
      setTimeout(() => {
        const fresh = { variant_id: stub, hook_clip_id: hookId, body_clip_id: bodyId, status: 'planned' }
        setSelectedVariant(fresh)
      }, 100)
    } catch (e) { toast.error(`Create failed: ${e.message}`) }
  }

  // window.confirm → styled ConfirmModal (2026-06-12): native dialogs
  // block the JS thread and look broken next to the editorial system.
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const deleteVariant = async (variant_id) => {
    setDeleteBusy(true)
    try {
      await supabase.rpc('lib_variant_delete', { p_variant_id: variant_id })
      await load()
      setConfirmDeleteId(null)
    } catch (e) { toast.error(`Delete failed: ${e.message}`) }
    finally { setDeleteBusy(false) }
  }

  const seedSampleData = async () => {
    setSeeding(true); setError(null)
    try {
      const DEMO_CLIPS = [
        { id: 'DEMO-H1-OSO',       type: 'hook',  creator: 'OSO',      desc: 'Referrals & word of mouth (~15s)' },
        { id: 'DEMO-H2-OSO',       type: 'hook',  creator: 'OSO',      desc: 'Burning Google Ads budget (~16s)' },
        { id: 'DEMO-H3-SOFIA',     type: 'hook',  creator: 'SOFIA',    desc: 'HomeAdvisor / Angi tire-kickers (~16s)' },
        { id: 'DEMO-BODY-B1-OSO',  type: 'body',  creator: 'OSO',      desc: 'Body B1 (location pages) — UGC' },
        { id: 'DEMO-BODY-B5-OSO',  type: 'body',  creator: 'OSO',      desc: 'Body B5 (reviews) — UGC' },
        { id: 'DEMO-FRAME-RESTO',  type: 'testimonial', creator: 'RESTO-AI', desc: 'Testimonial intro — locked to Script 3' },
      ]
      for (const c of DEMO_CLIPS) {
        await supabase.rpc('lib_clip_upsert', {
          p_clip_id: c.id, p_clip_type: c.type, p_creator_id: c.creator,
          p_description: c.desc, p_section: 'Demo · sample data', p_priority: 'med',
        })
      }
      await supabase.rpc('lib_variants_bulk_from_clips', {
        p_hook_clip_ids: ['DEMO-H1-OSO', 'DEMO-H2-OSO', 'DEMO-H3-SOFIA'],
        p_body_clip_ids: ['DEMO-BODY-B1-OSO', 'DEMO-BODY-B5-OSO'],
        p_frame_clip_id: 'DEMO-FRAME-RESTO',
        p_editor: 'Mohamed', p_priority: 'med',
      })
      toast.success('6 demo clips + 6 demo variants created')
      await load()
    } catch (e) { setError(`Seed failed: ${e.message}`) }
    finally { setSeeding(false) }
  }

  return (
    <div>
      <SectionHead
        level="page"
        eyebrow="Creative · Variants"
        title="Variants"
        tagline={`${rows.length} variants · ${hooks.length} hooks × ${bodies.length} bodies = ${summary.totalCombos} combos · ${summary.testedCombos} tested.`}
        gap={20}
        right={
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <ViewToggle view={view} setView={setView} />
            <span style={{ width: 1, height: 22, background: 'var(--rule)' }} />
            <button onClick={() => setShowAddClip('hook')} style={btnGhost} title="Add a new hook idea — no MP4 required">
              <Sparkles size={12} /> + Hook
            </button>
            <button onClick={() => setShowAddClip('body')} style={btnGhost} title="Add a new body idea">
              <MessageSquare size={12} /> + Body
            </button>
            <button onClick={() => setShowAddClip('full_video')} style={btnGhost} title="Add a new full-video clip">
              <Type size={12} /> + Frame
            </button>
            <span style={{ width: 1, height: 22, background: 'var(--rule)' }} />
            <button onClick={() => setShowMatrix(true)} style={btnPrimary}>
              <Grid3x3 size={13} /> Splice
            </button>
            {rows.length === 0 && (
              <button onClick={seedSampleData} disabled={seeding} style={btnGhost}>
                {seeding ? <Loader size={13} className="animate-spin" /> : <FlaskConical size={13} />}
                {seeding ? 'Seeding…' : 'Seed demo'}
              </button>
            )}
          </div>
        }
      />

      {/* "How this works" callout — only shown on first visits (when no
          variants exist yet) so it doesn't clutter for power users */}
      {rows.length === 0 && !loading && (
        <div className="what-it-means" style={{ marginBottom: 24 }}>
          <div className="wim-tag">How this board works</div>
          <div className="wim-body">
            <strong>Clips</strong> are atomic edits (one hook, one body, one full video). Use <em>+ Hook</em>/<em>+ Body</em>/<em>+ Full Video</em> to add new ideas — you don't need an MP4 to start, just a label. <strong>Variants</strong> are spliced combinations: pick hooks × bodies via <em>Splice</em> and the system creates one row per combination. Once a variant is filmed and uploaded as a Meta ad, click any cell to open the drawer and link it to the live ad — spend, booked calls, and revenue flow back automatically.
          </div>
        </div>
      )}

      {/* Pattern summary — only when we have variants */}
      {rows.length > 0 && (
        <PatternSummary
          summary={summary}
          hookPerf={hookPerf}
          bodyPerf={bodyPerf}
          hooks={hooks}
          bodies={bodies}
          clipById={clipById}
        />
      )}

      {/* Error banner */}
      {error && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', background: 'var(--down-soft)', border: '1px solid var(--down)', borderLeftWidth: 3, borderRadius: '0 3px 3px 0', color: 'var(--down)', marginBottom: 16, fontSize: 13 }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>{error}</div>
        </div>
      )}

      {loading && <div className="flex items-center justify-center py-16"><Loader className="animate-spin" style={{ color: 'var(--ink-3)' }} /></div>}

      {/* Empty state */}
      {!loading && rows.length === 0 && !error && (
        <EmptyState onMatrix={() => setShowMatrix(true)} onSeed={seedSampleData} seeding={seeding} />
      )}

      {/* Main content — picks view based on toggle */}
      {!loading && rows.length > 0 && view === 'matrix' && (
        <MatrixView
          hooks={hooks}
          bodies={bodies}
          variantByCombo={variantByCombo}
          hookPerf={hookPerf}
          bodyPerf={bodyPerf}
          maxSpend={maxVariantSpend}
          onCellClick={(hookId, bodyId) => {
            const key = `${hookId}|${bodyId}`
            const existing = variantByCombo.get(key)
            if (existing) setSelectedVariant(existing)
            else createVariantForCombo(hookId, bodyId)
          }}
        />
      )}

      {!loading && rows.length > 0 && view === 'byHook' && (
        <ByHookView
          rows={filtered}
          hooks={hooks}
          hookPerf={hookPerf}
          clipById={clipById}
          onVariantClick={setSelectedVariant}
        />
      )}

      {!loading && rows.length > 0 && view === 'sheet' && (
        <SheetView
          filtered={filtered}
          clips={clips}
          search={search} setSearch={setSearch}
          statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          onSaveField={saveField}
          onToggleStage={toggleStage}
          onDelete={deleteVariant}
          onRowClick={setSelectedVariant}
        />
      )}

      {/* Detail drawer */}
      {selectedVariant && (
        <VariantDrawer
          variant={selectedVariant}
          clips={clips}
          ads={ads}
          clipById={clipById}
          onClose={() => setSelectedVariant(null)}
          onSaveField={saveField}
          onToggleStage={toggleStage}
          onDelete={(id) => { setConfirmDeleteId(id); setSelectedVariant(null) }}
        />
      )}

      {/* Matrix splice modal */}
      {showMatrix && (
        <MatrixSpliceModal
          clips={clips}
          onClose={() => setShowMatrix(false)}
          onCreated={() => { setShowMatrix(false); load() }}
        />
      )}

      {/* Quick-add clip modal (hook / body / full_video) — no MP4 required */}
      {showAddClip && (
        <QuickAddClipModal
          clipType={showAddClip}
          onClose={() => setShowAddClip(null)}
          onCreated={() => { setShowAddClip(null); load() }}
        />
      )}

      <ConfirmModal
        open={confirmDeleteId !== null}
        onClose={() => { if (!deleteBusy) setConfirmDeleteId(null) }}
        title={`Delete variant ${confirmDeleteId || ''}?`}
        message="The variant row is removed; its hook/body clips are untouched."
        confirmLabel="Delete variant"
        variant="danger"
        loading={deleteBusy}
        onConfirm={() => deleteVariant(confirmDeleteId)}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Quick-add clip modal — used to seed a new hook / body / full-video idea
// straight from the Variants page without going to the Clips upload flow.
// Operator can attach an MP4 later via Clips → just need a label here.
// ────────────────────────────────────────────────────────────────────
function QuickAddClipModal({ clipType, onClose, onCreated }) {
  const [clipId, setClipId] = useState('')
  const [description, setDescription] = useState('')
  const [creator, setCreator] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const typeLabel = clipType === 'hook' ? 'hook' : clipType === 'body' ? 'body' : 'full_video'
  const placeholderId =
    clipType === 'hook'  ? 'H6-OSO' :
    clipType === 'body'  ? 'BODY-C-OSO' :
                           'FULL-VIDEO-OSO-V1'
  const placeholderDesc =
    clipType === 'hook'  ? 'Phone-stopped-ringing concern (~15s)' :
    clipType === 'body'  ? 'Body C (proof + reviews) — UGC' :
                           'Complete final ad video (no splicing needed)'

  const submit = async (e) => {
    e.preventDefault()
    if (!clipId.trim()) return
    setSaving(true); setErr(null)
    try {
      const { error } = await supabase.rpc('lib_clip_upsert', {
        p_clip_id: clipId.trim(),
        p_clip_type: typeLabel,
        p_description: description.trim() || null,
        p_creator_id: creator.trim() || null,
      })
      if (error) throw new Error(error.message)
      onCreated()
    } catch (e) {
      setErr(e.message); setSaving(false)
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.4)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} style={{ width: '100%', maxWidth: 460, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 10, padding: 24 }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4 }}>Add new clip</div>
          <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, margin: 0 }}>
            New <em>{typeLabel}</em>.
          </h3>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6, fontFamily: 'var(--serif)', lineHeight: 1.45 }}>
            Adds the clip stub. You can drop the source MP4 later from the Clips tab.
          </p>
        </div>

        <Field label={`${typeLabel} ID *`}>
          <input
            autoFocus required value={clipId} onChange={e => setClipId(e.target.value)}
            style={inputStyle} placeholder={placeholderId}
          />
        </Field>

        <Field label="Description">
          <input value={description} onChange={e => setDescription(e.target.value)} style={inputStyle} placeholder={placeholderDesc} />
        </Field>

        <Field label="Creator">
          <input value={creator} onChange={e => setCreator(e.target.value)} style={inputStyle} placeholder="OSO" />
        </Field>

        {err && <div style={{ color: 'var(--down, #b41e1e)', fontSize: 12, marginTop: 4 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
          <button type="submit" disabled={saving || !clipId.trim()} style={btnPrimary}>
            {saving ? 'Saving…' : `Add ${typeLabel}`}
          </button>
        </div>
      </form>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Pattern summary strip — top hook, top body, winners, untested-combo count
// ────────────────────────────────────────────────────────────────────
function PatternSummary({ summary, hookPerf, bodyPerf, hooks, bodies, clipById }) {
  const untested = summary.totalCombos - summary.testedCombos
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
      <PatternTile
        eyebrow="Top hook"
        title={summary.topHook ? shortClipId(summary.topHook, 'hook') : '—'}
        sub={summary.topHook ? `${fmt$(summary.topHookSpend)} across ${hookPerf[summary.topHook]?.variantCount || 0} variants` : 'No spend data yet'}
        accent
      />
      <PatternTile
        eyebrow="Top body"
        title={summary.topBody ? shortClipId(summary.topBody, 'body') : '—'}
        sub={summary.topBody ? `${fmt$(summary.topBodySpend)} across ${bodyPerf[summary.topBody]?.variantCount || 0} variants` : 'No spend data yet'}
      />
      <PatternTile
        eyebrow="Winners"
        title={String(summary.winners)}
        sub={summary.live > 0 ? `${summary.live} currently live` : 'Variants tagged winner'}
      />
      <PatternTile
        eyebrow="Untested combos"
        title={String(untested)}
        sub={`${summary.testedCombos}/${summary.totalCombos} hook × body explored`}
        warning={untested > summary.testedCombos}
      />
    </div>
  )
}

function PatternTile({ eyebrow, title, sub, accent, warning }) {
  const border = accent ? '3px solid var(--accent)' : warning ? '3px solid var(--ink)' : '1px solid var(--rule)'
  return (
    <div style={{ padding: '14px 16px', background: 'var(--paper)', border: '1px solid var(--rule)', borderLeftWidth: accent ? 3 : warning ? 3 : 1, borderLeftColor: accent ? 'var(--accent)' : warning ? 'var(--ink)' : 'var(--rule)', borderRadius: 9 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4 }}>{eyebrow}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, color: 'var(--ink)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{title}</div>
      {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', letterSpacing: '0.08em', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Matrix view — hooks (rows) × bodies (columns) grid
// ────────────────────────────────────────────────────────────────────
function MatrixView({ hooks, bodies, variantByCombo, hookPerf, bodyPerf, maxSpend, onCellClick }) {
  if (!hooks.length || !bodies.length) {
    return (
      <div style={{ padding: 32, textAlign: 'center', background: 'var(--paper-2)', border: '1px dashed var(--rule)', borderRadius: 10 }}>
        <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)' }}>
          Need at least one hook clip and one body clip to build the matrix. Upload them on the Clips tab.
        </p>
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9 }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%' }}>
        <thead>
          <tr>
            {/* Corner cell */}
            <th style={{
              position: 'sticky', left: 0, zIndex: 2,
              padding: 12,
              fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
              color: 'var(--ink-3)', fontWeight: 500,
              background: 'var(--paper-2)',
              borderRight: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)',
              minWidth: 200,
              textAlign: 'left',
            }}>
              Hook ↓ &nbsp;/&nbsp; Body →
            </th>
            {bodies.map(b => {
              const perf = bodyPerf[b.clip_id]
              return (
                <th key={b.clip_id} style={{
                  padding: '10px 8px',
                  background: 'var(--paper-2)',
                  borderBottom: `2px solid ${CLIP_TYPE_COLORS.body}`, borderRight: '1px solid var(--rule)',
                  fontWeight: 400,
                  minWidth: 120,
                  textAlign: 'left',
                }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.14em', fontWeight: 700, textTransform: 'uppercase', color: CLIP_TYPE_COLORS.body, marginBottom: 3 }}>Body</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, color: 'var(--ink)', letterSpacing: '0.04em' }} title={b.description || ''}>
                    {shortClipId(b.clip_id, 'body')}
                  </div>
                  {perf && perf.spend > 0 && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-3)', marginTop: 2, letterSpacing: '0.04em' }}>
                      {fmt$(perf.spend)} · {fmtN(perf.booked)} booked
                    </div>
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {hooks.map(h => {
            const perf = hookPerf[h.clip_id]
            return (
              <tr key={h.clip_id}>
                <th style={{
                  position: 'sticky', left: 0, zIndex: 1,
                  padding: '10px 12px',
                  background: 'var(--paper)',
                  borderRight: `2px solid ${CLIP_TYPE_COLORS.hook}`, borderBottom: '1px solid var(--rule)',
                  textAlign: 'left', fontWeight: 400, verticalAlign: 'middle',
                }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.14em', fontWeight: 700, textTransform: 'uppercase', color: CLIP_TYPE_COLORS.hook, marginBottom: 3 }}>Hook</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600, color: 'var(--ink)', letterSpacing: '0.04em' }} title={h.description || ''}>
                    {shortClipId(h.clip_id, 'hook')}
                  </div>
                  {h.description && (
                    <div style={{ fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 11, color: 'var(--ink-3)', marginTop: 2, lineHeight: 1.3 }}>
                      {h.description.length > 38 ? h.description.slice(0, 36) + '…' : h.description}
                    </div>
                  )}
                  {perf && perf.spend > 0 && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-3)', marginTop: 4, letterSpacing: '0.04em' }}>
                      {fmt$(perf.spend)} · {fmtN(perf.booked)} booked
                    </div>
                  )}
                </th>
                {bodies.map(b => {
                  const key = `${h.clip_id}|${b.clip_id}`
                  const variant = variantByCombo.get(key)
                  return (
                    <MatrixCell
                      key={b.clip_id}
                      variant={variant}
                      maxSpend={maxSpend}
                      onClick={() => onCellClick(h.clip_id, b.clip_id)}
                    />
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MatrixCell({ variant, maxSpend, onClick }) {
  if (!variant) {
    return (
      <td onClick={onClick} style={{
        padding: 10,
        background: 'var(--paper-2)',
        border: '1px dashed var(--rule)',
        borderRight: '1px solid var(--rule)',
        borderBottom: '1px solid var(--rule)',
        cursor: 'pointer',
        minWidth: 120, height: 80,
        verticalAlign: 'middle', textAlign: 'center',
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)',
          letterSpacing: '0.14em', textTransform: 'uppercase',
        }}>
          <Plus size={11} /> Untested
        </div>
      </td>
    )
  }

  const spend = parseFloat(variant.spend_30d || 0)
  const booked = variant.hyros_calls || 0
  const isWinner = variant.status === 'winner'
  const isLive = variant.meta_ad_id && variant.ad_effective_status === 'ACTIVE'
  const isKilled = variant.status === 'killed'
  const heat = heatBucket(spend, maxSpend)

  // Color palette
  let bg = 'var(--paper)'
  let border = '1px solid var(--rule)'
  if (isWinner) { bg = 'var(--accent)'; border = '1px solid var(--accent)' }
  else if (isLive) { bg = `rgba(244,225,74,${0.15 + 0.15 * heat})`; border = '1px solid var(--accent)' }
  else if (spend > 0) { bg = `rgba(10,10,10,${0.04 + 0.04 * heat})`; border = '1px solid var(--rule)' }
  else if (isKilled) { bg = 'var(--paper-2)'; border = '1px solid var(--rule)' }

  return (
    <td onClick={onClick} style={{
      padding: 8,
      background: bg,
      border, borderRight: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)',
      cursor: 'pointer',
      minWidth: 120, height: 80,
      verticalAlign: 'top',
      opacity: isKilled ? 0.5 : 1,
      transition: 'transform 120ms ease',
    }}>
      {/* Status pill */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
          color: isWinner ? 'var(--ink)' : isLive ? 'var(--ink)' : 'var(--ink-3)',
        }}>
          {isWinner ? '★ WINNER' : variant.status}
        </span>
        {variant.meta_ad_id && (
          <Link2 size={9} style={{ color: 'var(--ink-3)' }} />
        )}
      </div>

      {/* Performance metrics */}
      {spend > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 14, fontWeight: 500, color: 'var(--ink)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
            {fmt$(spend)}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.04em' }}>
            {fmtN(booked)} booked
          </div>
        </div>
      ) : variant.meta_ad_id ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)', letterSpacing: '0.08em', fontStyle: 'italic' }}>
          linked · no spend yet
        </div>
      ) : (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)', letterSpacing: '0.08em' }}>
          not linked
        </div>
      )}

      {/* Stage progress dots */}
      <div style={{ display: 'flex', gap: 2, marginTop: 6 }}>
        {STAGES.map(s => (
          <div key={s.key} title={s.label} style={{
            width: 6, height: 6, borderRadius: '50%',
            background: variant[`stage_${s.key}`] ? 'var(--ink)' : 'transparent',
            border: '1px solid', borderColor: variant[`stage_${s.key}`] ? 'var(--ink)' : 'var(--ink-4)',
          }} />
        ))}
      </div>
    </td>
  )
}

// ────────────────────────────────────────────────────────────────────
// By-hook view — variants grouped by hook clip
// ────────────────────────────────────────────────────────────────────
function ByHookView({ rows, hooks, hookPerf, clipById, onVariantClick }) {
  const byHook = useMemo(() => {
    const m = new Map()
    for (const v of rows) {
      const hid = v.hook_clip_id || 'NO_HOOK'
      if (!m.has(hid)) m.set(hid, [])
      m.get(hid).push(v)
    }
    return m
  }, [rows])

  // Sort hooks by total spend
  const sortedHooks = useMemo(() => {
    return Array.from(byHook.keys()).sort((a, b) => {
      const sa = hookPerf[a]?.spend || 0
      const sb = hookPerf[b]?.spend || 0
      return sb - sa
    })
  }, [byHook, hookPerf])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {sortedHooks.map(hid => {
        const variants = byHook.get(hid)
        const perf = hookPerf[hid]
        const hook = clipById[hid]
        return (
          <div key={hid} style={{ background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9 }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--rule)', background: 'var(--paper-2)', display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--ink)', letterSpacing: '0.04em' }}>
                {hid === 'NO_HOOK' ? '(no hook)' : shortClipId(hid, 'hook')}
              </div>
              {hook?.description && (
                <div style={{ fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3)' }}>{hook.description}</div>
              )}
              {perf && perf.spend > 0 && (
                <div style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', color: 'var(--ink-3)' }}>
                  {fmt$(perf.spend)} · {fmtN(perf.booked)} booked · {variants.length} variant{variants.length === 1 ? '' : 's'}
                </div>
              )}
            </div>
            <div style={{ padding: '10px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {variants.map(v => {
                const c = STATUS_COLORS[v.status] || STATUS_COLORS.planned
                return (
                  <div key={v.variant_id} onClick={() => onVariantClick(v)} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px',
                    background: v.status === 'winner' ? 'var(--accent-soft)' : 'var(--paper)',
                    border: '1px solid var(--rule)', borderLeftWidth: 3, borderLeftColor: c.accent,
                    borderRadius: 9, cursor: 'pointer',
                  }}>
                    {/* Body + full-video composition — color-coded labels
                        match the Clips page palette so the type signals
                        are visually consistent across both surfaces. */}
                    <div style={{ minWidth: 200, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', fontWeight: 700,
                          color: CLIP_TYPE_COLORS.body,
                          padding: '2px 6px',
                          background: 'rgba(184,129,11,0.12)',
                          borderRadius: 9,
                        }}>BODY</span>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600, color: 'var(--ink)' }}>
                          {v.body_clip_id ? shortClipId(v.body_clip_id, 'body') : '(none)'}
                        </span>
                      </div>
                      {v.frame_clip_id && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', fontWeight: 700,
                            color: CLIP_TYPE_COLORS.full_video,
                            padding: '2px 6px',
                            background: 'rgba(122,58,166,0.10)',
                            borderRadius: 9,
                          }}>FULL VIDEO</span>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500, color: 'var(--ink-2)' }}>
                            {shortClipId(v.frame_clip_id, 'full_video')}
                          </span>
                        </div>
                      )}
                    </div>
                    <StatusPill status={v.status} />
                    <div style={{ flex: 1, fontFamily: 'var(--serif)', fontSize: 12, color: 'var(--ink-3)' }}>
                      {v.meta_ad_name || (v.meta_ad_id ? `Linked: ${v.meta_ad_id.slice(-8)}` : <span style={{ fontStyle: 'italic' }}>not linked · click to link →</span>)}
                    </div>
                    <div style={{ display: 'flex', gap: 16, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)', letterSpacing: '0.04em' }}>
                      <Metric label="Spend" value={fmt$(v.spend_30d)} />
                      <Metric label="Booked" value={fmtN(v.hyros_calls)} />
                      <Metric label="Revenue" value={fmt$(parseFloat(v.hyros_revenue || 0))} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <div style={{ textAlign: 'right', minWidth: 50 }}>
      <div style={{ fontSize: 8, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-4)' }}>{label}</div>
      <div style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink)' }}>{value}</div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Spreadsheet view (kept for bulk operations) — abbreviated from previous
// ────────────────────────────────────────────────────────────────────
function SheetView({ filtered, clips, search, setSearch, statusFilter, setStatusFilter, onSaveField, onToggleStage, onDelete, onRowClick }) {
  const clipOptions = (type) => [
    '',
    ...clips.filter(c => !type || (Array.isArray(type) ? type.includes(c.clip_type) : c.clip_type === type)).map(c => c.clip_id),
  ]

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9, marginBottom: 12 }}>
        <ChipGroup label="Status" value={statusFilter} setValue={setStatusFilter}
          options={[{ value: 'all', label: 'All' }, ...STATUS_OPTIONS.map(s => ({ value: s, label: s }))]} />
        <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <Search size={12} style={{ color: 'var(--ink-3)', flexShrink: 0, marginLeft: 4 }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
            style={{ flex: 1, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 9, padding: '5px 8px', fontSize: 12, color: 'var(--ink)', outline: 'none' }} />
        </div>
      </div>

      <div style={{ overflowX: 'auto', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9 }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
              <Th w={150}>Variant</Th>
              <Th w={90}>Status</Th>
              <Th w={130}>Hook</Th>
              <Th w={130}>Body</Th>
              <Th w={120}>Frame</Th>
              <Th w={80}>Editor</Th>
              {STAGES.map(s => <Th key={s.key} w={52} center>{s.label}</Th>)}
              <Th w={140}>Linked ad</Th>
              <Th w={70} center>Spend 30d</Th>
              <Th w={60} center>Booked</Th>
              <Th w={32} />
            </tr>
          </thead>
          <tbody>
            {filtered.map(v => {
              const c = STATUS_COLORS[v.status] || STATUS_COLORS.planned
              return (
              <tr key={v.variant_id} style={{
                borderBottom: '1px solid var(--rule)',
                background: v.status === 'winner' ? 'var(--accent-soft)' : undefined,
                cursor: 'pointer',
                borderLeft: `3px solid ${c.accent}`,
              }}>
                <Td mono onClick={() => onRowClick(v)} style={{ wordBreak: 'break-all' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600 }}>{shortClipId(v.hook_clip_id, 'hook') || '—'}</span>
                    <span style={{ color: 'var(--ink-4)', fontWeight: 300 }}>×</span>
                    <span style={{ fontWeight: 600 }}>{shortClipId(v.body_clip_id, 'body') || '—'}</span>
                    {v.frame_clip_id && (<>
                      <span style={{ color: 'var(--ink-4)', fontWeight: 300 }}>×</span>
                      <span style={{ fontWeight: 500, color: 'var(--ink-2)' }}>{shortClipId(v.frame_clip_id, 'full_video')}</span>
                    </>)}
                  </div>
                </Td>
                <Td><StatusPicker value={v.status} onChange={val => onSaveField(v, 'status', val)} /></Td>
                <Td><InlineSelect value={v.hook_clip_id} options={clipOptions('hook')} onSave={val => onSaveField(v, 'hook_clip_id', val || null)} /></Td>
                <Td><InlineSelect value={v.body_clip_id} options={clipOptions('body')} onSave={val => onSaveField(v, 'body_clip_id', val || null)} /></Td>
                <Td><InlineSelect value={v.frame_clip_id} options={clipOptions(['full_video','testimonial'])} onSave={val => onSaveField(v, 'frame_clip_id', val || null)} /></Td>
                <Td><InlineEdit value={v.editor} onSave={val => onSaveField(v, 'editor', val || null)} /></Td>
                {STAGES.map(s => (
                  <Td key={s.key} center><StageCheckbox checked={v[`stage_${s.key}`]} onChange={() => onToggleStage(v, s.key)} /></Td>
                ))}
                <Td>
                  {v.meta_ad_id ? (
                    <Link to={`/sales/ads/ad/${v.meta_ad_id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--serif)', fontSize: 12, color: 'var(--ink-2)' }}>
                      {v.meta_ad_name ? (v.meta_ad_name.length > 22 ? v.meta_ad_name.slice(0, 20) + '…' : v.meta_ad_name) : v.meta_ad_id.slice(-8)}
                      <ExternalLink size={9} />
                    </Link>
                  ) : <span style={{ color: 'var(--ink-4)', fontStyle: 'italic', fontSize: 11 }}>link in drawer →</span>}
                </Td>
                <Td center mono>{fmt$(v.spend_30d)}</Td>
                <Td center mono>{fmtN(v.hyros_calls)}</Td>
                <Td>
                  <button onClick={(e) => { e.stopPropagation(); onDelete(v.variant_id) }} title="Delete" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink-4)', padding: 2 }}>
                    <Trash2 size={12} />
                  </button>
                </Td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Variant detail drawer — right-side slide-out
// ────────────────────────────────────────────────────────────────────
function VariantDrawer({ variant, clips, ads, clipById, onClose, onSaveField, onToggleStage, onDelete }) {
  const [adSearch, setAdSearch] = useState('')
  const hook = variant.hook_clip_id ? clipById[variant.hook_clip_id] : null
  const body = variant.body_clip_id ? clipById[variant.body_clip_id] : null
  const fullVideo = variant.frame_clip_id ? clipById[variant.frame_clip_id] : null

  const filteredAds = useMemo(() => {
    if (!adSearch.trim()) return ads.slice(0, 10)
    const q = adSearch.toLowerCase()
    return ads.filter(a =>
      (a.ad_name || '').toLowerCase().includes(q) ||
      (a.campaign_name || '').toLowerCase().includes(q) ||
      (a.ad_id || '').includes(q)
    ).slice(0, 15)
  }, [ads, adSearch])

  const linkAd = (ad) => {
    onSaveField(variant, 'meta_ad_id', ad.ad_id)
    onSaveField(variant, 'meta_ad_name', ad.ad_name)
  }
  const unlinkAd = () => {
    onSaveField(variant, 'meta_ad_id', null)
    onSaveField(variant, 'meta_ad_name', null)
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.35)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 520, height: '100vh', overflowY: 'auto',
        background: 'var(--paper)', borderLeft: '1px solid var(--rule)',
        padding: 24,
      }}>
        {/* Close */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4 }}>Variant</div>
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500, margin: 0, wordBreak: 'break-all' }}>{variant.variant_id}</h3>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 9, padding: 6, cursor: 'pointer', color: 'var(--ink-3)' }}>
            <X size={14} />
          </button>
        </div>

        {/* Splice recipe */}
        <Section title="Splice recipe">
          <RecipeRow label="Hook" clip={hook} />
          <RecipeRow label="Body" clip={body} />
          <RecipeRow label="Full video" clip={fullVideo} />
        </Section>

        {/* Status + priority + editor */}
        <Section title="Production">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
            <Field label="Status">
              <div style={{ paddingTop: 2 }}>
                <StatusPicker value={variant.status} onChange={val => onSaveField(variant, 'status', val)} />
              </div>
            </Field>
            <Field label="Priority">
              <select value={variant.priority || ''} onChange={e => onSaveField(variant, 'priority', e.target.value || null)} style={inputStyle}>
                {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p || '—'}</option>)}
              </select>
            </Field>
            <Field label="Editor">
              <input defaultValue={variant.editor || ''} onBlur={e => onSaveField(variant, 'editor', e.target.value || null)} style={inputStyle} placeholder="Mohamed" />
            </Field>
          </div>

          {/* Stage checkboxes */}
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6, fontWeight: 500 }}>Stages</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {STAGES.map(s => (
                <button key={s.key} onClick={() => onToggleStage(variant, s.key)} style={{
                  padding: '6px 12px',
                  background: variant[`stage_${s.key}`] ? 'var(--accent)' : 'var(--paper-2)',
                  color: 'var(--ink)',
                  border: '1px solid', borderColor: variant[`stage_${s.key}`] ? 'var(--accent)' : 'var(--rule)',
                  borderRadius: 9,
                  fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
                  cursor: 'pointer',
                }}>{s.label}</button>
              ))}
            </div>
          </div>
        </Section>

        {/* Meta ad linkage */}
        <Section title="Linked Meta ad">
          {variant.meta_ad_id ? (
            <div style={{ padding: 12, background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 9 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
                <Link to={`/sales/ads/ad/${variant.meta_ad_id}`} style={{ fontFamily: 'var(--serif)', fontSize: 14, fontWeight: 500, color: 'var(--ink)', textDecoration: 'underline', textDecorationStyle: 'dotted', textDecorationColor: 'var(--ink-3)' }}>
                  {variant.meta_ad_name || variant.meta_ad_id}
                </Link>
                <button onClick={unlinkAd} style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', background: 'transparent', border: 'none', color: 'var(--ink-3)', cursor: 'pointer' }}>
                  Unlink
                </button>
              </div>
              <div style={{ display: 'flex', gap: 16, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)' }}>
                <div><strong style={{ color: 'var(--ink-3)' }}>SPEND 30D</strong> · {fmt$(variant.spend_30d)}</div>
                <div><strong style={{ color: 'var(--ink-3)' }}>BOOKED</strong> · {fmtN(variant.hyros_calls)}</div>
                <div><strong style={{ color: 'var(--ink-3)' }}>REVENUE</strong> · {fmt$(parseFloat(variant.hyros_revenue || 0))}</div>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>Not linked yet. Search for a live Meta ad below:</p>
              <input
                autoFocus
                value={adSearch}
                onChange={e => setAdSearch(e.target.value)}
                placeholder="Search by ad name, campaign, or ad ID…"
                style={{ ...inputStyle, marginBottom: 8 }}
              />
              <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--rule)', borderRadius: 9 }}>
                {filteredAds.map(ad => (
                  <button
                    key={ad.ad_id}
                    onClick={() => linkAd(ad)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                      padding: '8px 10px', background: 'var(--paper)', border: 'none',
                      borderBottom: '1px solid var(--rule)', cursor: 'pointer', textAlign: 'left',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--paper-2)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--paper)' }}
                  >
                    {ad.thumbnail_url && <img src={ad.thumbnail_url} alt="" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 9, flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--serif)', fontSize: 12.5, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {ad.ad_name || ad.ad_id}
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)', letterSpacing: '0.08em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {ad.campaign_name || ''}
                      </div>
                    </div>
                    <StatusPill status={ad.effective_status} small />
                  </button>
                ))}
                {filteredAds.length === 0 && (
                  <div style={{ padding: 12, fontSize: 12, color: 'var(--ink-4)', fontStyle: 'italic' }}>No ads match — try a different search</div>
                )}
              </div>
            </div>
          )}
        </Section>

        {/* Notes */}
        <Section title="Notes">
          <textarea
            defaultValue={variant.notes || ''}
            onBlur={e => onSaveField(variant, 'notes', e.target.value || null)}
            placeholder="Anything else worth recording about this variant…"
            rows={3}
            style={{ ...inputStyle, fontFamily: 'var(--serif)', resize: 'vertical', minHeight: 60 }}
          />
        </Section>

        {/* Danger zone */}
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--rule)' }}>
          <button onClick={() => onDelete(variant.variant_id)} style={{
            padding: '8px 14px', background: 'transparent', color: 'var(--down)',
            border: '1px solid var(--down)', borderRadius: 9,
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600, cursor: 'pointer',
          }}>
            <Trash2 size={11} style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />
            Delete variant
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  )
}

function RecipeRow({ label, clip }) {
  if (!clip) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: 'var(--paper-2)', borderRadius: 9, marginBottom: 4 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-4)', minWidth: 50 }}>{label}</span>
      <span style={{ fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 13, color: 'var(--ink-4)' }}>not assigned</span>
    </div>
  )
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: 'var(--paper-2)', borderRadius: 9, marginBottom: 4 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)', minWidth: 50 }}>{label}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>{clip.clip_id}</div>
        {clip.description && <div style={{ fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{clip.description}</div>}
      </div>
      {clip.source_file_url && (
        <a href={clip.source_file_url} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>open</a>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// View toggle
// ────────────────────────────────────────────────────────────────────
function ViewToggle({ view, setView }) {
  const VIEWS = [
    { value: 'matrix', label: 'Matrix', icon: LayoutGrid },
    { value: 'byHook', label: 'By hook', icon: TrendingUp },
    { value: 'sheet',  label: 'Sheet',  icon: Table2 },
  ]
  return (
    <div style={{ display: 'inline-flex', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 9, padding: 2 }}>
      {VIEWS.map(v => {
        const active = view === v.value
        const Icon = v.icon
        return (
          <button key={v.value} onClick={() => setView(v.value)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
            background: active ? 'var(--ink)' : 'transparent', color: active ? 'var(--paper)' : 'var(--ink-3)',
            border: 'none', borderRadius: 9, cursor: 'pointer',
          }}>
            <Icon size={12} /> {v.label}
          </button>
        )
      })}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Empty state
// ────────────────────────────────────────────────────────────────────
function EmptyState({ onMatrix, onSeed, seeding }) {
  return (
    <div style={{ border: '2px dashed var(--rule)', borderRadius: 10, padding: 48, textAlign: 'center', background: 'var(--paper-2)' }}>
      <Trophy size={48} style={{ color: 'var(--ink-4)', margin: '0 auto 12px' }} />
      <h3 className="h3" style={{ fontSize: 22, marginBottom: 8 }}>Splice your first variants.</h3>
      <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)', maxWidth: '52ch', margin: '0 auto 18px', lineHeight: 1.55 }}>
        Pick hooks × bodies from your Clips catalog and the matrix generator creates one variant per combination. Or seed sample data to preview what the matrix looks like populated.
      </p>
      <div style={{ display: 'inline-flex', gap: 8 }}>
        <button onClick={onMatrix} style={{ ...btnPrimary, padding: '10px 18px' }}>
          <Grid3x3 size={13} /> Open splicer
        </button>
        <button onClick={onSeed} disabled={seeding} style={{ ...btnGhost, padding: '10px 18px' }}>
          {seeding ? <Loader size={13} className="animate-spin" /> : <FlaskConical size={13} />}
          {seeding ? 'Seeding…' : 'Seed demo data'}
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Matrix splice modal (unchanged from prior commit, with clip option fix)
// ────────────────────────────────────────────────────────────────────
function MatrixSpliceModal({ clips, onClose, onCreated }) {
  const hooks = clips.filter(c => c.clip_type === 'hook')
  const bodies = clips.filter(c => c.clip_type === 'body')
  const fullVideos = clips.filter(c => c.clip_type === 'full_video' || c.clip_type === 'testimonial')

  const [selectedHooks, setSelectedHooks] = useState(new Set())
  const [selectedBodies, setSelectedBodies] = useState(new Set())
  const [selectedFullVideo, setSelectedFullVideo] = useState('')
  const [editor, setEditor] = useState('')
  const [priority, setPriority] = useState('')
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState(null)

  const toggle = (set, setSet, id) => {
    const next = new Set(set); next.has(id) ? next.delete(id) : next.add(id); setSet(next)
  }
  const hookCount = selectedHooks.size || 1
  const bodyCount = selectedBodies.size || 1
  const willCreate = (selectedHooks.size === 0 && selectedBodies.size === 0) ? 0 : hookCount * bodyCount

  const submit = async (e) => {
    e.preventDefault(); setErr(null); setCreating(true)
    try {
      const { data, error } = await supabase.rpc('lib_variants_bulk_from_clips', {
        p_hook_clip_ids: Array.from(selectedHooks),
        p_body_clip_ids: Array.from(selectedBodies),
        p_frame_clip_id: selectedFullVideo || null,
        p_editor: editor || null,
        p_priority: priority || null,
      })
      if (error) throw new Error(error.message)
      onCreated(data || 0)
    } catch (e) { setErr(e.message); setCreating(false) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} style={{ width: '100%', maxWidth: 760, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 10, padding: 24, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500, margin: '0 0 6px 0' }}>Matrix splicer</h3>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 18, fontFamily: 'var(--serif)' }}>
          Pick hooks × bodies. Click <em>Generate</em> and the system creates one variant per combination.
        </p>

        <SelectGroup label={`Hook clips · ${selectedHooks.size} selected`} items={hooks} selected={selectedHooks} onToggle={id => toggle(selectedHooks, setSelectedHooks, id)} emptyMsg="No hook clips yet — upload on the Clips tab." />
        <SelectGroup label={`Body clips · ${selectedBodies.size} selected`} items={bodies} selected={selectedBodies} onToggle={id => toggle(selectedBodies, setSelectedBodies, id)} emptyMsg="No body clips yet." />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 18 }}>
          <Field label="Full-video clip (single, optional)">
            <select value={selectedFullVideo} onChange={e => setSelectedFullVideo(e.target.value)} style={inputStyle}>
              <option value="">—</option>
              {fullVideos.map(f => <option key={f.clip_id} value={f.clip_id}>{f.clip_id}</option>)}
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

        <div style={{ marginTop: 18, padding: '12px 14px', background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 9 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4 }}>Will create</div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 20, color: 'var(--ink)', fontWeight: 500 }}>
            {willCreate === 0 ? 'Pick at least one hook or body' : `${willCreate} variant${willCreate > 1 ? 's' : ''}`}
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
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500, marginBottom: 8 }}>{label}</div>
      {items.length === 0 ? (
        <div style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontFamily: 'var(--serif)', fontSize: 13 }}>{emptyMsg}</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 200, overflowY: 'auto', padding: 6, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 9 }}>
          {items.map(c => {
            const active = selected.has(c.clip_id)
            return (
              <button key={c.clip_id} type="button" onClick={() => onToggle(c.clip_id)} title={c.description || ''} style={{
                padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.05em', fontWeight: 500,
                background: active ? 'var(--accent)' : 'var(--paper)', color: 'var(--ink)',
                border: '1px solid', borderColor: active ? 'var(--accent)' : 'var(--rule)', borderRadius: 9, cursor: 'pointer',
              }}>{c.clip_id}</button>
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

function Th({ children, w, center }) {
  return (
    <th style={{
      padding: '8px 10px', textAlign: center ? 'center' : 'left',
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
      color: 'var(--ink-3)', fontWeight: 500, width: w ? w : undefined, whiteSpace: 'nowrap',
    }}>{children}</th>
  )
}
function Td({ children, center, mono, onClick, style }) {
  return (
    <td onClick={onClick} style={{
      padding: '4px 8px', textAlign: center ? 'center' : 'left', verticalAlign: 'middle',
      fontFamily: mono ? 'var(--mono)' : undefined, fontSize: 12, color: 'var(--ink)',
      ...style,
    }}>{children}</td>
  )
}
function InlineEdit({ value, onSave, placeholder }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value || '')
  useEffect(() => { setV(value || '') }, [value])
  if (editing) {
    return <input autoFocus value={v} onChange={e => setV(e.target.value)} onBlur={() => { setEditing(false); onSave(v.trim()) }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } if (e.key === 'Escape') { setV(value || ''); setEditing(false) } }} style={{ width: '100%', minWidth: 60, background: 'var(--paper)', border: '1px solid var(--accent)', padding: '3px 6px', fontSize: 12, color: 'var(--ink)', outline: 'none', borderRadius: 9 }} />
  }
  return <span onClick={() => setEditing(true)} style={{ display: 'inline-block', minWidth: 40, padding: '3px 6px', cursor: 'text', color: value ? 'var(--ink)' : 'var(--ink-4)', borderRadius: 9 }}>{value || placeholder || '—'}</span>
}
function InlineSelect({ value, options, onSave, placeholder }) {
  return (
    <select value={value || ''} onChange={e => onSave(e.target.value || null)} onClick={e => e.stopPropagation()}
      style={{ width: '100%', background: 'transparent', border: '1px solid transparent', padding: '3px 6px', fontFamily: 'var(--mono)', fontSize: 11, color: value ? 'var(--ink)' : 'var(--ink-4)', cursor: 'pointer', borderRadius: 9, outline: 'none' }}>
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
    <button onClick={e => { e.stopPropagation(); onChange() }} style={{
      width: 18, height: 18,
      background: checked ? 'var(--accent)' : 'var(--paper-2)',
      border: '1px solid', borderColor: checked ? 'var(--accent)' : 'var(--rule)',
      borderRadius: 9, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--ink)', fontSize: 11, lineHeight: 1,
    }}>{checked ? '✓' : ''}</button>
  )
}
function ChipGroup({ label, value, setValue, options }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500, marginRight: 4 }}>{label}</span>
      <div style={{ display: 'inline-flex', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 9, padding: 2 }}>
        {options.map(opt => {
          const active = value === opt.value
          return (
            <button key={String(opt.value)} onClick={() => setValue(opt.value)} style={{
              padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500,
              background: active ? 'var(--ink)' : 'transparent', color: active ? 'var(--paper)' : 'var(--ink-3)', borderRadius: 9, border: 'none', cursor: 'pointer',
            }}>{opt.label}</button>
          )
        })}
      </div>
    </div>
  )
}
function StatusPill({ status, small }) {
  if (!status) return null
  // Meta ad's effective_status sometimes comes through as ACTIVE — alias it
  // to 'live' so it lands on the right palette.
  const key = status === 'ACTIVE' ? 'live' : (status === 'CAMPAIGN_PAUSED' || status === 'ADSET_PAUSED' || status === 'PAUSED') ? 'paused' : status
  const c = STATUS_COLORS[key] || STATUS_COLORS.planned
  const isWinner = key === 'winner'
  return (
    <span style={{
      padding: small ? '1px 6px' : '2px 8px',
      background: c.bg, color: c.fg,
      border: '1px solid', borderColor: c.accent,
      borderRadius: 9,
      fontFamily: 'var(--mono)', fontSize: small ? 8 : 9, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
      whiteSpace: 'nowrap',
      display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>
      {isWinner && '★ '}
      {status}
    </span>
  )
}

// Branded status picker — replaces the native <select> with a colored
// pill that opens a popover of status options, each rendered with its own
// color so the operator picks visually.
function StatusPicker({ value, onChange, options = STATUS_OPTIONS }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const current = value || 'planned'
  const c = STATUS_COLORS[current] || STATUS_COLORS.planned

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px',
          background: c.bg, color: c.fg,
          border: '1px solid', borderColor: c.accent,
          borderRadius: 9,
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
          cursor: 'pointer',
          minWidth: 90, justifyContent: 'space-between',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {current === 'winner' && '★ '}
          {current}
        </span>
        <span style={{ fontSize: 8, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9,
          boxShadow: '0 6px 20px rgba(10,10,10,0.10)',
          zIndex: 50, padding: 4, minWidth: 140,
          display: 'flex', flexDirection: 'column', gap: 3,
        }}>
          {options.map(opt => {
            const oc = STATUS_COLORS[opt] || STATUS_COLORS.planned
            const isActive = opt === current
            return (
              <button
                key={opt}
                onClick={(e) => { e.stopPropagation(); onChange(opt); setOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 8px',
                  background: isActive ? oc.bg : 'transparent',
                  color: isActive ? oc.fg : 'var(--ink)',
                  border: '1px solid', borderColor: isActive ? oc.accent : 'transparent',
                  borderRadius: 9,
                  fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
                  cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--paper-2)' }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: oc.accent, flexShrink: 0 }} />
                {opt === 'winner' && '★ '}{opt}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

const inputStyle = {
  width: '100%', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 9,
  padding: '8px 10px', fontSize: 13, fontFamily: 'var(--sans)', color: 'var(--ink)', outline: 'none',
}
const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
  background: 'var(--accent)', color: 'var(--ink)', border: '1px solid var(--accent)', borderRadius: 9,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, cursor: 'pointer',
}
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
  background: 'var(--paper-2)', color: 'var(--ink-2)', border: '1px solid var(--rule)', borderRadius: 9,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500, cursor: 'pointer',
}
const btnSecondary = {
  padding: '8px 16px', background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--rule)', borderRadius: 9,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
}
