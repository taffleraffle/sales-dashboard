import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { listOffers } from '../../services/creativeTagger'
import GlossaryDrawer from '../../components/ads/GlossaryDrawer'
import { Icon } from '../../components/editorial/atoms'

/*
  Creative testing layout. Two responsibilities beyond the sub-nav now:

  1. Hoist the lib_ad_performance fetch to this layer so all 4 sub-pages
     (Insights / Library / Attributes / Explorations) share one fetch
     instead of re-querying on every tab change. Cached per (since, until)
     window for 5 minutes.

  2. Host the Glossary drawer + the "?" button that opens it, so it's one
     keystroke away from every sub-page without each page wiring it up
     individually.
*/

// Analysis surfaces first (where Ben spends his time), then production
// pipeline (Clips → Variants → Ads). Order requested 2026-05-18.
const SUBNAV = [
  { to: '/sales/ads/creative/insights',     label: 'Insights' },
  { to: '/sales/ads/creative/creatives',    label: 'Creatives' },
  { to: '/sales/ads/creative/attributes',   label: 'Attributes' },
  { to: '/sales/ads/creative/explorations', label: 'Explorations' },
  { to: '/sales/ads/creative/generate',     label: 'Generate' },
  { to: '/sales/ads/creative/clips',        label: 'Clips' },
  { to: '/sales/ads/creative/variants',     label: 'Variants' },
  { to: '/sales/ads/creative/ads',          label: 'Ads' },
]

// Pages that consume the shared lib_ad_performance fetch
const ANALYTICS_PATHS = new Set([
  '/sales/ads/creative/insights',
  '/sales/ads/creative/creatives',
  '/sales/ads/creative/attributes',
  '/sales/ads/creative/explorations',
])

const todayISO = () => new Date().toISOString().slice(0, 10)
const daysAgoISO = (d) => {
  const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10)
}

// 5-minute TTL cache keyed by (since, until)
const PERF_CACHE = new Map()
const CACHE_TTL_MS = 5 * 60 * 1000

export default function AdsCreativeTestingLayout() {
  const location = useLocation()
  const [glossaryOpen, setGlossaryOpen] = useState(false)

  // Date window — shared across analytics pages, defaults to 90d.
  // Stored in localStorage so it survives navigation.
  const [since, setSince] = useState(() => {
    try { return localStorage.getItem('insights.since') || daysAgoISO(90) } catch { return daysAgoISO(90) }
  })
  const [until, setUntil] = useState(() => {
    try { return localStorage.getItem('insights.until') || todayISO() } catch { return todayISO() }
  })

  const [perf, setPerf] = useState(null)
  const [offers, setOffers] = useState([])
  // `loading` = true ONLY on first load (no perf at all). Re-fetches while
  // a window/preset change is in flight set `refetching` instead — pages
  // keep showing the stale data so the UI doesn't flash to "Loading…".
  const [loading, setLoading] = useState(false)
  const [refetching, setRefetching] = useState(false)
  const [err, setErr] = useState(null)
  const [lastSyncedAt, setLastSyncedAt] = useState(null)

  // Shared offer filter + campaign filter + "hide inactive" toggle —
  // every analytics page reads filteredPerf via the context, so toggling
  // these here narrows Insights / Library / Attributes / Explorations
  // in lockstep.
  const [activeOffers, setActiveOffers] = useState(() => {
    try { return JSON.parse(localStorage.getItem('insights.activeOffers') || '[]') } catch { return [] }
  })
  const [activeCampaigns, setActiveCampaigns] = useState(() => {
    try { return JSON.parse(localStorage.getItem('insights.activeCampaigns') || '[]') } catch { return [] }
  })
  const [hideInactive, setHideInactive] = useState(() => {
    try { return localStorage.getItem('insights.hideInactive') !== 'false' } catch { return true }
  })

  // Only fetch when on an analytics page — Clips/Variants/Ads/Generate use their own data
  const needsPerf = ANALYTICS_PATHS.has(location.pathname)

  const cacheKey = `${since}|${until}`

  const loadPerf = useCallback(async ({ force = false } = {}) => {
    const cached = PERF_CACHE.get(cacheKey)
    if (!force && cached && Date.now() - cached.t < CACHE_TTL_MS) {
      setPerf(cached.perf); setOffers(cached.offers); setLastSyncedAt(new Date(cached.t))
      return
    }
    // Only show first-load skeleton if there's literally nothing to show.
    // Otherwise show the existing rows with a subtle "refetching" pulse.
    const hasExisting = perf && perf.length > 0
    if (hasExisting) setRefetching(true)
    else setLoading(true)
    setErr(null)
    try {
      const [offersData, perfRes] = await Promise.all([
        listOffers(),
        supabase.rpc('lib_ad_performance', { since, until }),
      ])
      if (perfRes.error) throw new Error(perfRes.error.message)
      const fresh = perfRes.data || []
      setPerf(fresh); setOffers(offersData); setLastSyncedAt(new Date())
      PERF_CACHE.set(cacheKey, { perf: fresh, offers: offersData, t: Date.now() })
      // Cap cache size — drop oldest if we exceed 20 windows
      if (PERF_CACHE.size > 20) {
        const oldest = [...PERF_CACHE.entries()].sort((a, b) => a[1].t - b[1].t)[0]
        if (oldest) PERF_CACHE.delete(oldest[0])
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false); setRefetching(false)
    }
  }, [cacheKey, since, until, perf])

  // Fire on navigation into an analytics page AND on date-window change.
  // loadPerf itself does the cache check + TTL — no need to duplicate here.
  useEffect(() => {
    if (needsPerf) loadPerf()
  }, [needsPerf, loadPerf])

  // Persist window + filter prefs
  useEffect(() => { try { localStorage.setItem('insights.since', since) } catch {} }, [since])
  useEffect(() => { try { localStorage.setItem('insights.until', until) } catch {} }, [until])
  useEffect(() => { try { localStorage.setItem('insights.activeOffers', JSON.stringify(activeOffers)) } catch {} }, [activeOffers])
  useEffect(() => { try { localStorage.setItem('insights.activeCampaigns', JSON.stringify(activeCampaigns)) } catch {} }, [activeCampaigns])
  useEffect(() => { try { localStorage.setItem('insights.hideInactive', String(hideInactive)) } catch {} }, [hideInactive])

  // Distinct campaigns available in the current perf set — drives the
  // campaign dropdown in the toolbar.
  const availableCampaigns = useMemo(() => {
    const seen = new Map()  // name → { count, anyLive }
    for (const r of (perf || [])) {
      const name = r.campaign_name
      if (!name) continue
      const entry = seen.get(name) || { count: 0, anyLive: false }
      entry.count++
      if (r.is_live || r.effective_status === 'ACTIVE') entry.anyLive = true
      seen.set(name, entry)
    }
    return [...seen.entries()]
      .map(([name, m]) => ({ name, count: m.count, anyLive: m.anyLive }))
      .sort((a, b) => Number(b.anyLive) - Number(a.anyLive) || b.count - a.count)
  }, [perf])

  // Drop stale campaign filters when perf set changes
  useEffect(() => {
    if (!availableCampaigns.length || activeCampaigns.length === 0) return
    const valid = activeCampaigns.filter(n => availableCampaigns.find(c => c.name === n))
    if (valid.length !== activeCampaigns.length) setActiveCampaigns(valid)
  }, [availableCampaigns]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drop stale offer slugs once offers list loads
  useEffect(() => {
    if (!offers.length || activeOffers.length === 0) return
    const valid = activeOffers.filter(slug => offers.find(o => o.slug === slug))
    if (valid.length !== activeOffers.length) setActiveOffers(valid)
  }, [offers]) // eslint-disable-line react-hooks/exhaustive-deps

  // Filter perf by activeOffers + activeCampaigns + hideInactive + the
  // exclude_from_tests flag (per-ad opt-out). Every analytics page reads
  // the same filtered dataset from context.
  const filteredPerf = useMemo(() => {
    if (!perf) return null
    let rows = perf
    if (activeOffers.length) rows = rows.filter(r => activeOffers.includes(r.offer_slug))
    if (activeCampaigns.length) rows = rows.filter(r => activeCampaigns.includes(r.campaign_name))
    // Ads marked exclude_from_tests are always hidden from the analytics
    // surfaces — they show up only on the Library page when the operator
    // unticks the "Hide excluded" filter there.
    rows = rows.filter(r => !r.exclude_from_tests)
    if (hideInactive) {
      rows = rows.filter(r =>
        (Number(r.spend)  || 0) > 0 ||
        (Number(r.leads)  || 0) > 0 ||
        (Number(r.booked) || 0) > 0
      )
    }
    return rows
  }, [perf, activeOffers, activeCampaigns, hideInactive])

  function toggleOffer(slug) {
    setActiveOffers(prev => prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug])
  }
  function toggleCampaign(name) {
    setActiveCampaigns(prev => prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name])
  }
  const clearCampaigns = () => setActiveCampaigns([])

  // Context exposed to nested routes via <Outlet context>
  const ctx = useMemo(() => ({
    perf: filteredPerf, perfRaw: perf, offers,
    loading, refetching, err, lastSyncedAt,
    since, until, setSince, setUntil,
    activeOffers, toggleOffer, hideInactive, setHideInactive,
    activeCampaigns, toggleCampaign, clearCampaigns, availableCampaigns,
    refresh: () => loadPerf({ force: true }),
    openGlossary: () => setGlossaryOpen(true),
  }), [filteredPerf, perf, offers, loading, refetching, err, lastSyncedAt,
       since, until, activeOffers, hideInactive, activeCampaigns, availableCampaigns, loadPerf])

  const showToolbar = needsPerf

  return (
    <div>
      {/* Sub-nav — sans-serif, numbered, accent underline on active.
          "?" glossary trigger floats on the right. */}
      <div style={{
        display: 'flex', gap: 0, marginBottom: 28,
        borderBottom: '1px solid var(--rule)',
        alignItems: 'center',
      }}>
        {SUBNAV.map((t, i) => (
          <NavLink
            key={t.to}
            to={t.to}
            style={({ isActive }) => ({
              padding: '10px 14px 11px',
              fontFamily: 'var(--sans)',
              fontSize: 13, fontWeight: 500, letterSpacing: '-0.005em',
              color: isActive ? 'var(--ink)' : 'var(--ink-4)',
              background: 'transparent',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
              textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              textTransform: 'capitalize',
              transition: 'color 160ms ease, border-color 160ms ease',
            })}
          >
            <span style={{
              fontFamily: 'var(--mono)', opacity: 0.5,
              fontSize: 10, fontWeight: 400,
            }}>{String(i + 1).padStart(2, '0')}</span>
            <span>{t.label}</span>
          </NavLink>
        ))}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setGlossaryOpen(true)}
          title="What do these tags mean? (Esc to close)"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 12px',
            fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 500,
            color: 'var(--ink-3)', background: 'transparent',
            border: '1px solid var(--rule-2)', borderRadius: 2,
            marginBottom: 6, cursor: 'pointer',
          }}>
          <span style={{
            display: 'inline-grid', placeItems: 'center',
            width: 16, height: 16, borderRadius: 16,
            background: 'var(--ink)', color: 'var(--paper)',
            fontFamily: 'var(--serif)', fontStyle: 'italic',
            fontSize: 11, fontWeight: 500,
          }}>?</span>
          Glossary
        </button>
      </div>

      {showToolbar && (
        <AnalyticsToolbar
          since={since} until={until} setSince={setSince} setUntil={setUntil}
          offers={offers} activeOffers={activeOffers} toggleOffer={toggleOffer}
          campaigns={availableCampaigns} activeCampaigns={activeCampaigns}
          toggleCampaign={toggleCampaign} clearCampaigns={clearCampaigns}
          hideInactive={hideInactive} setHideInactive={setHideInactive}
          loading={loading || refetching} lastSyncedAt={lastSyncedAt}
          totalAds={(perf || []).length}
          visibleAds={(filteredPerf || []).length}
          onRefresh={() => loadPerf({ force: true })}
        />
      )}

      <Outlet context={ctx} />

      <GlossaryDrawer open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// AnalyticsToolbar — date range + offer chips + hide-inactive toggle.
// Lives in the layout so all four analytics pages share one control bar.
// ───────────────────────────────────────────────────────────────────────
const DATE_PRESETS = [
  { id: '7d',  label: '7d',  days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: '60d', label: '60d', days: 60 },
  { id: '90d', label: '90d', days: 90 },
  { id: 'mtd', label: 'MTD' },   // month-to-date
  { id: 'qtd', label: 'QTD' },   // quarter-to-date
  { id: 'all', label: 'All',  days: 365 * 3 },
]
const OFFER_DOT = {
  'opt-restoration':  '#b53e3e',
  'opt-plumbing':     '#0e7c86',
  'opt-roofing-stub': '#5b3a8f',
}

function AnalyticsToolbar({
  since, until, setSince, setUntil,
  offers, activeOffers, toggleOffer,
  campaigns = [], activeCampaigns = [], toggleCampaign = () => {}, clearCampaigns = () => {},
  hideInactive, setHideInactive,
  loading, lastSyncedAt, totalAds, visibleAds, onRefresh,
}) {
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)
  // Match the current window to a preset for active-state styling
  const activePreset = useMemo(() => {
    if (!since || !until) return null
    if (until !== todayISO()) return 'custom'
    const days = Math.round((new Date(until) - new Date(since)) / 86400000)
    const match = DATE_PRESETS.find(p => p.days === days)
    return match?.id || 'custom'
  }, [since, until])

  function applyPreset(p) {
    if (p.id === 'mtd') {
      const d = new Date(); d.setDate(1)
      setSince(d.toISOString().slice(0, 10)); setUntil(todayISO())
    } else if (p.id === 'qtd') {
      const d = new Date()
      const q = Math.floor(d.getMonth() / 3) * 3
      d.setMonth(q, 1)
      setSince(d.toISOString().slice(0, 10)); setUntil(todayISO())
    } else if (p.days) {
      setSince(daysAgoISO(p.days)); setUntil(todayISO())
    }
  }

  const liveOffers = (offers || []).filter(o => !o.slug.includes('template') && !o.slug.includes('stub'))

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      padding: '10px 14px', marginBottom: 24,
      background: 'var(--paper-2)',
      border: '1px solid var(--rule)',
      position: 'relative',
    }}>
      {/* Date presets */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
          letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)',
        }}>Window</span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--ink-3)', background: 'white' }}>
          {DATE_PRESETS.map((p, i) => {
            const on = activePreset === p.id
            return (
              <button key={p.id} onClick={() => applyPreset(p)} style={{
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
                letterSpacing: '0.04em', textTransform: 'uppercase',
                padding: '5px 10px',
                background: on ? 'var(--ink)' : 'transparent',
                color: on ? 'var(--paper)' : 'var(--ink-2)',
                border: 'none',
                borderRight: i < DATE_PRESETS.length - 1 ? '1px solid var(--rule-2)' : 'none',
                cursor: 'pointer',
              }}>{p.label}</button>
            )
          })}
        </div>
      </div>

      {/* Custom date range — always editable */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="date" value={since} max={until}
          onChange={e => setSince(e.target.value)}
          style={{
            fontFamily: 'var(--mono)', fontSize: 11.5,
            padding: '4px 6px', border: '1px solid var(--rule-2)',
            background: 'white', color: 'var(--ink)', borderRadius: 2,
          }} />
        <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>→</span>
        <input type="date" value={until} min={since} max={todayISO()}
          onChange={e => setUntil(e.target.value)}
          style={{
            fontFamily: 'var(--mono)', fontSize: 11.5,
            padding: '4px 6px', border: '1px solid var(--rule-2)',
            background: 'white', color: 'var(--ink)', borderRadius: 2,
          }} />
      </div>

      {/* Offer chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
          letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)',
        }}>Offers</span>
        {liveOffers.length === 0 && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)' }}>—</span>
        )}
        {liveOffers.map(o => {
          const on = activeOffers.includes(o.slug)
          return (
            <button key={o.slug} onClick={() => toggleOffer(o.slug)} style={{
              fontFamily: 'var(--mono)', fontSize: 10.5,
              letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 500,
              padding: '4px 10px',
              background: on ? 'var(--ink)' : 'transparent',
              color: on ? 'var(--paper)' : 'var(--ink-2)',
              border: `1px solid ${on ? 'var(--ink)' : 'var(--rule-2)'}`,
              cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: 6, flexShrink: 0,
                background: on ? 'var(--accent)' : (OFFER_DOT[o.slug] || 'var(--ink-3)'),
              }} />
              {o.name.replace('OPT ', '').replace(' (Direct Call Engine)', '').replace(' (placeholder)', '')}
            </button>
          )
        })}
      </div>

      {/* Campaigns picker — narrows every analytics page to N CBOs */}
      <div style={{ position: 'relative' }}>
        <button onClick={() => setCampaignPickerOpen(o => !o)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
            letterSpacing: '0.04em', textTransform: 'uppercase',
            color: activeCampaigns.length ? 'var(--ink)' : 'var(--ink-3)',
            padding: '4px 10px',
            background: activeCampaigns.length ? 'white' : 'transparent',
            border: `1px solid ${activeCampaigns.length ? 'var(--ink)' : 'var(--rule-2)'}`,
            cursor: 'pointer',
          }}>
          Campaigns
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9.5, color: activeCampaigns.length ? 'var(--ink-2)' : 'var(--ink-4)',
            letterSpacing: '0.04em',
          }}>
            {activeCampaigns.length ? `(${activeCampaigns.length})` : `(all ${campaigns.length})`}
          </span>
          <span style={{ fontSize: 9, color: 'var(--ink-4)' }}>▾</span>
        </button>
        {campaignPickerOpen && (
          <>
            <div onClick={() => setCampaignPickerOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0,
              minWidth: 320, maxWidth: 480,
              maxHeight: 420, overflowY: 'auto',
              background: 'white', border: '1px solid var(--rule)',
              boxShadow: '0 12px 32px rgba(10,10,10,0.12)',
              zIndex: 51,
            }}>
              <div style={{
                padding: '10px 12px', borderBottom: '1px solid var(--rule)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'var(--paper-2)', position: 'sticky', top: 0,
              }}>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
                  letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)',
                }}>
                  {activeCampaigns.length === 0
                    ? `All ${campaigns.length} campaigns`
                    : `${activeCampaigns.length} of ${campaigns.length} selected`}
                </span>
                {activeCampaigns.length > 0 && (
                  <button onClick={clearCampaigns} style={{
                    background: 'transparent', border: 'none',
                    fontFamily: 'var(--mono)', fontSize: 10, color: '#b53e3e',
                    letterSpacing: '0.04em', textTransform: 'uppercase',
                    cursor: 'pointer', padding: 0,
                  }}>Clear</button>
                )}
              </div>
              {campaigns.length === 0 && (
                <div style={{
                  padding: 24, textAlign: 'center', color: 'var(--ink-4)',
                  fontFamily: 'var(--sans)', fontSize: 12, fontStyle: 'italic',
                }}>
                  No campaigns in the current window.
                </div>
              )}
              {campaigns.map(c => {
                const on = activeCampaigns.includes(c.name)
                return (
                  <button key={c.name} onClick={() => toggleCampaign(c.name)} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                    width: '100%', textAlign: 'left',
                    padding: '8px 12px',
                    background: on ? 'var(--paper-2)' : 'transparent',
                    border: 'none', borderTop: '1px solid var(--rule)',
                    cursor: 'pointer',
                  }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{
                        width: 12, height: 12,
                        background: on ? 'var(--ink)' : 'transparent',
                        border: `1px solid ${on ? 'var(--ink)' : 'var(--rule-2)'}`,
                        display: 'inline-grid', placeItems: 'center',
                        color: 'var(--accent)', fontSize: 9, flexShrink: 0,
                      }}>{on ? '✓' : ''}</span>
                      {c.anyLive && (
                        <span title="At least one ACTIVE ad in this campaign" style={{
                          width: 6, height: 6, borderRadius: 6,
                          background: '#3e8a5e', flexShrink: 0,
                        }} />
                      )}
                      <span style={{
                        fontFamily: 'var(--sans)', fontSize: 12.5,
                        color: 'var(--ink)', fontWeight: on ? 600 : 400,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{c.name}</span>
                    </span>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                      flexShrink: 0,
                    }}>{c.count}</span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Hide-inactive toggle */}
      <label title="Hide ads with zero spend, zero leads, and zero booked calls in the selected window."
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          color: hideInactive ? 'var(--ink)' : 'var(--ink-3)',
          padding: '4px 10px',
          background: hideInactive ? 'var(--accent-soft, #fdf6c5)' : 'transparent',
          border: `1px solid ${hideInactive ? 'var(--accent-2, #ead84a)' : 'var(--rule-2)'}`,
          cursor: 'pointer',
        }}>
        <input type="checkbox" checked={hideInactive}
          onChange={e => setHideInactive(e.target.checked)}
          style={{ accentColor: 'var(--ink)' }} />
        Hide inactive
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
          letterSpacing: '0.04em', marginLeft: 2,
        }}>
          {hideInactive ? `(${visibleAds}/${totalAds})` : `(${totalAds})`}
        </span>
      </label>

      {/* Last synced + refresh */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
          letterSpacing: '0.04em', textTransform: 'uppercase',
          display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: 6,
            background: loading ? '#e0a93e' : '#3e8a5e',
            boxShadow: `0 0 0 3px ${loading ? 'rgba(224,169,62,0.18)' : 'rgba(62,138,94,0.18)'}`,
          }} />
          {loading ? 'Syncing…' : (lastSyncedAt ? minutesAgo(lastSyncedAt) + ' ago' : 'idle')}
        </span>
        <button onClick={onRefresh} title="Refresh data"
          style={{
            background: 'transparent', border: '1px solid var(--rule-2)',
            padding: '4px 8px', cursor: 'pointer',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'var(--ink-3)',
          }}>↻</button>
      </div>
    </div>
  )
}

function minutesAgo(date) {
  const min = Math.max(0, Math.floor((Date.now() - date) / 60000))
  if (min < 1) return 'just now'
  if (min === 1) return '1 min'
  return `${min} min`
}
