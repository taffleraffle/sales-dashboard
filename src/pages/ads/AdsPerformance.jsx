import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertCircle, ChevronRight, ChevronDown, Search, ArrowDown, ArrowUp, X } from 'lucide-react'
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

// Date utilities for the range picker. Returns { preset, startStr, endStr }
// where startStr/endStr are 'YYYY-MM-DD'. preset values: '7' | '30' | '90' | 'all' | 'custom'.
function initialDateRange(days) {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - days + 1)
  return {
    preset: String(days),
    startStr: start.toISOString().split('T')[0],
    endStr:   end.toISOString().split('T')[0],
  }
}
function rangeFromPreset(preset) {
  if (preset === 'all') {
    // 'all' = last 2 years — long enough to feel like all-time without
    // pulling ten years of ad_daily_stats.
    return initialDateRange(730)
  }
  return initialDateRange(parseInt(preset, 10) || 30)
}
function rangeLabel(r) {
  if (r.preset === 'all') return 'All time (last 2 years)'
  if (r.preset === 'custom') return `${r.startStr} → ${r.endStr}`
  return `Last ${r.preset} days (${r.startStr} → ${r.endStr})`
}

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

// "Profitable" = at least one closed deal AND CAC is in the green tier.
// Used to light up the entire row in pale green so winners are obvious
// at a glance across the campaign / adset / ad hierarchy.
function isRowProfitable(rollup) {
  if (!rollup || !rollup.tfCloses || rollup.tfCloses <= 0) return false
  if (!rollup.spend || rollup.spend <= 0) return false
  const cac = rollup.spend / rollup.tfCloses
  return cac <= KPI.costPerClose.green
}
const PROFITABLE_BG = 'rgba(31, 122, 58, 0.10)'   // pale green tint

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
  // Unified close attribution. Maps from lib_close_resolved aggregated
  // client-side by ad / adset / campaign. Includes BOTH typeform-derived
  // closes AND HYROS-attributed closes (e.g. Shain Mann, Jeff Stovall).
  const [closeAd, setCloseAd] = useState({})
  const [closeAdset, setCloseAdset] = useState({})
  const [closeCampaign, setCloseCampaign] = useState({})
  // GHL-contact-attributed lead counts. Critical for paid-Meta-Lead-Form
  // campaigns where leads never touched Typeform (~1,500 leads invisible
  // to the dashboard before this).
  const [ghlLeadsAd, setGhlLeadsAd] = useState({})
  const [ghlLeadsAdset, setGhlLeadsAdset] = useState({})
  const [ghlLeadsCampaign, setGhlLeadsCampaign] = useState({})
  const [orphanCloses, setOrphanCloses] = useState({ count: 0, revenue: 0, cash: 0, rows: [] })
  const [showOrphans, setShowOrphans] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expandedCampaigns, setExpandedCampaigns] = useState(new Set())
  const [expandedAdSets, setExpandedAdSets] = useState(new Set())
  const [statusFilter, setStatusFilter] = useState('ACTIVE')
  const [search, setSearch] = useState('')
  // sortKey is a rollup field name; sortDir is 'asc' | 'desc'. For cost-per
  // metrics, we use a synthetic key (e.g. 'cpQualBooked') that the comparator
  // resolves at sort time by dividing spend by the appropriate denominator.
  const [sortKey, setSortKey] = useState('spend')
  const [sortDir, setSortDir] = useState('desc')
  const setSort = (key) => {
    if (key === sortKey) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortKey(key)
      // Cost-per metrics default to ascending (cheaper is better);
      // everything else defaults to descending (more is better).
      setSortDir(key.startsWith('cp') ? 'asc' : 'desc')
    }
  }
  // Drill-down modal state: { scope: { level, id, label }, metric, title }
  const [drill, setDrill] = useState(null)
  // Earliest + latest date in ad_daily_stats — shown next to the date range
  // so the operator can see what historical spend has actually been synced.
  const [dataCoverage, setDataCoverage] = useState(null)
  // Date range: { preset, startStr, endStr }. `preset` is one of 7|30|90|all|custom.
  // startStr/endStr are 'YYYY-MM-DD' strings. Default = last 30 days.
  const [dateRange, setDateRange] = useState(() => initialDateRange(30))

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const { startStr, endStr } = dateRange

      // 1. Ads — paginated so we never silently cap at 1000.
      const adsLoaded = []
      let adOffset = 0
      const AD_PAGE = 1000
      while (true) {
        const { data: adRows, error: aErr } = await supabase
          .from('ads')
          .select('ad_id, ad_name, status, effective_status, campaign_id, campaign_name, adset_id, adset_name, thumbnail_url, asset_url, asset_type, first_seen_at')
          .order('first_seen_at', { ascending: false })
          .range(adOffset, adOffset + AD_PAGE - 1)
        if (aErr) throw new Error(aErr.message)
        if (!adRows || !adRows.length) break
        adsLoaded.push(...adRows)
        if (adRows.length < AD_PAGE) break
        adOffset += AD_PAGE
      }
      setAds(adsLoaded)

      // Stats coverage check — tells the operator what date range Meta has
      // actually synced into ad_daily_stats, since the dashboard's date
      // picker can ask for periods that don't exist yet.
      const { data: covMin } = await supabase.from('ad_daily_stats').select('date').order('date', { ascending: true }).limit(1)
      const { data: covMax } = await supabase.from('ad_daily_stats').select('date').order('date', { ascending: false }).limit(1)
      if (covMin?.[0] && covMax?.[0]) setDataCoverage({ earliest: covMin[0].date, latest: covMax[0].date })

      const adIds = adsLoaded.map(a => a.ad_id)
      if (!adIds.length) { setLoading(false); return }

      // 2. Stats — paged to bypass PostgREST 1000-row cap. Filtered to
      // the active date range.
      const perAd = {}
      const PAGE = 1000
      let offset = 0
      while (true) {
        const { data, error: sErr } = await supabase
          .from('ad_daily_stats')
          .select('ad_id, spend, impressions, clicks, results')
          .in('ad_id', adIds)
          .gte('date', startStr)
          .lte('date', endStr)
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

      // 3. HYROS attribution (unchanged — already 90d in the view)
      const { data: hRows } = await supabase
        .from('lib_hyros_ad_attribution')
        .select('ad_id, calls_attributed, calls_qualified, revenue_attributed')
      const hyMap = {}
      for (const h of hRows || []) hyMap[h.ad_id] = h
      setHyros(hyMap)

      // 4. Typeform attribution — query the per-prospect detail view
      // directly, filter by submitted_at, and aggregate client-side.
      // We do this instead of querying the pre-aggregated rollup views
      // because those don't honour a date filter.
      const detailRows = []
      let dOff = 0
      while (true) {
        const { data, error: dErr } = await supabase
          .from('lib_typeform_response_detail')
          .select('response_id, submitted_at, ad_id, adset_id, utm_campaign, qualified, is_booked, is_live, is_closed, revenue, cash_collected')
          .gte('submitted_at', startStr + 'T00:00:00Z')
          .lte('submitted_at', endStr   + 'T23:59:59Z')
          .range(dOff, dOff + PAGE - 1)
        if (dErr) throw new Error(dErr.message)
        if (!data || !data.length) break
        detailRows.push(...data)
        if (data.length < PAGE) break
        dOff += PAGE
      }
      const tfAdMap = {}, tfAdsetMap = {}, tfCampMap = {}
      for (const r of detailRows) {
        const stamp = (target, key) => {
          if (!key) return
          let row = target[key]
          if (!row) {
            row = target[key] = { leads: 0, qualified_leads: 0, booked_calls: 0, qualified_booked_calls: 0, live_calls: 0, closes: 0, revenue_attributed: 0, cash_attributed: 0 }
          }
          row.leads++
          if (r.qualified)               row.qualified_leads++
          if (r.is_booked)               row.booked_calls++
          if (r.is_booked && r.qualified) row.qualified_booked_calls++
          if (r.is_live)                 row.live_calls++
          if (r.is_closed) {
            row.closes++
            row.revenue_attributed += parseFloat(r.revenue || 0)
            row.cash_attributed    += parseFloat(r.cash_collected || 0)
          }
        }
        stamp(tfAdMap,    r.ad_id)
        stamp(tfAdsetMap, r.adset_id)
        stamp(tfCampMap,  r.utm_campaign)
      }
      setTfAd(tfAdMap)
      setTfAdset(tfAdsetMap)
      setTfCampaign(tfCampMap)

      // 5. UNIFIED close attribution. Pulls every closed closer_call
      // (typeform-attributed + HYROS-attributed + orphan) filtered by
      // the date range, then aggregates by ad / adset / campaign.
      const closeRows = []
      let cOff = 0
      while (true) {
        const { data, error: ccErr } = await supabase
          .from('lib_close_resolved')
          .select('closer_call_id, prospect_name, clean_name, revenue, cash_collected, created_at, resolved_ad_id, resolved_adset_id, resolved_campaign, attribution_source')
          .gte('created_at', startStr + 'T00:00:00Z')
          .lte('created_at', endStr   + 'T23:59:59Z')
          .range(cOff, cOff + PAGE - 1)
        if (ccErr) throw new Error(ccErr.message)
        if (!data || !data.length) break
        closeRows.push(...data)
        if (data.length < PAGE) break
        cOff += PAGE
      }
      const cAd = {}, cAdset = {}, cCamp = {}
      const orphans = []
      let orphanRev = 0, orphanCash = 0
      for (const r of closeRows) {
        const rev = parseFloat(r.revenue || 0)
        const cash = parseFloat(r.cash_collected || 0)
        const bump = (target, key) => {
          if (!key) return
          let row = target[key]
          if (!row) row = target[key] = { closes: 0, revenue: 0, cash: 0 }
          row.closes++
          row.revenue += rev
          row.cash    += cash
        }
        bump(cAd,    r.resolved_ad_id)
        bump(cAdset, r.resolved_adset_id)
        bump(cCamp,  r.resolved_campaign)
        if (r.attribution_source === 'orphan') {
          orphans.push(r)
          orphanRev += rev
          orphanCash += cash
        }
      }
      setCloseAd(cAd)
      setCloseAdset(cAdset)
      setCloseCampaign(cCamp)
      setOrphanCloses({ count: orphans.length, revenue: orphanRev, cash: orphanCash, rows: orphans })

      // 6. GHL-contact-attributed leads. Paid Meta Lead Form prospects
      // never touched Typeform; they live exclusively on ghl_contacts.
      // Pull per-contact rows filtered by date, aggregate client-side.
      const ghlRows = []
      let gOff = 0
      while (true) {
        const { data, error: gErr } = await supabase
          .from('lib_ghl_leads_detail')
          .select('ghl_contact_id, landed_at, ad_id, adset_id, utm_campaign')
          .gte('landed_at', startStr + 'T00:00:00Z')
          .lte('landed_at', endStr   + 'T23:59:59Z')
          .range(gOff, gOff + PAGE - 1)
        if (gErr) throw new Error(gErr.message)
        if (!data || !data.length) break
        ghlRows.push(...data)
        if (data.length < PAGE) break
        gOff += PAGE
      }
      const gAd = {}, gAdset = {}, gCamp = {}
      for (const r of ghlRows) {
        if (r.ad_id)        gAd[r.ad_id]        = (gAd[r.ad_id]        || 0) + 1
        if (r.adset_id)     gAdset[r.adset_id]  = (gAdset[r.adset_id]  || 0) + 1
        if (r.utm_campaign) gCamp[r.utm_campaign] = (gCamp[r.utm_campaign] || 0) + 1
      }
      setGhlLeadsAd(gAd)
      setGhlLeadsAdset(gAdset)
      setGhlLeadsCampaign(gCamp)

    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  // Re-run on date-range change.
  useEffect(() => { load() }, [dateRange.startStr, dateRange.endStr])

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

      const adRollup = adRollupFrom(a, stats, hyros, tfAd, closeAd, ghlLeadsAd)
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

    // Overlay ad-set + campaign-level Typeform numbers (catches leads
    // where utm_content didn't match a specific ad name but utm_term
    // or utm_campaign did). Also overlay unified close attribution at
    // each parent level so HYROS-attributed closes (Shain Mann, Jeff
    // Stovall, etc) flow up correctly even when the closer_call had no
    // typeform behind it.
    for (const camp of campaigns.values()) {
      for (const set of camp.ad_sets.values()) {
        const tf = tfAdset[set.id]
        if (tf) overlayTypeformIfHigher(set.rollup, tf)
        const cs = closeAdset[set.id]
        if (cs) overlayClose(set.rollup, cs)
        // GHL lead count for this adset — takes MAX of bottom-up sum and view-level count.
        const ghlSet = ghlLeadsAdset[set.id] || 0
        if (ghlSet > (set.rollup.tfLeads || 0)) set.rollup.tfLeads = ghlSet
      }
      const tfc = tfCampaign[camp.name]
      if (tfc) overlayTypeformIfHigher(camp.rollup, tfc)
      const cc = closeCampaign[camp.name]
      if (cc) overlayClose(camp.rollup, cc)
      const ghlCamp = ghlLeadsCampaign[camp.name] || 0
      if (ghlCamp > (camp.rollup.tfLeads || 0)) camp.rollup.tfLeads = ghlCamp
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
      const compareAds = (a, b) => sortCompare(a.rollup, b.rollup, sortKey, sortDir)
      for (const s of visibleSets) s.ads.sort(compareAds)
      const compareSets = (a, b) => sortCompare(a.rollup, b.rollup, sortKey, sortDir)
      visibleSets.sort(compareSets)
      visibleCampaigns.push({ ...camp, ad_sets_sorted: visibleSets })
    }
    const compareCamps = (a, b) => sortCompare(a.rollup, b.rollup, sortKey, sortDir)
    visibleCampaigns.sort(compareCamps)
    return visibleCampaigns
  }, [ads, stats, hyros, tfAd, tfAdset, tfCampaign, closeAd, closeAdset, closeCampaign, ghlLeadsAd, ghlLeadsAdset, ghlLeadsCampaign, statusFilter, search, sortKey, sortDir])

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

      {/* Orphan-closes banner — visible whenever the closer logged closes
          that we couldn't attribute to any ad via typeform or HYROS. Click
          to see who. Keeps the operator honest about closed-deal coverage. */}
      {orphanCloses.count > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14,
          padding: '10px 14px',
          background: 'rgba(184,135,20,0.10)',
          border: '1px solid #b88714',
          borderLeftWidth: 3,
          borderRadius: '0 3px 3px 0',
          marginBottom: 8,
          fontSize: 13,
        }}>
          <div style={{ flex: '1 1 280px' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#7d5a0a', fontWeight: 600, marginBottom: 3 }}>
              Closes with no ad attribution · in range
            </div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink)' }}>
              <strong>{orphanCloses.count}</strong> close{orphanCloses.count > 1 ? 's' : ''} ({fmt$(orphanCloses.revenue)} contract, {fmt$(orphanCloses.cash)} cash)
              couldn't be matched to a Meta ad via Typeform or HYROS. They're real revenue, not lost — but not credited to any creative below.
            </div>
          </div>
          <button onClick={() => setShowOrphans(true)} style={{
            padding: '7px 12px', background: 'var(--paper)', color: 'var(--ink)',
            border: '1px solid var(--ink)', borderRadius: 3,
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}>View {orphanCloses.count} →</button>
        </div>
      )}

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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 8 }}>
        <ChipGroup
          label="Range"
          value={dateRange.preset}
          setValue={(v) => setDateRange(v === 'custom'
            ? { ...dateRange, preset: 'custom' }
            : rangeFromPreset(v))}
          options={[
            { value: '7',      label: '7d' },
            { value: '30',     label: '30d' },
            { value: '90',     label: '90d' },
            { value: 'all',    label: 'All' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
        {dateRange.preset === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="date"
              value={dateRange.startStr}
              max={dateRange.endStr}
              onChange={e => setDateRange({ ...dateRange, preset: 'custom', startStr: e.target.value })}
              style={dateInputStyle}
            />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>→</span>
            <input
              type="date"
              value={dateRange.endStr}
              min={dateRange.startStr}
              onChange={e => setDateRange({ ...dateRange, preset: 'custom', endStr: e.target.value })}
              style={dateInputStyle}
            />
          </div>
        )}
        <ChipGroup label="Status" value={statusFilter} setValue={setStatusFilter} options={STATUS_OPTIONS} />
        <button
          onClick={() => {
            setStatusFilter('ACTIVE')
            setDateRange(rangeFromPreset('30'))
            setSearch('')
            setSortKey('spend'); setSortDir('desc')
          }}
          style={{ ...btnGhost, padding: '4px 10px', fontSize: 9.5 }}
          title="Reset every filter to defaults"
        >Reset</button>
        <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <Search size={12} style={{ color: 'var(--ink-3)', flexShrink: 0, marginLeft: 4 }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search campaign / ad set / ad…"
            style={{ flex: 1, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: '5px 8px', fontSize: 12, color: 'var(--ink)', outline: 'none' }} />
        </div>
      </div>

      {/* Current range — always visible so it's clear what window is in play */}
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 12 }}>
        Showing: {rangeLabel(dateRange)}
        {dataCoverage && (
          <span style={{ marginLeft: 12, color: 'var(--ink-4)' }}>
            · spend synced from Meta: {dataCoverage.earliest} → {dataCoverage.latest}
          </span>
        )}
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
                <Th right w={70}  sortKey="spend"        activeSort={sortKey} sortDir={sortDir} onSort={setSort}>Spend</Th>
                <Th right w={60}  sortKey="tfLeads"      activeSort={sortKey} sortDir={sortDir} onSort={setSort}>Leads</Th>
                <Th right w={70}  sortKey="tfQualLeads"  activeSort={sortKey} sortDir={sortDir} onSort={setSort}>Qual Leads</Th>
                <Th right w={60}  sortKey="tfBooked"     activeSort={sortKey} sortDir={sortDir} onSort={setSort}>Booked</Th>
                <Th right w={75}  sortKey="tfQualBooked" activeSort={sortKey} sortDir={sortDir} onSort={setSort}>Qual Booked</Th>
                <Th right w={55}  sortKey="tfLive"       activeSort={sortKey} sortDir={sortDir} onSort={setSort}>Live</Th>
                <Th right w={55}  sortKey="tfCloses"     activeSort={sortKey} sortDir={sortDir} onSort={setSort}>Closes</Th>
                <Th right w={75}  sortKey="tfRevenue"    activeSort={sortKey} sortDir={sortDir} onSort={setSort}>Revenue</Th>
                <Th right w={70}  sortKey="cpLead"       activeSort={sortKey} sortDir={sortDir} onSort={setSort}>$ / Lead</Th>
                <Th right w={80}  sortKey="cpQualLead"   activeSort={sortKey} sortDir={sortDir} onSort={setSort}>$ / Qual</Th>
                <Th right w={70}  sortKey="cpBooked"     activeSort={sortKey} sortDir={sortDir} onSort={setSort}>$ / Book</Th>
                <Th right w={85}  sortKey="cpQualBooked" activeSort={sortKey} sortDir={sortDir} onSort={setSort}>$ / QBook</Th>
                <Th right w={70}  sortKey="cpLive"       activeSort={sortKey} sortDir={sortDir} onSort={setSort}>$ / Live</Th>
                <Th right w={70}  sortKey="cpClose"      activeSort={sortKey} sortDir={sortDir} onSort={setSort}>CAC</Th>
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
      {showOrphans && <OrphanClosesModal rows={orphanCloses.rows} onClose={() => setShowOrphans(false)} />}
    </div>
  )
}

// ── Orphan closes modal ─────────────────────────────────────────────
function OrphanClosesModal({ rows, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 680, height: '100vh', overflowY: 'auto',
        background: 'var(--paper)', borderLeft: '1px solid var(--rule)', padding: '24px 28px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid var(--rule)' }}>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4 }}>Orphan closes</div>
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, margin: 0 }}>{rows.length} close{rows.length > 1 ? 's' : ''} with no ad match</h3>
            <p style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-3)', marginTop: 6, lineHeight: 1.5 }}>
              These prospects closed but couldn't be matched to any Meta ad via Typeform (no form submission) or HYROS (no attributed event with a meta_ad_id). Likely cold outreach, old funnel re-engagements, or historical backfills. The revenue is real — just not creditable to a creative.
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 2, padding: 6, cursor: 'pointer', color: 'var(--ink-3)' }}>
            <X size={14} />
          </button>
        </div>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--rule)' }}>
              <th style={drillTh}>Date</th>
              <th style={drillTh}>Prospect</th>
              <th style={{ ...drillTh, textAlign: 'right' }}>Revenue</th>
              <th style={{ ...drillTh, textAlign: 'right' }}>Cash</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.closer_call_id} style={{ borderBottom: '1px solid var(--rule)' }}>
                <td style={drillTd}>{(r.created_at || '').slice(0, 10)}</td>
                <td style={drillTd}>{r.clean_name || r.prospect_name}</td>
                <td style={{ ...drillTd, textAlign: 'right', color: r.revenue > 0 ? 'var(--ink)' : 'var(--ink-4)' }}>{r.revenue > 0 ? fmt$(parseFloat(r.revenue)) : '—'}</td>
                <td style={{ ...drillTd, textAlign: 'right', color: r.cash_collected > 0 ? '#1f7a3a' : 'var(--ink-4)' }}>{r.cash_collected > 0 ? fmt$(parseFloat(r.cash_collected)) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CampaignBlock({ camp, open, onToggle, expandedAdSets, onToggleAdSet, onDrill }) {
  // Carry the full ad_id list in the campaign's scope so the drill modal can
  // resolve closes by ad_id IN (...) instead of by campaign-name string match.
  // The string can drift (Meta lets you rename a campaign while GHL keeps
  // the original utmCampaign on the contact) which makes string-match miss.
  const adIds = camp.ad_sets_sorted.flatMap(s => s.ads.map(x => x.ad.ad_id))
  const adsetIds = camp.ad_sets_sorted.map(s => s.id).filter(Boolean)
  const scope = { level: 'campaign', id: camp.name, label: camp.name, adIds, adsetIds }
  const anyActive = camp.activeAdCount > 0
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          borderTop: '2px solid var(--ink)',
          borderBottom: '1px solid var(--rule)',
          background: isRowProfitable(camp.rollup) ? PROFITABLE_BG : 'var(--paper-2)',
          borderLeft: isRowProfitable(camp.rollup) ? '3px solid #1f7a3a' : undefined,
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
  const adIds = set.ads.map(x => x.ad.ad_id)
  const adsetScope = { level: 'adset', id: set.id, label: set.name, adIds }
  return (
    <>
      <tr onClick={onToggle} style={{
        cursor: 'pointer',
        borderTop: '1px solid var(--rule)',
        borderBottom: '1px solid var(--rule)',
        background: isRowProfitable(set.rollup) ? PROFITABLE_BG : 'var(--paper-2)',
        borderLeft: isRowProfitable(set.rollup) ? '3px solid #1f7a3a' : undefined,
      }}>
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
        <tr key={ad.ad_id} style={{
          borderBottom: '1px solid var(--rule)',
          background: isRowProfitable(rollup) ? PROFITABLE_BG : undefined,
          borderLeft: isRowProfitable(rollup) ? '3px solid #1f7a3a' : undefined,
        }}>
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

function Th({ children, w, right, style, sortKey, activeSort, sortDir, onSort }) {
  const isActive = sortKey && activeSort === sortKey
  const clickable = !!sortKey && !!onSort
  return (
    <th
      onClick={clickable ? () => onSort(sortKey) : undefined}
      style={{
        padding: '12px 10px',
        textAlign: right ? 'right' : 'left',
        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
        color: isActive ? 'var(--ink)' : 'var(--ink-3)',
        fontWeight: isActive ? 700 : 600,
        width: w ? w : undefined, whiteSpace: 'nowrap',
        borderRight: '1px solid var(--rule)',
        cursor: clickable ? 'pointer' : undefined,
        background: isActive ? 'var(--accent-soft, rgba(244,225,74,0.18))' : undefined,
        userSelect: 'none',
        ...style,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, justifyContent: right ? 'flex-end' : 'flex-start' }}>
        {children}
        {isActive && (sortDir === 'asc' ? <ArrowUp size={9} strokeWidth={2.5} /> : <ArrowDown size={9} strokeWidth={2.5} />)}
      </span>
    </th>
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
function adRollupFrom(ad, stats, hyros, tfAd, closeAd, ghlLeadsAd) {
  const s = stats[ad.ad_id] || {}
  const h = hyros[ad.ad_id] || {}
  const t = tfAd[ad.ad_id] || {}
  const c = closeAd[ad.ad_id] || {}
  const g = ghlLeadsAd[ad.ad_id] || 0
  // Leads pulls from BOTH sources. typeform-funnel ads get t.leads; paid-
  // lead-form ads get g (GHL contacts). Most ads will only have ONE of
  // the two non-zero, so MAX is the right operator. If somehow both are
  // populated (shouldn't happen — typeform vs Lead Form are different
  // funnels), MAX keeps us honest by not double-counting.
  const leadsCombined = Math.max(t.leads || 0, g)
  return {
    spend: s.spend || 0,
    leads: s.results || 0,
    booked: h.calls_attributed || 0,
    qualified: h.calls_qualified || 0,
    revenue: parseFloat(h.revenue_attributed || 0),
    tfLeads:      leadsCombined,
    tfQualLeads:  t.qualified_leads || 0,
    tfBooked:     t.booked_calls || 0,
    tfQualBooked: t.qualified_booked_calls || 0,
    tfLive:       t.live_calls || 0,
    // Closes / revenue / cash come from the UNIFIED close attribution
    // (typeform + HYROS resolved). Falls back to typeform-only data when
    // closeAd is empty for the ad.
    tfCloses:     c.closes || t.closes || 0,
    tfRevenue:    parseFloat(c.revenue ?? t.revenue_attributed ?? 0),
    tfCash:       parseFloat(c.cash    ?? t.cash_attributed    ?? 0),
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
// Overlay unified close-attribution numbers (from lib_close_per_adset /
// per_campaign) at the parent level. Closes can come from HYROS even when
// no typeform exists, so use MAX of bottom-up sum and view-level number.
function overlayClose(target, cRow) {
  const closes = Math.max(target.tfCloses || 0, cRow.closes || 0)
  const rev    = Math.max(target.tfRevenue || 0, cRow.revenue || 0)
  const cash   = Math.max(target.tfCash    || 0, cRow.cash    || 0)
  target.tfCloses  = closes
  target.tfRevenue = rev
  target.tfCash    = cash
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
// Pull the sort value for a rollup based on the active sort key.
// Cost-per keys (cp*) compute on the fly from spend / count.
function sortValue(r, key) {
  if (!r) return 0
  switch (key) {
    case 'spend':         return r.spend || 0
    case 'tfLeads':       return r.tfLeads || 0
    case 'tfQualLeads':   return r.tfQualLeads || 0
    case 'tfBooked':      return r.tfBooked || 0
    case 'tfQualBooked':  return r.tfQualBooked || 0
    case 'tfLive':        return r.tfLive || 0
    case 'tfCloses':      return r.tfCloses || 0
    case 'tfRevenue':     return (r.tfRevenue || r.revenue) || 0
    case 'cpLead':        return r.tfLeads      > 0 ? r.spend / r.tfLeads      : Infinity
    case 'cpQualLead':    return r.tfQualLeads  > 0 ? r.spend / r.tfQualLeads  : Infinity
    case 'cpBooked':      return r.tfBooked     > 0 ? r.spend / r.tfBooked     : Infinity
    case 'cpQualBooked':  return r.tfQualBooked > 0 ? r.spend / r.tfQualBooked : Infinity
    case 'cpLive':        return r.tfLive       > 0 ? r.spend / r.tfLive       : Infinity
    case 'cpClose':       return r.tfCloses     > 0 ? r.spend / r.tfCloses     : Infinity
    default:              return r.spend || 0
  }
}
function sortCompare(a, b, key, dir) {
  const av = sortValue(a, key)
  const bv = sortValue(b, key)
  const cmp = av - bv
  return dir === 'asc' ? cmp : -cmp
}

const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
  background: 'var(--paper-2)', color: 'var(--ink-2)', border: '1px solid var(--rule)', borderRadius: 3,
  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500, cursor: 'pointer',
}

const dateInputStyle = {
  background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2,
  padding: '4px 6px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
  outline: 'none',
}

// ── Drill-down modal ────────────────────────────────────────────────
// Backs the click-to-see-the-actual-prospects behaviour on any number
// cell in the rollup table. Queries lib_typeform_response_detail with the
// scope (ad / adset / campaign) + the metric filter (leads, qualified,
// booked, qual_booked, live, closed).
function ProspectDrillModal({ drill, onClose }) {
  const [rows, setRows] = useState([])
  const [source, setSource] = useState('typeform')  // 'typeform' | 'closed'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoading(true); setError(null)
      try {
        // Closes / CAC come from the UNIFIED close attribution view, which
        // includes typeform + GHL + HYROS + manual sources. Everything else
        // is typeform-side data so it stays on lib_typeform_response_detail.
        const wantClosed = drill.metric === 'closed'
        if (wantClosed) {
          setSource('closed')
          // Query by the SAME identifiers the rollup uses. The campaign +
          // adset rows bubble closes up through ad-level rollup (closeAd),
          // not by string-matching the campaign name. So we have to mirror
          // that: include every close whose resolved_ad_id is in the
          // scope's ad list, OR whose resolved_adset_id is in scope, OR
          // whose resolved_campaign matches the scope name. Belt-and-braces
          // — covers data drift where Meta renamed a campaign after the
          // contact's utmCampaign was captured.
          let q = supabase.from('lib_close_resolved').select('*')
            .order('created_at', { ascending: false })
          if (drill.scope.level === 'ad') {
            q = q.eq('resolved_ad_id', drill.scope.id)
          } else if (drill.scope.level === 'adset') {
            const adIds = drill.scope.adIds || []
            if (adIds.length > 0) {
              q = q.or(`resolved_adset_id.eq.${drill.scope.id},resolved_ad_id.in.(${adIds.join(',')})`)
            } else {
              q = q.eq('resolved_adset_id', drill.scope.id)
            }
          } else if (drill.scope.level === 'campaign') {
            const adIds = drill.scope.adIds || []
            const adsetIds = drill.scope.adsetIds || []
            const ors = []
            if (drill.scope.id) ors.push(`resolved_campaign.eq.${encodeURIComponent(drill.scope.id)}`)
            if (adsetIds.length > 0) ors.push(`resolved_adset_id.in.(${adsetIds.join(',')})`)
            if (adIds.length > 0)    ors.push(`resolved_ad_id.in.(${adIds.join(',')})`)
            if (ors.length) q = q.or(ors.join(','))
          }
          const { data, error: e } = await q
          if (e) throw new Error(e.message)
          if (!cancelled) setRows(data || [])
          return
        }
        setSource('typeform')
        let q = supabase.from('lib_typeform_response_detail').select('*')
          .order('submitted_at', { ascending: false })
        if (drill.scope.level === 'ad')           q = q.eq('ad_id',        drill.scope.id)
        else if (drill.scope.level === 'adset')   q = q.eq('adset_id',     drill.scope.id)
        else if (drill.scope.level === 'campaign')q = q.eq('utm_campaign', drill.scope.id)
        if (drill.metric === 'qualified')   q = q.eq('qualified',  true)
        if (drill.metric === 'booked')      q = q.eq('is_booked',  true)
        if (drill.metric === 'qual_booked') q = q.eq('is_booked',  true).eq('qualified', true)
        if (drill.metric === 'live')        q = q.eq('is_live',    true)
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

        {!loading && rows.length > 0 && source === 'closed' && (
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--rule)' }}>
                <th style={drillTh}>Closed at</th>
                <th style={drillTh}>Prospect</th>
                <th style={drillTh}>Attribution</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Revenue</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Cash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.closer_call_id} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td style={drillTd}>{(r.created_at || '').slice(0, 10)}</td>
                  <td style={drillTd}>
                    <div style={{ fontFamily: 'var(--serif)', fontWeight: 500, color: 'var(--ink)', fontSize: 14 }}>{r.clean_name || r.prospect_name}</div>
                  </td>
                  <td style={drillTd}>
                    <span style={{
                      padding: '2px 8px', borderRadius: 2,
                      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase',
                      background: r.attribution_source === 'manual' ? 'var(--accent-soft)' : 'transparent',
                      border: '1px solid', borderColor: r.attribution_source === 'manual' ? 'var(--accent)' : 'var(--rule)',
                      color: 'var(--ink)',
                    }}>{r.attribution_source}</span>
                  </td>
                  <td style={{ ...drillTd, textAlign: 'right' }}>{r.revenue > 0 ? fmt$(parseFloat(r.revenue)) : '—'}</td>
                  <td style={{ ...drillTd, textAlign: 'right', color: r.cash_collected > 0 ? '#1f7a3a' : 'var(--ink-4)' }}>{r.cash_collected > 0 ? fmt$(parseFloat(r.cash_collected)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && rows.length > 0 && source === 'typeform' && (
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
