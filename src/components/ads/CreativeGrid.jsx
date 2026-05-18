import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AdThumbnail from './AdThumbnail'
import {
  Eyebrow, Pill, Icon, fmtMoney, fmtMoneyFull, fmtNum, humanAttr, frameColor, frameTone,
  ValueChip, attrColor, displayValue, PodiumRank, WinnerBadge,
} from '../editorial/atoms'

const FILTER_GROUPS = [
  { attr: 'assignment_status', label: 'Source',  values: ['assigned', 'manual_transcript', 'auto_transcript', 'ad_copy_only', 'unassigned'] },
  { attr: 'asset_type',       label: 'Asset',     values: ['video', 'image'] },
  { attr: 'message_frame',    label: 'Frame',     values: ['problem', 'circumstance', 'outcome'] },
  { attr: 'hook_type',        label: 'Hook',      values: ['question', 'scene', 'dollar_pain', 'diagnostic', 'conditional'] },
  { attr: 'mechanism_reveal', label: 'Mechanism', values: ['gated', 'explicit', 'hidden'] },
  { attr: 'funnel_stage',     label: 'Funnel',    values: ['tof', 'mof', 'bof', 'cross'] },
  { attr: 'format',           label: 'Format',    values: ['talking_head', 'ugc', 'comparative', 'voiceover'] },
  { attr: 'proof_character',  label: 'Proof',     values: ['eric', 'adam', 'belinda', 'morgan', 'karen', 'derek', 'mike', 'none'] },
  { attr: 'pain_angle',       label: 'Pain angle', values: ['phone_not_ringing', 'agency_burn', 'tpa_referral_dep', 'capacity_mismatch', 'lead_platform', 'storm_seasonal', 'guarantee_proof', 'founder_identity', 'adjuster_relations', 'commercial_tier', 'last_objection'] },
]

// Assignment status badge — quick visual for assigned/unassigned per row.
// Falls back gracefully if migration 065 hasn't been applied (assignment_status undefined → 'unknown').
const ASSIGNMENT_LABELS = {
  assigned:          { label: 'Assigned',   color: '#3e8a5e', desc: 'Linked to a generated script' },
  manual_transcript: { label: 'Manual',     color: '#1f4a8b', desc: 'Operator added transcript' },
  auto_transcript:   { label: 'Auto',       color: '#5a5650', desc: 'Whisper or Meta captions' },
  ad_copy_only:      { label: 'Copy only',  color: '#88847e', desc: 'Only Meta ad copy as transcript' },
  unassigned:        { label: 'Unassigned', color: '#b53e3e', desc: 'No transcript, no script link' },
  unknown:           { label: '—',          color: '#b8b3a8', desc: 'Status unknown (migration 065 pending)' },
}
function tintRgba(hex, a) {
  if (!hex || !hex.startsWith('#')) return `rgba(0,0,0,${a})`
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}
function AssignmentChip({ status }) {
  const cfg = ASSIGNMENT_LABELS[status] || ASSIGNMENT_LABELS.unknown
  return (
    <span title={cfg.desc} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 7px',
      background: tintRgba(cfg.color, 0.1),
      color: cfg.color,
      border: `1px solid ${tintRgba(cfg.color, 0.25)}`,
      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
      letterSpacing: '0.04em', textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: 6, background: cfg.color, flexShrink: 0,
      }} />
      {cfg.label}
    </span>
  )
}

/*
  All-creatives spreadsheet — explicit attribute columns (Hook · Frame · Mech ·
  Pain · Proof) instead of pill tags. Wide table (~1280px), horizontal scroll
  on narrower viewports.
*/

// Grid columns: rank | thumb | ad+campaign | source | hook | frame | mech | pain | proof | booked | cpb | state
const GRID_COLS = '40px 56px minmax(200px, 1.3fr) 110px 110px 110px 110px 130px 100px 80px 80px 90px'
const MIN_TABLE_WIDTH = 1300

const PAGE_SIZE = 30

const SORT_OPTIONS = [
  { key: 'booked_desc',   label: 'Booked ↓' },
  { key: 'cpb_asc',       label: 'CPB ↑' },
  { key: 'spend_desc',    label: 'Spend ↓' },
  { key: 'recent',        label: 'Recent' },
  { key: 'winrate_desc',  label: 'Winners' },
]

const FILTER_CHIPS = [
  { key: 'all',          label: 'All' },
  { key: 'winners',      label: 'Winners' },
  { key: 'has_booked',   label: 'Has booked' },
  { key: 'unassigned',   label: 'Unassigned' },
  { key: 'fully_tagged', label: 'Fully tagged' },
  { key: 'missing_tags', label: 'Missing tags' },
]

export default function CreativeGrid({ rows, loading, onClickRow, pinnedTopN = 3 }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('booked_desc')
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  // Attribute-rail filters: { attr: Set<value> }
  const [attrFilters, setAttrFilters] = useState({})

  const toggleAttrFilter = (attr, value) => {
    setAttrFilters(prev => {
      const next = { ...prev }
      const set = new Set(next[attr] || [])
      if (set.has(value)) set.delete(value)
      else set.add(value)
      if (set.size === 0) delete next[attr]
      else next[attr] = set
      return next
    })
  }
  const clearAllAttrFilters = () => { setAttrFilters({}); setFilter('all'); setSearch('') }
  const attrFilterCount = Object.values(attrFilters).reduce((s, v) => s + v.size, 0)

  const processed = useMemo(() => {
    let list = [...(rows || [])]
    if (filter === 'winners')        list = list.filter(r => r.effective_winner)
    else if (filter === 'has_booked')   list = list.filter(r => (Number(r.booked) || 0) > 0)
    else if (filter === 'unassigned')   list = list.filter(r => !r.assignment_status || r.assignment_status === 'unassigned' || r.assignment_status === 'ad_copy_only' || r.assignment_status === 'auto_transcript')
    else if (filter === 'fully_tagged') list = list.filter(r => r.attributes_complete)
    else if (filter === 'missing_tags') list = list.filter(r => !r.attributes_complete)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(r =>
        (r.ad_name || '').toLowerCase().includes(q) ||
        (r.campaign_name || '').toLowerCase().includes(q) ||
        (r.ad_id || '').toLowerCase().includes(q)
      )
    }
    // Apply attribute-rail filters (AND across attrs, OR within an attr)
    for (const attr in attrFilters) {
      const vals = attrFilters[attr]
      if (!vals || vals.size === 0) continue
      list = list.filter(r => vals.has(r[attr]))
    }
    list.sort((a, b) => {
      const bn = (x) => Number(x) || 0
      switch (sort) {
        case 'booked_desc':   return bn(b.booked) - bn(a.booked)
        case 'cpb_asc': {
          const ca = a.cost_per_booked == null ? Infinity : Number(a.cost_per_booked)
          const cb = b.cost_per_booked == null ? Infinity : Number(b.cost_per_booked)
          return ca - cb
        }
        case 'spend_desc':    return bn(b.spend) - bn(a.spend)
        case 'recent':        return new Date(b.extracted_at || 0) - new Date(a.extracted_at || 0)
        case 'winrate_desc':  return (b.effective_winner ? 1 : 0) - (a.effective_winner ? 1 : 0)
        default:              return 0
      }
    })
    return list
  }, [rows, search, filter, sort, attrFilters])

  // Counter strip stats from the filtered list
  const stats = useMemo(() => {
    const winners = processed.filter(r => r.effective_winner).length
    const totalSpend = processed.reduce((s, r) => s + (Number(r.spend) || 0), 0)
    const totalBooked = processed.reduce((s, r) => s + (Number(r.booked) || 0), 0)
    const avgCpb = totalBooked > 0 ? Math.round(totalSpend / totalBooked) : 0
    return { count: processed.length, winners, totalSpend, totalBooked, avgCpb }
  }, [processed])

  const filterActive = filter !== 'all' || search.trim().length > 0 || attrFilterCount > 0
  const visible = processed.slice(0, pageSize)
  const hasMore = processed.length > pageSize

  return (
    <div>
      {/* Toolbar: search + counters + sort */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14,
        padding: '12px 16px', background: 'white',
        border: '1px solid var(--rule)',
      }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 240, maxWidth: 320 }}>
          <span style={{ position: 'absolute', left: 10, top: 8, color: 'var(--ink-4)' }}>
            {Icon.filter(13)}
          </span>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search ads, campaigns, ad_id…"
            style={{
              width: '100%', padding: '7px 10px 7px 32px',
              fontFamily: 'var(--sans)', fontSize: 13,
              border: '1px solid var(--rule-2)', background: 'var(--paper)',
              outline: 'none',
            }} />
        </div>
        <Counter v={fmtNum(stats.count)} l="creatives" />
        <Counter v={fmtNum(stats.winners)} l="winners" />
        <Counter v={fmtNum(stats.totalBooked)} l="booked" />
        <Counter v={fmtMoney(stats.totalSpend)} l="spend" />
        <Counter v={stats.avgCpb > 0 ? `$${stats.avgCpb}` : '—'} l="avg CPB" />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Eyebrow>Sort</Eyebrow>
          {SORT_OPTIONS.map(o => (
            <button key={o.key} onClick={() => setSort(o.key)}
              style={{
                padding: '5px 10px',
                fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.04em',
                textTransform: 'uppercase', fontWeight: 500,
                border: `1px solid ${sort === o.key ? 'var(--ink)' : 'var(--rule-2)'}`,
                background: sort === o.key ? 'var(--ink)' : 'transparent',
                color: sort === o.key ? 'var(--paper)' : 'var(--ink-3)',
                cursor: 'pointer',
              }}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Quick-filter chip row */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
        padding: '10px 16px', background: 'var(--paper-2)',
        borderLeft: '1px solid var(--rule)', borderRight: '1px solid var(--rule)',
        borderBottom: '1px solid var(--rule)',
      }}>
        <Eyebrow>Quick filter</Eyebrow>
        {FILTER_CHIPS.map(c => (
          <button key={c.key} onClick={() => setFilter(c.key)}
            style={{
              padding: '4px 10px',
              fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.04em',
              textTransform: 'uppercase', fontWeight: 500,
              border: `1px solid ${filter === c.key ? 'var(--ink)' : 'var(--rule-2)'}`,
              background: filter === c.key ? 'var(--ink)' : 'transparent',
              color: filter === c.key ? 'var(--paper)' : 'var(--ink-3)',
              cursor: 'pointer',
            }}>
            {c.label}
          </button>
        ))}
        {(attrFilterCount > 0 || filter !== 'all' || search.trim()) && (
          <button onClick={clearAllAttrFilters}
            style={{
              marginLeft: 'auto', padding: '4px 10px',
              fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.04em',
              textTransform: 'uppercase', fontWeight: 500,
              background: 'transparent', color: '#b53e3e',
              border: '1px solid rgba(181,62,62,0.4)', cursor: 'pointer',
            }}>
            Clear {attrFilterCount > 0 ? `${attrFilterCount} filter${attrFilterCount === 1 ? '' : 's'}` : 'all'}
          </button>
        )}
      </div>

      {/* Two-column: left filter rail + table */}
      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 0 }}>
        <FilterRail rows={rows || []} filters={attrFilters}
          onToggle={toggleAttrFilter} onClear={clearAllAttrFilters} filterCount={attrFilterCount} />

      {/* Table — horizontally scrollable; min-width keeps columns from collapsing */}
      <div style={{ background: 'white', border: '1px solid var(--rule)',
                    borderLeft: 'none', overflowX: 'auto' }}>
        <div style={{ minWidth: MIN_TABLE_WIDTH }}>
        {/* Header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: GRID_COLS,
          alignItems: 'end', gap: 12,
          padding: '12px 18px',
          background: 'var(--paper-2)',
          borderBottom: '1px solid var(--rule)',
        }}>
          <Eyebrow>#</Eyebrow>
          <Eyebrow>Creative</Eyebrow>
          <Eyebrow>Ad · campaign</Eyebrow>
          <Eyebrow>Source</Eyebrow>
          <Eyebrow>Hook</Eyebrow>
          <Eyebrow>Frame</Eyebrow>
          <Eyebrow>Mech</Eyebrow>
          <Eyebrow>Pain angle</Eyebrow>
          <Eyebrow>Proof</Eyebrow>
          <Eyebrow style={{ textAlign: 'right' }}>Booked</Eyebrow>
          <Eyebrow style={{ textAlign: 'right' }}>CPB</Eyebrow>
          <Eyebrow style={{ textAlign: 'right' }}>State</Eyebrow>
        </div>

        {/* Rows */}
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-4)',
                        fontFamily: 'var(--serif)', fontStyle: 'italic' }}>
            Loading creatives…
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-4)',
                        fontFamily: 'var(--serif)', fontStyle: 'italic' }}>
            {filterActive
              ? `No creatives match "${search || filter}".`
              : 'No tagged creatives yet.'}
          </div>
        ) : visible.map((c, i) => {
          const rank = i + 1
          const isPodium = !filterActive && rank <= pinnedTopN && c.effective_winner
          return (
            <CreativeRow key={c.ad_id} c={c} rank={rank} isPodium={isPodium}
              onClick={() => onClickRow?.(c)}
              isLast={i === visible.length - 1} />
          )
        })}
        </div>
      </div>
      </div>{/* /two-column grid */}

      {/* Load more */}
      {hasMore && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button onClick={() => setPageSize(p => p + PAGE_SIZE)}
            style={{
              padding: '8px 18px',
              fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.04em',
              textTransform: 'uppercase', fontWeight: 500,
              border: '1px solid var(--ink-3)', background: 'transparent',
              color: 'var(--ink)', cursor: 'pointer',
            }}>
            Load {Math.min(PAGE_SIZE, processed.length - pageSize)} more
            <span style={{ marginLeft: 6, color: 'var(--ink-4)' }}>
              ({pageSize} of {processed.length})
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Counter — tiny serif+mono pair for the toolbar strip ─────────────
function Counter({ v, l }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{
        fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
        fontSize: 17, color: 'var(--ink)',
      }}>{v}</span>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
        letterSpacing: '0.04em', textTransform: 'uppercase',
      }}>{l}</span>
    </div>
  )
}

// ─── FilterRail — collapsible attribute groups with value counts ──────
function FilterRail({ rows, filters, onToggle, onClear, filterCount }) {
  // Compute counts per (attr, value) from the unfiltered rows
  const counts = useMemo(() => {
    const out = {}
    for (const g of FILTER_GROUPS) {
      out[g.attr] = {}
      g.values.forEach(v => { out[g.attr][v] = 0 })
      rows.forEach(r => {
        if (out[g.attr][r[g.attr]] != null) out[g.attr][r[g.attr]]++
      })
    }
    return out
  }, [rows])

  return (
    <div>
      <div style={{
        padding: '10px 14px', background: 'white',
        border: '1px solid var(--rule)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <Eyebrow>Filter</Eyebrow>
        {filterCount > 0 && (
          <button onClick={onClear} style={{
            background: 'transparent', border: 'none',
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
            letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer',
            padding: 0,
          }}>clear all</button>
        )}
      </div>
      <div style={{
        background: 'white',
        borderLeft: '1px solid var(--rule)',
        borderRight: '1px solid var(--rule)',
        borderBottom: '1px solid var(--rule)',
      }}>
        {FILTER_GROUPS.map((g, gi) => (
          <FilterGroup key={g.attr} group={g} counts={counts[g.attr] || {}}
                       active={filters[g.attr] || new Set()}
                       toggle={(v) => onToggle(g.attr, v)} />
        ))}
      </div>
    </div>
  )
}

function FilterGroup({ group, counts, active, toggle }) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ borderTop: '1px solid var(--rule)' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', textAlign: 'left',
        padding: '10px 14px',
        background: 'transparent', border: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        cursor: 'pointer',
      }}>
        <span style={{ fontFamily: 'var(--serif)', fontSize: 14 }}>{group.label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {active.size > 0 && (
            <span style={{
              padding: '1px 6px', background: 'var(--ink)', color: 'var(--paper)',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            }}>{active.size}</span>
          )}
          <span style={{
            color: 'var(--ink-4)', fontSize: 12,
            transform: open ? 'rotate(90deg)' : 'rotate(0)',
            transition: 'transform 0.15s cubic-bezier(0.2,0.7,0.2,1)',
            display: 'inline-block',
          }}>›</span>
        </div>
      </button>
      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          {group.values.map(v => {
            const isActive = active.has(v)
            const count = counts[v] || 0
            const valColor = attrColor(group.attr, v)
            return (
              <button key={v} onClick={() => toggle(v)} disabled={count === 0}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '5px 8px',
                  background: isActive ? 'var(--paper-2)' : 'transparent',
                  color: count === 0 ? 'var(--ink-5)' : 'var(--ink-2)',
                  border: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  cursor: count === 0 ? 'default' : 'pointer',
                  opacity: count === 0 ? 0.5 : 1,
                }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{
                    width: 12, height: 12,
                    background: isActive ? 'var(--ink)' : 'transparent',
                    border: `1px solid ${isActive ? 'var(--ink)' : 'var(--rule-2)'}`,
                    display: 'inline-grid', placeItems: 'center',
                    color: 'var(--accent)', fontSize: 9, flexShrink: 0,
                  }}>{isActive ? '✓' : ''}</span>
                  <span style={{
                    width: 7, height: 7, borderRadius: 7, background: valColor, flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: 12.5,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{displayValue(v)}</span>
                </span>
                <span style={{
                  fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                  fontSize: 10.5, color: 'var(--ink-4)', flexShrink: 0, marginLeft: 4,
                }}>{count}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CreativeRow({ c, rank, isPodium, onClick, isLast }) {
  const frame = c.message_frame
  const isWinner = !!c.effective_winner
  const proof = c.proof_character && c.proof_character !== 'none' ? c.proof_character : null

  return (
    <div onClick={onClick}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      style={{
        display: 'grid',
        gridTemplateColumns: GRID_COLS,
        alignItems: 'center', gap: 12,
        padding: '14px 18px',
        paddingLeft: isWinner ? 15 : 18,
        borderBottom: isLast ? 'none' : '1px solid var(--rule)',
        borderLeft: isWinner ? '3px solid var(--accent)' : '3px solid transparent',
        cursor: 'pointer',
        transition: 'background 0.12s cubic-bezier(0.2,0.7,0.2,1)',
      }}>
      {/* Rank */}
      <div>
        <PodiumRank rank={rank} size="sm" />
      </div>

      {/* Thumbnail with frame-color top stripe + winner star */}
      <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
        <AdThumbnail ad={c} size="md" style={{
          outline: isWinner ? '2px solid var(--accent)' : 'none',
          outlineOffset: isWinner ? -2 : 0,
        }} />
        {frame && (
          <span style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 4,
            background: frameColor(frame), pointerEvents: 'none', zIndex: 1,
          }} />
        )}
        {isWinner && (
          <span style={{
            position: 'absolute', top: -6, right: -6,
            width: 18, height: 18, background: 'var(--accent)',
            border: '1.5px solid var(--paper)',
            display: 'grid', placeItems: 'center',
            color: 'var(--ink)', fontSize: 10, fontWeight: 700,
            borderRadius: 18, zIndex: 2,
          }}>★</span>
        )}
      </div>

      {/* Ad name + campaign */}
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--serif)', fontSize: 16, lineHeight: 1.2,
          color: 'var(--ink)', fontWeight: 500,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {c.ad_name || c.ad_id}
        </div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
          marginTop: 3, letterSpacing: '0.02em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {c.campaign_name || '—'} <span style={{ opacity: 0.6 }}>· {c.ad_id}</span>
        </div>
      </div>

      {/* Source / assignment chip */}
      <div style={{ overflow: 'hidden' }}>
        <AssignmentChip status={c.assignment_status} />
      </div>

      {/* Explicit attribute columns */}
      <AttrCell attr="hook_type"        value={c.hook_type} />
      <AttrCell attr="message_frame"    value={c.message_frame} />
      <AttrCell attr="mechanism_reveal" value={c.mechanism_reveal} />
      <AttrCell attr="pain_angle"       value={c.pain_angle} />
      <AttrCell attr="proof_character"  value={proof} />

      {/* Booked */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                      fontSize: 20, lineHeight: 1, color: 'var(--ink)', fontWeight: 500 }}>
          {fmtNum(c.booked)}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginTop: 3 }}>
          {c.leads ? `${c.leads} leads` : ''}
        </div>
      </div>

      {/* CPB */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                      fontSize: 20, lineHeight: 1, color: 'var(--ink)', fontWeight: 500 }}>
          {c.cost_per_booked != null ? fmtMoney(Number(c.cost_per_booked)) : '—'}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginTop: 3 }}>
          {c.spend ? `${fmtMoney(Number(c.spend))} spent` : ''}
        </div>
      </div>

      {/* State */}
      <div style={{ textAlign: 'right' }}>
        {isWinner ? (
          <WinnerBadge size="sm" />
        ) : (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-5)',
                        letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Testing
          </span>
        )}
      </div>
    </div>
  )
}

// Single attribute cell — colored ValueChip if tagged, em-dash if not
function AttrCell({ attr, value }) {
  if (!value) {
    return (
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-5)',
        textAlign: 'left',
      }}>—</span>
    )
  }
  return (
    <div style={{ overflow: 'hidden' }}>
      <ValueChip attr={attr} value={value} size="xs" />
    </div>
  )
}
