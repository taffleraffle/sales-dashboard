import { useMemo, useState } from 'react'
import Modal from '../editorial/Modal'
import {
  Eyebrow, ValueChip, attrColor, tint, PALETTE,
} from '../editorial/atoms'

/*
  Centered campaign picker — replaces the cramped toolbar dropdown.

  Big, bold, scannable. Search · status filter · sort. Shows per-campaign
  launch date (MIN first_seen_at), current Meta status, ads + tagged
  rollup, spend in window, top winning hook/pain chips.

  Selection writes through to the same activeCampaigns state the toolbar
  + Tests page use, so opening this from any analytics page sets scope
  for every analytics page.
*/

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return `$${Math.round(n)}`
}
function fmtDate(d) {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  if (isNaN(date.getTime())) return '—'
  const now = Date.now()
  const days = Math.floor((now - date.getTime()) / 86400000)
  if (days < 1) return 'today'
  if (days < 7) return `${days}d ago`
  if (days < 60) return `${Math.floor(days / 7)}w ago`
  return date.toISOString().slice(0, 10)
}

export default function CampaignPickerModal({ open, onClose, perfRaw, activeCampaigns, toggleCampaign, clearCampaigns }) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')      // all | live | paused | needs_setup
  const [sortKey, setSortKey] = useState('recent')              // recent | spend | ads | tagged | name

  // Per-campaign aggregate (matches the Tests page shape)
  const campaigns = useMemo(() => {
    if (!perfRaw) return []
    const map = new Map()
    for (const r of perfRaw) {
      const name = r.campaign_name
      if (!name) continue
      const entry = map.get(name) || {
        name, ads: 0, taggedAds: 0, winners: 0, excluded: 0, anyLive: false,
        spend: 0, booked: 0,
        firstSeen: null, lastSynced: null,
        hookCounts: {}, painCounts: {},
      }
      entry.ads++
      if (r.hook_type) entry.taggedAds++
      if (r.effective_winner) entry.winners++
      if (r.exclude_from_tests) entry.excluded++
      if (r.is_live || r.effective_status === 'ACTIVE') entry.anyLive = true
      entry.spend += Number(r.spend) || 0
      entry.booked += Number(r.booked) || 0
      // Launch / activity dates — earliest first_seen, latest last_synced
      if (r.first_seen_at) {
        const t = new Date(r.first_seen_at).getTime()
        if (!entry.firstSeen || t < entry.firstSeen) entry.firstSeen = t
      }
      if (r.last_synced_at) {
        const t = new Date(r.last_synced_at).getTime()
        if (!entry.lastSynced || t > entry.lastSynced) entry.lastSynced = t
      }
      const booked = Number(r.booked) || 0
      if (booked > 0) {
        if (r.hook_type)  entry.hookCounts[r.hook_type]  = (entry.hookCounts[r.hook_type]  || 0) + booked
        if (r.pain_angle) entry.painCounts[r.pain_angle] = (entry.painCounts[r.pain_angle] || 0) + booked
      }
      map.set(name, entry)
    }
    const rows = [...map.values()].map(e => {
      const topOf = (counts) => {
        let best = null, n = 0
        for (const k in counts) if (counts[k] > n) { best = k; n = counts[k] }
        return best
      }
      return { ...e, topHook: topOf(e.hookCounts), topPain: topOf(e.painCounts) }
    })

    const q = search.trim().toLowerCase()
    let filtered = q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows
    if (statusFilter === 'live')   filtered = filtered.filter(r => r.anyLive)
    if (statusFilter === 'paused') filtered = filtered.filter(r => !r.anyLive)
    if (statusFilter === 'needs_setup') filtered = filtered.filter(r => r.taggedAds === 0)

    filtered.sort((a, b) => {
      if (sortKey === 'recent') return (b.firstSeen || 0) - (a.firstSeen || 0)
      if (sortKey === 'spend')  return b.spend - a.spend
      if (sortKey === 'ads')    return b.ads - a.ads
      if (sortKey === 'tagged') return b.taggedAds - a.taggedAds
      if (sortKey === 'name')   return a.name.localeCompare(b.name)
      return 0
    })
    return filtered
  }, [perfRaw, search, statusFilter, sortKey])

  const totalAvailable = useMemo(() => {
    const s = new Set(); for (const r of (perfRaw || [])) if (r.campaign_name) s.add(r.campaign_name); return s.size
  }, [perfRaw])
  const selectedCount = activeCampaigns?.length || 0
  const isAllScope = selectedCount === 0

  function selectAllVisible() {
    for (const c of campaigns) if (!activeCampaigns.includes(c.name)) toggleCampaign(c.name)
  }
  function deselectAllVisible() {
    for (const c of campaigns) if (activeCampaigns.includes(c.name)) toggleCampaign(c.name)
  }

  return (
    <Modal
      open={open} onClose={onClose}
      size="xl"
      eyebrow="Scope"
      title="Pick campaigns"
      subtitle="Whatever you select here filters Insights, Attributes, Explorations, and the Library in lockstep. With nothing selected, every page shows the full account."
      footer={
        <>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
            letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>
            {isAllScope ? `All ${totalAvailable} campaigns` : `${selectedCount} of ${totalAvailable} selected`}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {!isAllScope && (
              <button onClick={clearCampaigns} style={{
                padding: '7px 14px',
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
                letterSpacing: '0.04em', textTransform: 'uppercase',
                background: 'transparent', color: 'var(--ink)',
                border: '1px solid var(--ink-3)', cursor: 'pointer',
              }}>Clear · show all</button>
            )}
            <button onClick={onClose} style={{
              padding: '7px 16px',
              fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 500,
              background: 'var(--ink)', color: 'var(--paper)',
              border: '1px solid var(--ink)', cursor: 'pointer',
            }}>Done</button>
          </div>
        </>
      }
    >
      {/* Sticky toolbar inside the modal body */}
      <div style={{
        padding: '14px 28px',
        background: 'var(--paper)',
        borderBottom: '1px solid var(--rule)',
        position: 'sticky', top: 0, zIndex: 2,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search campaigns…"
          autoFocus
          style={{
            flex: '1 1 280px', maxWidth: 360,
            padding: '8px 12px', fontFamily: 'var(--sans)', fontSize: 14,
            border: '1px solid var(--rule-2)', background: 'white', outline: 'none',
          }} />
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { k: 'all', l: 'All' },
            { k: 'live', l: 'Live' },
            { k: 'paused', l: 'Paused' },
            { k: 'needs_setup', l: 'Not set up' },
          ].map(o => (
            <button key={o.k} onClick={() => setStatusFilter(o.k)} style={{
              padding: '6px 12px',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              background: statusFilter === o.k ? 'var(--ink)' : 'transparent',
              color: statusFilter === o.k ? 'var(--paper)' : 'var(--ink-3)',
              border: `1px solid ${statusFilter === o.k ? 'var(--ink)' : 'var(--rule-2)'}`,
              cursor: 'pointer',
            }}>{o.l}</button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Eyebrow>Sort</Eyebrow>
          <select value={sortKey} onChange={e => setSortKey(e.target.value)}
            style={{
              padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 11.5,
              fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase',
              border: '1px solid var(--rule-2)', background: 'white', outline: 'none',
            }}>
            <option value="recent">Recent first</option>
            <option value="spend">Spend</option>
            <option value="ads">Ads</option>
            <option value="tagged">Tagged</option>
            <option value="name">Name</option>
          </select>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={selectAllVisible} style={{
          padding: '6px 12px',
          fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          background: 'transparent', color: 'var(--ink-2)',
          border: '1px solid var(--rule-2)', cursor: 'pointer',
        }}>Select all visible</button>
        <button onClick={deselectAllVisible} style={{
          padding: '6px 12px',
          fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          background: 'transparent', color: 'var(--ink-3)',
          border: '1px solid var(--rule-2)', cursor: 'pointer',
        }}>Deselect visible</button>
      </div>

      {/* Big, bold campaign list */}
      <div>
        {campaigns.length === 0 && (
          <div style={{
            padding: 48, textAlign: 'center', color: 'var(--ink-4)',
            fontFamily: 'var(--serif)', fontStyle: 'italic',
          }}>
            No campaigns match the current filter.
          </div>
        )}
        {campaigns.map((c, i) => {
          const checked = activeCampaigns.includes(c.name)
          const needsSetup = c.taggedAds === 0
          return (
            <div key={c.name}
              onClick={() => toggleCampaign(c.name)}
              style={{
                display: 'grid',
                gridTemplateColumns: '28px minmax(0, 1fr) auto',
                alignItems: 'center', gap: 18,
                padding: '18px 28px',
                paddingLeft: checked ? 25 : 28,
                borderBottom: i < campaigns.length - 1 ? '1px solid var(--rule)' : 'none',
                borderLeft: checked ? `3px solid ${PALETTE.green}` : '3px solid transparent',
                background: checked ? tint(PALETTE.green, 0.06) : 'transparent',
                cursor: 'pointer',
                opacity: needsSetup && !checked ? 0.65 : 1,
                transition: 'background 0.12s ease',
              }}
              onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--paper-2)' }}
              onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{
                width: 20, height: 20,
                background: checked ? 'var(--ink)' : 'transparent',
                border: `1.5px solid ${checked ? 'var(--ink)' : 'var(--rule-2)'}`,
                display: 'inline-grid', placeItems: 'center',
                color: 'var(--accent)', fontSize: 13, flexShrink: 0,
              }}>{checked ? '✓' : ''}</span>

              <div style={{ minWidth: 0 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  flexWrap: 'wrap', marginBottom: 6,
                }}>
                  {/* Status pill */}
                  {c.anyLive ? (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: '3px 9px',
                      background: tint(PALETTE.green, 0.12),
                      color: PALETTE.green,
                      border: `1px solid ${tint(PALETTE.green, 0.3)}`,
                      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: 6, background: PALETTE.green }} />
                      Live
                    </span>
                  ) : (
                    <span style={{
                      padding: '3px 9px',
                      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      color: 'var(--ink-3)',
                      border: '1px solid var(--rule-2)',
                    }}>Paused</span>
                  )}
                  {needsSetup && (
                    <span style={{
                      padding: '3px 9px',
                      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      background: tint(PALETTE.orange, 0.1),
                      color: PALETTE.orange,
                      border: `1px solid ${tint(PALETTE.orange, 0.3)}`,
                    }}>Not set up</span>
                  )}
                </div>
                <div style={{
                  fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500,
                  color: 'var(--ink)', lineHeight: 1.2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{c.name}</div>
                <div style={{
                  display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 8,
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
                  letterSpacing: '0.02em',
                }}>
                  <span>
                    <span style={{ color: 'var(--ink-4)', textTransform: 'uppercase', fontSize: 9.5, letterSpacing: '0.08em' }}>Launched </span>
                    <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>{fmtDate(c.firstSeen)}</span>
                  </span>
                  <span>
                    <span style={{ color: 'var(--ink-4)', textTransform: 'uppercase', fontSize: 9.5, letterSpacing: '0.08em' }}>Last synced </span>
                    <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>{fmtDate(c.lastSynced)}</span>
                  </span>
                  <span>
                    <span style={{ color: 'var(--ink-4)', textTransform: 'uppercase', fontSize: 9.5, letterSpacing: '0.08em' }}>Ads </span>
                    <span style={{ color: 'var(--ink-2)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                      {c.ads}
                      {c.taggedAds < c.ads && (
                        <span style={{ color: 'var(--ink-4)' }}> ({c.taggedAds} tagged)</span>
                      )}
                    </span>
                  </span>
                  <span>
                    <span style={{ color: 'var(--ink-4)', textTransform: 'uppercase', fontSize: 9.5, letterSpacing: '0.08em' }}>Spend </span>
                    <span style={{ color: 'var(--ink-2)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(c.spend)}</span>
                  </span>
                  <span>
                    <span style={{ color: 'var(--ink-4)', textTransform: 'uppercase', fontSize: 9.5, letterSpacing: '0.08em' }}>Booked </span>
                    <span style={{
                      color: c.booked > 0 ? 'var(--ink)' : 'var(--ink-5)',
                      fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                    }}>{c.booked || '0'}</span>
                  </span>
                </div>
                {(c.topHook || c.topPain) && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8, alignItems: 'center' }}>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                    }}>Winning</span>
                    {c.topHook && <ValueChip attr="hook_type" value={c.topHook} size="xs" />}
                    {c.topPain && <ValueChip attr="pain_angle" value={c.topPain} size="xs" />}
                  </div>
                )}
              </div>

              <div style={{
                fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                fontSize: 32, fontWeight: 500, color: c.booked > 0 ? 'var(--ink)' : 'var(--ink-5)',
                lineHeight: 1, textAlign: 'right',
              }}>
                {c.booked || '·'}
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  fontWeight: 500, marginTop: 4,
                }}>Booked</div>
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
