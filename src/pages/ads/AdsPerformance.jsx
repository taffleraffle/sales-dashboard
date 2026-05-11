import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertCircle, ChevronRight, ChevronDown, Search, Circle, CircleDot } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  Performance view — hierarchical rollup.
  Replaces the old tile-grid gallery with a Campaign → Ad set → Ad table.
  Rollup metrics at every level. Click a row to expand. Click an ad name
  to drill into AdDetail (where the existing transcript / video / HYROS
  sections live).

  Data sources:
    - public.ads                            (campaign_id, adset_id, ad_id, name, effective_status, thumbnail)
    - public.ad_daily_stats (30d window)    (spend, impressions, clicks, results)
    - public.lib_hyros_ad_attribution view  (calls_attributed, calls_qualified, revenue)

  All paged through 1000-row chunks because Meta accounts easily blow past
  PostgREST's default cap.
*/

// Active is the default — Ben said he doesn't want to see every single thing,
// the live work should be what shows up first. "All" is the escape hatch.
const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'all',    label: 'All' },
]
const SORT_OPTIONS = [
  { value: 'spend_desc',  label: 'Spend ↓' },
  { value: 'booked_desc', label: 'Booked ↓' },
  { value: 'cpa_asc',     label: 'Cost / booked ↑' },
]

function fmt$(n) {
  if (n == null || isNaN(n) || n === 0) return '—'
  if (n >= 10000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 1000)  return `$${(n / 1000).toFixed(2)}k`
  return `$${Math.round(n).toLocaleString()}`
}
function fmtN(n) {
  if (n == null || isNaN(n) || n === 0) return '—'
  return Math.round(n).toLocaleString()
}

export default function AdsPerformance() {
  const [ads, setAds] = useState([])
  const [stats, setStats] = useState({})       // ad_id → {spend, impressions, clicks, results}
  const [hyros, setHyros] = useState({})       // ad_id → {calls_attributed, calls_qualified, revenue_attributed}
  const [attrHealth, setAttrHealth] = useState(null)  // attribution-health rollup (30d)
  const [unattributed, setUnattributed] = useState([]) // sample list of un-linkable HYROS events
  const [showUnattr, setShowUnattr] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expandedCampaigns, setExpandedCampaigns] = useState(new Set())
  const [expandedAdSets, setExpandedAdSets] = useState(new Set())
  const [statusFilter, setStatusFilter] = useState('ACTIVE')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('spend_desc')

  const load = async () => {
    setLoading(true); setError(null)
    try {
      // 1. Ads
      const { data: adRows, error: aErr } = await supabase
        .from('ads')
        .select('ad_id, ad_name, status, effective_status, campaign_id, campaign_name, adset_id, adset_name, thumbnail_url, asset_url, asset_type, first_seen_at')
        .order('first_seen_at', { ascending: false })
        .limit(1000)
      if (aErr) throw new Error(aErr.message)
      const adsLoaded = adRows || []
      setAds(adsLoaded)

      const adIds = adsLoaded.map(a => a.ad_id)
      if (!adIds.length) { setLoading(false); return }

      // 2. Stats — paged to bypass PostgREST 1000-row cap
      const since = new Date(); since.setDate(since.getDate() - 30)
      const sinceStr = since.toISOString().split('T')[0]
      const perAd = {}
      const PAGE = 1000
      let offset = 0
      while (true) {
        const { data, error: sErr } = await supabase
          .from('ad_daily_stats')
          .select('ad_id, spend, impressions, clicks, results')
          .in('ad_id', adIds)
          .gte('date', sinceStr)
          .range(offset, offset + PAGE - 1)
        if (sErr) throw new Error(sErr.message)
        if (!data || !data.length) break
        for (const s of data) {
          const r = perAd[s.ad_id] || { spend: 0, impressions: 0, clicks: 0, results: 0 }
          r.spend += parseFloat(s.spend || 0)
          r.impressions += parseInt(s.impressions || 0)
          r.clicks += parseInt(s.clicks || 0)
          r.results += parseInt(s.results || 0)
          perAd[s.ad_id] = r
        }
        if (data.length < PAGE) break
        offset += PAGE
      }
      setStats(perAd)

      // 3. HYROS attribution
      const { data: hRows } = await supabase
        .from('lib_hyros_ad_attribution')
        .select('ad_id, calls_attributed, calls_qualified, revenue_attributed')
      const hyMap = {}
      for (const h of hRows || []) hyMap[h.ad_id] = h
      setHyros(hyMap)

      // 4. Attribution health rollup
      const { data: health } = await supabase
        .from('lib_hyros_attribution_health').select('*').single()
      if (health) setAttrHealth(health)

      // 5. Sample of unattributed events (so the operator can see who they are)
      const { data: unattr } = await supabase
        .from('hyros_events')
        .select('event_type, event_date, first_name, last_name, email, is_qualified, lead_tags')
        .is('meta_ad_id', null)
        .gte('event_date', new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0])
        .order('event_date', { ascending: false })
        .limit(50)
      setUnattributed(unattr || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  // Build the hierarchical tree: campaign → adset → ads, with rollups.
  // Parent status is derived bottom-up: if ANY descendant ad is ACTIVE the
  // parent counts as active. Used both for the status dot and for hiding
  // all-paused branches when statusFilter === 'ACTIVE'.
  const tree = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filteredAds = ads.filter(a => {
      // Per-ad status filter only applies AT the ad level for the
      // current filter mode. We still need ALL ads to compute parent
      // rollups; we hide branches in a second pass.
      if (q) {
        const blob = `${a.ad_name || ''} ${a.campaign_name || ''} ${a.adset_name || ''}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })

    const campaigns = new Map()
    for (const a of filteredAds) {
      const cid = a.campaign_id || 'no-campaign'
      const cname = a.campaign_name || 'Untitled campaign'
      if (!campaigns.has(cid)) {
        campaigns.set(cid, { id: cid, name: cname, ad_sets: new Map(), rollup: emptyRollup(), activeAdCount: 0, totalAdCount: 0 })
      }
      const camp = campaigns.get(cid)

      const asid = a.adset_id || 'no-adset'
      const asname = a.adset_name || 'Untitled ad set'
      if (!camp.ad_sets.has(asid)) {
        camp.ad_sets.set(asid, { id: asid, name: asname, ads: [], rollup: emptyRollup(), activeAdCount: 0, totalAdCount: 0 })
      }
      const adset = camp.ad_sets.get(asid)

      const adRollup = adRollupFrom(a, stats, hyros)
      const isActive = a.effective_status === 'ACTIVE'

      adset.ads.push({ ad: a, rollup: adRollup, isActive })
      adset.totalAdCount++
      camp.totalAdCount++
      if (isActive) { adset.activeAdCount++; camp.activeAdCount++ }

      addRollup(adset.rollup, adRollup)
      addRollup(camp.rollup, adRollup)
    }

    // Now apply the status filter at each level
    const visibleCampaigns = []
    for (const camp of campaigns.values()) {
      const visibleSets = []
      for (const set of camp.ad_sets.values()) {
        let ads = set.ads
        if (statusFilter === 'ACTIVE') ads = ads.filter(x => x.isActive)
        else if (statusFilter === 'PAUSED') ads = ads.filter(x => !x.isActive)
        if (!ads.length) continue
        visibleSets.push({ ...set, ads })
      }
      if (!visibleSets.length) continue
      const compareAds = (a, b) => sortCompare(a.rollup, b.rollup, sort)
      for (const s of visibleSets) s.ads.sort(compareAds)
      const compareSets = (a, b) => sortCompare(a.rollup, b.rollup, sort)
      visibleSets.sort(compareSets)
      visibleCampaigns.push({ ...camp, ad_sets_sorted: visibleSets })
    }
    const compareCamps = (a, b) => sortCompare(a.rollup, b.rollup, sort)
    visibleCampaigns.sort(compareCamps)
    return visibleCampaigns
  }, [ads, stats, hyros, statusFilter, search, sort])

  // When filter or data changes and the user hasn't manually toggled
  // anything, auto-expand the visible campaigns. This way Ben lands on a
  // page with ALL his active campaigns already open — no extra clicks.
  useEffect(() => {
    if (!tree.length) return
    setExpandedCampaigns(prev => {
      // Only auto-expand on the FIRST load after data lands. If the user
      // has already collapsed something, don't override them.
      if (prev.size > 0) return prev
      return new Set(tree.map(c => c.id))
    })
  }, [tree.length])

  const totals = useMemo(() => {
    const t = emptyRollup()
    for (const c of tree) addRollup(t, c.rollup)
    return t
  }, [tree])

  const toggleCampaign = (id) => {
    setExpandedCampaigns(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  const toggleAdSet = (id) => {
    setExpandedAdSets(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  const expandAll = () => {
    setExpandedCampaigns(new Set(tree.map(c => c.id)))
    setExpandedAdSets(new Set(tree.flatMap(c => c.ad_sets_sorted.map(s => s.id))))
  }
  const collapseAll = () => {
    setExpandedCampaigns(new Set())
    setExpandedAdSets(new Set())
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">Ads · Performance</span>
          <h2 className="h3 mt-2" style={{ fontSize: 22 }}>The <em>performance</em> view.</h2>
          <p className="mt-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            {tree.length} campaigns · last 30 days · click rows to expand
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={expandAll} style={btnGhost}>Expand all</button>
          <button onClick={collapseAll} style={btnGhost}>Collapse</button>
        </div>
      </div>

      {/* Attribution-health banner — shown when the HYROS gap is wide so
          Ben understands why the dashboard "leads" number is less than what
          he sees in HYROS itself. */}
      {attrHealth && attrHealth.fully_unattributed > 0 && (
        <AttributionHealthBanner
          health={attrHealth}
          onShowUnattributed={() => setShowUnattr(true)}
        />
      )}

      {/* Totals strip */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: '14px 16px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 16 }}>
        <TotalsTile label="Spend 30d" value={fmt$(totals.spend)} />
        <TotalsTile label="Booked (HYROS)" value={fmtN(totals.booked)} sub={totals.qualified ? `${totals.qualified} qualified` : null} />
        <TotalsTile label="Leads (Meta)" value={fmtN(totals.leads)} />
        <TotalsTile label="Revenue" value={fmt$(totals.revenue)} sub={totals.revenue ? 'HYROS-attributed' : null} />
        <TotalsTile label="Cost / book" value={totals.booked > 0 ? fmt$(totals.spend / totals.booked) : '—'} />
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 16 }}>
        <ChipGroup label="Status" value={statusFilter} setValue={setStatusFilter} options={STATUS_OPTIONS} />
        <ChipGroup label="Sort"   value={sort}         setValue={setSort}         options={SORT_OPTIONS} />
        <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <Search size={12} style={{ color: 'var(--ink-3)', flexShrink: 0, marginLeft: 4 }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search campaign / ad set / ad…"
            style={{ flex: 1, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: '5px 8px', fontSize: 12, color: 'var(--ink)', outline: 'none' }} />
        </div>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', background: 'var(--down-soft)', border: '1px solid var(--down)', borderLeftWidth: 3, borderRadius: '0 3px 3px 0', color: 'var(--down)', marginBottom: 16, fontSize: 13 }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>{error}</div>
        </div>
      )}

      {loading && <div className="flex items-center justify-center py-16"><Loader className="animate-spin" style={{ color: 'var(--ink-3)' }} /></div>}

      {!loading && tree.length === 0 && !error && (
        <div style={{ border: '1px dashed var(--rule)', borderRadius: 4, padding: 32, textAlign: 'center', background: 'var(--paper-2)' }}>
          <span className="eyebrow eyebrow-accent" style={{ justifyContent: 'center', display: 'inline-flex', marginBottom: 12 }}>No ads loaded</span>
          <h3 className="h3" style={{ fontSize: 22, marginBottom: 10 }}>Nothing matches.</h3>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)' }}>Adjust filters or run a Meta sync.</p>
        </div>
      )}

      {/* Hierarchical table */}
      {!loading && tree.length > 0 && (
        <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
                <Th style={{ minWidth: 360 }}>Name</Th>
                <Th right w={90}>Spend 30d</Th>
                <Th right w={80}>Booked</Th>
                <Th right w={70}>Qualified</Th>
                <Th right w={70}>Leads</Th>
                <Th right w={80}>Revenue</Th>
                <Th right w={90}>Cost / book</Th>
                <Th right w={90}>Cost / qual</Th>
                <Th w={80}>Status</Th>
              </tr>
            </thead>
            <tbody>
              {tree.map(camp => {
                const cOpen = expandedCampaigns.has(camp.id)
                return (
                  <CampaignBlock
                    key={camp.id}
                    camp={camp}
                    open={cOpen}
                    onToggle={() => toggleCampaign(camp.id)}
                    expandedAdSets={expandedAdSets}
                    onToggleAdSet={toggleAdSet}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Unattributed-events drawer */}
      {showUnattr && (
        <UnattributedDrawer events={unattributed} onClose={() => setShowUnattr(false)} />
      )}
    </div>
  )
}

function CampaignBlock({ camp, open, onToggle, expandedAdSets, onToggleAdSet }) {
  const anyActive = camp.activeAdCount > 0
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          borderTop: '2px solid var(--ink)',
          borderBottom: '1px solid var(--rule)',
          background: 'var(--paper-2)',
        }}
      >
        <Td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {open ? <ChevronDown size={15} style={{ color: 'var(--ink)' }} /> : <ChevronRight size={15} style={{ color: 'var(--ink)' }} />}
            <StatusDot active={anyActive} size={9} />
            <span
              style={{
                fontFamily: 'var(--serif)',
                fontSize: 17,
                fontWeight: 500,
                color: 'var(--ink)',
                letterSpacing: '-0.005em',
              }}
            >
              {camp.name}
            </span>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 9,
                color: anyActive ? 'var(--ink-2)' : 'var(--ink-4)',
                letterSpacing: '0.1em',
                marginLeft: 10,
                padding: '2px 6px',
                background: anyActive ? 'var(--accent-soft)' : 'transparent',
                border: anyActive ? '1px solid var(--accent)' : '1px solid var(--rule)',
                borderRadius: 2,
                fontWeight: 600,
              }}
            >
              {camp.activeAdCount}/{camp.totalAdCount} ACTIVE · {camp.ad_sets_sorted.length} AD SET{camp.ad_sets_sorted.length === 1 ? '' : 'S'}
            </span>
          </div>
        </Td>
        <RollupCells rollup={camp.rollup} bold />
      </tr>
      {open && camp.ad_sets_sorted.map(set => {
        const sOpen = expandedAdSets.has(set.id)
        return (
          <AdSetBlock
            key={set.id}
            set={set}
            open={sOpen}
            onToggle={() => onToggleAdSet(set.id)}
          />
        )
      })}
    </>
  )
}

function AdSetBlock({ set, open, onToggle }) {
  const anyActive = set.activeAdCount > 0
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer', borderBottom: '1px solid var(--rule)', background: 'var(--paper)' }}>
        <Td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 28 }}>
            {open ? <ChevronDown size={12} style={{ color: 'var(--ink-3)' }} /> : <ChevronRight size={12} style={{ color: 'var(--ink-3)' }} />}
            <StatusDot active={anyActive} size={7} />
            <span style={{ fontFamily: 'var(--serif)', fontSize: 13.5, color: 'var(--ink-2)', fontWeight: 400 }}>
              {set.name}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)', letterSpacing: '0.1em', marginLeft: 6 }}>
              {set.activeAdCount}/{set.totalAdCount} ACTIVE · {set.ads.length} SHOWN
            </span>
          </div>
        </Td>
        <RollupCells rollup={set.rollup} />
      </tr>
      {open && set.ads.map(({ ad, rollup, isActive }) => (
        <tr key={ad.ad_id} style={{ borderBottom: '1px solid var(--rule)' }}>
          <Td>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 56 }}>
              <StatusDot active={isActive} size={6} />
              {ad.thumbnail_url || ad.asset_url ? (
                <img src={ad.asset_url || ad.thumbnail_url} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 2, background: 'var(--paper-2)', flexShrink: 0 }} />
              ) : (
                <div style={{ width: 28, height: 28, background: 'var(--paper-2)', borderRadius: 2, flexShrink: 0 }} />
              )}
              <Link to={`/sales/ads/ad/${ad.ad_id}`} style={{ fontFamily: 'var(--serif)', fontSize: 13, color: isActive ? 'var(--ink)' : 'var(--ink-3)', textDecoration: 'underline', textDecorationColor: 'var(--ink-4)', textDecorationStyle: 'dotted' }}>
                {ad.ad_name || ad.ad_id}
              </Link>
            </div>
          </Td>
          <RollupCells rollup={rollup} muted={!isActive} />
          <Td>
            <StatusPill status={ad.effective_status || ad.status} />
          </Td>
        </tr>
      ))}
    </>
  )
}

// Solid filled dot for active, hollow ring for paused. Visual at-a-glance
// signal at every hierarchy level (campaign / ad set / ad).
function StatusDot({ active, size = 8 }) {
  return (
    <span
      title={active ? 'Has active ads' : 'No active ads'}
      style={{
        display: 'inline-block',
        width: size, height: size,
        flexShrink: 0,
        borderRadius: '50%',
        background: active ? 'var(--accent)' : 'transparent',
        border: active ? '1px solid var(--accent)' : `1.5px solid var(--ink-4)`,
      }}
    />
  )
}

function RollupCells({ rollup, bold, muted }) {
  const wt = bold ? 600 : 400
  const color = muted ? 'var(--ink-3)' : undefined
  return (
    <>
      <Td right mono style={{ fontWeight: wt, color }}>{fmt$(rollup.spend)}</Td>
      <Td right mono style={{ fontWeight: wt, color }}>{fmtN(rollup.booked)}</Td>
      <Td right mono style={{ fontWeight: wt, color }}>{fmtN(rollup.qualified)}</Td>
      <Td right mono style={{ fontWeight: wt, color }}>{fmtN(rollup.leads)}</Td>
      <Td right mono style={{ fontWeight: wt, color }}>{fmt$(rollup.revenue)}</Td>
      <Td right mono style={{ fontWeight: wt, color }}>{rollup.booked > 0 ? fmt$(rollup.spend / rollup.booked) : '—'}</Td>
      <Td right mono style={{ fontWeight: wt, color }}>{rollup.qualified > 0 ? fmt$(rollup.spend / rollup.qualified) : '—'}</Td>
    </>
  )
}

function StatusPill({ status }) {
  if (!status) return <span style={{ color: 'var(--ink-4)' }}>—</span>
  const isActive = status === 'ACTIVE'
  return (
    <span style={{
      padding: '2px 8px',
      background: isActive ? 'var(--accent-soft)' : 'transparent',
      color: isActive ? 'var(--ink)' : 'var(--ink-3)',
      border: '1px solid', borderColor: isActive ? 'var(--accent)' : 'var(--rule)',
      borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
    }}>{status}</span>
  )
}

// Attribution health banner — explains where HYROS leads went and why the
// dashboard's per-ad rollup can't show all of them.
function AttributionHealthBanner({ health, onShowUnattributed }) {
  const total = health.total_events || 0
  const withAd = health.attributed_to_ad || 0
  const unattr = health.fully_unattributed || 0
  const pct = total > 0 ? Math.round((withAd / total) * 100) : 0
  const isWarning = pct < 50
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16,
      padding: '12px 16px',
      background: isWarning ? 'var(--down-soft, rgba(180,30,30,0.06))' : 'var(--accent-soft)',
      border: '1px solid', borderColor: isWarning ? 'var(--down, #b41e1e)' : 'var(--accent)',
      borderLeftWidth: 3,
      borderRadius: '0 3px 3px 0',
      marginBottom: 16,
    }}>
      <div style={{ flex: '1 1 280px', minWidth: 280 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: isWarning ? 'var(--down, #b41e1e)' : 'var(--ink-3)', fontWeight: 600, marginBottom: 4 }}>
          {isWarning ? 'Attribution gap · last 30 days' : 'Attribution health · last 30 days'}
        </div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink)', lineHeight: 1.5 }}>
          HYROS recorded <strong>{total}</strong> events ({health.calls_total} calls + {health.leads_total} leads).
          {' '}
          <strong>{withAd}</strong> ({pct}%) link back to a specific Meta ad and show in the rollup below.
          {' '}
          <strong>{unattr}</strong> arrived with no ad / campaign / source data — they're real leads HYROS captured but can't tie to an ad.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <HealthTile label="Ad-attributed" value={withAd} sub={`${pct}%`} />
        <HealthTile label="Unattributed" value={unattr} warning />
        <button onClick={onShowUnattributed} style={{
          padding: '8px 14px',
          background: 'var(--paper)',
          color: 'var(--ink)',
          border: '1px solid var(--ink)',
          borderRadius: 3,
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}>
          View {unattr} unattributed →
        </button>
      </div>
    </div>
  )
}

function HealthTile({ label, value, sub, warning }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: warning ? 'var(--down, #b41e1e)' : 'var(--ink-3)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, color: warning ? 'var(--down, #b41e1e)' : 'var(--ink)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--ink-4)' }}>{sub}</div>}
    </div>
  )
}

// Drawer listing the unattributed events so the operator can see WHO they
// are and confirm they're real leads.
function UnattributedDrawer({ events, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.4)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 560, height: '100vh', overflowY: 'auto',
        background: 'var(--paper)', borderLeft: '1px solid var(--rule)', padding: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4 }}>Unattributed leads · last 30 days</div>
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, margin: 0 }}>{events.length} events HYROS couldn't tie to an ad.</h3>
            <p style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-3)', marginTop: 8, lineHeight: 1.5 }}>
              These are leads + calls HYROS recorded with no ad / campaign / source data — typically organic, direct, referral, or webhook-races where attribution settled after the event fired. They're real prospects; they just can't roll up under a specific Meta ad.
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 2, padding: 6, cursor: 'pointer', color: 'var(--ink-3)' }}>
            <X size={14} />
          </button>
        </div>

        {events.length === 0 ? (
          <p style={{ fontStyle: 'italic', color: 'var(--ink-3)' }}>No unattributed events in the window. Attribution is clean.</p>
        ) : (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--rule)' }}>
                <th style={{ textAlign: 'left', padding: '8px 6px', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500 }}>Date</th>
                <th style={{ textAlign: 'left', padding: '8px 6px', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500 }}>Type</th>
                <th style={{ textAlign: 'left', padding: '8px 6px', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500 }}>Lead</th>
                <th style={{ textAlign: 'right', padding: '8px 6px', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500 }}>Qual?</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td style={{ padding: '6px 6px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>{e.event_date}</td>
                  <td style={{ padding: '6px 6px', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>{e.event_type?.replace('.attributed', '')}</td>
                  <td style={{ padding: '6px 6px', fontFamily: 'var(--serif)', fontSize: 12, color: 'var(--ink)' }}>
                    {[e.first_name, e.last_name].filter(Boolean).join(' ') || e.email || <span style={{ color: 'var(--ink-4)', fontStyle: 'italic' }}>—</span>}
                  </td>
                  <td style={{ padding: '6px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10 }}>
                    {e.is_qualified === true ? <span style={{ color: 'var(--ink)' }}>YES</span> : e.is_qualified === false ? <span style={{ color: 'var(--ink-4)' }}>no</span> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function TotalsTile({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, color: 'var(--ink)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)', letterSpacing: '0.08em', marginTop: 2 }}>{sub}</div>}
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

function Th({ children, w, right, style }) {
  return (
    <th style={{
      padding: '10px 12px',
      textAlign: right ? 'right' : 'left',
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
      color: 'var(--ink-3)', fontWeight: 500, width: w ? w : undefined, whiteSpace: 'nowrap',
      ...style,
    }}>{children}</th>
  )
}
function Td({ children, right, mono, style }) {
  return (
    <td style={{
      padding: '8px 12px',
      textAlign: right ? 'right' : 'left',
      fontFamily: mono ? 'var(--mono)' : undefined,
      fontSize: 12, color: 'var(--ink)',
      fontVariantNumeric: mono ? 'tabular-nums' : undefined,
      ...style,
    }}>{children}</td>
  )
}

// ── Rollup utilities ────────────────────────────────────────────────
function emptyRollup() {
  return { spend: 0, leads: 0, booked: 0, qualified: 0, revenue: 0 }
}
function adRollupFrom(ad, stats, hyros) {
  const s = stats[ad.ad_id] || {}
  const h = hyros[ad.ad_id] || {}
  return {
    spend: s.spend || 0,
    leads: s.results || 0,
    booked: h.calls_attributed || 0,
    qualified: h.calls_qualified || 0,
    revenue: parseFloat(h.revenue_attributed || 0),
  }
}
function addRollup(target, src) {
  target.spend     += src.spend
  target.leads     += src.leads
  target.booked    += src.booked
  target.qualified += src.qualified
  target.revenue   += src.revenue
}
function sortCompare(a, b, mode) {
  if (mode === 'booked_desc') return (b.booked || 0) - (a.booked || 0)
  if (mode === 'cpa_asc') {
    const aCpa = a.booked > 0 ? a.spend / a.booked : Infinity
    const bCpa = b.booked > 0 ? b.spend / b.booked : Infinity
    return aCpa - bCpa
  }
  return (b.spend || 0) - (a.spend || 0)
}

const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
  background: 'var(--paper-2)', color: 'var(--ink-2)', border: '1px solid var(--rule)', borderRadius: 3,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500, cursor: 'pointer',
}
