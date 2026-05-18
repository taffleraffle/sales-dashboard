import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AdThumbnail from './AdThumbnail'
import {
  Eyebrow, Pill, Icon, fmtMoney, fmtNum, humanAttr, frameColor, frameTone,
  ValueChip, attrColor, displayValue, PodiumRank, WinnerBadge,
} from '../editorial/atoms'

/*
  All-creatives spreadsheet — explicit attribute columns (Hook · Frame · Mech ·
  Pain · Proof) instead of pill tags. Wide table (~1280px), horizontal scroll
  on narrower viewports.
*/

// Grid columns: rank | thumb | ad+campaign | hook | frame | mech | pain | proof | booked | cpb | state
const GRID_COLS = '40px 56px minmax(200px, 1.3fr) 110px 110px 110px 130px 100px 80px 80px 90px'
const MIN_TABLE_WIDTH = 1180

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
  { key: 'fully_tagged', label: 'Fully tagged' },
  { key: 'missing_tags', label: 'Missing tags' },
]

export default function CreativeGrid({ rows, loading, onClickRow, pinnedTopN = 3 }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('booked_desc')
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  const processed = useMemo(() => {
    let list = [...(rows || [])]
    if (filter === 'winners')        list = list.filter(r => r.effective_winner)
    else if (filter === 'has_booked')   list = list.filter(r => (Number(r.booked) || 0) > 0)
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
  }, [rows, search, filter, sort])

  const filterActive = filter !== 'all' || search.trim().length > 0
  const visible = processed.slice(0, pageSize)
  const hasMore = processed.length > pageSize

  return (
    <div>
      {/* Filter + sort bar */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14,
        padding: '12px 16px', background: 'var(--paper-2)',
        border: '1px solid var(--rule)', borderBottom: 'none',
      }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 240 }}>
          <span style={{ position: 'absolute', left: 10, top: 8, color: 'var(--ink-4)' }}>
            {Icon.filter(13)}
          </span>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search ad name, campaign, or ID…"
            style={{
              width: '100%', padding: '6px 10px 6px 32px',
              fontFamily: 'var(--sans)', fontSize: 13,
              border: '1px solid var(--rule-2)', background: 'white',
            }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {FILTER_CHIPS.map(c => (
            <button key={c.key} onClick={() => setFilter(c.key)}
              style={{
                padding: '5px 10px',
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
        </div>
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
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
                      letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {processed.length} of {(rows || []).length}
        </span>
      </div>

      {/* Table — horizontally scrollable; min-width keeps columns from collapsing */}
      <div style={{ background: 'white', border: '1px solid var(--rule)', overflowX: 'auto' }}>
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
