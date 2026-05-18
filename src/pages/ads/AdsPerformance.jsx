import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertCircle, ChevronRight, ChevronDown, Search, ArrowDown, ArrowUp, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import EditorialDate from '../../components/EditorialDate'
import { dateRangeBoundsET } from '../../lib/dateUtils'
import { useCloserCallProspectMetrics } from '../../hooks/useCloserCallProspectMetrics'
import { subscribeSyncStatus, getLastSyncTime } from '../../services/autoSync'
import { SectionHead, ValueChip } from '../../components/editorial/atoms'

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
//
// Anchored to ET via dateRangeBoundsET so windows match the Marketing
// dashboard exactly. Previously this used browser-local + toISOString,
// which produced UTC-offset windows that diverged from the marketing
// dashboard's ET-anchored ones (~4-12 hours of edge mismatch).
function initialDateRange(days) {
  const { startStr, endStr } = dateRangeBoundsET(days)
  return { preset: String(days), startStr, endStr }
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

// Detect mobile viewport for the page wrapper + table behaviour. Avoids
// the negative-margin "break out of editorial gutter" trick on phones,
// which leaves the table hanging off the right edge.
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' ? window.innerWidth < breakpoint : false)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [breakpoint])
  return isMobile
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

// Show-rate cell: Live / Booked as %. Color-coded:
//   green ≥ 50%,  amber ≥ 25%,  red < 25%.  '—' when no bookings.
function ShowRateCell({ live, booked, bold, muted }) {
  const wt = bold ? 600 : 400
  if (!booked || booked === 0) {
    return <Td right mono style={{ fontWeight: wt, color: muted ? 'var(--ink-3)' : 'var(--ink-4)' }}>—</Td>
  }
  const pct = (live / booked) * 100
  const color = muted ? 'var(--ink-3)'
    : pct >= 50 ? '#1f7a3a'
    : pct >= 25 ? '#b88714'
    : '#b41e1e'
  return (
    <Td right mono style={{ fontWeight: wt, color }}>{pct.toFixed(0)}%</Td>
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
  // ad_id → { hook_type, message_frame, mechanism_reveal, pain_angle, proof_character, … }
  // Used to compute per-campaign winning attributes ("what's the leading
  // hook in this CBO") on the rolled-up campaign row.
  const [attrsByAd, setAttrsByAd] = useState({})
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
  // GHL-attributed bookings/lives (paid-lead-form leads who booked / showed)
  const [ghlBookedAd, setGhlBookedAd] = useState({})
  const [ghlBookedAdset, setGhlBookedAdset] = useState({})
  const [ghlBookedCampaign, setGhlBookedCampaign] = useState({})
  const [ghlLivesAd, setGhlLivesAd] = useState({})
  const [ghlLivesAdset, setGhlLivesAdset] = useState({})
  const [ghlLivesCampaign, setGhlLivesCampaign] = useState({})
  const [orphanCloses, setOrphanCloses] = useState({ count: 0, revenue: 0, cash: 0, rows: [] })
  // Source-of-truth totals from marketing_tracker (the same table the marketing
  // dashboard reads). Keeping these separate from the per-campaign rollup
  // makes the "attributed vs total" gap explicit — the headline can never
  // silently undercount because we compare it against the EOD-aggregated truth.
  // KPI totals. The "eod" object is the EOD-reported aggregate (same source
  // as the marketing dashboard — closer-entered daily counters). The
  // "attributed" object is how many of those we can credit to a Meta ad.
  // Headline = eod (so the ads dashboard matches what's reported in EOD).
  // Sub-line = attributed + gap (how much we couldn't tie to a creative).
  const [rowTotals, setRowTotals] = useState({
    eod:        { leads: 0, booked: 0, live: 0, closes: 0, revenue: 0, cash: 0 },
    attributed: { leads: 0, booked: 0, live: 0, closes: 0, revenue: 0, cash: 0 },
    // Unique-prospect counts that match what the drilldown panel will
    // actually display when the tile is clicked. Computed by unioning
    // typeform + GHL + close-resolved rows, deduped by email (or
    // name-token fallback when a source has no email column).
    prospects:  { leads: 0, booked: 0, live: 0, closes: 0 },
  })
  // Per-query failure list. Populated if any of the parallel fetches
  // throws; rendered as a banner so a broken source can't silently
  // produce wrong numbers.
  const [dataIssues, setDataIssues] = useState([])
  // Prospect-deduped close/live counts. Same source the Marketing dashboard
  // uses (via applyProspectMetrics). We surface both numbers — the EOD raw
  // counter and the deduped prospect count — so the discrepancy between
  // the two dashboards is explained inline rather than hidden.
  const { byRange: prospectMetricsByRange } = useCloserCallProspectMetrics()
  const [showOrphans, setShowOrphans] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expandedCampaigns, setExpandedCampaigns] = useState(new Set())
  const [expandedAdSets, setExpandedAdSets] = useState(new Set())
  const [statusFilter, setStatusFilter] = useState('ACTIVE')
  // Search input removed — Ben said he'll never use it. Tree filters by status/range/numeric only.
  const search = ''
  // Advanced numeric filters. All optional, all min/max ranges. Empty string =
  // not applied. Filter runs at the campaign-row level (the top of the tree)
  // so individual ads inside a campaign aren't hidden by their parent's
  // aggregate not matching.
  const [advFilter, setAdvFilter] = useState({
    spendMin: '', spendMax: '',
    leadsMin: '', leadsMax: '',
    closesMin: '', closesMax: '',
    showMin: '',  showMax: '',
    cacMin: '',   cacMax: '',
  })
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
  const isMobile = useIsMobile()
  // Date range: { preset, startStr, endStr }. `preset` is one of 7|30|90|all|custom.
  // startStr/endStr are 'YYYY-MM-DD' strings. Default = last 30 days.
  const [dateRange, setDateRange] = useState(() => initialDateRange(30))

  // Internal: ad list cached on window so date-scoped reloads don't re-
  // paginate the full ads table on every chip click. Cache has a 5-minute
  // TTL so newly-synced Meta ads (hourly sync) become visible without
  // requiring a hard refresh.
  const ADS_CACHE_TTL_MS = 5 * 60 * 1000
  const adsCacheRef = (typeof window !== 'undefined') ? (window.__adsPerfAdsCache || (window.__adsPerfAdsCache = { data: null, ts: 0 })) : { data: null, ts: 0 }
  const adsCacheFresh = () => adsCacheRef.data && (Date.now() - adsCacheRef.ts) < ADS_CACHE_TTL_MS

  // Static load: things that don't change with the date window. Runs once
  // on mount. Includes ads list, HYROS, GHL booked/lives rollups (all
  // aggregate-across-time views).
  const loadStatic = async () => {
    try {
      // 1. Ads — paginated so we never silently cap at 1000.
      let adsLoaded = adsCacheFresh() ? adsCacheRef.data : null
      if (!adsLoaded) {
        adsLoaded = []
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
        adsCacheRef.data = adsLoaded
        adsCacheRef.ts = Date.now()
      }
      setAds(adsLoaded)

      // Stats coverage (range Meta has actually synced)
      const { data: covMin } = await supabase.from('ad_daily_stats').select('date').order('date', { ascending: true }).limit(1)
      const { data: covMax } = await supabase.from('ad_daily_stats').select('date').order('date', { ascending: false }).limit(1)
      if (covMin?.[0] && covMax?.[0]) setDataCoverage({ earliest: covMin[0].date, latest: covMax[0].date })

      // HYROS attribution (already aggregated across time)
      const { data: hRows } = await supabase
        .from('lib_hyros_ad_attribution')
        .select('ad_id, calls_attributed, calls_qualified, revenue_attributed')
      const hyMap = {}
      for (const h of hRows || []) hyMap[h.ad_id] = h
      setHyros(hyMap)

      // Creative attributes — paginate through (one row per tagged ad).
      // Used to compute per-campaign winning hook / pain / mechanism /
      // proof on the rolled-up campaign row.
      const attrRows = await fetchAllPaged(() =>
        supabase.from('creative_attributes')
          .select('ad_id, hook_type, message_frame, mechanism_reveal, pain_angle, proof_character, funnel_stage, format'))
      const attrsMap = {}
      for (const a of attrRows) attrsMap[a.ad_id] = a
      setAttrsByAd(attrsMap)

      // NOTE: booked + live counts used to be fetched from the
      // all-time aggregate views here. Removed in favour of date-scoped
      // detail queries inside load() so a paused campaign doesn't show
      // 80 historical bookings against 0 in-range spend.
    } catch (e) { setError(e.message) }
  }

  // Helper: paginate a Supabase query through PostgREST's 1000-row cap.
  // The callsites used to inline this loop 5 times; one helper keeps
  // the pagination math out of the load() body.
  const fetchAllPaged = async (queryBuilder) => {
    const PAGE = 1000
    const out = []
    let off = 0
    while (true) {
      const { data, error } = await queryBuilder().range(off, off + PAGE - 1)
      if (error) throw new Error(error.message)
      if (!data || !data.length) break
      out.push(...data)
      if (data.length < PAGE) break
      off += PAGE
    }
    return out
  }

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const { startStr, endStr } = dateRange
      // Ads list comes from the static cache (loadStatic guarantees it's set first)
      const adsLoaded = (adsCacheFresh() ? adsCacheRef.data : null) || adsCacheRef.data || []
      const adIds = adsLoaded.map(a => a.ad_id)
      if (!adIds.length) { setLoading(false); return }
      // Use ET-anchored bounds so the window matches the Marketing dashboard's
      // ET cutoffs exactly. ET is UTC-5 (UTC-4 during DST), so we offset the
      // UTC instant we send to PostgREST. Using '-05:00' is safe both at
      // east-coast standard time AND for DST — PostgREST compares with stored
      // UTC timestamps and the boundary lands on the right ET calendar day.
      const startTs = startStr + 'T00:00:00-05:00'
      const endTs   = endStr   + 'T23:59:59-05:00'

      // Kick off ALL date-scoped fetches in parallel. Seven independent
      // queries each paged to bypass the 1000-row cap. Use allSettled
      // so one missing/failing source (e.g., a view not yet migrated)
      // degrades gracefully instead of blanking the entire page.
      const results = await Promise.allSettled([
        fetchAllPaged(() => supabase
          .from('ad_daily_stats')
          .select('ad_id, spend, impressions, clicks, results')
          .in('ad_id', adIds)
          .gte('date', startStr).lte('date', endStr)),
        fetchAllPaged(() => supabase
          .from('lib_typeform_response_detail')
          // email + display_name added so the top-of-page tile counts can
          // dedupe across typeform/GHL/closes using the same keys the
          // drilldown panel uses (email primary, name-token fallback).
          // Without these, the headline tiles used EOD self-reports while
          // the drilldown showed deduped prospect rows — same class of
          // bug Ben caught on per-campaign cells.
          .select('response_id, email, display_name, submitted_at, ad_id, adset_id, utm_campaign, qualified, is_booked, is_live, is_closed, revenue, cash_collected')
          .gte('submitted_at', startTs).lte('submitted_at', endTs)),
        fetchAllPaged(() => supabase
          .from('lib_close_resolved')
          .select('closer_call_id, prospect_name, clean_name, revenue, cash_collected, created_at, resolved_ad_id, resolved_adset_id, resolved_campaign, attribution_source')
          .gte('created_at', startTs).lte('created_at', endTs)),
        fetchAllPaged(() => supabase
          .from('lib_ghl_leads_detail')
          .select('ghl_contact_id, email, landed_at, ad_id, adset_id, utm_campaign')
          .gte('landed_at', startTs).lte('landed_at', endTs)),
        fetchAllPaged(() => supabase
          .from('lib_ghl_booked_detail')
          // email added for cross-source dedupe on the Booked tile.
          .select('appointment_id, email, display_name, landed_at, ad_id, adset_id, utm_campaign')
          .gte('landed_at', startTs).lte('landed_at', endTs)),
        fetchAllPaged(() => supabase
          .from('lib_ghl_lives_detail')
          // lib_ghl_lives_detail has no email column — pull display_name
          // (prospect_name aliased) so name-token dedupe works vs typeform.
          .select('closer_call_id, display_name, landed_at, ad_id, adset_id, utm_campaign')
          .gte('landed_at', startTs).lte('landed_at', endTs)),
        // marketing_tracker = closer-entered daily EOD aggregates. Same
        // source the marketing dashboard uses. Drives the headline KPI
        // numbers so "Closes 18" on the ads dashboard equals "Total Closes
        // 18" on the marketing dashboard.
        fetchAllPaged(() => supabase
          .from('marketing_tracker')
          .select('date, leads, net_new_calls, new_live_calls, live_calls, closes, trial_cash, trial_revenue')
          .gte('date', startStr).lte('date', endStr)),
      ])

      // Per-query degradation: log any failure but use [] so downstream
      // aggregation still runs. Failed queries surface in the UI via the
      // dataIssues banner so Ben can see exactly which source is broken.
      const newIssues = []
      const unpack = (i, label) => {
        if (results[i].status === 'fulfilled') return results[i].value
        const reason = results[i].reason?.message || String(results[i].reason)
        console.warn(`[AdsPerformance] ${label} failed:`, reason)
        newIssues.push(`${label}: ${reason}`)
        return []
      }
      const [statRows, tfRows, closeRows, ghlLeadRows, ghlBookedRows, ghlLiveRows, mtRows] = [
        unpack(0, 'Meta spend (ad_daily_stats)'),
        unpack(1, 'Typeform leads'),
        unpack(2, 'Resolved closes'),
        unpack(3, 'GHL leads'),
        unpack(4, 'GHL bookings'),
        unpack(5, 'GHL live calls'),
        unpack(6, 'EOD totals (marketing_tracker)'),
      ]
      setDataIssues(newIssues)

      // EOD aggregates — same source the marketing dashboard uses.
      // These are the headline numbers.
      const eod = { leads: 0, booked: 0, live: 0, closes: 0, revenue: 0, cash: 0 }
      for (const r of mtRows) {
        eod.leads   += parseInt(r.leads || 0)
        eod.booked  += parseInt(r.net_new_calls || 0)
        eod.live    += parseInt((r.new_live_calls != null ? r.new_live_calls : r.live_calls) || 0)
        eod.closes  += parseInt(r.closes || 0)
        eod.revenue += parseFloat(r.trial_revenue || 0)
        eod.cash    += parseFloat(r.trial_cash || 0)
      }

      // Attributed counts (rows we can credit to a Meta creative).
      // Dedup-by-prospect so a single person who books twice or has both
      // a typeform AND a GHL row only counts once. Without this dedup
      // the "attributed" number ROW-counts and routinely exceeds the
      // headline union count (e.g. 93 attrBooked vs 80 union-prospects)
      // which is mathematically impossible and makes the cost-per tiles
      // disagree with the per-row math.
      const closeRev = closeRows.reduce((s, r) => s + parseFloat(r.revenue || 0), 0)
      const closeCash = closeRows.reduce((s, r) => s + parseFloat(r.cash_collected || 0), 0)
      // Unique-prospect counts — mirror the union+dedupe logic in
      // ProspectDrillModal so the headline tile count equals what the
      // drilldown panel renders when clicked. Without this, top tiles
      // showed EOD self-reports (e.g. "5 closes") while clicking opened
      // a panel with deduped prospect rows (e.g. 3) — the same drift
      // class fixed at the per-campaign cells. Email dedupe primary,
      // name-token fallback for sources without email (lib_close_resolved,
      // lib_ghl_lives_detail).
      const lc = (s) => (s || '').toString().toLowerCase().trim()
      const nameTok = (r) => {
        const raw = lc(r.clean_name || r.prospect_name || r.display_name || r.email)
        if (!raw) return ''
        return raw.split(/\s+/).filter(Boolean).slice(0, 2).join(' ')
      }
      // Two union flavours — must match the drilldown's dedupe strategy
      // for each metric or the headline tile reads a different number
      // than what the panel will list.
      //
      // unionCountEmail: both sources have an email column (leads, booked).
      //   Email primary, name fallback when an individual row lacks email.
      // unionCountName:  ONE source lacks email (live = ghl_lives_detail,
      //   closes = lib_close_resolved). Using email on the side that has
      //   it while the other side falls through to name produces two
      //   different keys for the same person — that's the bug that made
      //   the Ads tile show 3 closes when the drilldown showed 2 (George
      //   Sidhom matched as "george@..." in typeform and "george sidhom"
      //   in lib_close_resolved → counted twice).
      // Both helpers skip rows with NO key — they can't be distinguished
      // from other key-less rows, so counting them inflates the universe.
      const unionCountEmail = (tfList, otherList) => {
        const emails = new Set(), names = new Set()
        let n = 0
        for (const r of tfList) {
          const e = lc(r.email), k = nameTok(r)
          if (!e && !k) continue
          if (e && emails.has(e)) continue
          if (!e && k && names.has(k)) continue
          if (e) emails.add(e)
          if (k) names.add(k)
          n++
        }
        for (const r of otherList) {
          const e = lc(r.email), k = nameTok(r)
          if (!e && !k) continue
          if (e && emails.has(e)) continue
          if (!e && k && names.has(k)) continue
          if (e) emails.add(e)
          if (k) names.add(k)
          n++
        }
        return n
      }
      const unionCountName = (tfList, otherList) => {
        const names = new Set()
        let n = 0
        for (const r of tfList) {
          const k = nameTok(r)
          if (!k) continue
          if (names.has(k)) continue
          names.add(k)
          n++
        }
        for (const r of otherList) {
          const k = nameTok(r)
          if (!k) continue
          if (names.has(k)) continue
          names.add(k)
          n++
        }
        return n
      }
      const prospects = {
        leads:  unionCountEmail(tfRows, ghlLeadRows),
        booked: unionCountEmail(tfRows.filter(r => r.is_booked), ghlBookedRows),
        live:   unionCountName(tfRows.filter(r => r.is_live),   ghlLiveRows),
        closes: unionCountName(tfRows.filter(r => r.is_closed), closeRows),
      }
      // Attributed = union (typeform with ad_id) ∪ (GHL row with ad_id),
      // prospect-deduped via the same email-first + name-token fallback
      // that the headline tiles use. Same shape as unionCountEmail /
      // unionCountName above so attributed never exceeds the headline.
      const attrLeads = unionCountEmail(
        tfRows.filter(r => r.ad_id),
        ghlLeadRows.filter(r => r.ad_id)
      )
      const attrBooked = unionCountEmail(
        tfRows.filter(r => r.is_booked && r.ad_id),
        ghlBookedRows.filter(r => r.ad_id)
      )
      // Live/closes use name-token (lib_ghl_lives_detail + lib_close_resolved
      // expose no email column, so an email-first dedup silently double-
      // counts every prospect who appears in both sources).
      const attrLive = unionCountName(
        tfRows.filter(r => r.is_live && r.ad_id),
        ghlLiveRows.filter(r => r.ad_id)
      )
      const attrCloses = unionCountName(
        tfRows.filter(r => r.is_closed && r.ad_id),
        closeRows.filter(r => r.resolved_ad_id || r.resolved_campaign)
      )
      setRowTotals({
        eod,
        attributed: {
          leads:   attrLeads,
          booked:  attrBooked,
          live:    attrLive,
          closes:  attrCloses,
          revenue: closeRev,
          cash:    closeCash,
        },
        prospects,
      })

      // 2. Stats — aggregate by ad_id
      const perAd = {}
      for (const s of statRows) {
        const r = perAd[s.ad_id] || { spend: 0, impressions: 0, clicks: 0, results: 0 }
        r.spend       += parseFloat(s.spend || 0)
        r.impressions += parseInt(s.impressions || 0)
        r.clicks      += parseInt(s.clicks || 0)
        r.results     += parseInt(s.results || 0)
        perAd[s.ad_id] = r
      }
      setStats(perAd)

      // Per-scope prospect-deduped aggregation.
      //
      // Every count + revenue/cash sum below is computed the SAME way the
      // drilldown panel computes them: union the relevant sources, dedupe
      // by email (or name-token fallback when a source has no email
      // column), and bucket per ad / adset / campaign. This guarantees
      // the number shown in the table row equals the number of rows the
      // drilldown lists when that cell is clicked.
      //
      // Previously each metric had its own ad-hoc rule (closes used
      // `c.closes || t.closes`, leads/booked/live used Math.max(typeform,
      // ghl), qual_booked was typeform-only) which systematically
      // disagreed with the deduped drilldown. Most painful was the
      // closes case: a typeform `is_closed=true` row not yet resolved
      // by HYROS counted toward the drilldown but the `||` fallback
      // hid it from the row whenever ANY resolved close existed for
      // the same ad — so a $9k unresolved typeform close stayed
      // invisible behind the $10k resolved close.

      // Bucket builder. Sources are normalized to { key, ad, adset, campaign,
      // rev, cash } before union, so the same accumulator handles every
      // metric. (lc + nameTok already declared above by the top-tile
      // prospects block; reusing them here keeps both code paths in sync.)
      //
      // Two dedupe strategies — pick the one that matches the source pair:
      //
      // • dedupeByEmail: email primary, name-token fallback. Use when BOTH
      //   sources have an email column (leads = typeform + lib_ghl_leads,
      //   booked = typeform + lib_ghl_booked).
      //
      // • dedupeByName: name-token ONLY. Use when EITHER source lacks an
      //   email column (closes = typeform + lib_close_resolved [no email],
      //   live = typeform + lib_ghl_lives_detail [no email]). If we let
      //   typeform key by email and resolved-side key by name, the same
      //   person collides on neither key → double-counted. This is the
      //   bug that made closes count 3 when the drilldown showed 2: George
      //   Sidhom appeared in both sources with email "george@..." in
      //   typeform and only `clean_name` in lib_close_resolved.
      const dedupeByEmail = (r) => lc(r.email) || nameTok(r) || ''
      const dedupeByName  = (r) => nameTok(r) || lc(r.email) || ''

      const accumulate = (target, scopeKey, row) => {
        if (!scopeKey) return
        const k = row._dedupe
        // Skip rows with NO dedupe key (no email AND no name). They can't
        // be distinguished from each other, so counting them all inflates
        // the universe. Prior version counted them as separate prospects,
        // adding silent slop to every metric.
        if (!k) return
        let bucket = target[scopeKey]
        if (!bucket) bucket = target[scopeKey] = { count: 0, revenue: 0, cash: 0, _seen: new Set() }
        if (bucket._seen.has(k)) return
        bucket._seen.add(k)
        bucket.count++
        bucket.revenue += row._rev || 0
        bucket.cash    += row._cash || 0
      }
      // Campaign / adset resolution for prospect rows.
      //
      // Priority (drilldown must match exactly or counts drift):
      //   1. utm_campaign / adset_id (lead-time truth, captured at form
      //      submission) — but ONLY if the value matches a known
      //      campaign/adset in adsLoaded. This handles the "Meta moved
      //      the ad after the lead came in" case: e.g. Wendell + Vlad
      //      submitted via the 5/2 campaign; Meta later moved their
      //      ad_ids to the 4/30 campaign. Ad-parent says 4/30; utm
      //      says 5/2; utm wins because that's where the conversion
      //      came from.
      //   2. ad-parent → adset-parent (current Meta state) — fallback
      //      when utm is missing or points to a campaign that no
      //      longer exists in adsLoaded (handles Meta rename: old utm
      //      value isn't in adsLoaded anymore, so we use the current
      //      campaign name).
      //   3. Raw row._campaign / row._adset — fallback for completely
      //      orphaned rows (campaign was deleted; will bucket under a
      //      ghost name that doesn't match any visible campaign row).
      //
      // Without this, the campaign row showed 8 leads but the drilldown
      // showed 10 because Wendell + Vlad's ad_id-parent moved them off
      // 5/2 while the drilldown's utm_campaign.eq.X OR caught them.
      const adParent = {}
      const adsetParent = {}
      const validCampaigns = new Set()
      const validAdsets    = new Set()
      for (const a of adsLoaded) {
        adParent[a.ad_id] = { adset: a.adset_id, campaign: a.campaign_name }
        if (a.adset_id) adsetParent[a.adset_id] = { campaign: a.campaign_name }
        if (a.campaign_name) validCampaigns.add(a.campaign_name)
        if (a.adset_id)      validAdsets.add(a.adset_id)
      }
      const resolveCampaign = (row) =>
        (row._campaign && validCampaigns.has(row._campaign) ? row._campaign : null) ||
        (row._ad    && adParent[row._ad]    ? adParent[row._ad].campaign       : null) ||
        (row._adset && adsetParent[row._adset] ? adsetParent[row._adset].campaign : null) ||
        row._campaign
      const resolveAdset = (row) =>
        (row._adset && validAdsets.has(row._adset) ? row._adset : null) ||
        (row._ad && adParent[row._ad] ? adParent[row._ad].adset : null) ||
        row._adset

      const bucketUnion = (...sourceLists) => {
        const ad = {}, adset = {}, campaign = {}
        for (const list of sourceLists) {
          for (const row of list) {
            accumulate(ad,       row._ad,            row)
            accumulate(adset,    resolveAdset(row),  row)
            accumulate(campaign, resolveCampaign(row), row)
          }
        }
        return { ad, adset, campaign }
      }

      // Normalize each row source to a uniform shape. Order matters in
      // sourceLists: the FIRST source seen for a given dedupe key wins
      // (its revenue/cash counts; later sources are skipped). For closes
      // we put lib_close_resolved first so HYROS-validated $/cash wins
      // over typeform self-report.
      //
      // Dedupe-key choice per metric (must match the drilldown for the
      // tile count to equal the panel count):
      //   leads / qual_leads / booked / qual_booked → email-first
      //     (both sources have an email column).
      //   live / closes                             → name-only
      //     (lib_close_resolved + lib_ghl_lives_detail expose no email).
      const tfAsLead = tfRows.map(r => ({
        _dedupe: dedupeByEmail(r),
        _ad: r.ad_id, _adset: r.adset_id, _campaign: r.utm_campaign,
      }))
      const tfQualLead = tfRows.filter(r => r.qualified).map(r => ({
        _dedupe: dedupeByEmail(r),
        _ad: r.ad_id, _adset: r.adset_id, _campaign: r.utm_campaign,
      }))
      const tfAsBooked = tfRows.filter(r => r.is_booked).map(r => ({
        _dedupe: dedupeByEmail(r),
        _ad: r.ad_id, _adset: r.adset_id, _campaign: r.utm_campaign,
      }))
      const tfAsQualBooked = tfRows.filter(r => r.is_booked && r.qualified).map(r => ({
        _dedupe: dedupeByEmail(r),
        _ad: r.ad_id, _adset: r.adset_id, _campaign: r.utm_campaign,
      }))
      const tfAsLive = tfRows.filter(r => r.is_live).map(r => ({
        _dedupe: dedupeByName(r),
        _ad: r.ad_id, _adset: r.adset_id, _campaign: r.utm_campaign,
      }))
      const tfAsClose = tfRows.filter(r => r.is_closed).map(r => ({
        _dedupe: dedupeByName(r),
        _ad: r.ad_id, _adset: r.adset_id, _campaign: r.utm_campaign,
        _rev: parseFloat(r.revenue || 0),
        _cash: parseFloat(r.cash_collected || 0),
      }))
      const gAsLead = ghlLeadRows.map(r => ({
        _dedupe: dedupeByEmail(r),
        _ad: r.ad_id, _adset: r.adset_id, _campaign: r.utm_campaign,
      }))
      const gAsBooked = ghlBookedRows.map(r => ({
        _dedupe: dedupeByEmail(r),
        _ad: r.ad_id, _adset: r.adset_id, _campaign: r.utm_campaign,
      }))
      const gAsLive = ghlLiveRows.map(r => ({
        _dedupe: dedupeByName(r),
        _ad: r.ad_id, _adset: r.adset_id, _campaign: r.utm_campaign,
      }))
      const closeAsClose = closeRows.map(r => ({
        _dedupe: dedupeByName(r),
        _ad: r.resolved_ad_id, _adset: r.resolved_adset_id, _campaign: r.resolved_campaign,
        _rev: parseFloat(r.revenue || 0),
        _cash: parseFloat(r.cash_collected || 0),
      }))

      // Replace the old tfAdMap shape with the deduped per-metric maps.
      // Each level (ad/adset/campaign) gets its own dedupe scope so a
      // prospect that attributes across multiple ads in the same adset
      // counts once at the adset level — same as the drilldown does.
      const mapsLead       = bucketUnion(tfAsLead,       gAsLead)
      const mapsQualLead   = bucketUnion(tfQualLead)
      const mapsBooked     = bucketUnion(tfAsBooked,     gAsBooked)
      const mapsQualBooked = bucketUnion(tfAsQualBooked)
      // Lives universe = typeform is_live ∪ ghl_lives_detail ∪ closes
      // (closed implies live by definition). Without the closes union, a
      // closed prospect with no recorded live event (e.g. George Sidhom)
      // shows in Closes=1 but Lives=0 on the same row — the kind of
      // impossible math that makes Ben yell at the dashboard.
      const mapsLive       = bucketUnion(tfAsLive,       gAsLive,    closeAsClose, tfAsClose)
      // Closes: lib_close_resolved FIRST so its revenue wins on prospects
      // that appear in both sources. Typeform is_closed adds prospects
      // that haven't been HYROS-resolved yet.
      const mapsClose      = bucketUnion(closeAsClose,   tfAsClose)

      const adMap = (m, fields) => {
        const out = {}
        for (const [k, v] of Object.entries(m)) {
          const o = {}
          for (const [src, dst] of fields) o[dst] = v[src] || 0
          out[k] = o
        }
        return out
      }
      // Backwards-compat shape: existing consumers (extract, addRollup,
      // overlayTypeformIfHigher, overlayClose) read .leads / .booked_calls
      // / .closes / etc. Emit the same field names — but the underlying
      // counts are now drilldown-matched prospect totals, not raw row
      // counts or MAX heuristics.
      const tfAdMap = {}, tfAdsetMap = {}, tfCampMap = {}
      const cAd = {}, cAdset = {}, cCamp = {}
      const merge = (target, source, key, field) => {
        for (const [k, v] of Object.entries(source[key])) {
          if (!target[k]) target[k] = { leads: 0, qualified_leads: 0, booked_calls: 0, qualified_booked_calls: 0, live_calls: 0, closes: 0, revenue_attributed: 0, cash_attributed: 0 }
          target[k][field] = v.count || 0
        }
      }
      merge(tfAdMap,    mapsLead,       'ad',       'leads')
      merge(tfAdsetMap, mapsLead,       'adset',    'leads')
      merge(tfCampMap,  mapsLead,       'campaign', 'leads')
      merge(tfAdMap,    mapsQualLead,   'ad',       'qualified_leads')
      merge(tfAdsetMap, mapsQualLead,   'adset',    'qualified_leads')
      merge(tfCampMap,  mapsQualLead,   'campaign', 'qualified_leads')
      merge(tfAdMap,    mapsBooked,     'ad',       'booked_calls')
      merge(tfAdsetMap, mapsBooked,     'adset',    'booked_calls')
      merge(tfCampMap,  mapsBooked,     'campaign', 'booked_calls')
      merge(tfAdMap,    mapsQualBooked, 'ad',       'qualified_booked_calls')
      merge(tfAdsetMap, mapsQualBooked, 'adset',    'qualified_booked_calls')
      merge(tfCampMap,  mapsQualBooked, 'campaign', 'qualified_booked_calls')
      merge(tfAdMap,    mapsLive,       'ad',       'live_calls')
      merge(tfAdsetMap, mapsLive,       'adset',    'live_calls')
      merge(tfCampMap,  mapsLive,       'campaign', 'live_calls')
      // Close rev/cash also fold into the tf* maps' revenue_attributed /
      // cash_attributed so overlayTypeformIfHigher carries them up the tree.
      for (const level of ['ad', 'adset', 'campaign']) {
        const target = level === 'ad' ? tfAdMap : level === 'adset' ? tfAdsetMap : tfCampMap
        for (const [k, v] of Object.entries(mapsClose[level])) {
          if (!target[k]) target[k] = { leads: 0, qualified_leads: 0, booked_calls: 0, qualified_booked_calls: 0, live_calls: 0, closes: 0, revenue_attributed: 0, cash_attributed: 0 }
          target[k].closes              = v.count   || 0
          target[k].revenue_attributed  = v.revenue || 0
          target[k].cash_attributed     = v.cash    || 0
        }
      }
      // cAd / cAdset / cCamp expose the close-only view (for extract's
      // tfRevenue / tfCash fallback chain and overlayClose at the parent
      // level). Keep the same shape consumers expect.
      for (const [k, v] of Object.entries(mapsClose.ad))       cAd[k]    = { closes: v.count, revenue: v.revenue, cash: v.cash }
      for (const [k, v] of Object.entries(mapsClose.adset))    cAdset[k] = { closes: v.count, revenue: v.revenue, cash: v.cash }
      for (const [k, v] of Object.entries(mapsClose.campaign)) cCamp[k]  = { closes: v.count, revenue: v.revenue, cash: v.cash }

      setTfAd(tfAdMap); setTfAdset(tfAdsetMap); setTfCampaign(tfCampMap)
      setCloseAd(cAd); setCloseAdset(cAdset); setCloseCampaign(cCamp)

      // Orphan tracking — unchanged from the prior aggregation, runs on
      // the raw lib_close_resolved rows. Orphan = close that couldn't be
      // attributed to any ad/adset/campaign by the resolver.
      const orphans = []
      let orphanRev = 0, orphanCash = 0
      for (const r of closeRows) {
        if (r.attribution_source === 'orphan') {
          orphans.push(r)
          orphanRev  += parseFloat(r.revenue || 0)
          orphanCash += parseFloat(r.cash_collected || 0)
        }
      }
      setOrphanCloses({ count: orphans.length, revenue: orphanRev, cash: orphanCash, rows: orphans })

      // GHL-side standalone maps still feed extract's Math.max() / orphan
      // detection paths. Counts are NOT deduped here because the union
      // dedupe already happened in mapsLead/mapsBooked/mapsLive above —
      // these per-source maps survive only for callers that need to know
      // "how many rows did GHL contribute at this scope" (the dataIssues
      // banner + attribution gap displays). They no longer drive any
      // row-level cell math.
      const tally = (rows, idKey = 'ad_id', asKey = 'adset_id', cKey = 'utm_campaign') => {
        const a = {}, ads = {}, c = {}
        for (const r of rows) {
          if (r[idKey])  a[r[idKey]]   = (a[r[idKey]]   || 0) + 1
          if (r[asKey])  ads[r[asKey]] = (ads[r[asKey]] || 0) + 1
          if (r[cKey])   c[r[cKey]]    = (c[r[cKey]]    || 0) + 1
        }
        return [a, ads, c]
      }
      const [gLeadAd, gLeadAdset, gLeadCamp]     = tally(ghlLeadRows)
      const [gBookAd, gBookAdset, gBookCamp]     = tally(ghlBookedRows)
      const [gLiveAd, gLiveAdset, gLiveCamp]     = tally(ghlLiveRows)
      setGhlBookedAd(gBookAd); setGhlBookedAdset(gBookAdset); setGhlBookedCampaign(gBookCamp)
      setGhlLivesAd(gLiveAd);  setGhlLivesAdset(gLiveAdset);  setGhlLivesCampaign(gLiveCamp)
      setGhlLeadsAd(gLeadAd)
      setGhlLeadsAdset(gLeadAdset)
      setGhlLeadsCampaign(gLeadCamp)

    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  // Mount: fetch all date-invariant data once, then the date-scoped load.
  useEffect(() => { (async () => { await loadStatic(); await load() })() }, [])
  // Subsequent date-range changes only re-run the date-scoped load.
  useEffect(() => {
    if (!adsCacheRef.data) return  // first mount path handled above
    load()
  }, [dateRange.startStr, dateRange.endStr])

  // Live updates: when the background Meta status sync (15-min cadence)
  // completes, blow away the 5-minute in-memory ads cache and re-fetch.
  // Without this, the page kept showing "8/8 ACTIVE" for ads Ben had
  // paused in Meta because the cached `ads` list was older than the
  // status row in the DB. Triggers ONLY on a fresh metaAdStatus
  // timestamp — not on every sync's notify().
  useEffect(() => {
    let lastSeen = getLastSyncTime('metaAdStatus') || 0
    const unsub = subscribeSyncStatus(() => {
      const t = getLastSyncTime('metaAdStatus') || 0
      if (t > lastSeen) {
        lastSeen = t
        adsCacheRef.data = null  // force loadStatic to re-fetch from DB
        adsCacheRef.ts = 0
        ;(async () => { await loadStatic(); await load() })()
      }
    })
    return unsub
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        campaigns.set(cid, {
          id: cid, name: cname,
          ad_sets: new Map(),
          rollup: emptyRollup(),
          activeAdCount: 0, totalAdCount: 0,
          // attrBookedCounts[attr][value] = sum(booked) of ads in this campaign with that value.
          // Used to compute the leading value per attribute on the campaign row.
          attrBookedCounts: {},
        })
      }
      const camp = campaigns.get(cid)

      const asid = a.adset_id || 'no-adset'
      const asname = a.adset_name || 'Untitled ad set'
      if (!camp.ad_sets.has(asid)) {
        camp.ad_sets.set(asid, { id: asid, name: asname, ads: [], rollup: emptyRollup(), activeAdCount: 0, totalAdCount: 0 })
      }
      const adset = camp.ad_sets.get(asid)

      const adRollup = adRollupFrom(a, stats, hyros, tfAd, closeAd, ghlLeadsAd, ghlBookedAd, ghlLivesAd)
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

      // Attribute roll-up: for each tagged ad, attribute booked-count to
      // each of its attribute values. After the loop the campaign's
      // attrBookedCounts maps attr → { value: booked_total }; we then
      // pick the value with max booked as the campaign's leader for that
      // dimension. Booked is the right denominator (CPB matters; raw
      // count is noise once an ad never books).
      const attrs = attrsByAd[a.ad_id]
      const booked = Number(adRollup.tfBooked) || 0
      if (attrs && booked > 0) {
        for (const dim of ['hook_type', 'message_frame', 'mechanism_reveal', 'pain_angle', 'proof_character']) {
          const v = attrs[dim]
          if (!v || v === 'none') continue
          if (!camp.attrBookedCounts[dim]) camp.attrBookedCounts[dim] = {}
          camp.attrBookedCounts[dim][v] = (camp.attrBookedCounts[dim][v] || 0) + booked
        }
      }
    }

    // For every campaign, reduce attrBookedCounts into a `topAttrs`
    // object: { hook_type: 'diagnostic', pain_angle: 'tpa_referral_dep', … }
    // The CampaignBlock renders these as ValueChips inline.
    for (const camp of campaigns.values()) {
      const top = {}
      for (const dim in camp.attrBookedCounts) {
        let bestValue = null; let bestBooked = 0
        for (const value in camp.attrBookedCounts[dim]) {
          if (camp.attrBookedCounts[dim][value] > bestBooked) {
            bestBooked = camp.attrBookedCounts[dim][value]
            bestValue = value
          }
        }
        if (bestValue) top[dim] = { value: bestValue, booked: bestBooked }
      }
      camp.topAttrs = top
    }

    // Overlay ad-set + campaign-level Typeform numbers (catches leads
    // where utm_content didn't match a specific ad name but utm_term
    // or utm_campaign did). Also overlay unified close attribution at
    // each parent level so HYROS-attributed closes (Shain Mann, Jeff
    // Stovall, etc) flow up correctly even when the closer_call had no
    // typeform behind it.
    // Overlay all parent-level counts. MAX of bottom-up sum vs view value
    // for each metric. Payment revenue is overlaid SUM-style because each
    // payment maps to one ad already; the parent should sum its children.
    const overlayMax = (target, val, field) => { if (val > (target[field] || 0)) target[field] = val }
    for (const camp of campaigns.values()) {
      for (const set of camp.ad_sets.values()) {
        const tf = tfAdset[set.id]
        if (tf) overlayTypeformIfHigher(set.rollup, tf)
        const cs = closeAdset[set.id]
        if (cs) overlayClose(set.rollup, cs)
        overlayMax(set.rollup, ghlLeadsAdset[set.id]  || 0, 'tfLeads')
        overlayMax(set.rollup, ghlBookedAdset[set.id] || 0, 'tfBooked')
        overlayMax(set.rollup, ghlLivesAdset[set.id]  || 0, 'tfLive')
      }
      const tfc = tfCampaign[camp.name]
      if (tfc) overlayTypeformIfHigher(camp.rollup, tfc)
      const cc = closeCampaign[camp.name]
      if (cc) overlayClose(camp.rollup, cc)
      overlayMax(camp.rollup, ghlLeadsCampaign[camp.name]  || 0, 'tfLeads')
      overlayMax(camp.rollup, ghlBookedCampaign[camp.name] || 0, 'tfBooked')
      overlayMax(camp.rollup, ghlLivesCampaign[camp.name]  || 0, 'tfLive')
    }

    // Parse advanced numeric filters once.
    const num = (v) => (v === '' || v == null ? null : parseFloat(v))
    const f = {
      spendMin:  num(advFilter.spendMin),  spendMax:  num(advFilter.spendMax),
      leadsMin:  num(advFilter.leadsMin),  leadsMax:  num(advFilter.leadsMax),
      closesMin: num(advFilter.closesMin), closesMax: num(advFilter.closesMax),
      showMin:   num(advFilter.showMin),   showMax:   num(advFilter.showMax),
      cacMin:    num(advFilter.cacMin),    cacMax:    num(advFilter.cacMax),
    }
    const passesAdv = (r) => {
      if (f.spendMin  != null && (r.spend || 0) < f.spendMin)  return false
      if (f.spendMax  != null && (r.spend || 0) > f.spendMax)  return false
      if (f.leadsMin  != null && (r.tfLeads || 0) < f.leadsMin)  return false
      if (f.leadsMax  != null && (r.tfLeads || 0) > f.leadsMax)  return false
      if (f.closesMin != null && (r.tfCloses || 0) < f.closesMin) return false
      if (f.closesMax != null && (r.tfCloses || 0) > f.closesMax) return false
      const showPct = r.tfBooked > 0 ? (r.tfLive / r.tfBooked) * 100 : 0
      if (f.showMin   != null && showPct < f.showMin) return false
      if (f.showMax   != null && showPct > f.showMax) return false
      const cac = r.tfCloses > 0 ? r.spend / r.tfCloses : Infinity
      if (f.cacMin    != null && cac < f.cacMin) return false
      if (f.cacMax    != null && cac > f.cacMax && cac !== Infinity) return false
      // For "max CAC" with finite limit, a campaign with no closes (cac=Infinity) should be excluded.
      if (f.cacMax    != null && cac === Infinity) return false
      return true
    }

    // Now apply the status filter at each level. CRITICAL: rebuild the
    // adset + campaign rollups from the FILTERED ads so totals.spend
    // (and every other top-tile metric derived from `tree`) reflects
    // only the visible-status ads. Prior version kept the pre-filter
    // rollup, so switching to 'PAUSED' or 'All' silently included
    // active-ad spend in the totals — what looked like a $100k spike
    // was actually the totals double-counting the active ads' spend
    // while the table only showed paused ads.
    const visibleCampaigns = []
    for (const camp of campaigns.values()) {
      const visibleSets = []
      const campVisibleRollup = emptyRollup()
      for (const set of camp.ad_sets.values()) {
        let ads = set.ads
        if (statusFilter === 'ACTIVE') ads = ads.filter(x => x.isActive)
        else if (statusFilter === 'PAUSED') ads = ads.filter(x => !x.isActive)
        if (!ads.length) continue
        // Rebuild set rollup from filtered ads.
        const setVisibleRollup = emptyRollup()
        for (const a of ads) addRollup(setVisibleRollup, a.rollup)
        // Re-apply parent overlays (typeform / close / GHL) so adset +
        // campaign cells continue to show deduped union counts that
        // include leads/bookings attributed via utm_term / utm_campaign
        // (not directly to an ad). Overlays overwrite — same semantics
        // as the pre-filter build.
        const tf = tfAdset[set.id]
        if (tf) overlayTypeformIfHigher(setVisibleRollup, tf)
        const cs = closeAdset[set.id]
        if (cs) overlayClose(setVisibleRollup, cs)
        const overlayMax = (target, val, field) => { if (val > (target[field] || 0)) target[field] = val }
        overlayMax(setVisibleRollup, ghlLeadsAdset[set.id]  || 0, 'tfLeads')
        overlayMax(setVisibleRollup, ghlBookedAdset[set.id] || 0, 'tfBooked')
        overlayMax(setVisibleRollup, ghlLivesAdset[set.id]  || 0, 'tfLive')
        addRollup(campVisibleRollup, setVisibleRollup)
        visibleSets.push({ ...set, rollup: setVisibleRollup, ads })
      }
      if (!visibleSets.length) continue
      // Re-apply campaign overlays on the filtered campaign rollup.
      const tfc = tfCampaign[camp.name]
      if (tfc) overlayTypeformIfHigher(campVisibleRollup, tfc)
      const cc = closeCampaign[camp.name]
      if (cc) overlayClose(campVisibleRollup, cc)
      const overlayMax2 = (target, val, field) => { if (val > (target[field] || 0)) target[field] = val }
      overlayMax2(campVisibleRollup, ghlLeadsCampaign[camp.name]  || 0, 'tfLeads')
      overlayMax2(campVisibleRollup, ghlBookedCampaign[camp.name] || 0, 'tfBooked')
      overlayMax2(campVisibleRollup, ghlLivesCampaign[camp.name]  || 0, 'tfLive')
      // Advanced filter runs at the filtered campaign rollup.
      if (!passesAdv(campVisibleRollup)) continue
      const compareAds = (a, b) => sortCompare(a.rollup, b.rollup, sortKey, sortDir)
      for (const s of visibleSets) s.ads.sort(compareAds)
      const compareSets = (a, b) => sortCompare(a.rollup, b.rollup, sortKey, sortDir)
      visibleSets.sort(compareSets)
      // Hide ONLY truly-empty campaigns (no spend, no leads, no
      // bookings, no lives, no closes). Previously this filter was
      // tighter (spend OR leads only) which hid campaigns whose old
      // leads were still booking — and then the top tile said "80
      // booked" while the visible rows summed to ~49 because 29
      // bookings lived in hidden rows. Broaden the filter so any
      // attributed activity keeps the row visible, and the math at
      // the top reconciles with the rows.
      const hasActivity =
        (campVisibleRollup.spend     || 0) > 0 ||
        (campVisibleRollup.tfLeads   || 0) > 0 ||
        (campVisibleRollup.tfBooked  || 0) > 0 ||
        (campVisibleRollup.tfLive    || 0) > 0 ||
        (campVisibleRollup.tfCloses  || 0) > 0
      if (!hasActivity && !search.trim()) continue
      visibleCampaigns.push({ ...camp, rollup: campVisibleRollup, ad_sets_sorted: visibleSets })
    }
    const compareCamps = (a, b) => sortCompare(a.rollup, b.rollup, sortKey, sortDir)
    visibleCampaigns.sort(compareCamps)
    return visibleCampaigns
  }, [ads, stats, hyros, attrsByAd, tfAd, tfAdset, tfCampaign, closeAd, closeAdset, closeCampaign, ghlLeadsAd, ghlLeadsAdset, ghlLeadsCampaign, ghlBookedAd, ghlBookedAdset, ghlBookedCampaign, ghlLivesAd, ghlLivesAdset, ghlLivesCampaign, statusFilter, search, sortKey, sortDir, advFilter])

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
    <div style={{
      // Desktop: break out of Layout's md:px-8 gutter so the wide table
      // gets full-viewport width. Mobile: stay within the layout — the
      // negative margins would leave the table hanging off-screen.
      margin: isMobile ? 0 : '-16px -32px -40px -32px',
      padding: isMobile ? 0 : '16px 24px',
      // Allow horizontal scroll on the page itself if anything overflows.
      overflowX: 'auto',
    }}>
      {/* Header */}
      <SectionHead
        level="page"
        eyebrow="Ads · Performance"
        title="Performance"
        tagline={`${tree.length} campaigns · last 30 days · click rows to expand.`}
        gap={20}
        right={
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={expandAll} style={btnGhost}>Expand all</button>
            <button onClick={collapseAll} style={btnGhost}>Collapse</button>
          </div>
        }
      />

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

      {/* Per-query failure banner — visible whenever any of the parallel
          fetches threw. Without this, a missing view or a column name typo
          silently zeros a KPI and the rest of the page looks fine. */}
      {dataIssues.length > 0 && (
        <div style={{
          padding: '10px 14px',
          background: 'rgba(180, 30, 30, 0.07)',
          border: '1px solid #b41e1e',
          borderLeftWidth: 3,
          borderRadius: '0 3px 3px 0',
          marginBottom: 8,
          fontSize: 13,
        }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#7d1a1a', fontWeight: 600, marginBottom: 4 }}>
            Data source error · {dataIssues.length} of 7 queries failed
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink)' }}>
            {dataIssues.map((m, i) => <li key={i} style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{m}</li>)}
          </ul>
        </div>
      )}

      {/* Totals strip — Live and Closes now drive from the SAME source the
          Marketing dashboard uses: useCloserCallProspectMetrics (unique
          prospects from closer_calls per-call truth). $/Live and CAC
          divide spend by these so they equal MarketingPerformance's
          cost_per_new_live_call and cpa_trial exactly. Leads and Booked
          continue to use the attribution-based union (typeform + GHL)
          because closer_calls has no ad attribution above the close
          event — that's the only available source. Sub-line below each
          tile explains the gap between closer-reported truth and
          ad-attributed coverage. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: '14px 16px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 8 }}>
        <TotalsTile label="Spend" value={fmt$(totals.spend)} />
        {(() => {
          const eod = rowTotals.eod, attr = rowTotals.attributed, prosp = rowTotals.prospects
          // Single source of truth for Live and Closes — closer_calls
          // deduped by prospect_name. Same hook MarketingPerformance uses
          // via applyProspectMetrics() so numbers reconcile cross-page.
          const pm = prospectMetricsByRange({ from: dateRange.startStr, to: dateRange.endStr })
          const liveCount   = pm.liveProspects
          const closesCount = pm.closedProspects
          // Sub-line reconciles three numbers: EOD self-report, the unique
          // prospects we have records for (= headline + drilldown count),
          // and how many of those we attributed to a Meta ad.
          const sub = (eodVal, prospVal, attrVal, extra = '') => {
            const parts = []
            if (eodVal > 0 && eodVal !== prospVal) parts.push(`${fmtN(eodVal)} EOD-reported`)
            if (attrVal !== prospVal)               parts.push(`${fmtN(attrVal)} attributed`)
            else if (attrVal > 0)                   parts.push(`all attributed`)
            return parts.length ? parts.join(' · ') + extra : null
          }
          const closeSub = sub(eod.closes, closesCount, attr.closes, eod.revenue > 0 ? ` · ${fmt$(eod.revenue)} rev` : '')
          const liveSub  = sub(eod.live,  liveCount,   attr.live)
          const click = (metric) => () => setDrill({ metric, scope: { level: 'all' } })
          // Headline tile values are now SUM-OF-VISIBLE-ROWS so the top
          // tile always equals the sum of the table below. Previously
          // the top used the global deduped union count (e.g. "80 booked")
          // while rows summed to 49 because some bookings live on
          // hidden/orphan rows — looks like a counting bug to the user
          // even though both numbers are correct in isolation.
          //
          // Sub-line still surfaces the global universe count + EOD self-
          // report + attributed total so the gap is visible. Drilldown
          // still queries the global universe so clicking a top tile
          // shows ALL prospects, not just the attributed subset.
          const visibleLeads  = totals.tfLeads  || 0
          const visibleBooked = totals.tfBooked || 0
          const visibleLive   = totals.tfLive   || 0
          const visibleCloses = totals.tfCloses || 0
          // Show "N global unique" when the visible sum differs (cross-
          // campaign prospects only count once globally but in each
          // campaign here; orphan bookings are global but not in rows).
          const subRows = (eodVal, visibleVal, globalVal, extra = '') => {
            const parts = []
            if (eodVal > 0)                       parts.push(`${fmtN(eodVal)} EOD-reported`)
            if (globalVal && globalVal !== visibleVal) parts.push(`${fmtN(globalVal)} unique total`)
            return parts.length ? parts.join(' · ') + extra : null
          }
          const tipProspect = 'Sum of every visible campaign-row attribution in this window. Drilldown queries the global universe so the panel may list more prospects than this count (cross-campaign dedup) — the panel header explains the math.'
          const tipLive   = 'Sum of every visible row\'s Live count. Source: typeform is_live ∪ ghl_lives ∪ closes (a close implies a live). Compare with the closer-EOD self-reported count in the subtitle.'
          const tipCloses = 'Sum of every visible row\'s Close count. Source: lib_close_resolved ∪ typeform is_closed. Compare with the closer-EOD count.'
          return (
            <>
              <TotalsTile label="Leads"      value={fmtN(visibleLeads)}  sub={subRows(eod.leads,  visibleLeads,  prosp.leads)}  onClick={click('leads')}  tip={tipProspect} />
              <TotalsTile label="Booked"     value={fmtN(visibleBooked)} sub={subRows(eod.booked, visibleBooked, prosp.booked)} onClick={click('booked')} tip={tipProspect} />
              <TotalsTile label="Live calls" value={fmtN(visibleLive)}   sub={subRows(eod.live,   visibleLive,   liveCount)}    onClick={click('live')}   tip={tipLive} />
              <TotalsTile
                label="Closes"
                value={fmtN(visibleCloses)}
                sub={subRows(eod.closes, visibleCloses, closesCount, eod.revenue > 0 ? ` · ${fmt$(eod.revenue)} rev` : '')}
                valueColor={visibleCloses > 0 ? '#1f7a3a' : undefined}
                onClick={click('closed')}
                tip={tipCloses}
              />
            </>
          )
        })()}
        {(() => {
          // Cost-per tiles divide spend by the ATTRIBUTED denominator —
          // same universe the per-campaign rows use. Previously this
          // divided by the deduped union count (typeform ∪ GHL, regardless
          // of ad attribution), giving e.g. $4.40k / 80 = $55 per Booked
          // at the top while the rows showed $135 / $198 / $192 because
          // the rows only see ad-attributed bookings (~29). Ben saw $55
          // up top and $135+ in the rows and rightly called bullshit.
          //
          // Now: top tile cost-per uses rowTotals.attributed, so the math
          // reconciles end to end. The COUNT tile keeps showing the union
          // (the truer "how many leads/bookings happened" number) but the
          // cost number divides by the same denominator the rows divide
          // by. Sub-text shows both so the gap is visible.
          // Cost-per tiles divide by the SAME visible-sum totals the
          // count tiles use. spend / leads / booked / live / closes all
          // come from `totals` (= sum of visible rows). The math now
          // reconciles end-to-end: top tile $/X exactly equals
          // total_spend ÷ (sum of per-row X).
          const vLeads  = totals.tfLeads  || 0
          const vBooked = totals.tfBooked || 0
          const vLive   = totals.tfLive   || 0
          const vCloses = totals.tfCloses || 0
          return (
            <>
              <TotalsTile
                label="$ / Lead"
                value={vLeads > 0 ? fmt$(totals.spend / vLeads) : '—'}
                valueColor={kpiColor(vLeads > 0 ? totals.spend / vLeads : null, KPI.costPerLead)}
                tip={`${fmt$(totals.spend)} spend ÷ ${vLeads} leads = sum of visible rows' $/Lead.`}
              />
              <TotalsTile
                label="$ / Booked"
                value={vBooked > 0 ? fmt$(totals.spend / vBooked) : '—'}
                valueColor={kpiColor(vBooked > 0 ? totals.spend / vBooked : null, KPI.costPerQualBooked)}
                tip={`${fmt$(totals.spend)} spend ÷ ${vBooked} bookings = sum of visible rows' $/Book.`}
              />
              <TotalsTile
                label="$ / Live"
                value={vLive > 0 ? fmt$(totals.spend / vLive) : '—'}
                valueColor={kpiColor(vLive > 0 ? totals.spend / vLive : null, KPI.costPerLive)}
                tip={`${fmt$(totals.spend)} spend ÷ ${vLive} live calls.`}
              />
              <TotalsTile
                label="CAC"
                value={vCloses > 0 ? fmt$(totals.spend / vCloses) : '—'}
                sub={vCloses > 0 ? `${fmt$(totals.spend)} ÷ ${vCloses} closes` : null}
                valueColor={kpiColor(vCloses > 0 ? totals.spend / vCloses : null, KPI.costPerClose)}
                tip={`${fmt$(totals.spend)} spend ÷ ${vCloses} closes.`}
              />
            </>
          )
        })()}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginBottom: 16, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        <LegendDot color="#1f7a3a" arrow="down" label="Under target" />
        <LegendDot color="#b88714" label="Borderline" />
        <LegendDot color="#b41e1e" arrow="up" label="Over target" />
        <span style={{ color: 'var(--ink-4)' }}>Targets editable in code · KPI block</span>
      </div>

      {/* Inline filter bar — everything visible at once, no drawer */}
      <div style={{ padding: '12px 16px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 8 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginBottom: 12 }}>
          <ChipGroup label="Range" value={dateRange.preset}
            setValue={(v) => setDateRange(v === 'custom' ? { ...dateRange, preset: 'custom' } : rangeFromPreset(v))}
            options={[{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }, { value: 'all', label: '2y' }, { value: 'custom', label: 'Custom' }]} />
          {dateRange.preset === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <EditorialDate value={dateRange.startStr} max={dateRange.endStr}
                onChange={(v) => setDateRange({ ...dateRange, preset: 'custom', startStr: v })} compact />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>→</span>
              <EditorialDate value={dateRange.endStr} min={dateRange.startStr}
                onChange={(v) => setDateRange({ ...dateRange, preset: 'custom', endStr: v })} compact />
            </div>
          )}
          <ChipGroup label="Status" value={statusFilter} setValue={setStatusFilter} options={STATUS_OPTIONS} />
          <button onClick={() => {
            setStatusFilter('ACTIVE'); setDateRange(rangeFromPreset('30'))
            setSortKey('spend'); setSortDir('desc')
            setAdvFilter({ spendMin:'',spendMax:'',leadsMin:'',leadsMax:'',closesMin:'',closesMax:'',showMin:'',showMax:'',cacMin:'',cacMax:'' })
          }} style={{ ...btnGhost, padding: '5px 12px', fontSize: 10, marginLeft: 'auto' }}>Reset all</button>
        </div>
        {/* Numeric range filters always visible — one row of compact inputs */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10,
          paddingTop: 12,
          borderTop: '1px solid var(--rule)',
        }}>
          <RangeFilter label="Spend ($)"     valueMin={advFilter.spendMin}  valueMax={advFilter.spendMax}
            onMin={v => setAdvFilter({ ...advFilter, spendMin: v })}  onMax={v => setAdvFilter({ ...advFilter, spendMax: v })} />
          <RangeFilter label="Leads"         valueMin={advFilter.leadsMin}  valueMax={advFilter.leadsMax}
            onMin={v => setAdvFilter({ ...advFilter, leadsMin: v })}  onMax={v => setAdvFilter({ ...advFilter, leadsMax: v })} />
          <RangeFilter label="Closes"        valueMin={advFilter.closesMin} valueMax={advFilter.closesMax}
            onMin={v => setAdvFilter({ ...advFilter, closesMin: v })} onMax={v => setAdvFilter({ ...advFilter, closesMax: v })} />
          <RangeFilter label="Show rate %"   valueMin={advFilter.showMin}   valueMax={advFilter.showMax}
            onMin={v => setAdvFilter({ ...advFilter, showMin: v })}   onMax={v => setAdvFilter({ ...advFilter, showMax: v })} />
          <RangeFilter label="CAC ($)"       valueMin={advFilter.cacMin}    valueMax={advFilter.cacMax}
            onMin={v => setAdvFilter({ ...advFilter, cacMin: v })}    onMax={v => setAdvFilter({ ...advFilter, cacMax: v })} />
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
                <Th right w={65}  sortKey="showRate"    activeSort={sortKey} sortDir={sortDir} onSort={setSort}>Show %</Th>
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

      {drill && <ProspectDrillModal drill={drill} dateRange={dateRange} ads={ads} onClose={() => setDrill(null)} />}
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
          {/* Per-campaign winning attribute chips — the leading value for
              each dimension by booked-call volume within this CBO. Only
              shows when there are tagged ads producing booked calls. */}
          {camp.topAttrs && Object.keys(camp.topAttrs).length > 0 && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 4,
              marginTop: 6, marginLeft: 30,
            }}>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)',
                letterSpacing: '0.06em', textTransform: 'uppercase',
                alignSelf: 'center', marginRight: 4,
              }}>Winning</span>
              {[
                ['hook_type',        camp.topAttrs.hook_type],
                ['message_frame',    camp.topAttrs.message_frame],
                ['mechanism_reveal', camp.topAttrs.mechanism_reveal],
                ['pain_angle',       camp.topAttrs.pain_angle],
                ['proof_character',  camp.topAttrs.proof_character],
              ].filter(([_, v]) => v).map(([attr, v]) => (
                <ValueChip key={attr} attr={attr} value={v.value} size="xs" />
              ))}
            </div>
          )}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 36 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-4)' }}>↳</span>
            {open ? <ChevronDown size={12} style={{ color: 'var(--ink-3)' }} /> : <ChevronRight size={12} style={{ color: 'var(--ink-3)' }} />}
            <StatusDot active={anyActive} size={7} />
            <span style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic', fontWeight: 400 }}>
              {set.name}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)', letterSpacing: '0.1em', marginLeft: 6 }}>
              {set.activeAdCount}/{set.totalAdCount} ACTIVE · {set.ads.length} SHOWN · ⊂ part of parent campaign
            </span>
          </div>
        </Td>
        <RollupCells rollup={set.rollup} scope={adsetScope} onDrill={onDrill} muted />
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
      <ShowRateCell live={rollup.tfLive} booked={rollup.tfBooked} bold={bold} muted={muted} />
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

function TotalsTile({ label, value, sub, valueColor, onClick, tip }) {
  const clickable = typeof onClick === 'function'
  return (
    <div
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      title={tip || undefined}
      style={{
        cursor: clickable ? 'pointer' : 'default',
        padding: clickable ? '2px 4px' : 0,
        margin: clickable ? '-2px -4px' : 0,
        borderRadius: 3,
        transition: 'background 0.12s',
      }}
      onMouseEnter={clickable ? (e) => { e.currentTarget.style.background = 'rgba(244,225,74,0.10)' } : undefined}
      onMouseLeave={clickable ? (e) => { e.currentTarget.style.background = 'transparent' } : undefined}
    >
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 2 }}>
        {label}{clickable && <span style={{ color: 'var(--ink-4)', marginLeft: 4 }}>↗</span>}
        {tip && <span style={{ color: 'var(--ink-4)', marginLeft: 4, cursor: 'help' }}>ⓘ</span>}
      </div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, color: valueColor || 'var(--ink)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)', letterSpacing: '0.08em', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// Helpers for the Filters drawer.
function activeFilterCount({ statusFilter, dateRange, advFilter }) {
  let n = 0
  if (statusFilter !== 'ACTIVE') n++
  if (dateRange.preset !== '30') n++
  for (const v of Object.values(advFilter)) if (v !== '' && v != null) n++
  return n
}
function advFilterLabel(k) {
  const map = { spendMin:'Spend ≥', spendMax:'Spend ≤', leadsMin:'Leads ≥', leadsMax:'Leads ≤',
    closesMin:'Closes ≥', closesMax:'Closes ≤', showMin:'Show % ≥', showMax:'Show % ≤',
    cacMin:'CAC ≥', cacMax:'CAC ≤' }
  return map[k] || k
}
function ActiveFilterPill({ label, onClear }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '4px 8px 4px 10px',
      background: 'var(--accent-soft, rgba(244,225,74,0.18))',
      border: '1px solid var(--accent)',
      borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em', color: 'var(--ink)',
    }}>
      {label}
      <button onClick={onClear} aria-label="Remove" style={{
        background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink-3)',
        padding: 0, marginLeft: 2, fontFamily: 'inherit', fontSize: 12, lineHeight: 1,
      }}>×</button>
    </span>
  )
}
function FilterSection({ title, subtitle, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {subtitle && <div style={{ fontFamily: 'var(--serif)', fontSize: 12, color: 'var(--ink-3)', marginBottom: 10, fontStyle: 'italic' }}>{subtitle}</div>}
      {children}
    </div>
  )
}

// Two number inputs for min / max range filters. Empty = no filter applied.
function RangeFilter({ label, valueMin, valueMax, onMin, onMax }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4, fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input type="number" min="0" value={valueMin} onChange={e => onMin(e.target.value)} placeholder="min"
          style={{ width: '100%', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: '5px 7px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)', outline: 'none' }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)' }}>→</span>
        <input type="number" min="0" value={valueMax} onChange={e => onMax(e.target.value)} placeholder="max"
          style={{ width: '100%', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: '5px 7px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)', outline: 'none' }} />
      </div>
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
function adRollupFrom(ad, stats, hyros, tfAd, closeAd /* , ghlLeadsAd, ghlBookedAd, ghlLivesAd */) {
  // Unused params (g/gB/gL) kept positional for backwards-compat with the
  // call site but no longer consulted — every prospect-deduped count now
  // lives directly on tfAd[ad.ad_id] (built upstream as union of typeform +
  // GHL + lib_close_resolved at this exact scope). The prior Math.max()
  // and `c.closes || t.closes` heuristics were the source of the row-vs-
  // drilldown drift Ben hit (e.g. row showed 1 close because lib_close_
  // resolved had 1 row, while drilldown unioned in an unresolved typeform
  // close and showed 2).
  const s = stats[ad.ad_id] || {}
  const h = hyros[ad.ad_id] || {}
  const t = tfAd[ad.ad_id] || {}
  const c = closeAd[ad.ad_id] || {}
  return {
    spend: s.spend || 0,
    leads: s.results || 0,
    booked: h.calls_attributed || 0,
    qualified: h.calls_qualified || 0,
    revenue: parseFloat(h.revenue_attributed || 0),
    // Prospect-deduped counts: a single source-of-truth that matches the
    // drilldown panel one-for-one. No MAX, no ||fallback.
    tfLeads:      t.leads || 0,
    tfQualLeads:  t.qualified_leads || 0,
    tfBooked:     t.booked_calls || 0,
    tfQualBooked: t.qualified_booked_calls || 0,
    tfLive:       t.live_calls || 0,
    tfCloses:     t.closes || 0,
    // Revenue + cash come from the close union (lib_close_resolved wins,
    // typeform fallback for unresolved). c.revenue/c.cash are folded into
    // t.revenue_attributed/t.cash_attributed upstream; keep the c.* path
    // as a redundant cross-check.
    tfRevenue:    parseFloat(t.revenue_attributed || c.revenue || 0),
    tfCash:       parseFloat(t.cash_attributed    || c.cash    || 0),
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
// Replace (not max!) the bottom-up sums with the parent-level deduped
// counts. Bottom-up summing double-counts any prospect that attributes to
// multiple child ads in the same parent — e.g. ad1 has prospects {A,B},
// ad2 has prospects {B,C}, child sum = 4, true adset dedupe = 3. The
// prior overlay-if-higher logic kept the inflated sum; this replacement
// forces the parent to match the per-scope deduped map (= what the
// drilldown shows when clicked on the parent row).
function overlayClose(target, cRow) {
  // Always overwrite — cRow is built upstream as the prospect-deduped
  // close count + summed revenue/cash for unique prospects at this scope.
  target.tfCloses  = cRow.closes  || 0
  target.tfRevenue = cRow.revenue || 0
  target.tfCash    = cRow.cash    || 0
}

function overlayTypeformIfHigher(target, tfRow) {
  // Despite the historical name, this no longer compares — it OVERWRITES.
  // tfRow comes from the parent-level deduped map; child bottom-up sums
  // double-count any prospect that spans multiple child ads.
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
    target[t] = parseFloat(tfRow[s] || 0)
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
    case 'showRate':      return r.tfBooked > 0 ? (r.tfLive || 0) / r.tfBooked : 0
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

// ── Drill-down helpers ──────────────────────────────────────────────
// PostgREST .or() treats `,` `(` `)` `.` and unquoted whitespace as syntax.
// Campaign names like "SCIO -Restoration - Application - 4/22 - New Videos"
// contain dashes, slashes, and spaces — wrap in double-quotes and escape
// internal backslashes/quotes so the value survives both PostgREST parsing
// and supabase-js URL encoding. encodeURIComponent here would double-encode
// (supabase-js re-encodes the full filter string).
function pgQuote(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Generic scope filter — every drilldown query applies the same OR-pattern
// so a campaign-scoped drill catches rows by utm_campaign string match OR
// adset_id.in OR ad_id.in (covers Meta rename drift + attribution gaps).
// `cols` maps logical scope levels to the actual column names in the
// queried table (e.g. lib_close_resolved uses `resolved_ad_id` instead of
// `ad_id`).
function applyDrillScope(q, scope, cols) {
  if (!scope) return q
  if (scope.level === 'ad') return q.eq(cols.ad, scope.id)
  if (scope.level === 'adset') {
    const adIds = scope.adIds || []
    // pgQuote on adset.eq is defensive — Meta adset IDs are numeric so
    // they're safe today, but if we ever store a non-numeric adset_id
    // (e.g., synthetic groupings) the raw interpolation would break
    // .or() parsing. Same shape as the campaign branch below.
    if (adIds.length > 0) return q.or(`${cols.adset}.eq.${pgQuote(scope.id)},${cols.ad}.in.(${adIds.join(',')})`)
    return q.eq(cols.adset, scope.id)
  }
  if (scope.level === 'campaign') {
    const ors = []
    if (scope.id)                              ors.push(`${cols.campaign}.eq.${pgQuote(scope.id)}`)
    if ((scope.adsetIds || []).length)         ors.push(`${cols.adset}.in.(${scope.adsetIds.join(',')})`)
    if ((scope.adIds    || []).length)         ors.push(`${cols.ad}.in.(${scope.adIds.join(',')})`)
    if (ors.length) return q.or(ors.join(','))
  }
  return q
}

// Name-token key for cross-table dedupe (lib_close_resolved and
// lib_ghl_lives_detail expose `clean_name` / `prospect_name` / `display_name`
// but NOT `email` — using email here would silently dedupe nothing and
// double-count every prospect that appears in both sources). Lowercases
// and joins first two tokens — same heuristic the resolver views use.
function nameKey(row) {
  const raw = (row.clean_name || row.prospect_name || row.display_name || row.email || '').toString().toLowerCase().trim()
  if (!raw) return ''
  const parts = raw.split(/\s+/).filter(Boolean)
  return parts.slice(0, 2).join(' ')
}

// Column maps per table — lets applyDrillScope work uniformly.
const SCOPE_COLS_TYPEFORM = { ad: 'ad_id',          adset: 'adset_id',          campaign: 'utm_campaign'      }
const SCOPE_COLS_GHL      = { ad: 'ad_id',          adset: 'adset_id',          campaign: 'utm_campaign'      }
const SCOPE_COLS_CLOSE    = { ad: 'resolved_ad_id', adset: 'resolved_adset_id', campaign: 'resolved_campaign' }

async function fetchTypeformDetail(drill, sinceISO, untilISO) {
  let q = supabase.from('lib_typeform_response_detail').select('*')
    .gte('submitted_at', sinceISO).lte('submitted_at', untilISO)
    .order('submitted_at', { ascending: false })
  q = applyDrillScope(q, drill.scope, SCOPE_COLS_TYPEFORM)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data || []
}

async function fetchGhlDetail(drill, sinceISO, untilISO) {
  let q = supabase.from('lib_ghl_leads_detail').select('*')
    .gte('landed_at', sinceISO).lte('landed_at', untilISO)
    .order('landed_at', { ascending: false })
  q = applyDrillScope(q, drill.scope, SCOPE_COLS_GHL)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data || []
}

// Union + dedupe — typeform-side rows win ties (richer columns).
// Dedupe key: email when available on BOTH sides, else fall back to
// first+second name tokens. lib_ghl_lives_detail has no email column,
// so the email-only approach silently double-counted every prospect.
function unionByEmail(tfRows, otherRows, otherKind) {
  const seenEmail = new Set()
  const seenName  = new Set()
  const out = []
  // Single check-and-add path used for BOTH sources. Prior version added
  // tfRows unconditionally then only deduped otherRows, so a typeform
  // submission that appeared twice (e.g. a prospect resubmitting the form)
  // counted twice on the panel while the aggregation deduped to 1 — same
  // row-vs-drilldown drift class Ben hit on closes.
  const tryPush = (r, kind) => {
    const email = (r.email || '').toLowerCase()
    const name  = nameKey(r)
    if (email && seenEmail.has(email)) return
    if (!email && name && seenName.has(name)) return
    if (email) seenEmail.add(email)
    if (name)  seenName.add(name)
    out.push({ kind, ...r })
  }
  for (const r of tfRows)    tryPush(r, 'tf')
  for (const r of otherRows) tryPush(r, otherKind)
  return out.sort((a, b) =>
    (b.submitted_at || b.landed_at || b.created_at || '')
      .localeCompare(a.submitted_at || a.landed_at || a.created_at || ''))
}

// ── Drill-down modal ────────────────────────────────────────────────
// Backs the click-to-see-the-actual-prospects behaviour on any number
// cell in the rollup table. Queries multiple sources (typeform + GHL +
// closer_calls) so every metric pulls from the source that actually has
// the rows. Respects the active date range.
function ProspectDrillModal({ drill, dateRange, ads, onClose }) {
  const [rows, setRows] = useState([])
  const [source, setSource] = useState('typeform')  // 'typeform' | 'closed' | 'ghl' | 'mixed'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Resolution maps — must match the aggregator in AdsPerformance.load()
  // exactly so that drilldown row count == campaign row cell. Without
  // this post-filter, the drilldown's three-tier OR can include rows
  // whose ad_id maps to a DIFFERENT campaign (e.g. Meta moved the ad
  // after the lead came in). See the resolveCampaign comment block
  // in AdsPerformance.load() for the full case analysis.
  const resolution = useMemo(() => {
    const adP = {}, asetP = {}
    const validC = new Set(), validA = new Set()
    for (const a of (ads || [])) {
      adP[a.ad_id] = { adset: a.adset_id, campaign: a.campaign_name }
      if (a.adset_id) asetP[a.adset_id] = { campaign: a.campaign_name }
      if (a.campaign_name) validC.add(a.campaign_name)
      if (a.adset_id)      validA.add(a.adset_id)
    }
    return { adP, asetP, validC, validA }
  }, [ads])
  const rowCampaign = (r) =>
    (r.utm_campaign && resolution.validC.has(r.utm_campaign) ? r.utm_campaign : null) ||
    (r.ad_id && resolution.adP[r.ad_id]?.campaign) ||
    (r.adset_id && resolution.asetP[r.adset_id]?.campaign) ||
    r.utm_campaign
  const rowAdset = (r) =>
    (r.adset_id && resolution.validA.has(r.adset_id) ? r.adset_id : null) ||
    (r.ad_id && resolution.adP[r.ad_id]?.adset) ||
    r.adset_id
  const matchesScope = (r) => {
    if (drill.scope.level === 'all') return true
    if (drill.scope.level === 'ad')   return r.ad_id === drill.scope.id || r.resolved_ad_id === drill.scope.id
    if (drill.scope.level === 'adset')    return rowAdset(r) === drill.scope.id
    if (drill.scope.level === 'campaign') return rowCampaign(r) === drill.scope.id
    return true
  }
  // closer_calls rows have no ad/adset/utm — drilldown at scope='all'
  // already filters them properly. Skip post-filter for the cc kind.
  const postFilter = (list) => list.filter(r => r.kind === 'cc' || r.kind === 'close' || matchesScope(r))

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoading(true); setError(null)
      try {
        // ET-anchored timestamps to match AdsPerformance.load() which
        // queries with `-05:00` offset. Prior `'T00:00:00Z'` was UTC,
        // which carved a different calendar boundary on the east coast
        // — top tile counted Mar 5 ET while drilldown queried Mar 5 UTC.
        const sinceISO = (dateRange?.startStr || '2024-01-01') + 'T00:00:00-05:00'
        const untilISO = (dateRange?.endStr   || '2099-12-31') + 'T23:59:59-05:00'

        // ── CLOSED ─────────────────────────────────────────────────
        // At scope.level === 'all', source-of-truth is closer_calls
        // (outcome = 'closed', call_type IN ('new_call','follow_up') —
        // both NC and FU closes count). Same source the top tile uses
        // via useCloserCallProspectMetrics.closedSet. Prior version
        // queried lib_close_resolved + typeform.is_closed which is a
        // different universe and drifted from the top tile by 1-3 rows
        // whenever HYROS hadn't ingested a close yet.
        //
        // Per-ad / per-adset / per-campaign scope falls back to
        // lib_close_resolved + typeform because closer_calls has no
        // ad attribution at the per-call level.
        if (drill.metric === 'closed') {
          if (drill.scope.level === 'all') {
            setSource('closer_calls')
            const sinceDate = dateRange?.startStr || '2024-01-01'
            const untilDate = dateRange?.endStr   || '2099-12-31'
            const { data: reports, error: rErr } = await supabase
              .from('closer_eod_reports')
              .select('id, report_date')
              .gte('report_date', sinceDate).lte('report_date', untilDate)
            if (rErr) throw new Error(rErr.message)
            const reportIds = (reports || []).map(r => r.id)
            if (!reportIds.length) {
              if (!cancelled) setRows([])
              return
            }
            const allCalls = []
            const PAGE = 1000
            let off = 0
            while (true) {
              const { data, error: ccErr } = await supabase
                .from('closer_calls')
                .select('id, prospect_name, outcome, call_type, revenue, cash_collected, created_at, eod_report_id')
                .in('eod_report_id', reportIds)
                .eq('outcome', 'closed')
                .range(off, off + PAGE - 1)
              if (ccErr) throw new Error(ccErr.message)
              if (!data?.length) break
              allCalls.push(...data)
              if (data.length < PAGE) break
              off += PAGE
            }
            const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ')
            const isPlaceholder = (s) => /^historical close\b/i.test((s || '').trim())
            const seen = new Set()
            const rows = []
            for (const c of allCalls) {
              const k = norm(c.prospect_name)
              if (!k) continue
              if (isPlaceholder(c.prospect_name)) continue
              if (seen.has(k)) continue
              seen.add(k)
              rows.push({ kind: 'cc', ...c })
            }
            rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
            if (!cancelled) setRows(rows)
            return
          }
          // Per-ad/adset/campaign scope: union lib_close_resolved +
          // typeform.is_closed (necessary for ad attribution).
          setSource('closed')
          let qC = supabase.from('lib_close_resolved').select('*')
            .gte('created_at', sinceISO).lte('created_at', untilISO)
            .order('created_at', { ascending: false })
          qC = applyDrillScope(qC, drill.scope, SCOPE_COLS_CLOSE)
          let qT = supabase.from('lib_typeform_response_detail').select('*')
            .eq('is_closed', true)
            .gte('submitted_at', sinceISO).lte('submitted_at', untilISO)
            .order('submitted_at', { ascending: false })
          qT = applyDrillScope(qT, drill.scope, SCOPE_COLS_TYPEFORM)
          const [{ data: cData, error: cErr }, { data: tData, error: tErr }] = await Promise.all([qC, qT])
          if (cErr) throw new Error(cErr.message)
          if (tErr) throw new Error(tErr.message)
          // lib_close_resolved is keyed by closer_call_id, so a prospect
          // with multiple closed closer_calls produces multiple rows —
          // self-dedupe by nameKey.
          const closeSeen = new Set()
          const closeRows = []
          for (const r of (cData || [])) {
            const k = nameKey(r)
            if (k && closeSeen.has(k)) continue
            if (k) closeSeen.add(k)
            closeRows.push({ kind: 'close', ...r })
          }
          const tfRows = (tData || [])
            .filter(r => {
              const k = nameKey(r)
              return !k || !closeSeen.has(k)
            })
            .map(r => ({ kind: 'tf', ...r }))
          const merged = [...closeRows, ...tfRows]
          // Enrich with ad name so the drilldown shows WHICH creative
          // each close came from — even when the ad is paused and
          // doesn't appear in the visible row tree. Batch lookup by
          // ad_id from public.ads.
          const adIdSet = new Set()
          for (const r of merged) {
            const aid = r.resolved_ad_id || r.ad_id
            if (aid) adIdSet.add(aid)
          }
          if (adIdSet.size) {
            const { data: adRows } = await supabase
              .from('ads')
              .select('ad_id, ad_name, adset_name, campaign_name, effective_status')
              .in('ad_id', [...adIdSet])
            const adById = {}
            for (const a of (adRows || [])) adById[a.ad_id] = a
            for (const r of merged) {
              const aid = r.resolved_ad_id || r.ad_id
              const meta = aid ? adById[aid] : null
              if (meta) {
                r._ad_name = meta.ad_name
                r._ad_status = meta.effective_status
                r._adset_name = meta.adset_name
              }
            }
          }
          if (!cancelled) setRows(postFilter(merged).sort((a, b) =>
            (b.created_at || b.submitted_at || '').localeCompare(a.created_at || a.submitted_at || '')))
          return
        }

        // ── BOOKED ─────────────────────────────────────────────────
        // Row count = MAX(typeform is_booked, GHL booked) per the rollup
        // builder. Drilldown unions both sources deduped by email so the
        // visible list matches the count.
        if (drill.metric === 'booked') {
          let qG = supabase.from('lib_ghl_booked_detail').select('*')
            .gte('landed_at', sinceISO).lte('landed_at', untilISO)
            .order('landed_at', { ascending: false })
          qG = applyDrillScope(qG, drill.scope, SCOPE_COLS_GHL)
          let qT = supabase.from('lib_typeform_response_detail').select('*')
            .eq('is_booked', true)
            .gte('submitted_at', sinceISO).lte('submitted_at', untilISO)
            .order('submitted_at', { ascending: false })
          qT = applyDrillScope(qT, drill.scope, SCOPE_COLS_TYPEFORM)
          const [{ data: gData, error: gErr }, { data: tData, error: tErr }] = await Promise.all([qG, qT])
          if (gErr) throw new Error(gErr.message)
          if (tErr) throw new Error(tErr.message)
          const merged = unionByEmail(tData || [], gData || [], 'ghl')
          setSource((tData || []).length && (gData || []).length ? 'mixed' : ((gData || []).length ? 'ghl' : 'typeform'))
          if (!cancelled) setRows(postFilter(merged))
          return
        }

        // ── QUALIFIED BOOKED ───────────────────────────────────────
        // Row count comes ONLY from typeform (is_booked AND qualified) —
        // lib_ghl_booked_detail has no qualification column so the rollup
        // doesn't union it in. Drilldown matches that single source.
        if (drill.metric === 'qual_booked') {
          setSource('typeform')
          let q = supabase.from('lib_typeform_response_detail').select('*')
            .eq('is_booked', true).eq('qualified', true)
            .gte('submitted_at', sinceISO).lte('submitted_at', untilISO)
            .order('submitted_at', { ascending: false })
          q = applyDrillScope(q, drill.scope, SCOPE_COLS_TYPEFORM)
          const { data, error: e } = await q
          if (e) throw new Error(e.message)
          if (!cancelled) setRows(postFilter((data || []).map(r => ({ kind: 'tf', ...r }))))
          return
        }

        // ── LIVE ──────────────────────────────────────────────────
        // Source-of-truth at the "all in window" level: closer_calls
        // (outcome IN closed/not_closed AND call_type='new_call', deduped
        // by prospect_name). Same hook MarketingPerformance and the top
        // tile use via useCloserCallProspectMetrics. Earlier this branch
        // queried lib_ghl_lives_detail + typeform.is_live which gave a
        // DIFFERENT universe (appointments vs closer-self-report) and
        // produced the row-vs-drilldown drift Ben hit (top tile said 20,
        // panel said 15).
        //
        // Per-ad / per-adset / per-campaign scope falls back to the
        // attribution-based union because closer_calls has no ad
        // attribution — that universe only exists in typeform + GHL.
        if (drill.metric === 'live') {
          if (drill.scope.level === 'all') {
            setSource('closer_calls')
            // Date window via closer_eod_reports.report_date so we filter
            // by EOD date, not call.created_at (which can lag if the EOD
            // gets submitted late).
            const sinceDate = dateRange?.startStr || '2024-01-01'
            const untilDate = dateRange?.endStr   || '2099-12-31'
            const { data: reports, error: rErr } = await supabase
              .from('closer_eod_reports')
              .select('id, report_date')
              .gte('report_date', sinceDate).lte('report_date', untilDate)
            if (rErr) throw new Error(rErr.message)
            const reportIds = (reports || []).map(r => r.id)
            if (!reportIds.length) {
              if (!cancelled) setRows([])
              return
            }
            // Page through to bypass PostgREST's 1000-row cap.
            const allCalls = []
            const PAGE = 1000
            let off = 0
            while (true) {
              const { data, error: ccErr } = await supabase
                .from('closer_calls')
                .select('id, prospect_name, outcome, call_type, revenue, cash_collected, created_at, eod_report_id')
                .in('eod_report_id', reportIds)
                .in('outcome', ['closed', 'not_closed'])
                .eq('call_type', 'new_call')
                .range(off, off + PAGE - 1)
              if (ccErr) throw new Error(ccErr.message)
              if (!data?.length) break
              allCalls.push(...data)
              if (data.length < PAGE) break
              off += PAGE
            }
            // Dedupe by prospect_name (matches useCloserCallProspectMetrics).
            // Skip "Historical Close YYYY-MM-DD" backfill placeholders that
            // aren't real prospects.
            const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ')
            const isPlaceholder = (s) => /^historical close\b/i.test((s || '').trim())
            const seen = new Set()
            const rows = []
            for (const c of allCalls) {
              const k = norm(c.prospect_name)
              if (!k) continue
              if (isPlaceholder(c.prospect_name)) continue
              if (seen.has(k)) continue
              seen.add(k)
              rows.push({ kind: 'cc', ...c })
            }
            rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
            if (!cancelled) setRows(rows)
            return
          }
          // Per-ad/adset/campaign scope: stays on attribution-based union
          // because closer_calls has no ad attribution at the per-call level.
          //
          // Closes-imply-lives: a prospect who CLOSED was alive by definition.
          // is_live and is_closed are computed independently in the typeform
          // view (joined via different paths), so a close can land without a
          // matching is_live=true row — that's the George Sidhom case
          // (closed $10k, attributed to this campaign, but missing from the
          // Live drilldown because his typeform row had is_live=false).
          // Add a third source: lib_close_resolved scoped to the same campaign
          // so any closed prospect surfaces here too.
          let qG = supabase.from('lib_ghl_lives_detail').select('*')
            .gte('landed_at', sinceISO).lte('landed_at', untilISO)
            .order('landed_at', { ascending: false })
          qG = applyDrillScope(qG, drill.scope, SCOPE_COLS_GHL)
          let qT = supabase.from('lib_typeform_response_detail').select('*')
            .eq('is_live', true)
            .gte('submitted_at', sinceISO).lte('submitted_at', untilISO)
            .order('submitted_at', { ascending: false })
          qT = applyDrillScope(qT, drill.scope, SCOPE_COLS_TYPEFORM)
          // Also pull closes scoped to this campaign — any close not already
          // covered by the typeform/GHL lives sources gets surfaced as a
          // live (because closed implies live).
          let qC = supabase.from('lib_close_resolved').select('*')
            .gte('created_at', sinceISO).lte('created_at', untilISO)
            .order('created_at', { ascending: false })
          qC = applyDrillScope(qC, drill.scope, SCOPE_COLS_CLOSE)
          // ALSO pull typeform is_closed=true (catches typeform closes not
          // yet HYROS-resolved).
          let qTC = supabase.from('lib_typeform_response_detail').select('*')
            .eq('is_closed', true)
            .gte('submitted_at', sinceISO).lte('submitted_at', untilISO)
            .order('submitted_at', { ascending: false })
          qTC = applyDrillScope(qTC, drill.scope, SCOPE_COLS_TYPEFORM)
          const [{ data: gData, error: gErr }, { data: tData, error: tErr }, { data: cData, error: cErr }, { data: tcData, error: tcErr }] = await Promise.all([qG, qT, qC, qTC])
          if (gErr) throw new Error(gErr.message)
          if (tErr) throw new Error(tErr.message)
          if (cErr) throw new Error(cErr.message)
          if (tcErr) throw new Error(tcErr.message)
          // Union by name-token (lib_close_resolved has no email column).
          // Tag close rows so the UI can show they're surfacing here because
          // they closed, not because they have a recorded live event.
          const liveRows = unionByEmail(tData || [], gData || [], 'ghl')
          // Add closes that aren't already covered by liveRows. Use nameKey
          // (lib_close_resolved exposes clean_name / display_name).
          const seenLiveNames = new Set(liveRows.map(r => nameKey(r)).filter(Boolean))
          const seenLiveEmails = new Set(liveRows.map(r => (r.email || '').toLowerCase()).filter(Boolean))
          const extraFromCloses = []
          for (const r of (cData || [])) {
            const k = nameKey(r)
            const e = (r.email || '').toLowerCase()
            if (k && seenLiveNames.has(k)) continue
            if (e && seenLiveEmails.has(e)) continue
            if (k) seenLiveNames.add(k)
            if (e) seenLiveEmails.add(e)
            extraFromCloses.push({ kind: 'close', _liveViaClose: true, ...r })
          }
          for (const r of (tcData || [])) {
            const k = nameKey(r)
            const e = (r.email || '').toLowerCase()
            if (k && seenLiveNames.has(k)) continue
            if (e && seenLiveEmails.has(e)) continue
            if (k) seenLiveNames.add(k)
            if (e) seenLiveEmails.add(e)
            extraFromCloses.push({ kind: 'tf', _liveViaClose: true, ...r })
          }
          const merged = [...liveRows, ...extraFromCloses].sort((a, b) =>
            (b.submitted_at || b.landed_at || b.created_at || '')
              .localeCompare(a.submitted_at || a.landed_at || a.created_at || ''))
          setSource((tData || []).length && (gData || []).length ? 'mixed' : ((gData || []).length ? 'ghl' : 'typeform'))
          if (!cancelled) setRows(postFilter(merged))
          return
        }

        // ── LEADS / QUAL ─────────────────────────────────────────
        // Leads come from BOTH typeform and GHL contacts.
        const [tfData, ghlData] = await Promise.all([
          fetchTypeformDetail(drill, sinceISO, untilISO),
          fetchGhlDetail(drill, sinceISO, untilISO),
        ])

        let tf = tfData
        if (drill.metric === 'qualified') tf = tf.filter(r => r.qualified)

        const merged = unionByEmail(tf, ghlData, 'ghl')
        const filtered = postFilter(merged)
        const tfCount = filtered.filter(r => r.kind === 'tf').length
        const ghlCount = filtered.filter(r => r.kind === 'ghl').length
        setSource(ghlCount && tfCount ? 'mixed' : (ghlCount ? 'ghl' : 'typeform'))
        if (!cancelled) setRows(filtered)
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [drill.scope.level, drill.scope.id, drill.metric, dateRange?.startStr, dateRange?.endStr])

  const levelLabel = drill.scope.level === 'ad' ? 'Ad'
    : drill.scope.level === 'adset' ? 'Ad set'
    : drill.scope.level === 'campaign' ? 'Campaign'
    : 'All in window'
  const headerTitle = drill.scope.level === 'all'
    ? `${({ closed: 'Closes', booked: 'Bookings', live: 'Live calls', leads: 'Leads', qualified: 'Qualified leads', qual_booked: 'Qualified bookings' })[drill.metric] || drill.metric}`
    : (drill.label || drill.metric)
  const headerScope = drill.scope.label || (drill.scope.level === 'all' ? 'Across every campaign in the active date range' : '')

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 760, height: '100vh', overflowY: 'auto',
        background: 'var(--paper)', borderLeft: '1px solid var(--rule)', padding: '24px 28px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--rule)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>
              {levelLabel} · {headerTitle}
            </div>
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500, margin: 0, color: 'var(--ink)' }}>
              {headerTitle}: {loading ? '…' : rows.length}
            </h3>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', marginTop: 6, letterSpacing: '0.06em' }}>
              {headerScope}
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
                <th style={drillTh}>Creative</th>
                <th style={drillTh}>Attribution</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Revenue</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Cash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const isTf = r.kind === 'tf'
                const key = r.closer_call_id || r.response_id || `${r.kind}-${idx}`
                const closedAt = (r.created_at || r.submitted_at || '').slice(0, 10) || '—'
                const name = r.clean_name || r.prospect_name || r.display_name || r.email || 'Unknown'
                const attr = isTf ? 'typeform · unresolved' : (r.attribution_source || 'attributed')
                const adName = r._ad_name
                const adStatus = r._ad_status
                const isPaused = adStatus && adStatus !== 'ACTIVE'
                return (
                  <tr key={key} style={{ borderBottom: '1px solid var(--rule)' }}>
                    <td style={drillTd}>{closedAt}</td>
                    <td style={drillTd}>
                      <div style={{ fontFamily: 'var(--serif)', fontWeight: 500, color: 'var(--ink)', fontSize: 14 }}>{name}</div>
                      {isTf && r.email && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.email}</div>}
                    </td>
                    <td style={drillTd}>
                      {adName ? (
                        <>
                          <div style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink)' }}>{adName}</div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', marginTop: 2 }}>
                            {r._adset_name || '—'}
                            {isPaused && (
                              <span style={{ marginLeft: 6, padding: '1px 5px', background: '#fee', color: '#a44', borderRadius: 2, fontSize: 9 }}>
                                {adStatus}
                              </span>
                            )}
                          </div>
                        </>
                      ) : (
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)' }}>no ad attribution</span>
                      )}
                    </td>
                    <td style={drillTd}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 2,
                        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: r.attribution_source === 'manual' ? 'var(--accent-soft)' : 'transparent',
                        border: '1px solid', borderColor: isTf ? '#b88714' : (r.attribution_source === 'manual' ? 'var(--accent)' : 'var(--rule)'),
                        color: 'var(--ink)',
                      }}>{attr}</span>
                    </td>
                    <td style={{ ...drillTd, textAlign: 'right' }}>{(r.revenue || r.revenue_attributed) > 0 ? fmt$(parseFloat(r.revenue || r.revenue_attributed)) : '—'}</td>
                    <td style={{ ...drillTd, textAlign: 'right', color: (r.cash_collected || r.cash_attributed) > 0 ? '#1f7a3a' : 'var(--ink-4)' }}>{(r.cash_collected || r.cash_attributed) > 0 ? fmt$(parseFloat(r.cash_collected || r.cash_attributed)) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {!loading && rows.length > 0 && source === 'closer_calls' && (
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--rule)' }}>
                <th style={drillTh}>Date</th>
                <th style={drillTh}>Prospect</th>
                <th style={drillTh}>Outcome</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Revenue</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Cash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={r.id || `cc-${idx}`} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td style={drillTd}>{(r.created_at || '').slice(0, 10) || '—'}</td>
                  <td style={drillTd}>
                    <div style={{ fontFamily: 'var(--serif)', fontWeight: 500, color: 'var(--ink)', fontSize: 14 }}>{r.prospect_name || '—'}</div>
                  </td>
                  <td style={drillTd}>
                    <span style={{
                      padding: '2px 8px', borderRadius: 2,
                      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase',
                      background: r.outcome === 'closed' ? 'rgba(31,122,58,0.10)' : 'transparent',
                      border: '1px solid', borderColor: r.outcome === 'closed' ? '#1f7a3a' : 'var(--rule)',
                      color: 'var(--ink)',
                    }}>{r.outcome || '—'}</span>
                  </td>
                  <td style={{ ...drillTd, textAlign: 'right' }}>{r.revenue > 0 ? fmt$(parseFloat(r.revenue)) : '—'}</td>
                  <td style={{ ...drillTd, textAlign: 'right', color: r.cash_collected > 0 ? '#1f7a3a' : 'var(--ink-4)' }}>{r.cash_collected > 0 ? fmt$(parseFloat(r.cash_collected)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && rows.length > 0 && source !== 'closed' && source !== 'closer_calls' && (
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--rule)' }}>
                <th style={drillTh}>Submitted</th>
                <th style={drillTh}>Prospect</th>
                <th style={drillTh}>Source</th>
                <th style={drillTh}>Revenue tier / form</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Booked</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Live</th>
                <th style={{ ...drillTh, textAlign: 'right' }}>Closed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const isGhl = r.kind === 'ghl'
                // lib_ghl_lives_detail rows have no response_id / ghl_contact_id —
                // closer_call_id is the stable key. Index fallback prevents
                // duplicate-key warnings + render glitches when nothing identifies
                // the row.
                const id = r.response_id || r.ghl_contact_id || r.closer_call_id || r.appointment_id || `${r.kind}-${idx}`
                const when = (r.submitted_at || r.landed_at || '').slice(0, 10) || '—'
                const name = r.display_name || r.clean_name || r.prospect_name || r.email || '—'
                return (
                  <tr key={id} style={{ borderBottom: '1px solid var(--rule)' }}>
                    <td style={drillTd}>{when}</td>
                    <td style={drillTd}>
                      <div style={{ fontFamily: 'var(--serif)', fontWeight: 500, color: 'var(--ink)', fontSize: 14 }}>{name}</div>
                      {r.email && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.email}</div>}
                      {r.phone && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.phone}</div>}
                    </td>
                    <td style={drillTd}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 2,
                        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: isGhl ? 'rgba(38,117,212,0.10)' : 'rgba(184,135,20,0.10)',
                        border: '1px solid', borderColor: isGhl ? '#2675d4' : '#b88714',
                        color: 'var(--ink)',
                      }}>{isGhl ? 'lead form' : 'typeform'}</span>
                    </td>
                    <td style={drillTd}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 2,
                        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
                        background: r.qualified ? 'var(--accent-soft)' : 'transparent',
                        border: '1px solid', borderColor: r.qualified ? 'var(--accent)' : 'var(--rule)',
                        color: 'var(--ink)',
                      }}>
                        {r.revenue_tier || r.form_name || (r.tier === 'abandoned' ? 'abandoned' : '—')}
                      </span>
                    </td>
                    <td style={{ ...drillTd, textAlign: 'right' }}>{r.is_booked  ? '●' : '—'}</td>
                    <td style={{ ...drillTd, textAlign: 'right' }}>{r.is_live    ? '●' : '—'}</td>
                    <td style={{ ...drillTd, textAlign: 'right', color: r.is_closed ? '#1f7a3a' : 'var(--ink-4)' }}>{r.is_closed ? '●' : '—'}</td>
                  </tr>
                )
              })}
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
