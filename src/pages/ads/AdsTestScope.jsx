import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Plus, Send } from 'lucide-react'
import {
  SectionHead, Eyebrow, ValueChip, attrColor, displayValue, tint, PALETTE,
} from '../../components/editorial/atoms'
import { listTestBatches } from '../../services/testBatches'
import CreateTestBatchModal from '../../components/ads/CreateTestBatchModal'
import TestBatchDetailModal from '../../components/ads/TestBatchDetailModal'

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

  // Test batches (drafts + launched-with-history). Loaded once on mount.
  const [batches, setBatches] = useState([])
  const [batchesLoading, setBatchesLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [openBatchId, setOpenBatchId] = useState(null)

  const loadBatches = () => {
    setBatchesLoading(true)
    listTestBatches()
      .then(setBatches)
      .catch(() => setBatches([]))
      .finally(() => setBatchesLoading(false))
  }
  useEffect(() => { loadBatches() }, [])

  const drafts   = useMemo(() => batches.filter(b => !b.launched_at), [batches])
  const launched = useMemo(() => batches.filter(b =>  b.launched_at && !b.closed_at), [batches])

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
        tagline="Set up the next test you'll run, see density before you commit to film, then launch by linking the scripts to a campaign. Or scope the analytics pages to the campaigns of an already-launched test below."
        gap={28}
        right={
          <button onClick={() => setCreateOpen(true)} style={btnPrimary}>
            <Plus size={13} /> New test draft
          </button>
        }
      />

      {/* Test drafts — bundles of scripts waiting to be filmed + launched */}
      <DraftsSection drafts={drafts} loading={batchesLoading}
        onOpen={id => setOpenBatchId(id)} />

      {/* Launched tests — historical batches with their campaign assignments.
          Click one to scope the analytics pages to those campaigns. */}
      {launched.length > 0 && (
        <LaunchedSection launched={launched} onOpen={id => setOpenBatchId(id)} />
      )}

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

      {/* Campaign table — overflow-x because the column template needs
          ~1046px; below that the spend/booked/winning columns were
          hard-clipped (≤768px CSS hides main overflow). */}
      <div style={{ background: 'white', border: '1px solid var(--rule)', borderTop: 'none', overflowX: 'auto' }}>
      {/* minWidth only when rows exist — a centered loading/empty message
          inside a 1046px canvas sits off-viewport on phones. */}
      <div style={{ minWidth: campaigns.length > 0 ? 1046 : undefined }}>
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

      <CreateTestBatchModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(batch) => { loadBatches(); setOpenBatchId(batch.id) }}
      />
      <TestBatchDetailModal
        open={!!openBatchId}
        batchId={openBatchId}
        onClose={() => setOpenBatchId(null)}
        onChanged={loadBatches}
      />
    </div>
  )
}

// ─── Drafts section ─────────────────────────────────────────────────
function DraftsSection({ drafts, loading, onOpen }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 12, gap: 12, flexWrap: 'wrap',
      }}>
        <div>
          <Eyebrow>Drafts</Eyebrow>
          <h2 style={{
            margin: '4px 0 0', fontSize: 18, fontWeight: 600, color: 'var(--ink)',
            fontFamily: 'var(--sans)',
          }}>
            Tests in setup — {drafts.length}
          </h2>
        </div>
      </div>
      {loading && drafts.length === 0 ? (
        <EmptyBox>Loading drafts…</EmptyBox>
      ) : drafts.length === 0 ? (
        <EmptyBox>
          No drafts yet. Click <strong>New test draft</strong> above to set up your next test, then attach scripts from the Generate page.
        </EmptyBox>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16,
        }}>
          {drafts.map(b => (
            <DraftCard key={b.id} batch={b} onClick={() => onOpen(b.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function DraftCard({ batch, onClick }) {
  const topHook  = topValue(batch.density?.hook_type)
  const topFrame = topValue(batch.density?.message_frame)
  const topPain  = topValue(batch.density?.pain_angle)
  return (
    <button onClick={onClick}
      style={{
        background: 'white', border: '1px solid var(--rule)',
        borderLeft: '3px solid var(--accent)',
        padding: 18, textAlign: 'left', cursor: 'pointer',
        fontFamily: 'inherit',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--paper)'}
      onMouseLeave={e => e.currentTarget.style.background = 'white'}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
        <span style={{
          padding: '2px 7px',
          background: tint(PALETTE.orange, 0.1),
          color: PALETTE.orange,
          border: `1px solid ${tint(PALETTE.orange, 0.3)}`,
          fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
          letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>Draft</span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
          letterSpacing: '0.04em', textTransform: 'uppercase',
        }}>
          {fmtAgo(batch.created_at)}
        </span>
      </div>
      <div style={{
        fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)',
        lineHeight: 1.2, marginBottom: 8,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{batch.name}</div>
      {batch.hypothesis && (
        <p style={{
          margin: '0 0 12px', fontFamily: 'var(--sans)', fontSize: 12.5,
          color: 'var(--ink-3)', lineHeight: 1.5,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>{batch.hypothesis}</p>
      )}

      {/* Tiny density stack */}
      {batch.script_count > 0 && (
        <div style={{ marginBottom: 10 }}>
          <DensityStack counts={batch.density?.hook_type || {}} attr="hook_type" total={batch.script_count} />
        </div>
      )}

      {/* Stats row */}
      <div style={{
        display: 'flex', gap: 14, flexWrap: 'wrap',
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
        marginBottom: batch.script_count > 0 ? 10 : 0,
      }}>
        <span>
          <span style={{ color: 'var(--ink)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {batch.script_count}
          </span>{' '}script{batch.script_count === 1 ? '' : 's'}
        </span>
        {batch.linked_count > 0 && (
          <span>
            <span style={{ color: 'var(--ink)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {batch.linked_count}
            </span>{' '}filmed
          </span>
        )}
      </div>

      {/* Top winning chips */}
      {(topHook || topFrame || topPain) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {topHook  && <ValueChip attr="hook_type"     value={topHook}  size="xs" />}
          {topFrame && <ValueChip attr="message_frame" value={topFrame} size="xs" />}
          {topPain  && <ValueChip attr="pain_angle"    value={topPain}  size="xs" />}
        </div>
      )}
    </button>
  )
}

// ─── Launched section ───────────────────────────────────────────────
function LaunchedSection({ launched, onOpen }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ marginBottom: 12 }}>
        <Eyebrow>Launched tests</Eyebrow>
        <h2 style={{
          margin: '4px 0 0', fontSize: 18, fontWeight: 600, color: 'var(--ink)',
          fontFamily: 'var(--sans)',
        }}>
          In market — {launched.length}
        </h2>
      </div>
      <div style={{ background: 'white', border: '1px solid var(--rule)' }}>
        {launched.map((b, i) => (
          <button key={b.id} onClick={() => onOpen(b.id)}
            style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 14,
              alignItems: 'center',
              width: '100%', textAlign: 'left',
              padding: '14px 18px',
              background: 'transparent', border: 'none',
              borderTop: i === 0 ? 'none' : '1px solid var(--rule)',
              cursor: 'pointer',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 500, color: 'var(--ink)',
                lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{b.name}</div>
              {b.campaign_names?.length > 0 && (
                <div style={{
                  marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
                  letterSpacing: '0.02em',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {b.campaign_names.join(' · ')}
                </div>
              )}
            </div>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
              fontVariantNumeric: 'tabular-nums',
            }}>{b.script_count} scripts</span>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
              letterSpacing: '0.04em', textTransform: 'uppercase',
            }}>Launched {fmtAgo(b.launched_at)}</span>
            <span style={{
              padding: '2px 7px',
              background: tint(PALETTE.green, 0.1),
              color: PALETTE.green,
              border: `1px solid ${tint(PALETTE.green, 0.3)}`,
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>Live</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────────────
function topValue(counts) {
  if (!counts) return null
  let best = null, n = 0
  for (const k in counts) if (counts[k] > n) { best = k; n = counts[k] }
  return best
}

function DensityStack({ counts, attr, total }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0 || !total) return null
  return (
    <div style={{
      display: 'flex', height: 8, background: 'var(--paper-2)',
      border: '1px solid var(--rule)', overflow: 'hidden',
    }}>
      {entries.map(([v, n]) => (
        <div key={v} title={`${displayValue(v)}: ${n}/${total}`}
          style={{
            width: `${(n / total) * 100}%`,
            background: attrColor(attr, v),
          }} />
      ))}
    </div>
  )
}

function fmtAgo(dateStr) {
  if (!dateStr) return '—'
  const t = new Date(dateStr).getTime()
  if (isNaN(t)) return '—'
  const days = Math.floor((Date.now() - t) / 86400000)
  if (days < 1) return 'today'
  if (days < 7) return `${days}d ago`
  if (days < 60) return `${Math.floor(days / 7)}w ago`
  return new Date(t).toISOString().slice(0, 10)
}

function EmptyBox({ children }) {
  return (
    <div style={{
      padding: '24px 20px',
      background: 'white', border: '1px dashed var(--rule-2)',
      textAlign: 'center',
      fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-3)',
      lineHeight: 1.5,
    }}>{children}</div>
  )
}

const btnPrimary = {
  padding: '8px 16px',
  fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 600,
  background: 'var(--ink)', color: 'var(--paper)',
  border: '1px solid var(--ink)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
