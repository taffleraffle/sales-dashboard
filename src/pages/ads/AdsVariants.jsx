import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Loader, AlertCircle, Search, GitBranch, ExternalLink } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import AddVariantModal from '../../components/ads/AddVariantModal'

/*
  Variants page — performance-first. Sorted by 30d spend on the linked Meta
  ad so winners + their splice recipes are immediately obvious. Each row
  shows the production state (5 stages: raw → rough → final → approved →
  uploaded) and which atomic clips were spliced together.

  Source: public.lib_variants_with_performance view (joins library.variants
  to ads + ad_daily_stats + lib_hyros_ad_attribution).
*/

const STAGES = [
  { key: 'raw',        label: 'Raw' },
  { key: 'rough_cut',  label: 'Rough' },
  { key: 'final_cut',  label: 'Final' },
  { key: 'approved',   label: 'Approved' },
  { key: 'uploaded',   label: 'Uploaded' },
]

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'ready', label: 'Ready' },
  { value: 'editing', label: 'Editing' },
  { value: 'planned', label: 'Planned' },
  { value: 'winner', label: 'Winner' },
  { value: 'killed', label: 'Killed' },
]

function fmt$(n) {
  if (n == null || isNaN(n) || n === 0) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${Math.round(n).toLocaleString()}`
}
function fmtN(n) {
  if (n == null || isNaN(n) || n === 0) return '—'
  return Math.round(n).toLocaleString()
}

export default function AdsVariants() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [savingStage, setSavingStage] = useState(null)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const { data, error: err } = await supabase
        .from('lib_variants_with_performance')
        .select('*')
        .order('spend_30d', { ascending: false, nullsFirst: false })
      if (err) throw new Error(err.message)
      setRows(data || [])
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
        (v.notes || '').toLowerCase().includes(q) ||
        (v.meta_ad_name || '').toLowerCase().includes(q) ||
        (v.hook_clip_id || '').toLowerCase().includes(q) ||
        (v.body_clip_id || '').toLowerCase().includes(q)
      )
    }
    return out
  }, [rows, statusFilter, search])

  const toggleStage = async (variant, stageKey) => {
    const next = !variant[`stage_${stageKey}`]
    setSavingStage(`${variant.variant_id}:${stageKey}`)
    setRows(prev => prev.map(r => r.variant_id === variant.variant_id ? { ...r, [`stage_${stageKey}`]: next } : r))
    try {
      const { error: err } = await supabase.rpc('lib_variant_set_stage', {
        p_variant_id: variant.variant_id,
        p_stage: stageKey,
        p_value: next,
      })
      if (err) throw new Error(err.message)
    } catch (e) {
      setRows(prev => prev.map(r => r.variant_id === variant.variant_id ? { ...r, [`stage_${stageKey}`]: !next } : r))
      setError(`Stage update failed: ${e.message}`)
    } finally {
      setSavingStage(null)
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">Production · Spliced variants</span>
          <h2 className="h3 mt-2" style={{ fontSize: 22 }}>The <em>variant</em> board.</h2>
          <p
            className="mt-2"
            style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}
          >
            {rows.length} variants · sorted by 30d spend · winning recipes float to top
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setModalOpen(true) }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 16px',
            background: 'var(--accent)', color: 'var(--ink)', border: '1px solid var(--accent)', borderRadius: 3,
            fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, cursor: 'pointer',
          }}
        >
          <Plus size={13} /> Add variant
        </button>
      </div>

      {/* Filter bar */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 8,
        padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 16,
      }}>
        <ChipGroup label="Status" value={statusFilter} setValue={setStatusFilter} options={STATUS_OPTIONS} />
        <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <Search size={12} style={{ color: 'var(--ink-3)', flexShrink: 0, marginLeft: 4 }} />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search variant ID, clips, ad name…"
            style={{ flex: 1, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: '5px 8px', fontSize: 12, color: 'var(--ink)', outline: 'none' }}
          />
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '12px 14px', background: 'var(--down-soft)', border: '1px solid var(--down)', borderLeftWidth: 3,
          borderRadius: '0 3px 3px 0', color: 'var(--down)', marginBottom: 16, fontSize: 13,
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 4 }}>Variants error</div>
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
      {!loading && rows.length === 0 && !error && (
        <div style={{
          border: '1px dashed var(--rule)', borderRadius: 4, padding: 32, textAlign: 'center', background: 'var(--paper-2)',
        }}>
          <span className="eyebrow eyebrow-accent" style={{ justifyContent: 'center', display: 'inline-flex', marginBottom: 12 }}>No variants yet</span>
          <h3 className="h3" style={{ fontSize: 22, marginBottom: 10 }}>Start the <em>variant board</em>.</h3>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)', maxWidth: '50ch', margin: '0 auto 18px', lineHeight: 1.55 }}>
            A variant is one spliced combination — hook clip + body clip + creator. Add atomic clips on the Clips tab first, then assemble them into variants here. Each variant tracks its production through five stages and links to its Meta ad once shipped, so live performance flows straight back to the splice recipe.
          </p>
          <button onClick={() => { setEditing(null); setModalOpen(true) }} style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 16px',
            background: 'var(--accent)', color: 'var(--ink)', border: '1px solid var(--accent)',
            borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, cursor: 'pointer',
          }}>
            <Plus size={13} /> Add first variant
          </button>
        </div>
      )}

      {/* Variant rows */}
      {!loading && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map(v => (
            <VariantRow
              key={v.variant_id}
              variant={v}
              onToggleStage={toggleStage}
              savingStage={savingStage}
              onEdit={() => { setEditing(v); setModalOpen(true) }}
            />
          ))}
        </div>
      )}

      <p style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 12 }}>
        {filtered.length} of {rows.length} variants
      </p>

      <AddVariantModal
        open={modalOpen}
        existing={editing}
        onClose={() => { setModalOpen(false); setEditing(null) }}
        onSaved={() => load()}
      />
    </div>
  )
}

function VariantRow({ variant: v, onToggleStage, savingStage, onEdit }) {
  const hasPerf = (v.spend_30d || 0) > 0
  const accent = v.status === 'winner' ? 'var(--accent)' :
                 v.status === 'live' ? 'var(--ink)' :
                 v.status === 'killed' ? 'var(--down)' :
                 'var(--rule)'

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: hasPerf ? '120px minmax(0, 1fr) auto' : 'minmax(0, 1fr) auto',
      gap: 16,
      padding: '14px 16px',
      background: 'var(--paper)',
      border: '1px solid var(--rule)',
      borderLeftWidth: 3,
      borderLeftColor: accent,
      borderRadius: 3,
    }}>
      {/* Left thumbnail (if linked to a live ad) */}
      {hasPerf && (
        <div style={{ aspectRatio: '1', overflow: 'hidden', background: 'var(--paper-2)', borderRadius: 2 }}>
          {v.ad_thumbnail_url ? (
            <img src={v.ad_thumbnail_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : null}
        </div>
      )}

      {/* Middle column */}
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* Variant ID + status pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Link to={`/sales/ads/variants/${encodeURIComponent(v.variant_id)}`} style={{
            fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--ink)',
            textDecoration: 'none', letterSpacing: '0.04em',
          }}>{v.variant_id}</Link>
          <StatusPill status={v.status} />
          {v.priority && <PriorityChip p={v.priority} />}
          {v.editor && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              · {v.editor}
            </span>
          )}
        </div>

        {/* Splice recipe */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em' }}>
          {v.hook_clip_id && <ChipLabel>HOOK · {v.hook_clip_id}</ChipLabel>}
          {v.body_clip_id && <ChipLabel>BODY · {v.body_clip_id}</ChipLabel>}
          {v.frame_clip_id && <ChipLabel>FRAME · {v.frame_clip_id}</ChipLabel>}
          {v.creator_id && <ChipLabel>CREATOR · {v.creator_id}</ChipLabel>}
          {!v.hook_clip_id && !v.body_clip_id && (
            <span style={{ fontStyle: 'italic', color: 'var(--ink-4)', textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--serif)', fontSize: 12 }}>
              No clips assigned yet
            </span>
          )}
        </div>

        {/* Linked Meta ad */}
        {v.meta_ad_id ? (
          <div style={{ fontFamily: 'var(--serif)', fontSize: 12, color: 'var(--ink-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Link to={`/sales/ads/ad/${v.meta_ad_id}`} style={{ color: 'var(--ink-2)', textDecoration: 'underline', textDecorationColor: 'var(--ink-4)' }}>
              {v.meta_ad_name || v.meta_ad_id}
            </Link>
            <ExternalLink size={10} style={{ color: 'var(--ink-4)' }} />
          </div>
        ) : (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Not linked to a Meta ad yet
          </div>
        )}

        {/* Performance row */}
        {hasPerf && (
          <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
            <Metric label="Spend 30d" value={fmt$(v.spend_30d)} />
            <Metric label="Booked" value={fmtN(v.hyros_calls)} sub={v.hyros_qualified ? `${v.hyros_qualified} qual.` : null} />
            <Metric label="Leads" value={fmtN(v.results_30d)} />
            <Metric label="Revenue" value={fmt$(parseFloat(v.hyros_revenue || 0))} />
          </div>
        )}
      </div>

      {/* Right column — production stages + edit */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', minWidth: 200 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {STAGES.map(s => (
            <StageButton
              key={s.key}
              label={s.label}
              checked={v[`stage_${s.key}`]}
              saving={savingStage === `${v.variant_id}:${s.key}`}
              onClick={() => onToggleStage(v, s.key)}
            />
          ))}
        </div>
        <button onClick={onEdit} style={{
          padding: '4px 10px', background: 'transparent', color: 'var(--ink-3)', border: '1px solid var(--rule)',
          borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
          cursor: 'pointer',
        }}>Edit</button>
      </div>
    </div>
  )
}

function ChipLabel({ children }) {
  return (
    <span style={{
      padding: '2px 6px', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 500,
    }}>{children}</span>
  )
}

function StatusPill({ status }) {
  if (!status) return null
  const isWinner = status === 'winner'
  const isLive = status === 'live'
  const bg = isWinner ? 'var(--accent)' : isLive ? 'var(--ink)' : 'var(--paper-2)'
  const fg = isWinner ? 'var(--ink)' : isLive ? 'var(--paper)' : 'var(--ink-2)'
  return (
    <span style={{
      padding: '2px 8px', background: bg, color: fg, border: '1px solid', borderColor: bg, borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600,
    }}>{status}</span>
  )
}

function PriorityChip({ p }) {
  return (
    <span style={{
      padding: '2px 7px', background: p === 'high' ? 'var(--accent-soft)' : 'transparent',
      border: '1px solid var(--rule)', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, color: p === 'high' ? 'var(--ink)' : 'var(--ink-3)', letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
    }}>{p}</span>
  )
}

function StageButton({ label, checked, saving, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={saving}
      title={checked ? `${label} — done (click to undo)` : `Mark ${label} done`}
      style={{
        padding: '3px 8px',
        background: checked ? 'var(--accent)' : 'var(--paper-2)',
        color: checked ? 'var(--ink)' : 'var(--ink-3)',
        border: '1px solid', borderColor: checked ? 'var(--accent)' : 'var(--rule)',
        borderRadius: 2,
        fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
        cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.5 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

function Metric({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 14, fontWeight: 500, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--ink-4)', letterSpacing: '0.08em' }}>{sub}</div>}
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
