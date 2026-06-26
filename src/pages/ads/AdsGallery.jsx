import { useEffect, useMemo, useState } from 'react'
import { Sparkles, RefreshCw, AlertCircle, Search, Mic } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { pagedFetch } from '../../lib/pagedFetch'
import AdCard from '../../components/ads/AdCard'
import AdAnalystPanel from '../../components/ads/AdAnalystPanel'
import { triggerTranscribeAds } from '../../services/adAnalyst'
import { useToast } from '../../hooks/useToast'

/*
  Live Ad Gallery — the Meta-Ads-Library-style internal surface.
  Reads public.ads + public.ad_daily_stats + lib_variant_state_history,
  presents a card grid with filters and an analyst panel docked right.

  When public.ads is empty (no Meta sync run yet), shows the empty state
  with a "Sync now" button that triggers `syncMetaAdsAtAdLevel` directly.
*/

const STATE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'winning', label: 'Winning' },
  { value: 'foundational', label: 'Foundational' },
  { value: 'bench', label: 'Bench' },
  { value: 'bad_pocket', label: 'Bad pocket' },
  { value: 'fatigued', label: 'Fatigued' },
  { value: 'concept', label: 'Concept' },
]

const SPEND_TIERS = [
  { value: 'all', label: 'Any spend' },
  { value: 'high', label: '$10k+' },
  { value: 'mid',  label: '$1k–$10k' },
  { value: 'low',  label: '$100–$1k' },
  { value: 'tiny', label: '<$100' },
]

const SORTS = [
  { value: 'spend_desc', label: 'Spend ↓' },
  { value: 'closes_desc', label: 'Closes ↓' },
  { value: 'cpa_asc', label: 'CPA ↑' },
  { value: 'recent', label: 'Most recent' },
]

const STATUS_FILTERS = [
  { value: 'all', label: 'All status' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PAUSED', label: 'Paused' },
]

export default function AdsGallery() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [stateFilter, setStateFilter] = useState('all')
  const [spendTier, setSpendTier] = useState('all')
  const [campaignFilter, setCampaignFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sort, setSort] = useState('spend_desc')
  const [search, setSearch] = useState('')
  const [analystOpen, setAnalystOpen] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      // Paged through PostgREST's 1000-row cap. Prior .limit(500) hid
      // every ad past the 500th from the gallery without warning.
      const ads = await pagedFetch(() => supabase
        .from('ads')
        .select('ad_id, ad_name, status, effective_status, variant_id, variant_match_status, thumbnail_url, asset_url, asset_type, campaign_id, campaign_name, adset_id, adset_name, last_synced_at, first_seen_at')
        .order('first_seen_at', { ascending: false }))
      const adIds = ads.map(a => a.ad_id)

      // Stats over last 30 days, aggregated per ad.
      // PostgREST caps result sets at 1000 rows by default. With 381 ads × ~30d
      // we get ~1100+ rows, so we MUST page through with .range() — otherwise
      // the most-recent rows get silently dropped and high-spend ads show $0.
      const perAd = {}
      if (adIds.length) {
        const since = new Date(); since.setDate(since.getDate() - 30)
        const sinceStr = since.toISOString().split('T')[0]
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
            const r = perAd[s.ad_id] || { spend: 0, impressions: 0, clicks: 0, leads: 0 }
            r.spend += parseFloat(s.spend || 0)
            r.impressions += parseInt(s.impressions || 0)
            r.clicks += parseInt(s.clicks || 0)
            r.leads += parseInt(s.results || 0)
            perAd[s.ad_id] = r
          }
          if (data.length < PAGE) break
          offset += PAGE
        }
      }

      // Whisper transcripts. The /advideos corpus (C2) has ad_id=NULL — those
      // are brand-voice corpus only and can't be card-linked without a
      // video_id ↔ advideo_id resolution which Meta doesn't expose. Per-ad
      // transcripts come from the C3 upload path (operator drops MP4).
      const transcriptsRes = await supabase
        .from('lib_creative_transcripts')
        .select('ad_id, full_text')
        .eq('source', 'whisper_api')
        .not('ad_id', 'is', null)
      const transcriptByAd = new Map()
      for (const r of transcriptsRes.data || []) {
        transcriptByAd.set(r.ad_id, r.full_text)
      }

      // HYROS ad-level attribution. lib_hyros_ad_attribution is a view rolling
      // up calls/leads/sales per Meta ad over the last 90d. The view ad_id
      // resolves via COALESCE(source_link_ad_id, meta_ad_id) so it covers
      // both direct ad clicks and source-link redirects.
      const hyrosRes = await supabase
        .from('lib_hyros_ad_attribution')
        .select('ad_id, calls_attributed, calls_qualified, leads_attributed, sales_attributed, revenue_attributed')
      const hyrosByAd = new Map()
      for (const r of hyrosRes.data || []) {
        hyrosByAd.set(r.ad_id, r)
      }

      // TODO Phase E: join lib_variant_state_history to populate variant_state.
      const enriched = ads.map(a => {
        const st = perAd[a.ad_id] || {}
        const ctr = st.impressions > 0 ? (st.clicks / st.impressions) * 100 : null
        const transcript = transcriptByAd.get(a.ad_id)
        const transcript_preview = transcript ? transcript.slice(0, 140) : null
        const hy = hyrosByAd.get(a.ad_id) || {}
        // HYROS calls = Calendly bookings, so map straight to booked. Closed
        // requires sale.attributed events which are zero today (no Stripe →
        // HYROS pipe yet). Once those flow, closed + revenue light up.
        return {
          ...a,
          asset_type: a.asset_type || null,
          has_whisper_transcript: !!transcript,
          transcript_preview,
          stats: {
            spend: st.spend || 0,
            impressions: st.impressions || 0,
            clicks: st.clicks || 0,
            leads: st.leads || hy.leads_attributed || 0,
            booked: hy.calls_attributed || 0,
            qualified: hy.calls_qualified || 0,
            closed: hy.sales_attributed || 0,
            revenue: parseFloat(hy.revenue_attributed || 0),
            ctr,
            leadQualityPct: hy.calls_attributed > 0 ? (hy.calls_qualified / hy.calls_attributed) * 100 : null,
          },
          variant_state: a.variant_id ? 'bench' : 'concept',
          duration_sec: null,
        }
      })
      setRows(enriched)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const triggerSync = async () => {
    setSyncing(true)
    setError(null)
    try {
      const { syncMetaAdsAtAdLevel } = await import('../../services/metaAdsSync')
      console.time('[gallery] manual sync')
      const result = await syncMetaAdsAtAdLevel(30)
      console.timeEnd('[gallery] manual sync')
      console.log('[gallery] manual sync result:', result)
      await load()
    } catch (e) {
      console.error('[gallery] sync failed:', e)
      setError(`Sync failed: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }

  // Fire the transcribe-ads Edge Function. Runs server-side so OPENAI_API_KEY
  // stays out of the browser bundle. Processes up to 25 videos per click;
  // re-click to keep going through the backlog.
  const [transcribing, setTranscribing] = useState(false)
  const toast = useToast()
  const triggerTranscribe = async () => {
    setTranscribing(true)
    try {
      const result = await triggerTranscribeAds(25)
      toast.success(
        `Transcribed ${result.processed} videos · ${result.errors} errors · ${result.totalPending} pending. ` +
        (result.totalPending > 0 ? 'Click again to continue the backlog.' : 'All caught up.'),
        { duration: 6000 }
      )
    } catch (e) {
      console.error('[gallery] transcribe failed:', e)
      toast.error(`Transcribe failed: ${e.message}`)
    } finally {
      setTranscribing(false)
    }
  }

  // Derive the campaign list from rows for the filter dropdown.
  const campaigns = useMemo(() => {
    const set = new Set()
    for (const r of rows) if (r.campaign_name) set.add(r.campaign_name)
    return Array.from(set).sort()
  }, [rows])

  const filtered = useMemo(() => {
    let out = rows
    // effective_status is the rolled-up campaign × adset × ad delivery state
    // (e.g. CAMPAIGN_PAUSED, ADSET_PAUSED). `status` is just the ad-level
    // toggle which doesn't reflect actual delivery. Always filter by effective.
    if (statusFilter !== 'all') {
      out = out.filter(r => {
        const es = r.effective_status || r.status
        if (statusFilter === 'ACTIVE') return es === 'ACTIVE'
        if (statusFilter === 'PAUSED') return es && es !== 'ACTIVE'
        return true
      })
    }
    if (stateFilter !== 'all') out = out.filter(r => r.variant_state === stateFilter)
    if (campaignFilter !== 'all') out = out.filter(r => r.campaign_name === campaignFilter)
    if (spendTier !== 'all') {
      out = out.filter(r => {
        const s = r.stats.spend
        if (spendTier === 'high') return s >= 10000
        if (spendTier === 'mid') return s >= 1000 && s < 10000
        if (spendTier === 'low') return s >= 100 && s < 1000
        if (spendTier === 'tiny') return s < 100
        return true
      })
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      out = out.filter(r =>
        (r.ad_name || '').toLowerCase().includes(q) ||
        (r.variant_id || '').toLowerCase().includes(q)
      )
    }
    out = [...out].sort((a, b) => {
      if (sort === 'spend_desc') return b.stats.spend - a.stats.spend
      if (sort === 'closes_desc') return b.stats.closed - a.stats.closed
      if (sort === 'cpa_asc') {
        const aCpa = a.stats.closed > 0 ? a.stats.spend / a.stats.closed : Infinity
        const bCpa = b.stats.closed > 0 ? b.stats.spend / b.stats.closed : Infinity
        return aCpa - bCpa
      }
      return new Date(b.first_seen_at).getTime() - new Date(a.first_seen_at).getTime()
    })
    return out
  }, [rows, statusFilter, stateFilter, campaignFilter, spendTier, sort, search])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: analystOpen ? 'minmax(0, 1fr) 380px' : 'minmax(0, 1fr)', gap: 16 }} className="ads-gallery-grid">
      {/* Main column */}
      <div>
        {/* Page header for the gallery tab */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
          <div>
            <span className="eyebrow eyebrow-accent">Library · Live gallery</span>
            <h2 className="h3 mt-2" style={{ fontSize: 22 }}>Every ad, <em>at a glance</em>.</h2>
            <p
              className="mt-2"
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--ink-3)',
              }}
            >
              {rows.length} ads loaded · {filtered.length} after filters
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={triggerTranscribe}
              disabled={transcribing}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                background: 'var(--paper)',
                color: 'var(--ink)',
                border: '1px solid var(--rule)',
                borderRadius: 9,
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 500,
                cursor: transcribing ? 'wait' : 'pointer',
                opacity: transcribing ? 0.6 : 1,
                whiteSpace: 'nowrap',
              }}
              title="Whisper-transcribe up to 25 unprocessed video ads. Click again to continue the backlog."
            >
              <Mic size={12} className={transcribing ? 'animate-pulse' : ''} />
              {transcribing ? 'Transcribing…' : 'Transcribe videos'}
            </button>
            <button
              onClick={() => setAnalystOpen(v => !v)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                background: analystOpen ? 'var(--ink)' : 'var(--accent)',
                color: analystOpen ? 'var(--paper)' : 'var(--ink)',
                border: '1px solid',
                borderColor: analystOpen ? 'var(--ink)' : 'var(--accent)',
                borderRadius: 9,
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              <Sparkles size={12} />
              {analystOpen ? 'Hide analyst' : 'Ask analyst'}
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <FilterBar
          statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          stateFilter={stateFilter} setStateFilter={setStateFilter}
          spendTier={spendTier} setSpendTier={setSpendTier}
          sort={sort} setSort={setSort}
          search={search} setSearch={setSearch}
          campaignFilter={campaignFilter} setCampaignFilter={setCampaignFilter}
          campaigns={campaigns}
        />

        {/* Error banner */}
        {error && (
          <div
            style={{
              padding: '12px 14px',
              border: '1px solid var(--down)',
              borderLeftWidth: 3,
              borderRadius: '0 3px 3px 0',
              background: 'var(--down-soft)',
              color: 'var(--down)',
              marginBottom: 16,
              fontSize: 13,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
            }}
          >
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 4 }}>Gallery error</div>
              {error}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && rows.length === 0 && !error && (
          <div
            style={{
              border: '1px dashed var(--rule)',
              borderRadius: 10,
              padding: 32,
              textAlign: 'center',
              background: 'var(--paper-2)',
            }}
          >
            <span className="eyebrow eyebrow-accent" style={{ justifyContent: 'center', display: 'inline-flex', marginBottom: 12 }}>No ads synced</span>
            <h3 className="h3" style={{ fontSize: 22, marginBottom: 10 }}>The <em>library</em> is empty.</h3>
            <p
              style={{
                fontFamily: 'var(--serif)',
                fontSize: 14,
                color: 'var(--ink-2)',
                maxWidth: '46ch',
                margin: '0 auto 18px',
                lineHeight: 1.55,
              }}
            >
              Click sync to pull every ad from your Meta account into <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>public.ads</span>. The hourly autoSync will keep this fresh after the first run.
            </p>
            <button
              onClick={triggerSync}
              disabled={syncing}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 16px',
                background: 'var(--accent)',
                color: 'var(--ink)',
                border: '1px solid var(--accent)',
                borderRadius: 9,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
                cursor: syncing ? 'wait' : 'pointer',
                opacity: syncing ? 0.6 : 1,
              }}
            >
              <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing…' : 'Sync Meta ads now'}
            </button>
          </div>
        )}

        {loading && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                style={{
                  background: 'var(--paper-2)',
                  border: '1px solid var(--rule)',
                  borderRadius: 10,
                  height: 360,
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}
              />
            ))}
          </div>
        )}

        {/* Filtered-to-nothing state — without it the grid area renders
            silent blank space and reads as "no ads exist" (the real
            empty state only covers zero synced ads). */}
        {!loading && !error && rows.length > 0 && filtered.length === 0 && (
          <div style={{
            border: '1px dashed var(--rule)', padding: 40, textAlign: 'center',
            background: 'var(--paper-2)',
          }}>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink-2)', marginBottom: 6 }}>
              No ads match these filters
            </div>
            <button type="button"
              onClick={() => {
                setStatusFilter('all'); setStateFilter('all')
                setCampaignFilter('all'); setSpendTier('all'); setSearch('')
              }}
              style={{
                marginTop: 6, padding: '7px 14px',
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: 'var(--ink)', color: 'var(--paper)',
                border: 'none', cursor: 'pointer',
              }}>Clear filters</button>
          </div>
        )}

        {/* Card grid */}
        {!loading && filtered.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {filtered.map(ad => <AdCard key={ad.ad_id} ad={ad} />)}
          </div>
        )}
      </div>

      {/* Analyst panel */}
      {analystOpen && (
        <div style={{ position: 'sticky', top: 0, alignSelf: 'flex-start', height: 'calc(100vh - 80px)' }}>
          <AdAnalystPanel open={analystOpen} onClose={() => setAnalystOpen(false)} />
        </div>
      )}
    </div>
  )
}

function FilterBar({
  statusFilter, setStatusFilter,
  stateFilter, setStateFilter,
  spendTier, setSpendTier,
  sort, setSort,
  search, setSearch,
  campaignFilter, setCampaignFilter,
  campaigns,
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 16,
        padding: '10px 12px',
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 9,
      }}
    >
      <ChipGroup label="Status"  value={statusFilter} setValue={setStatusFilter} options={STATUS_FILTERS} />
      <ChipGroup label="State"   value={stateFilter}  setValue={setStateFilter}  options={STATE_FILTERS} />
      <ChipGroup label="Spend"   value={spendTier}    setValue={setSpendTier}    options={SPEND_TIERS} />
      <ChipGroup label="Sort"    value={sort}         setValue={setSort}         options={SORTS} />
      {/* Campaign filter — dropdown since there can be many */}
      {campaigns.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
              fontWeight: 500,
              marginRight: 4,
            }}
          >
            Campaign
          </span>
          <select
            value={campaignFilter}
            onChange={e => setCampaignFilter(e.target.value)}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.06em',
              background: 'var(--paper-2)',
              color: 'var(--ink)',
              border: '1px solid var(--rule)',
              borderRadius: 9,
              padding: '4px 8px',
              cursor: 'pointer',
              maxWidth: 240,
            }}
          >
            <option value="all">All campaigns ({campaigns.length})</option>
            {campaigns.map(c => (
              <option key={c} value={c}>{c.length > 48 ? c.slice(0, 45) + '…' : c}</option>
            ))}
          </select>
        </div>
      )}
      <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Search size={12} style={{ color: 'var(--ink-3)', flexShrink: 0, marginLeft: 4 }} />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search variant or ad name…"
          style={{
            flex: 1,
            background: 'var(--paper-2)',
            border: '1px solid var(--rule)',
            borderRadius: 9,
            padding: '5px 8px',
            fontSize: 12,
            color: 'var(--ink)',
            outline: 'none',
          }}
        />
      </div>
    </div>
  )
}

function ChipGroup({ label, value, setValue, options }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
          fontWeight: 500,
          marginRight: 4,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: 'inline-flex',
          background: 'var(--paper-2)',
          border: '1px solid var(--rule)',
          borderRadius: 9,
          padding: 2,
        }}
      >
        {options.map(opt => {
          const active = value === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => setValue(opt.value)}
              style={{
                padding: '4px 9px',
                fontFamily: 'var(--mono)',
                fontSize: 9.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 500,
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--paper)' : 'var(--ink-3)',
                borderRadius: 9,
              }}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
