import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  SectionHead, Eyebrow, ValueChip, attrColor, displayValue, tint, PALETTE,
} from '../../components/editorial/atoms'

/*
  Tests — the surface that owns "what am I looking at right now".

  Ben's pain: the analytics pages were pulling every campaign on the ad
  account, including unfinished/not-set-up ones, which made everything
  feel noisy. This page is the canonical place to set scope:

    - All campaigns (default — full account)
    - Or pick the specific CBOs you're actively testing

  Selection writes through to layout context (activeCampaigns), which
  cascades to Insights / Creatives / Attributes / Explorations via the
  same Outlet context the toolbar uses. So picking 3 campaigns here =
  picking 3 in the toolbar dropdown = every analytics page narrows.

  The "Not yet set up" pill flags campaigns with zero tagged ads — those
  are the ones polluting the testing view today.
*/

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return `$${Math.round(n)}`
}

export default function AdsTestScope() {
  const {
    perfRaw, loading, refetching,
    activeCampaigns, toggleCampaign, clearCampaigns,
  } = useOutletContext()

  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('spend')   // spend | ads | tagged | name
  const [statusFilter, setStatusFilter] = useState('all')  // all | live | needs_setup

  // Per-campaign rollup: ads, tagged, winners, excluded, spend, booked,
  // any-live, top hook + pain (so each row shows what it's testing).
  const campaigns = useMemo(() => {
    if (!perfRaw) return []
    const map = new Map()
    for (const r of perfRaw) {
      const name = r.campaign_name
      if (!name) continue
      const entry = map.get(name) || {
        name, ads: 0, taggedAds: 0, winners: 0, excluded: 0, anyLive: false,
        spend: 0, booked: 0,
        hookCounts: {}, painCounts: {},
      }
      entry.ads++
      if (r.hook_type) entry.taggedAds++
      if (r.effective_winner) entry.winners++
      if (r.exclude_from_tests) entry.excluded++
      if (r.is_live || r.effective_status === 'ACTIVE') entry.anyLive = true
      entry.spend += Number(r.spend) || 0
      entry.booked += Number(r.booked) || 0
      // Track top hook + pain by booked count so we can render which
      // value is dominating tests in this CBO.
      const booked = Number(r.booked) || 0
      if (booked > 0) {
        if (r.hook_type) entry.hookCounts[r.hook_type] = (entry.hookCounts[r.hook_type] || 0) + booked
        if (r.pain_angle) entry.painCounts[r.pain_angle] = (entry.painCounts[r.pain_angle] || 0) + booked
      }
      map.set(name, entry)
    }
    // Pick the leading hook / pain per campaign
    const rows = [...map.values()].map(e => {
      const topOf = (counts) => {
        let best = null, n = 0
        for (const k in counts) if (counts[k] > n) { best = k; n = counts[k] }
        return best
      }
      return { ...e, topHook: topOf(e.hookCounts), topPain: topOf(e.painCounts) }
    })

    // Search
    const q = search.trim().toLowerCase()
    let filtered = q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows

    // Status filter
    if (statusFilter === 'live') filtered = filtered.filter(r => r.anyLive)
    else if (statusFilter === 'needs_setup') filtered = filtered.filter(r => r.taggedAds === 0)

    // Sort
    filtered.sort((a, b) => {
      if (sortKey === 'spend')  return b.spend - a.spend
      if (sortKey === 'ads')    return b.ads - a.ads
      if (sortKey === 'tagged') return b.taggedAds - a.taggedAds
      if (sortKey === 'name')   return a.name.localeCompare(b.name)
      return 0
    })
    return filtered
  }, [perfRaw, search, sortKey, statusFilter])

  const selectedCount = activeCampaigns?.length || 0
  const totalAvailable = useMemo(() => {
    const s = new Set(); for (const r of (perfRaw || [])) if (r.campaign_name) s.add(r.campaign_name); return s.size
  }, [perfRaw])
  const isAllScope = selectedCount === 0

  // Selection summary (always reflects the CURRENT scope, regardless of search/sort)
  const scopeStats = useMemo(() => {
    if (!perfRaw) return { ads: 0, taggedAds: 0, spend: 0, booked: 0 }
    const rows = isAllScope ? perfRaw : perfRaw.filter(r => activeCampaigns.includes(r.campaign_name))
    return {
      ads: rows.length,
      taggedAds: rows.filter(r => r.hook_type).length,
      spend: rows.reduce((s, r) => s + (Number(r.spend) || 0), 0),
      booked: rows.reduce((s, r) => s + (Number(r.booked) || 0), 0),
    }
  }, [perfRaw, activeCampaigns, isAllScope])

  function selectAllVisible() {
    const next = new Set(activeCampaigns)
    for (const c of campaigns) next.add(c.name)
    // Use the toolbar's toggle to add any not currently in
    for (const c of campaigns) if (!activeCampaigns.includes(c.name)) toggleCampaign(c.name)
  }
  function deselectAllVisible() {
    for (const c of campaigns) if (activeCampaigns.includes(c.name)) toggleCampaign(c.name)
  }

  return (
    <div>
      <SectionHead
        level="page"
        eyebrow="Creative · Tests"
        title="Tests"
        tagline="Pick the campaigns you're actively testing. Whatever you select here filters Insights, Attributes, Explorations, and the Library in lockstep. Skip campaigns that aren't set up yet."
        gap={28}
      />

      {/* Active scope summary — sticky-ish banner that always tells you
          what window the analytics pages are showing. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
        padding: '14px 18px', marginBottom: 20,
        background: isAllScope ? 'var(--paper-2)' : 'var(--accent-soft, #fdf6c5)',
        border: `1px solid ${isAllScope ? 'var(--rule)' : 'var(--accent-2, #ead84a)'}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <Eyebrow>Active scope</Eyebrow>
          <span style={{
            fontFamily: 'var(--sans)', fontSize: 18, fontWeight: 600, color: 'var(--ink)',
          }}>
            {isAllScope ? `All campaigns (${totalAvailable})` : `${selectedCount} of ${totalAvailable} campaigns`}
          </span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
            letterSpacing: '0.04em',
          }}>
            {scopeStats.ads} ads · {scopeStats.taggedAds} tagged · {fmtMoney(scopeStats.spend)} spend · {scopeStats.booked} booked
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!isAllScope && (
            <button onClick={clearCampaigns} style={{
              padding: '6px 12px',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              border: '1px solid var(--ink-3)', background: 'white',
              color: 'var(--ink)', cursor: 'pointer',
            }}>Show all campaigns</button>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        padding: '10px 14px', background: 'white',
        border: '1px solid var(--rule)',
      }}>
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search campaigns…"
          style={{
            flex: '1 1 240px', maxWidth: 320,
            padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: 13,
            border: '1px solid var(--rule-2)', background: 'var(--paper)', outline: 'none',
          }} />
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { k: 'all', l: 'All' },
            { k: 'live', l: 'Live only' },
            { k: 'needs_setup', l: 'Not set up' },
          ].map(o => (
            <button key={o.k} onClick={() => setStatusFilter(o.k)} style={{
              padding: '5px 10px',
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
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
          {[
            { k: 'spend', l: 'Spend' },
            { k: 'ads', l: 'Ads' },
            { k: 'tagged', l: 'Tagged' },
            { k: 'name', l: 'Name' },
          ].map(o => (
            <button key={o.k} onClick={() => setSortKey(o.k)} style={{
              padding: '5px 10px',
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              background: sortKey === o.k ? 'var(--ink)' : 'transparent',
              color: sortKey === o.k ? 'var(--paper)' : 'var(--ink-3)',
              border: `1px solid ${sortKey === o.k ? 'var(--ink)' : 'var(--rule-2)'}`,
              cursor: 'pointer',
            }}>{o.l}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={selectAllVisible} style={{
          padding: '5px 10px',
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          background: 'transparent', color: 'var(--ink-2)',
          border: '1px solid var(--rule-2)', cursor: 'pointer',
        }}>Select all visible</button>
        <button onClick={deselectAllVisible} style={{
          padding: '5px 10px',
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          background: 'transparent', color: 'var(--ink-3)',
          border: '1px solid var(--rule-2)', cursor: 'pointer',
        }}>Deselect visible</button>
      </div>

      {/* Campaign table */}
      <div style={{ background: 'white', border: '1px solid var(--rule)', borderTop: 'none' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '40px minmax(280px, 2fr) 110px 80px 80px 80px 80px minmax(180px, 1fr)',
          alignItems: 'center', gap: 12,
          padding: '10px 16px',
          background: 'var(--paper-2)',
          borderBottom: '1px solid var(--rule)',
        }}>
          <Eyebrow>In test</Eyebrow>
          <Eyebrow>Campaign</Eyebrow>
          <Eyebrow>Status</Eyebrow>
          <Eyebrow style={{ textAlign: 'right' }}>Ads</Eyebrow>
          <Eyebrow style={{ textAlign: 'right' }}>Tagged</Eyebrow>
          <Eyebrow style={{ textAlign: 'right' }}>Spend</Eyebrow>
          <Eyebrow style={{ textAlign: 'right' }}>Booked</Eyebrow>
          <Eyebrow>Winning</Eyebrow>
        </div>
        {loading && campaigns.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-4)',
                        fontFamily: 'var(--serif)', fontStyle: 'italic' }}>
            Loading campaigns…
          </div>
        ) : campaigns.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-4)',
                        fontFamily: 'var(--serif)', fontStyle: 'italic' }}>
            No campaigns match the current filter.
          </div>
        ) : campaigns.map((c, i) => {
          const inTest = activeCampaigns.includes(c.name) || isAllScope
          const explicitlyChecked = activeCampaigns.includes(c.name)
          const needsSetup = c.taggedAds === 0
          return (
            <div key={c.name}
              onClick={() => toggleCampaign(c.name)}
              style={{
                display: 'grid',
                gridTemplateColumns: '40px minmax(280px, 2fr) 110px 80px 80px 80px 80px minmax(180px, 1fr)',
                alignItems: 'center', gap: 12,
                padding: '14px 16px',
                borderBottom: i < campaigns.length - 1 ? '1px solid var(--rule)' : 'none',
                cursor: 'pointer',
                background: explicitlyChecked ? tint(PALETTE.green, 0.06) : 'transparent',
                borderLeft: explicitlyChecked ? `3px solid ${PALETTE.green}` : '3px solid transparent',
                paddingLeft: 13,
                opacity: needsSetup && !explicitlyChecked ? 0.6 : 1,
                transition: 'background 0.12s ease',
              }}
              onMouseEnter={e => { if (!explicitlyChecked) e.currentTarget.style.background = 'var(--paper-2)' }}
              onMouseLeave={e => { if (!explicitlyChecked) e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{
                width: 16, height: 16,
                background: explicitlyChecked ? 'var(--ink)' : 'transparent',
                border: `1px solid ${explicitlyChecked ? 'var(--ink)' : 'var(--rule-2)'}`,
                display: 'inline-grid', placeItems: 'center',
                color: 'var(--accent)', fontSize: 11, flexShrink: 0,
              }}>{explicitlyChecked ? '✓' : ''}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--sans)', fontSize: 14, fontWeight: 500, color: 'var(--ink)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {c.name}
                </div>
              </div>
              <div>
                {c.anyLive ? (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '2px 7px',
                    background: tint(PALETTE.green, 0.1),
                    color: PALETTE.green,
                    border: `1px solid ${tint(PALETTE.green, 0.25)}`,
                    fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    letterSpacing: '0.04em', textTransform: 'uppercase',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: 6, background: PALETTE.green }} />
                    Live
                  </span>
                ) : (
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                    letterSpacing: '0.04em', textTransform: 'uppercase',
                    padding: '2px 7px',
                    border: '1px solid var(--rule-2)',
                    display: 'inline-block',
                  }}>Paused</span>
                )}
                {needsSetup && (
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 9.5, color: '#b88714',
                    letterSpacing: '0.04em', textTransform: 'uppercase',
                    marginTop: 4,
                  }}>
                    Not set up
                  </div>
                )}
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                            fontSize: 12, color: 'var(--ink-2)', textAlign: 'right' }}>
                {c.ads}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                            fontSize: 12, color: c.taggedAds === 0 ? 'var(--ink-5)' : 'var(--ink-2)',
                            textAlign: 'right' }}>
                {c.taggedAds}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                            fontSize: 12, color: 'var(--ink-2)', textAlign: 'right' }}>
                {fmtMoney(c.spend)}
              </span>
              <span style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                            fontSize: 16, fontWeight: 500, color: 'var(--ink)',
                            textAlign: 'right' }}>
                {c.booked || '—'}
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {c.topHook && <ValueChip attr="hook_type" value={c.topHook} size="xs" />}
                {c.topPain && <ValueChip attr="pain_angle" value={c.topPain} size="xs" />}
                {!c.topHook && !c.topPain && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-5)',
                                letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    No booked yet
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Help text */}
      <p style={{
        marginTop: 16, fontFamily: 'var(--sans)', fontSize: 12.5,
        color: 'var(--ink-3)', lineHeight: 1.5,
      }}>
        <strong style={{ color: 'var(--ink-2)' }}>How this works:</strong> click a row to add (or remove)
        the campaign from your active testing scope. Selection persists across all analytics pages.
        With no campaigns ticked, every page shows the whole account. With one or more ticked, every page
        narrows to just those.
        Campaigns flagged <em>Not set up</em> have zero tagged ads — those are the ones polluting your
        win-rate view if left in scope.
      </p>
    </div>
  )
}
