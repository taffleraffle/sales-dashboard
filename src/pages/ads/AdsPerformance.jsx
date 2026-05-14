import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertCircle, ChevronRight, ChevronDown, Search, ArrowDown, ArrowUp, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { dateRangeBoundsET } from '../../lib/dateUtils'
import { useCloserCallProspectMetrics } from '../../hooks/useCloserCallProspectMetrics'

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
          .select('response_id, submitted_at, ad_id, adset_id, utm_campaign, qualified, is_booked, is_live, is_closed, revenue, cash_collected')
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
          .select('appointment_id, landed_at, ad_id, adset_id, utm_campaign')
          .gte('landed_at', startTs).lte('landed_at', endTs)),
        fetchAllPaged(() => supabase
          .from('lib_ghl_lives_detail')
          .select('closer_call_id, landed_at, ad_id, adset_id, utm_campaign')
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
      const tfLeadEmails = new Set()
      for (const r of tfRows) if (r.email) tfLeadEmails.add(r.email.toLowerCase())
      const attrLeads = tfRows.filter(r => r.ad_id).length
        + ghlLeadRows.filter(r => r.ad_id && !tfLeadEmails.has((r.email || '').toLowerCase())).length
      const attrCloses = closeRows.filter(r => r.resolved_ad_id || r.resolved_campaign).length
      const closeRev = closeRows.reduce((s, r) => s + parseFloat(r.revenue || 0), 0)
      const closeCash = closeRows.reduce((s, r) => s + parseFloat(r.cash_collected || 0), 0)
      setRowTotals({
        eod,
        attributed: {
          leads:   attrLeads,
          booked:  ghlBookedRows.filter(r => r.ad_id).length,
          live:    ghlLiveRows.filter(r => r.ad_id).length,
          closes:  attrCloses,
          revenue: closeRev,
          cash:    closeCash,
        },
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

      // 3. Typeform — per ad/adset/campaign
      const tfAdMap = {}, tfAdsetMap = {}, tfCampMap = {}
      for (const r of tfRows) {
        const stamp = (target, key) => {
          if (!key) return
          let row = target[key]
          if (!row) row = target[key] = { leads: 0, qualified_leads: 0, booked_calls: 0, qualified_booked_calls: 0, live_calls: 0, closes: 0, revenue_attributed: 0, cash_attributed: 0 }
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
      setTfAd(tfAdMap); setTfAdset(tfAdsetMap); setTfCampaign(tfCampMap)

      // 4. Closes — per ad/adset/campaign + orphan tracking
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
          row.closes++; row.revenue += rev; row.cash += cash
        }
        bump(cAd,    r.resolved_ad_id)
        bump(cAdset, r.resolved_adset_id)
        bump(cCamp,  r.resolved_campaign)
        if (r.attribution_source === 'orphan') {
          orphans.push(r); orphanRev += rev; orphanCash += cash
        }
      }
      setCloseAd(cAd); setCloseAdset(cAdset); setCloseCampaign(cCamp)
      setOrphanCloses({ count: orphans.length, revenue: orphanRev, cash: orphanCash, rows: orphans })

      // 5. GHL leads + 6. booked + 7. lives — three identical aggregation
      // shapes (count per ad/adset/campaign).
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
      const gAd = gLeadAd, gAdset = gLeadAdset, gCamp = gLeadCamp
      setGhlLeadsAd(gAd)
      setGhlLeadsAdset(gAdset)
      setGhlLeadsCampaign(gCamp)

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
      // Advanced filter runs at the campaign rollup level.
      if (!passesAdv(camp.rollup)) continue
      const compareAds = (a, b) => sortCompare(a.rollup, b.rollup, sortKey, sortDir)
      for (const s of visibleSets) s.ads.sort(compareAds)
      const compareSets = (a, b) => sortCompare(a.rollup, b.rollup, sortKey, sortDir)
      visibleSets.sort(compareSets)
      visibleCampaigns.push({ ...camp, ad_sets_sorted: visibleSets })
    }
    const compareCamps = (a, b) => sortCompare(a.rollup, b.rollup, sortKey, sortDir)
    visibleCampaigns.sort(compareCamps)
    return visibleCampaigns
  }, [ads, stats, hyros, tfAd, tfAdset, tfCampaign, closeAd, closeAdset, closeCampaign, ghlLeadsAd, ghlLeadsAdset, ghlLeadsCampaign, ghlBookedAd, ghlBookedAdset, ghlBookedCampaign, ghlLivesAd, ghlLivesAdset, ghlLivesCampaign, statusFilter, search, sortKey, sortDir, advFilter])

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

      {/* Totals strip — headline numbers come from marketing_tracker (EOD
          closer-entered aggregates, same source the marketing dashboard
          uses). Sub-line shows how many we managed to attribute to a
          Meta ad. Clickable opens drill-down showing the attributable
          rows. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: '14px 16px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, marginBottom: 8 }}>
        <TotalsTile label="Spend" value={fmt$(totals.spend)} />
        {(() => {
          const eod = rowTotals.eod, attr = rowTotals.attributed
          // Pull the prospect-deduped numbers for the active window — same
          // formula the Marketing dashboard runs. Lets us show the 3-step
          // waterfall: EOD reported → unique prospects → attributed to ad.
          const pm = prospectMetricsByRange({ from: dateRange.startStr, to: dateRange.endStr })
          const sub = (eodVal, attrVal, extra = '') => {
            if (eodVal === 0) return attrVal > 0 ? `${fmtN(attrVal)} attributed (no EOD data)` : null
            const gap = eodVal - attrVal
            if (gap > 0)  return `${fmtN(attrVal)} attributed · ${fmtN(gap)} unattributed${extra}`
            if (gap < 0)  return `${fmtN(attrVal)} attributed · exceeds EOD by ${fmtN(-gap)} (check for dedup gap)${extra}`
            return `all ${fmtN(attrVal)} attributed${extra}`
          }
          // 3-step waterfall sub for Closes (and Live): EOD counter → prospect
          // dedup → ad attribution. This matches what the Marketing dashboard
          // shows (which substitutes the deduped number as the headline).
          const closeSub = eod.closes > 0
            ? `${fmtN(pm.closedProspects)} unique prospects · ${fmtN(attr.closes)} attributed${eod.revenue > 0 ? ` · ${fmt$(eod.revenue)} rev` : ''}`
            : (attr.closes > 0 ? `${fmtN(attr.closes)} attributed (no EOD data)` : null)
          const liveSub = eod.live > 0
            ? `${fmtN(pm.liveProspects)} unique prospects · ${fmtN(attr.live)} attributed`
            : (attr.live > 0 ? `${fmtN(attr.live)} attributed (no EOD data)` : null)
          const click = (metric) => () => setDrill({ metric, scope: { level: 'all' } })
          return (
            <>
              <TotalsTile label="Leads"      value={fmtN(eod.leads)}  sub={sub(eod.leads,  attr.leads)}  onClick={click('leads')} />
              <TotalsTile label="Booked"     value={fmtN(eod.booked)} sub={sub(eod.booked, attr.booked)} onClick={click('booked')} />
              <TotalsTile label="Live calls" value={fmtN(eod.live)}   sub={liveSub}                       onClick={click('live')} />
              <TotalsTile
                label="Closes"
                value={fmtN(eod.closes)}
                sub={closeSub}
                valueColor={eod.closes > 0 ? '#1f7a3a' : undefined}
                onClick={click('closed')}
              />
            </>
          )
        })()}
        {(() => {
          const e = rowTotals.eod
          return (
            <>
              <TotalsTile label="$ / Lead"   value={e.leads  > 0 ? fmt$(totals.spend / e.leads)  : '—'} valueColor={kpiColor(e.leads  > 0 ? totals.spend / e.leads  : null, KPI.costPerLead)} />
              <TotalsTile label="$ / Booked" value={e.booked > 0 ? fmt$(totals.spend / e.booked) : '—'} valueColor={kpiColor(e.booked > 0 ? totals.spend / e.booked : null, KPI.costPerQualBooked)} />
              <TotalsTile label="$ / Live"   value={e.live   > 0 ? fmt$(totals.spend / e.live)   : '—'} valueColor={kpiColor(e.live   > 0 ? totals.spend / e.live   : null, KPI.costPerLive)} />
              <TotalsTile
                label="CAC"
                value={e.closes > 0 ? fmt$(totals.spend / e.closes) : '—'}
                sub={e.closes > 0 ? `${fmt$(totals.spend)} ÷ ${e.closes} closes` : null}
                valueColor={kpiColor(e.closes > 0 ? totals.spend / e.closes : null, KPI.costPerClose)}
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
            options={[{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }, { value: 'all', label: 'All' }, { value: 'custom', label: 'Custom' }]} />
          {dateRange.preset === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="date" value={dateRange.startStr} max={dateRange.endStr}
                onChange={e => setDateRange({ ...dateRange, preset: 'custom', startStr: e.target.value })} style={dateInputStyle} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>→</span>
              <input type="date" value={dateRange.endStr} min={dateRange.startStr}
                onChange={e => setDateRange({ ...dateRange, preset: 'custom', endStr: e.target.value })} style={dateInputStyle} />
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

      {drill && <ProspectDrillModal drill={drill} dateRange={dateRange} onClose={() => setDrill(null)} />}
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

function TotalsTile({ label, value, sub, valueColor, onClick }) {
  const clickable = typeof onClick === 'function'
  return (
    <div
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
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
function adRollupFrom(ad, stats, hyros, tfAd, closeAd, ghlLeadsAd, ghlBookedAd, ghlLivesAd) {
  const s = stats[ad.ad_id] || {}
  const h = hyros[ad.ad_id] || {}
  const t = tfAd[ad.ad_id] || {}
  const c = closeAd[ad.ad_id] || {}
  const g  = ghlLeadsAd[ad.ad_id]  || 0
  const gB = ghlBookedAd[ad.ad_id] || 0
  const gL = ghlLivesAd[ad.ad_id]  || 0
  // MAX of (typeform funnel) + (paid-lead-form via GHL) at every metric.
  // Revenue + cash come ONLY from closer EOD reports (closer_calls) via
  // lib_close_resolved. We don't pull from Stripe/payments — Ben prefers
  // the dashboard to match EOD-reported numbers.
  return {
    spend: s.spend || 0,
    leads: s.results || 0,
    booked: h.calls_attributed || 0,
    qualified: h.calls_qualified || 0,
    revenue: parseFloat(h.revenue_attributed || 0),
    tfLeads:      Math.max(t.leads || 0, g),
    tfQualLeads:  t.qualified_leads || 0,
    tfBooked:     Math.max(t.booked_calls || 0, gB),
    tfQualBooked: t.qualified_booked_calls || 0,
    tfLive:       Math.max(t.live_calls || 0, gL),
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
async function fetchTypeformDetail(drill, sinceISO, untilISO) {
  let q = supabase.from('lib_typeform_response_detail').select('*')
    .gte('submitted_at', sinceISO).lte('submitted_at', untilISO)
    .order('submitted_at', { ascending: false })
  if (drill.scope.level === 'ad')           q = q.eq('ad_id',        drill.scope.id)
  else if (drill.scope.level === 'adset')   q = q.eq('adset_id',     drill.scope.id)
  else if (drill.scope.level === 'campaign')q = q.eq('utm_campaign', drill.scope.id)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data || []
}

async function fetchGhlDetail(drill, sinceISO, untilISO) {
  // Same OR-trick the closes drill uses: include rows that match scope by
  // ad_id, adset_id, OR utm_campaign string. Covers data drift.
  let q = supabase.from('lib_ghl_leads_detail').select('*')
    .gte('landed_at', sinceISO).lte('landed_at', untilISO)
    .order('landed_at', { ascending: false })
  if (drill.scope.level === 'ad') {
    q = q.eq('ad_id', drill.scope.id)
  } else if (drill.scope.level === 'adset') {
    const adIds = drill.scope.adIds || []
    if (adIds.length > 0) q = q.or(`adset_id.eq.${drill.scope.id},ad_id.in.(${adIds.join(',')})`)
    else                  q = q.eq('adset_id', drill.scope.id)
  } else if (drill.scope.level === 'campaign') {
    const ors = []
    if (drill.scope.id) ors.push(`utm_campaign.eq.${encodeURIComponent(drill.scope.id)}`)
    if ((drill.scope.adsetIds || []).length) ors.push(`adset_id.in.(${drill.scope.adsetIds.join(',')})`)
    if ((drill.scope.adIds    || []).length) ors.push(`ad_id.in.(${drill.scope.adIds.join(',')})`)
    if (ors.length) q = q.or(ors.join(','))
  }
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data || []
}

// ── Drill-down modal ────────────────────────────────────────────────
// Backs the click-to-see-the-actual-prospects behaviour on any number
// cell in the rollup table. Queries multiple sources (typeform + GHL +
// closer_calls) so every metric pulls from the source that actually has
// the rows. Respects the active date range.
function ProspectDrillModal({ drill, dateRange, onClose }) {
  const [rows, setRows] = useState([])
  const [source, setSource] = useState('typeform')  // 'typeform' | 'closed' | 'ghl' | 'mixed'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoading(true); setError(null)
      try {
        const sinceISO = (dateRange?.startStr || '2024-01-01') + 'T00:00:00Z'
        const untilISO = (dateRange?.endStr   || '2099-12-31') + 'T23:59:59Z'

        // ── CLOSED ─────────────────────────────────────────────────
        if (drill.metric === 'closed') {
          setSource('closed')
          let q = supabase.from('lib_close_resolved').select('*')
            .gte('created_at', sinceISO).lte('created_at', untilISO)
            .order('created_at', { ascending: false })
          if (drill.scope.level === 'ad') {
            q = q.eq('resolved_ad_id', drill.scope.id)
          } else if (drill.scope.level === 'adset') {
            const adIds = drill.scope.adIds || []
            if (adIds.length > 0) q = q.or(`resolved_adset_id.eq.${drill.scope.id},resolved_ad_id.in.(${adIds.join(',')})`)
            else                  q = q.eq('resolved_adset_id', drill.scope.id)
          } else if (drill.scope.level === 'campaign') {
            const ors = []
            if (drill.scope.id) ors.push(`resolved_campaign.eq.${encodeURIComponent(drill.scope.id)}`)
            if ((drill.scope.adsetIds || []).length) ors.push(`resolved_adset_id.in.(${drill.scope.adsetIds.join(',')})`)
            if ((drill.scope.adIds    || []).length) ors.push(`resolved_ad_id.in.(${drill.scope.adIds.join(',')})`)
            if (ors.length) q = q.or(ors.join(','))
          }
          const { data, error: e } = await q
          if (e) throw new Error(e.message)
          if (!cancelled) setRows((data || []).map(r => ({ kind: 'close', ...r })))
          return
        }

        // ── BOOKED ─────────────────────────────────────────────────
        // Use lib_ghl_booked_detail (the same source the headline count
        // is derived from). Falls back to typeform's is_booked rows for
        // typeform-only path coverage.
        if (drill.metric === 'booked' || drill.metric === 'qual_booked') {
          setSource('ghl')
          let q = supabase.from('lib_ghl_booked_detail').select('*')
            .gte('landed_at', sinceISO).lte('landed_at', untilISO)
            .order('landed_at', { ascending: false })
          if (drill.scope.level === 'ad')           q = q.eq('ad_id',        drill.scope.id)
          else if (drill.scope.level === 'adset')   q = q.eq('adset_id',     drill.scope.id)
          else if (drill.scope.level === 'campaign')q = q.eq('utm_campaign', drill.scope.id)
          const { data, error: e } = await q
          if (e) throw new Error(e.message)
          if (!cancelled) setRows((data || []).map(r => ({ kind: 'ghl', ...r })))
          return
        }

        // ── LIVE ──────────────────────────────────────────────────
        if (drill.metric === 'live') {
          setSource('ghl')
          let q = supabase.from('lib_ghl_lives_detail').select('*')
            .gte('landed_at', sinceISO).lte('landed_at', untilISO)
            .order('landed_at', { ascending: false })
          if (drill.scope.level === 'ad')           q = q.eq('ad_id',        drill.scope.id)
          else if (drill.scope.level === 'adset')   q = q.eq('adset_id',     drill.scope.id)
          else if (drill.scope.level === 'campaign')q = q.eq('utm_campaign', drill.scope.id)
          const { data, error: e } = await q
          if (e) throw new Error(e.message)
          if (!cancelled) setRows((data || []).map(r => ({ kind: 'ghl', ...r })))
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

        // Dedupe: a prospect who submitted typeform AND has a ghl_contact
        // gets counted once. Email is the join key.
        const tfEmails = new Set(tf.map(r => (r.email || '').toLowerCase()).filter(Boolean))
        const ghlDedup = ghlData.filter(r => !r.email || !tfEmails.has(r.email.toLowerCase()))

        const tfTagged  = tf.map(r => ({ kind: 'tf',  ...r }))
        const ghlTagged = ghlDedup.map(r => ({ kind: 'ghl', ...r }))
        const merged = [...tfTagged, ...ghlTagged].sort((a, b) =>
          (b.submitted_at || b.landed_at || '').localeCompare(a.submitted_at || a.landed_at || ''))

        setSource(ghlTagged.length && tfTagged.length ? 'mixed' : (ghlTagged.length ? 'ghl' : 'typeform'))
        if (!cancelled) setRows(merged)
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

        {!loading && rows.length > 0 && source !== 'closed' && (
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
              {rows.map(r => {
                const isGhl = r.kind === 'ghl'
                const id = r.response_id || r.ghl_contact_id
                const when = (r.submitted_at || r.landed_at || '').slice(0, 10) || '—'
                return (
                  <tr key={id} style={{ borderBottom: '1px solid var(--rule)' }}>
                    <td style={drillTd}>{when}</td>
                    <td style={drillTd}>
                      <div style={{ fontFamily: 'var(--serif)', fontWeight: 500, color: 'var(--ink)', fontSize: 14 }}>{r.display_name}</div>
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
