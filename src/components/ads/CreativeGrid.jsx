import { useMemo, useState } from 'react'
import { Search, Filter, ArrowUpDown, Trophy, Eye, AlertCircle } from 'lucide-react'
import AdThumbnail from './AdThumbnail'

/*
  All-creatives grid for the Insights page. Replaces the previous top-10
  table. Renders a card per ad with thumbnail + attributes + perf metrics.

  Props:
    rows         — array of ad rows from lib_ad_performance
    loading      — boolean
    onClickRow   — (row) => void   — opens CreativeEditDrawer
    pinnedTopN   — number (default 3) — first N rows render as "pinned"
                   in a separate strip above the grid

  Controls: search by name, filter chips (has booked / winner / fully tagged
  / missing tags), sort dropdown, pagination (30 per page with Load more).
*/

const PAGE_SIZE = 30

const SORT_OPTIONS = [
  { key: 'booked_desc',   label: 'Most booked' },
  { key: 'cpb_asc',       label: 'Lowest CPB' },
  { key: 'spend_desc',    label: 'Most spend' },
  { key: 'recent',        label: 'Recently tagged' },
  { key: 'winrate_desc',  label: 'Win rate (effective)' },
]

const FILTER_CHIPS = [
  { key: 'all',          label: 'All' },
  { key: 'winners',      label: 'Winners' },
  { key: 'has_booked',   label: 'Has booked' },
  { key: 'fully_tagged', label: 'Fully tagged' },
  { key: 'missing_tags', label: 'Missing tags' },
]

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
function fmtN(n) { return n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString() }

export default function CreativeGrid({ rows, loading, onClickRow, pinnedTopN = 3 }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('booked_desc')
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  const processed = useMemo(() => {
    let list = [...(rows || [])]
    // Filter
    if (filter === 'winners')        list = list.filter(r => r.effective_winner)
    else if (filter === 'has_booked')   list = list.filter(r => (Number(r.booked) || 0) > 0)
    else if (filter === 'fully_tagged') list = list.filter(r => r.attributes_complete)
    else if (filter === 'missing_tags') list = list.filter(r => !r.attributes_complete)
    // Search
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(r =>
        (r.ad_name || '').toLowerCase().includes(q) ||
        (r.campaign_name || '').toLowerCase().includes(q) ||
        (r.ad_id || '').toLowerCase().includes(q)
      )
    }
    // Sort
    list.sort((a, b) => {
      const bn = (x) => Number(x) || 0
      switch (sort) {
        case 'booked_desc':   return bn(b.booked) - bn(a.booked)
        case 'cpb_asc':       {
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

  // Pinned strip behavior:
  //  - When no filter/search is active: pinned = top N from processed list (intuitive default)
  //  - When filter/search active: hide the pinned strip entirely. "Top performers"
  //    is a global concept; showing 2 winners as "top" when there are 0 results below
  //    is more confusing than helpful.
  const filterActive = filter !== 'all' || search.trim().length > 0
  const pinned = filterActive ? [] : processed.slice(0, pinnedTopN)
  const remainderStart = filterActive ? 0 : pinnedTopN
  const remainder = processed.slice(remainderStart, remainderStart + pageSize)
  const totalAfterPinned = processed.length - remainderStart
  const hasMore = totalAfterPinned > pageSize

  return (
    <div>
      {/* Pinned winners strip */}
      {pinned.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="eyebrow eyebrow-accent" style={{ marginBottom: 12 }}>
            <Trophy size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
            Top <em>performers</em>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                        gap: 12 }}>
            {pinned.map((r, i) => (
              <PinnedCard key={r.ad_id} ad={r} rank={i + 1} onClick={() => onClickRow?.(r)} />
            ))}
          </div>
        </div>
      )}

      {/* Filter + sort bar */}
      <div className="eyebrow" style={{ marginBottom: 12, color: 'var(--ink-3)' }}>
        All <em>creatives</em>
        <span style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 11,
                      color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'none', fontStyle: 'normal' }}>
          ({processed.length} of {(rows || []).length} ads)
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12,
                    padding: '12px 16px', background: 'var(--paper)',
                    border: '1px solid var(--rule)', marginBottom: 16, borderRadius: 2 }}>
        {/* Search */}
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 240 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--ink-4)' }} />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by ad name, campaign, or ID…"
            style={{
              width: '100%', padding: '7px 10px 7px 32px',
              fontFamily: 'var(--sans)', fontSize: 13,
              border: '1px solid var(--rule)', background: 'white', borderRadius: 2,
            }} />
        </div>

        {/* Filter chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Filter size={12} color="var(--ink-4)" />
          {FILTER_CHIPS.map(c => (
            <button key={c.key} onClick={() => setFilter(c.key)}
              style={{
                padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
                border: `1px solid ${filter === c.key ? 'var(--ink)' : 'var(--rule)'}`,
                background: filter === c.key ? 'var(--ink)' : 'white',
                color: filter === c.key ? 'var(--paper)' : 'var(--ink-3)',
                cursor: 'pointer', borderRadius: 2,
              }}>
              {c.label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ArrowUpDown size={12} color="var(--ink-4)" />
          <select value={sort} onChange={e => setSort(e.target.value)}
            style={{
              padding: '6px 8px', fontFamily: 'var(--sans)', fontSize: 12,
              border: '1px solid var(--rule)', background: 'white', borderRadius: 2,
            }}>
            {SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-4)',
                      fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
          Loading creatives…
        </div>
      ) : remainder.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-4)',
                      fontStyle: 'italic', fontFamily: 'var(--serif)',
                      border: '1px dashed var(--rule)', borderRadius: 2 }}>
          {search.trim() || filter !== 'all'
            ? `No creatives match "${search || filter}".`
            : 'No additional creatives beyond the top performers above.'}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 12,
        }}>
          {remainder.map(r => (
            <CreativeCard key={r.ad_id} ad={r} onClick={() => onClickRow?.(r)} />
          ))}
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <div style={{ marginTop: 20, textAlign: 'center' }}>
          <button onClick={() => setPageSize(p => p + PAGE_SIZE)}
            style={{
              padding: '10px 20px', fontFamily: 'var(--mono)', fontSize: 11,
              letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
              border: '1px solid var(--ink)', background: 'white', color: 'var(--ink)',
              cursor: 'pointer', borderRadius: 2,
            }}>
            Load {Math.min(PAGE_SIZE, totalAfterPinned - pageSize)} more
            <span style={{ marginLeft: 6, color: 'var(--ink-4)' }}>
              ({pageSize} of {totalAfterPinned})
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

function PinnedCard({ ad, rank, onClick }) {
  return (
    <div onClick={onClick} style={{
      padding: 14, background: 'white', border: '1px solid var(--rule)',
      borderTop: '3px solid var(--accent)', borderRadius: 2,
      cursor: 'pointer', transition: 'all 120ms ease',
      display: 'flex', gap: 12,
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--ink)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--rule)'}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <AdThumbnail ad={ad} size="lg" />
        <span style={{
          position: 'absolute', top: -6, left: -6,
          width: 28, height: 28, borderRadius: 14,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
          background: 'var(--accent)', color: 'var(--ink)',
          border: '2px solid var(--ink)',
        }}>{rank}</span>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink)', fontWeight: 500,
                      lineHeight: 1.3, marginBottom: 4,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {ad.ad_name || ad.ad_id}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                      letterSpacing: '0.04em', marginBottom: 8,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ad.campaign_name || '—'}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between',
                      fontFamily: 'var(--mono)', fontSize: 11 }}>
          <span style={{ color: 'var(--ink-3)' }}>
            <strong style={{ color: 'var(--ink)', fontSize: 14 }}>{fmtN(ad.booked)}</strong> booked
          </span>
          <span style={{ color: 'var(--ink-3)' }}>
            CPB <strong style={{ color: 'var(--ink)', fontSize: 14 }}>{fmt$(ad.cost_per_booked)}</strong>
          </span>
        </div>
        {ad.effective_winner && (
          <div style={{ marginTop: 6 }}>
            <span style={{ padding: '2px 8px', background: 'var(--accent)',
                          fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
                          letterSpacing: '0.12em', textTransform: 'uppercase',
                          borderRadius: 2 }}>
              Winner
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function CreativeCard({ ad, onClick }) {
  const isWinner = ad.effective_winner
  const missingTags = !ad.attributes_complete
  return (
    <div onClick={onClick} style={{
      background: 'white', border: '1px solid var(--rule)', borderRadius: 2,
      cursor: 'pointer', transition: 'border-color 120ms ease',
      overflow: 'hidden',
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--ink)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--rule)'}>
      {/* Thumbnail strip — full-width */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9',
                    background: 'var(--paper)', overflow: 'hidden' }}>
        <AdThumbnail ad={ad} size="xl"
          style={{ width: '100%', height: '100%', borderRadius: 0, border: 'none' }} />
        {isWinner && (
          <span style={{
            position: 'absolute', top: 6, right: 6,
            padding: '2px 7px', background: 'var(--accent)', color: 'var(--ink)',
            fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
            letterSpacing: '0.12em', textTransform: 'uppercase', borderRadius: 2,
            boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
          }}>
            Winner
          </span>
        )}
        {missingTags && (
          <span style={{
            position: 'absolute', top: 6, left: 6,
            padding: '2px 6px', background: 'rgba(10,10,10,0.7)', color: 'white',
            fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase', borderRadius: 2,
            display: 'inline-flex', alignItems: 'center', gap: 3,
          }}>
            <AlertCircle size={9} /> Untagged
          </span>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: 12 }}>
        <div style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink)', fontWeight: 500,
                      lineHeight: 1.3, marginBottom: 4,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {ad.ad_name || ad.ad_id}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                      letterSpacing: '0.04em', marginBottom: 8,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ad.campaign_name || '—'}
        </div>

        {/* Attribute pills */}
        {!missingTags && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 10 }}>
            {[ad.hook_type, ad.mechanism_reveal, ad.pain_angle, ad.proof_character]
              .filter(v => v && v !== 'none').slice(0, 4).map((v, i) => (
                <span key={i} style={{ padding: '1px 6px', background: 'var(--paper)',
                                      fontFamily: 'var(--mono)', fontSize: 9,
                                      color: 'var(--ink-3)', border: '1px solid var(--rule)',
                                      borderRadius: 2,
                                      maxWidth: 120, overflow: 'hidden',
                                      textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
              ))}
          </div>
        )}

        {/* Stats footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between',
                      fontFamily: 'var(--mono)', fontSize: 11,
                      paddingTop: 8, borderTop: '1px solid var(--rule)' }}>
          <span style={{ color: 'var(--ink-3)' }}>
            <strong style={{ color: 'var(--ink)', fontSize: 13 }}>{fmtN(ad.booked)}</strong> booked
          </span>
          <span style={{ color: 'var(--ink-3)' }}>
            CPB <strong style={{ color: 'var(--ink)', fontSize: 13 }}>{fmt$(ad.cost_per_booked)}</strong>
          </span>
        </div>
      </div>
    </div>
  )
}
