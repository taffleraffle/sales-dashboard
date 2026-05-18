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

const SUBNAV = [
  { to: '/sales/ads/creative/clips',        label: 'Clips' },
  { to: '/sales/ads/creative/variants',     label: 'Variants' },
  { to: '/sales/ads/creative/ads',          label: 'Ads' },
  { to: '/sales/ads/creative/insights',     label: 'Insights' },
  { to: '/sales/ads/creative/creatives',    label: 'Creatives' },
  { to: '/sales/ads/creative/attributes',   label: 'Attributes' },
  { to: '/sales/ads/creative/explorations', label: 'Explorations' },
  { to: '/sales/ads/creative/generate',     label: 'Generate' },
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
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [lastSyncedAt, setLastSyncedAt] = useState(null)

  // Only fetch when on an analytics page — Clips/Variants/Ads/Generate use their own data
  const needsPerf = ANALYTICS_PATHS.has(location.pathname)

  const cacheKey = `${since}|${until}`

  const loadPerf = useCallback(async ({ force = false } = {}) => {
    const cached = PERF_CACHE.get(cacheKey)
    if (!force && cached && Date.now() - cached.t < CACHE_TTL_MS) {
      setPerf(cached.perf); setOffers(cached.offers); setLastSyncedAt(new Date(cached.t))
      return
    }
    setLoading(true); setErr(null)
    try {
      const [offersData, perfRes] = await Promise.all([
        listOffers(),
        supabase.rpc('lib_ad_performance', { since, until }),
      ])
      if (perfRes.error) throw new Error(perfRes.error.message)
      const fresh = perfRes.data || []
      setPerf(fresh); setOffers(offersData); setLastSyncedAt(new Date())
      PERF_CACHE.set(cacheKey, { perf: fresh, offers: offersData, t: Date.now() })
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [cacheKey, since, until])

  useEffect(() => {
    if (needsPerf && (!perf || perf.length === 0)) {
      const cached = PERF_CACHE.get(cacheKey)
      if (cached && Date.now() - cached.t < CACHE_TTL_MS) {
        setPerf(cached.perf); setOffers(cached.offers); setLastSyncedAt(new Date(cached.t))
      } else {
        loadPerf()
      }
    }
  }, [needsPerf, cacheKey, loadPerf, perf])

  // Persist window
  useEffect(() => { try { localStorage.setItem('insights.since', since) } catch {} }, [since])
  useEffect(() => { try { localStorage.setItem('insights.until', until) } catch {} }, [until])

  // Context exposed to nested routes via <Outlet context>
  const ctx = useMemo(() => ({
    perf, offers, loading, err, lastSyncedAt,
    since, until, setSince, setUntil,
    refresh: () => loadPerf({ force: true }),
    openGlossary: () => setGlossaryOpen(true),
  }), [perf, offers, loading, err, lastSyncedAt, since, until, loadPerf])

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

      <Outlet context={ctx} />

      <GlossaryDrawer open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
    </div>
  )
}
