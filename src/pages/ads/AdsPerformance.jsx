import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertCircle, ChevronRight, ChevronDown, Search, ArrowDown, ArrowUp } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  Performance view — hierarchical rollup.
  Replaces the old tile-grid gallery with a Campaign → Ad set → Ad table.
  Rollup metrics at every level. Click a row to expand. Click an ad name
  to drill into AdDetail (where the existing transcript / video / HYROS
  sections live).

  Data sources:
    - public.ads                                (campaign_id, adset_id, ad_id, name, effective_status, thumbnail)
    - public.ad_daily_stats (30d window)        (spend, impressions, clicks, results)
    - public.lib_hyros_ad_attribution view      (HYROS-tracked: calls_attributed, calls_qualified, revenue)
    - public.lib_typeform_ad_attribution view   (Typeform lead → GHL booking → live call/close, per ad_id)
    - public.lib_typeform_adset_attribution     (same, per adset_id — utm_term)
    - public.lib_typeform_campaign_attribution  (same, per utm_campaign — for campaign-level rollup)

  Why three Typeform views: lead attribution is hierarchical. Some leads have
  utm_content that matches ads.ad_name exactly → ad-level row. Some only have
  utm_term (adset_id) → adset-level only. Some only have utm_campaign → campaign-
  level only. The parent rollups don't sum children; they read from their own view.

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
  { value: 'cpa_asc',     label: 'Cost / qual booked ↑' },
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

// KPI cost-per-metric benchmarks (USD). Below green = great. Between green and
// yellow = OK. Above yellow = burning money. All thresholds picked off OPT's
// last-90-days restoration / local-SEO data and are conservative for a
// $1,500–$5,000/m offer. Edit here to tune globally — the colored cells and
// arrows in the rollup table pick these up automatically.
const KPI = {
  costPerLead:        { green:   80, yellow:  150 },  // cheap if < $80
  costPerQualLead:    { green:  150, yellow:  300 },
  costPerBooked:      { green:  400, yellow:  800 },
  costPerQualBooked:  { green:  500, yellow: 1000 },
  costPerLive:        { green: 1000, yellow: 2000 },
  costPerClose:       { green: 3000, yellow: 5000 },  // = CAC
}

function kpiColor(value, threshold) {
  if (value == null || isNaN(value) || value === 0 || !threshold) return 'var(--ink)'
  if (value <= threshold.green)  return '#1f7a3a'  // green — under budget
  if (value <= threshold.yellow) return '#b88714'  // amber — borderline
  return '#b41e1e'                                  // red — over budget
}

// Render a cost cell with color + up/down arrow vs benchmark.
// onClick (optional) makes the value clickable for drill-down.
function CostCell({ value, threshold, bold, muted, onClick }) {
  const wt = bold ? 600 : 400
  if (!value || !isFinite(value) || value === 0) {
    return <Td right mono style={{ fontWeight: wt, color: muted ? 'var(--ink-3)' : undefined }}>—</Td>
  }
  const color = muted ? 'var(--ink-3)' : kpiColor(value, threshold)
  const good = threshold && value <= threshold.green
  const bad  = threshold && value > threshold.yellow
  const clickable = typeof onClick === 'function'
  return (
    <Td right mono style={{ fontWeight: wt, color }}>
      <span
        onClick={clickable ? (e) => { e.stopPropagation(); onClick() } : undefined}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3,
          cursor: clickable ? 'pointer' : undefined,
          textDecoration: clickable ? 'underline' : undefined,
          textDecorationColor: clickable ? 'currentColor' : undefined,
          textDecorationStyle: 'dotted',
          textUnderlineOffset: 3,
        }}
      >
        {fmt$(value)}
        {good && <ArrowDown size={11} strokeWidth={2.5} />}
        {bad  && <ArrowUp   size={11} strokeWidth={2.5} />}
      </span>
    </Td>
  )
}

// Render a count cell. Clickable (with dotted underline) when onClick is given.
function CountCell({ value, bold, muted, color, onClick }) {
  const wt = bold ? 600 : 400
  const display = fmtN(value)
  if (display === '—' || !value) {
    return <Td right mono style={{ fontWeight: wt, color: muted ? 'var(--ink-3)' : 'var(--ink-4)' }}>—</Td>
  }
  const clickable = typeof onClick === 'function'
  return (
    <Td right mono style={{ fontWeight: wt, color: muted ? 'var(--ink-3)' : (color || undefined) }}>
      <span
        onClick={clickable ? (e) => { e.stopPropagation(); onClick() } : undefined}
        style={{
          cursor: clickable ? 'pointer' : undefined,
          textDecoration: clickable ? 'underline' : undefined,
          textDecorationStyle: 'dotted',
          textDecorationColor: 'currentColor',
          textUnderlineOffset: 3,
        }}
      >
        {display}
      </span>
    </Td>
  )
}

export default function AdsPerformance() {
  const [ads, setAds] = useState([])
  const [stats, setStats] = useState({})       // ad_id → {spend, impressions, clicks, results}
  const [hyros, setHyros] = useState({})       // ad_id → {calls_attributed, calls_qualified, revenue_attributed}
  const [tfAd, setTfAd] = useState({})         // ad_id → Typeform-attributed counts
  const [tfAdset, setTfAdset] = useState({})   // adset_id → Typeform-attributed counts
  const [tfCampaign, setTfCampaign] = useState({}) // utm_campaign (string) → Typeform counts
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expandedCampaigns, setExpandedCampaigns] = useState(new Set())
  const [expandedAdSets, setExpandedAdSets] = useState(new Set())
  const [statusFilter, setStatusFilter] = useState('ACTIVE')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('spend_desc')
  // Drill-down modal state: { scope: { level, id, label }, metric, title }
  const [drill, setDrill] = useState(null)

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

      // 3a. Typeform attribution — per ad, per ad set, per campaign.
      // All three levels because some leads only attribute up to adset or
      // campaign (the utm_content didn't match an exact ad name).
      const [{ data: tfAdRows }, { data: tfAdsetRows }, { data: tfCampRows }] = await Promise.all([
        supabase.from('lib_typeform_ad_attribution').select('*'),
        supabase.from('lib_typeform_adset_attribution').select('*'),
        supabase.from('lib_typeform_campaign_attribution').select('*'),
      ])
      const tfAdMap = {}
      for (const r of tfAdRows || []) tfAdMap[r.ad_id] = r
      setTfAd(tfAdMap)
      const tfAdsetMap = {}
      for (const r of tfAdsetRows || []) tfAdsetMap[r.adset_id] = r
      setTfAdset(tfAdsetMap)
      const tfCampMap = {}
      for (const r of tfCampRows || []) tfCampMap[r.utm_campaign] = r
      setTfCampaign(tfCampMap)

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

      const adRollup = adRollupFrom(a, stats, hyros, tfAd)
      const isActive = a.effective_status === 'ACTIVE'

      adset.ads.push({ ad: a, rollup: adRollup, isActive })
      adset.totalAdCount++
      camp.totalAdCount++
      if (isActive) { adset.activeAdCount++; camp.activeAdCount++ }

      // Spend always sums bottom-up (always exactly tied to ads.ad_id).
      // Typeform/HYROS fields are SUMMED bottom-up too, but we then
      // overlay the adset/campaign view rows so that leads with only
      // utm_term or only utm_campaign also surface at the parent level.
      addRollup(adset.rollup, adRollup)
      addRollup(camp.rollup, adRollup)
    }

    // Overlay ad-set-level Typeform numbers (catches leads where the
    // utm_content didn't match a specific ad name but utm_term did).
    for (const camp of campaigns.values()) {
      for (const set of camp.ad_sets.values()) {
        const tf = tfAdset[set.id]
        if (tf) overlayTypeformIfHigher(set.rollup, tf)
      }
      const tfc = tfCampaign[camp.name]
      if (tfc) overlayTypeformIfHigher(camp.rollup, tfc)
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
  }, [ads, stats, hyros, tfAd, tfAdset, tfCampaign, statusFilter, search, sort])

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
    // Negative-margin override so the perf table breaks out of Layout's
    // md:px-8 / md:py-6 wrapper and uses the full viewport width. The
    // table is dense — 16 columns with cost-per-X metrics — and the
    // editorial gutter steals real estate without giving anything back.
    <div style={{ margin: '-16px -32px -40px -32px', padding: '16px 24px' }}>
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

      {/* Totals strip */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: '14px 16px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 8 }}>
        <TotalsTile label="Spend 30d" value={fmt$(totals.spend)} />
        <TotalsTile label="Leads" value={fmtN(totals.tfLeads)} sub={totals.tfQualLeads ? `${totals.tfQualLeads} qualified` : null} />
        <TotalsTile label="Booked" value={fmtN(totals.tfBooked)} sub={totals.tfQualBooked ? `${totals.tfQualBooked} qualified` : null} />
        <TotalsTile label="Live calls" value={fmtN(totals.tfLive)} />
        <TotalsTile
          label="Closes"
          value={fmtN(totals.tfCloses)}
          sub={totals.tfRevenue ? fmt$(totals.tfRevenue) + ' rev' : null}
          valueColor={totals.tfCloses > 0 ? '#1f7a3a' : undefined}
        />
        <TotalsTile
          label="$ / Lead"
          value={totals.tfLeads > 0 ? fmt$(totals.spend / totals.tfLeads) : '—'}
          valueColor={kpiColor(totals.tfLeads > 0 ? totals.spend / totals.tfLeads : null, KPI.costPerLead)}
        />
        <TotalsTile
          label="$ / Qual booked"
          value={totals.tfQualBooked > 0 ? fmt$(totals.spend / totals.tfQualBooked) : '—'}
          valueColor={kpiColor(totals.tfQualBooked > 0 ? totals.spend / totals.tfQualBooked : null, KPI.costPerQualBooked)}
        />
        <TotalsTile
          label="$ / Live"
          value={totals.tfLive > 0 ? fmt$(totals.spend / totals.tfLive) : '—'}
          valueColor={kpiColor(totals.tfLive > 0 ? totals.spend / totals.tfLive : null, KPI.costPerLive)}
        />
        <TotalsTile
          label="CAC"
          value={totals.tfCloses > 0 ? fmt$(totals.spend / totals.tfCloses) : '—'}
          valueColor={kpiColor(totals.tfCloses > 0 ? totals.spend / totals.tfCloses : null, KPI.costPerClose)}
        />
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginBottom: 16, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        <LegendDot color="#1f7a3a" arrow="down" label="Under target" />
        <LegendDot color="#b88714" label="Borderline" />
        <LegendDot color="#b41e1e" arrow="up" label="Over target" />
        <span style={{ color: 'var(--ink-4)' }}>Targets editable in code · KPI block</span>
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
                <Th style={{ minWidth: 280 }}>Name</Th>
                <Th right w={70}>Spend</Th>
                <Th right w={60}>Leads</Th>
                <Th right w={70}>Qual Leads</Th>
                <Th right w={60}>Booked</Th>
                <Th right w={75}>Qual Booked</Th>
                <Th right w={55}>Live</Th>
                <Th right w={55}>Closes</Th>
                <Th right w={75}>Revenue</Th>
                <Th right w={70}>$ / Lead</Th>
                <Th right w={80}>$ / Qual</Th>
                <Th right w={70}>$ / Book</Th>
                <Th right w={85}>$ / QBook</Th>
                <Th right w={70}>$ / Live</Th>
                <Th right w={70}>CAC</Th>
                <Th w={70}>Status</Th>
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
                    onDrill={setDrill}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {drill && <ProspectDrillModal drill={drill} onClose={() => setDrill(null)} />}
    </div>
  )
}

function CampaignBlock({ camp, open, onToggle, expandedAdSets, onToggleAdSet, onDrill }) {
  const scope = { level: 'campaign', id: camp.name, label: camp.name }
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
        <RollupCells rollup={camp.rollup} bold scope={scope} onDrill={onDrill} />
        <Td />
      </tr>
      {open && camp.ad_sets_sorted.map(set => {
        const sOpen = expandedAdSets.has(set.id)
        return (
          <AdSetBlock
            key={set.id}
            set={set}
            open={sOpen}
            onToggle={() => onToggleAdSet(set.id)}
            onDrill={onDrill}
          />
        )
      })}
    </>
  )
}

function AdSetBlock({ set, open, onToggle, onDrill }) {
  const anyActive = set.activeAdCount > 0
  const adsetScope = { level: 'adset', id: set.id, label: set.name }
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer', borderTop: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)', background: 'var(--paper-2)' }}>
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
        <RollupCells rollup={set.rollup} scope={adsetScope} onDrill={onDrill} />
        <Td />
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
          <RollupCells rollup={rollup} muted={!isActive} scope={{ level: 'ad', id: ad.ad_id, label: ad.ad_name || ad.ad_id }} onDrill={onDrill} />
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

function RollupCells({ rollup, bold, muted, scope, onDrill }) {
  const wt = bold ? 600 : 400
  const color = muted ? 'var(--ink-3)' : undefined
  const greenIfPos = (n) => (muted ? 'var(--ink-3)' : (n > 0 ? '#1f7a3a' : 'var(--ink-4)'))
  const revShown = rollup.tfRevenue || rollup.revenue
  // Cost-per denominators all come from Typeform attribution.
  const cpLead     = rollup.tfLeads      > 0 ? rollup.spend / rollup.tfLeads      : 0
  const cpQualLead = rollup.tfQualLeads  > 0 ? rollup.spend / rollup.tfQualLeads  : 0
  const cpBooked   = rollup.tfBooked     > 0 ? rollup.spend / rollup.tfBooked     : 0
  const cpQualBook = rollup.tfQualBooked > 0 ? rollup.spend / rollup.tfQualBooked : 0
  const cpLive     = rollup.tfLive       > 0 ? rollup.spend / rollup.tfLive       : 0
  const cpClose    = rollup.tfCloses     > 0 ? rollup.spend / rollup.tfCloses     : 0
  // Drill click helper — only wired when scope + onDrill present (ad set + ad-level rows skip campaign-only drills).
  const drill = (metric, label) => (scope && onDrill ? () => onDrill({ scope, metric, label }) : undefined)
  return (
    <>
      <Td right mono style={{ fontWeight: wt, color }}>{fmt$(rollup.spend)}</Td>
      <CountCell value={rollup.tfLeads}      bold={bold} muted={muted} onClick={drill('leads',       'Leads')} />
      <CountCell value={rollup.tfQualLeads}  bold={bold} muted={muted} onClick={drill('qualified',   'Qualified leads')} />
      <CountCell value={rollup.tfBooked}     bold={bold} muted={muted} onClick={drill('booked',      'Booked calls')} />
      <CountCell value={rollup.tfQualBooked} bold={bold} muted={muted} onClick={drill('qual_booked', 'Qualified booked calls')} />
      <CountCell value={rollup.tfLive}       bold={bold} muted={muted} onClick={drill('live',        'Live calls')} />
      <CountCell value={rollup.tfCloses}     bold={bold} muted={muted} color={greenIfPos(rollup.tfCloses)} onClick={drill('closed', 'Closed deals')} />
      <Td right mono style={{ fontWeight: wt, color: greenIfPos(revShown) }}>{fmt$(revShown)}</Td>
      <CostCell value={cpLead}     threshold={KPI.costPerLead}        bold={bold} muted={muted} onClick={drill('leads',       'Leads')} />
      <CostCell value={cpQualLead} threshold={KPI.costPerQualLead}    bold={bold} muted={muted} onClick={drill('qualified',   'Qualified leads')} />
      <CostCell value={cpBooked}   threshold={KPI.costPerBooked}      bold={bold} muted={muted} onClick={drill('booked',      'Booked calls')} />
      <CostCell value={cpQualBook} threshold={KPI.costPerQualBooked}  bold={bold} muted={muted} onClick={drill('qual_booked', 'Qualified booked calls')} />
      <CostCell value={cpLive}     threshold={KPI.costPerLive}        bold={bold} muted={muted} onClick={drill('live',        'Live calls')} />
      <CostCell value={cpClose}    threshold={KPI.costPerClose}       bold={bold} muted={muted} onClick={drill('closed',      'Closed deals')} />
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

function TotalsTile({ label, value, sub, valueColor }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, color: valueColor || 'var(--ink)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)', letterSpacing: '0.08em', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function LegendDot({ color, label, arrow }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      {arrow === 'down' && <ArrowDown size={9} strokeWidth={2.5} style={{ color }} />}
      {arrow === 'up'   && <ArrowUp   size={9} strokeWidth={2.5} style={{ color }} />}
      <span style={{ color: 'var(--ink-3)' }}>{label}</span>
    </span>
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
      padding: '12px 10px',
      textAlign: right ? 'right' : 'left',
      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
      color: 'var(--ink-3)', fontWeight: 600, width: w ? w : undefined, whiteSpace: 'nowrap',
      borderRight: '1px solid var(--rule)',
      ...style,
    }}>{children}</th>
  )
}
function Td({ children, right, mono, style }) {
  return (
    <td style={{
      padding: '12px 10px',
      textAlign: right ? 'right' : 'left',
      fontFamily: mono ? 'var(--mono)' : undefined,
      fontSize: 14, color: 'var(--ink)',
      fontVariantNumeric: mono ? 'tabular-nums' : undefined,
      borderRight: '1px solid var(--rule-soft, rgba(0,0,0,0.06))',
      ...style,
    }}>{children}</td>
  )
}

// ── Rollup utilities ────────────────────────────────────────────────
function emptyRollup() {
  return {
    spend: 0,
    leads: 0,            // Meta-reported "results" (legacy column, kept for back-compat)
    booked: 0,           // HYROS calls_attributed (legacy)
    qualified: 0,        // HYROS calls_qualified (legacy)
    revenue: 0,          // HYROS revenue_attributed (legacy)
    // Typeform-driven attribution
    tfLeads: 0,
    tfQualLeads: 0,
    tfBooked: 0,
    tfQualBooked: 0,
    tfLive: 0,
    tfCloses: 0,
    tfRevenue: 0,
    tfCash: 0,
  }
}
function adRollupFrom(ad, stats, hyros, tfAd) {
  const s = stats[ad.ad_id] || {}
  const h = hyros[ad.ad_id] || {}
  const t = tfAd[ad.ad_id] || {}
  return {
    spend: s.spend || 0,
    leads: s.results || 0,
    booked: h.calls_attributed || 0,
    qualified: h.calls_qualified || 0,
    revenue: parseFloat(h.revenue_attributed || 0),
    tfLeads:      t.leads || 0,
    tfQualLeads:  t.qualified_leads || 0,
    tfBooked:     t.booked_calls || 0,
    tfQualBooked: t.qualified_booked_calls || 0,
    tfLive:       t.live_calls || 0,
    tfCloses:     t.closes || 0,
    tfRevenue:    parseFloat(t.revenue_attributed || 0),
    tfCash:       parseFloat(t.cash_attributed || 0),
  }
}
function addRollup(target, src) {
  target.spend        += src.spend
  target.leads        += src.leads
  target.booked       += src.booked
  target.qualified    += src.qualified
  target.revenue      += src.revenue
  target.tfLeads      += src.tfLeads
  target.tfQualLeads  += src.tfQualLeads
  target.tfBooked     += src.tfBooked
  target.tfQualBooked += src.tfQualBooked
  target.tfLive       += src.tfLive
  target.tfCloses     += src.tfCloses
  target.tfRevenue    += src.tfRevenue
  target.tfCash       += src.tfCash
}
// If the parent-level Typeform view has higher counts than the bottom-up
// sum (meaning leads landed at adset/campaign but not at an exact ad_name),
// take the view's values for the Typeform-side metrics. Spend stays bottom-up.
function overlayTypeformIfHigher(target, tfRow) {
  const fields = [
    ['tfLeads',      'leads'],
    ['tfQualLeads',  'qualified_leads'],
    ['tfBooked',     'booked_calls'],
    ['tfQualBooked', 'qualified_booked_calls'],
    ['tfLive',       'live_calls'],
    ['tfCloses',     'closes'],
    ['tfRevenue',    'revenue_attributed'],
    ['tfCash',       'cash_attributed'],
  ]
  for (const [t, s] of fields) {
    const v = parseFloat(tfRow[s] || 0)
    if (v > (target[t] || 0)) target[t] = v
  }
}
function sortCompare(a, b, mode) {
  if (mode === 'booked_desc') return (b.tfBooked || b.booked || 0) - (a.tfBooked || a.booked || 0)
  if (mode === 'cpa_asc') {
    // Prefer Typeform qualified booked when available; fall back to HYROS booked.
    const aDen = a.tfQualBooked || a.booked
    const bDen = b.tfQualBooked || b.booked
    const aCpa = aDen > 0 ? a.spend / aDen : Infinity
    const bCpa = bDen > 0 ? b.spend / bDen : Infinity
    return aCpa - bCpa
  }
  return (b.spend || 0) - (a.spend || 0)
}

const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
  background: 'var(--paper-2)', color: 'var(--ink-2)', border: '1px solid var(--rule)', borderRadius: 3,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500, cursor: 'pointer',
}

// ── Drill-down modal ────────────────────────────────────────────────
// Backs the click-to-see-the-actual-prospects behaviour on any number
// cell in the rollup table. Queries lib_typeform_response_detail with the
// scope (ad / adset / campaign) + the metric filter (leads, qualified,
// booked, qual_booked, live, closed).
function ProspectDrillModal({ drill, onClose }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoading(true); setError(null)
      try {
        let q = supabase.from('lib_typeform_response_detail').select('*')
          .order('submitted_at', { ascending: false })
        // Scope filter
        if (drill.scope.level === 'ad')           q = q.eq('ad_id',        drill.scope.id)
        else if (drill.scope.level === 'adset')   q = q.eq('adset_id',     drill.scope.id)
        else if (drill.scope.level === 'campaign')q = q.eq('utm_campaign', drill.scope.id)
        // Metric filter
        if (drill.metric === 'qualified')   q = q.eq('qualified',  true)
        if (drill.metric === 'booked')      q = q.eq('is_booked',  true)
        if (drill.metric === 'qual_booked') q = q.eq('is_booked',  true).eq('qualified', true)
        if (drill.metric === 'live')        q = q.eq('is_live',    true)
        if (drill.metric === 'closed')      q = q.eq('is_closed',  true)
        const { data, error: e } = await q
        if (e) throw new Error(e.message)
        if (!cancelled) setRows(data || [])
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [drill.scope.level, drill.scope.id, drill.metric])

  const levelLabel = drill.scope.level === 'ad' ? 'Ad' : drill.scope.level === 'adset' ? 'Ad set' : 'Campaign'

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 760, height: '100vh', overflowY: 'auto',
        background: 'var(--paper)', borderLeft: '1px solid var(--rule)', padding: '24px 28px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--rule)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>
              {levelLabel} · {drill.label}
            </div>
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500, margin: 0, color: 'var(--ink)' }}>
              {drill.label.includes('Leads') || drill.label.includes('leads') ? drill.label : drill.label}: {loading ? '…' : rows.length}
            </h3>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', marginTop: 6, letterSpacing: '0.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {drill.scope.label}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            background: 'transparent', border: '1px solid var(--rule)', borderRadius: 3,
            padding: '6px 10px', cursor: 'pointer', color: 'var(--ink-3)',
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
          }}>
            Close ✕
          </button>
        </div>

        {error && (
          <div style={{ padding: '12px 14px', background: 'rgba(180,30,30,0.08)', border: '1px solid #b41e1e', color: '#b41e1e', borderRadius: 3, fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Loader className="animate-spin" style={{ color: 'var(--ink-3)' }} />
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <p style={{ fontFamily: 'var(--serif)', fontSize: 14, fontStyle: 'italic', color: 'var(--ink-3)', padding: '32px 8px' }}>
            No prospects match this metric for the selected scope.
          </p>
        )}

        {!loading && rows.length > 0 && (
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--rule)' }}>
                <th style={drillTh}>Submitted</th>
                <th style={drillTh}>Prospect</th>
                <th style={drillTh}>Revenue tier</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Booked</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Live</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Closed</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Cash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.response_id} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td style={drillTd}>{(r.submitted_at || '').slice(0, 10) || '—'}</td>
                  <td style={drillTd}>
                    <div style={{ fontFamily: 'var(--serif)', fontWeight: 500, color: 'var(--ink)', fontSize: 14 }}>{r.display_name}</div>
                    {r.email && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.email}</div>}
                    {r.phone && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.phone}</div>}
                  </td>
                  <td style={drillTd}>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 2,
                      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
                      background: r.qualified ? 'var(--accent-soft)' : 'transparent',
                      border: '1px solid', borderColor: r.qualified ? 'var(--accent)' : 'var(--rule)',
                      color: 'var(--ink)',
                    }}>
                      {r.revenue_tier || (r.tier === 'abandoned' ? 'abandoned' : '—')}
                    </span>
                  </td>
                  <td style={{ ...drillTd, textAlign: 'right' }}>{r.is_booked  ? '●' : '—'}</td>
                  <td style={{ ...drillTd, textAlign: 'right' }}>{r.is_live    ? '●' : '—'}</td>
                  <td style={{ ...drillTd, textAlign: 'right', color: r.is_closed ? '#1f7a3a' : 'var(--ink-4)' }}>{r.is_closed ? '●' : '—'}</td>
                  <td style={{ ...drillTd, textAlign: 'right', color: r.cash_collected > 0 ? '#1f7a3a' : 'var(--ink-4)' }}>
                    {r.cash_collected > 0 ? fmt$(r.cash_collected) : '—'}
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

const drillTh = {
  textAlign: 'left', padding: '10px 8px',
  fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: 'var(--ink-3)', fontWeight: 500,
}
const drillTd = {
  padding: '12px 8px', fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink)',
  verticalAlign: 'top',
}
