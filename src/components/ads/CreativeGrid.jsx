import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AdThumbnail from './AdThumbnail'
import {
  Eyebrow, Pill, Icon, fmtMoney, fmtNum, humanAttr, frameColor, frameTone,
} from '../editorial/atoms'

/*
  All-creatives editorial table — implements the design from
  design-pkg/ad-performance/project/creatives.jsx.

  Replaces the previous card grid. Shows: rank · thumb (with frame stripe) ·
  ad+campaign · attribute pills · booked · CPB · winner state.

  Rank cells 1-3 (winners only) render as serif italic numbers in an accent
  box — the editorial podium treatment.
  Filter + sort + search controls in the header bar. Pagination 30/page.
*/

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

      {/* Table */}
      <div style={{ background: 'white', border: '1px solid var(--rule)' }}>
        {/* Header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '40px 72px minmax(260px, 2fr) minmax(280px, 2.4fr) 84px 84px 88px',
          alignItems: 'center', gap: 14,
          padding: '10px 18px',
          background: 'var(--paper-2)',
          borderBottom: '1px solid var(--rule)',
        }}>
          <Eyebrow>#</Eyebrow>
          <Eyebrow>Creative</Eyebrow>
          <Eyebrow>Ad · campaign</Eyebrow>
          <Eyebrow>Tags</Eyebrow>
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

  return (
    <div onClick={onClick}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      style={{
        display: 'grid',
        gridTemplateColumns: '40px 72px minmax(260px, 2fr) minmax(280px, 2.4fr) 84px 84px 88px',
        alignItems: 'center', gap: 14,
        padding: '14px 18px',
        borderBottom: isLast ? 'none' : '1px solid var(--rule)',
        cursor: 'pointer',
        transition: 'background 0.12s cubic-bezier(0.2,0.7,0.2,1)',
      }}>
      {/* Rank */}
      <div>
        {isPodium ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26,
            background: 'var(--accent)', color: 'var(--ink)',
            fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500, fontStyle: 'italic',
            fontVariantNumeric: 'tabular-nums',
            border: '1px solid var(--accent-2)',
          }}>
            {rank}
          </span>
        ) : (
          <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                        fontSize: 12, color: 'var(--ink-4)' }}>
            {String(rank).padStart(2, '0')}
          </span>
        )}
      </div>

      {/* Thumbnail with frame-color top stripe */}
      <div style={{ position: 'relative' }}>
        <AdThumbnail ad={c} size="md" />
        {frame && (
          <span style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 3,
            background: frameColor(frame),
          }} />
        )}
        {isWinner && (
          <span style={{
            position: 'absolute', inset: 0,
            outline: '2px solid var(--accent)', outlineOffset: -2,
            pointerEvents: 'none',
          }} />
        )}
      </div>

      {/* Ad name + campaign */}
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--serif)', fontSize: 17, lineHeight: 1.2,
          color: 'var(--ink)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {c.ad_name || c.ad_id}
        </div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
          marginTop: 3, letterSpacing: '0.02em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {c.campaign_name || '—'} <span style={{ opacity: 0.6 }}>· {c.ad_id}</span>
        </div>
      </div>

      {/* Attribute pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {[
          c.hook_type && { k: 'hook', v: c.hook_type },
          c.message_frame && { k: 'frame', v: c.message_frame, tone: frameTone(c.message_frame) },
          c.mechanism_reveal && { k: 'mech', v: c.mechanism_reveal },
          c.pain_angle && { k: 'pain', v: c.pain_angle },
          c.proof_character && c.proof_character !== 'none' && { k: 'proof', v: c.proof_character },
        ].filter(Boolean).slice(0, 5).map((p, i) => (
          <Pill key={i} tone={p.tone || 'default'} size="xs">
            <span style={{ color: 'var(--ink-4)', marginRight: 4 }}>{p.k}</span>
            {humanAttr(p.v)}
          </Pill>
        ))}
        {!c.hook_type && !c.message_frame && !c.pain_angle && (
          <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic',
                        fontSize: 11, color: 'var(--ink-4)' }}>
            click to tag →
          </span>
        )}
      </div>

      {/* Booked */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                      fontSize: 22, lineHeight: 1, color: 'var(--ink)' }}>
          {fmtNum(c.booked)}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginTop: 2 }}>
          {c.leads ? `${c.leads} leads` : ''}
        </div>
      </div>

      {/* CPB */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                      fontSize: 22, lineHeight: 1, color: 'var(--ink)' }}>
          {c.cost_per_booked != null ? fmtMoney(Number(c.cost_per_booked)) : '—'}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginTop: 2 }}>
          {c.spend ? `${fmtMoney(Number(c.spend))} spent` : ''}
        </div>
      </div>

      {/* State */}
      <div style={{ textAlign: 'right' }}>
        {isWinner ? (
          <span style={{
            display: 'inline-block', padding: '3px 9px',
            background: 'var(--accent)', color: 'var(--ink)',
            border: '1px solid var(--accent-2)',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>
            Winner
          </span>
        ) : (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-5)',
                        letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            testing
          </span>
        )}
      </div>
    </div>
  )
}
